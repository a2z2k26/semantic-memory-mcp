/**
 * SQLite Storage Adapter for Unified Memory System
 * Provides persistent storage with FTS5 full-text search
 * Sprint 1.2: SQLite Persistence Layer
 */

const sqlite3 = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const Logger = require('../lib/logger');
const { VersionVector } = require('../lib/version-vector');
const { ConflictResolver, ConflictStatus } = require('../lib/conflict-resolver');

const logger = new Logger('SQLiteStorageAdapter');

class SQLiteStorageAdapter {
  constructor(options = {}) {
    this.dbPath = options.dbPath || path.join(process.cwd(), '.bumba', 'memory.db');
    this.db = null;
    this.initialized = false;
    this.instanceId = options.instanceId || `storage-${process.pid}-${Date.now()}`;

    // Initialize conflict resolver
    this.conflictResolver = new ConflictResolver({
      instanceId: this.instanceId,
      autoResolve: options.autoResolve !== false
    });
  }

  async initialize() {
    try {
      // Ensure directory exists
      const dbDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      // Open database with WAL mode for better concurrency
      this.db = new sqlite3(this.dbPath);

      // Enable WAL mode
      this.db.pragma('journal_mode = WAL');

      // Create schema
      this.createSchema();

      this.initialized = true;
      logger.info(`📦 SQLite storage initialized: ${this.dbPath}`);

      return true;
    } catch (error) {
      logger.error('Failed to initialize SQLite storage:', error);
      throw error;
    }
  }

  createSchema() {
    // Create tables in a transaction
    const transaction = this.db.transaction(() => {
      // ===== CONTEXTS TABLE =====
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS contexts (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          access_count INTEGER DEFAULT 0,
          last_accessed INTEGER NOT NULL,
          metadata TEXT,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
        )
      `);

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_contexts_timestamp
        ON contexts(timestamp DESC)
      `);

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_contexts_last_accessed
        ON contexts(last_accessed DESC)
      `);

      // ===== KNOWLEDGE TABLE =====
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS knowledge (
          key TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          confidence REAL DEFAULT 0.8,
          source TEXT DEFAULT 'unknown',
          tags TEXT,
          timestamp INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
          metadata TEXT,
          version INTEGER DEFAULT 1,
          vector_clock TEXT DEFAULT '{}',
          last_modified_by TEXT,
          conflict_resolved INTEGER DEFAULT 0
        )
      `);

      // Migration: Add version columns if they don't exist (for existing databases)
      this.migrateVersionColumns();

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_knowledge_timestamp
        ON knowledge(timestamp DESC)
      `);

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_knowledge_confidence
        ON knowledge(confidence DESC)
      `);

      // ===== FTS5 FULL-TEXT SEARCH (Sprint 1.1) =====
      // Create FTS5 virtual table for semantic search with BM25 ranking
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
          key,
          data,
          tags,
          content='knowledge',
          content_rowid='rowid'
        )
      `);

      // Triggers to keep FTS index synchronized with knowledge table
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge BEGIN
          INSERT INTO knowledge_fts(rowid, key, data, tags)
          VALUES (NEW.rowid, NEW.key, NEW.data, NEW.tags);
        END
      `);

      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge BEGIN
          INSERT INTO knowledge_fts(knowledge_fts, rowid, key, data, tags)
          VALUES('delete', OLD.rowid, OLD.key, OLD.data, OLD.tags);
        END
      `);

      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge BEGIN
          INSERT INTO knowledge_fts(knowledge_fts, rowid, key, data, tags)
          VALUES('delete', OLD.rowid, OLD.key, OLD.data, OLD.tags);
          INSERT INTO knowledge_fts(rowid, key, data, tags)
          VALUES (NEW.rowid, NEW.key, NEW.data, NEW.tags);
        END
      `);

      // Populate FTS index from existing knowledge (migration)
      this.migrateExistingToFTS();

      // ===== CONVERSATIONS TABLE =====
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          messages TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
          updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
          message_count INTEGER DEFAULT 0,
          metadata TEXT
        )
      `);

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_conversations_updated
        ON conversations(updated_at DESC)
      `);

      // ===== TASKS TABLE (for coordination) =====
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          task_id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          complexity INTEGER,
          title TEXT,
          requirements TEXT,
          constraints TEXT,
          context TEXT,
          progress TEXT,
          results TEXT,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
          updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
          created_by TEXT,
          updated_by TEXT,
          metadata TEXT
        )
      `);

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tasks_status
        ON tasks(status)
      `);

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tasks_type
        ON tasks(type)
      `);

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tasks_updated
        ON tasks(updated_at DESC)
      `);

      // ===== PEERS TABLE (Peer Discovery) =====
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS peers (
          agent_id TEXT PRIMARY KEY,
          machine TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'online',
          capabilities TEXT NOT NULL,
          endpoint TEXT,
          last_seen INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
          registered_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
          current_task TEXT,
          metadata TEXT,
          version_vector TEXT DEFAULT '{}'
        )
      `);

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_peers_machine
        ON peers(machine)
      `);

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_peers_status
        ON peers(status)
      `);

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_peers_last_seen
        ON peers(last_seen DESC)
      `);

      // ===== PEER_MESSAGES TABLE (Agent-to-Agent Messaging) =====
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS peer_messages (
          message_id TEXT PRIMARY KEY,
          source_agent_id TEXT NOT NULL,
          target_agent_id TEXT NOT NULL,
          message TEXT NOT NULL,
          message_type TEXT NOT NULL DEFAULT 'standard',
          delivered INTEGER NOT NULL DEFAULT 0,
          delivered_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
          metadata TEXT,
          FOREIGN KEY (source_agent_id) REFERENCES peers(agent_id),
          FOREIGN KEY (target_agent_id) REFERENCES peers(agent_id)
        )
      `);

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_peer_messages_target
        ON peer_messages(target_agent_id, delivered)
      `);

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_peer_messages_source
        ON peer_messages(source_agent_id)
      `);

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_peer_messages_created
        ON peer_messages(created_at DESC)
      `);

      logger.info('📋 SQLite schema created successfully');
    });

    transaction();
  }

  /**
   * Migrate existing databases to add version tracking columns (Sprint 2.1)
   * Safe to call multiple times - only adds columns that don't exist
   */
  migrateVersionColumns() {
    try {
      // Check if version column exists
      const tableInfo = this.db.prepare("PRAGMA table_info(knowledge)").all();
      const columnNames = tableInfo.map(col => col.name);

      const columnsToAdd = [
        { name: 'version', def: 'INTEGER DEFAULT 1' },
        { name: 'vector_clock', def: "TEXT DEFAULT '{}'" },
        { name: 'last_modified_by', def: 'TEXT' },
        { name: 'conflict_resolved', def: 'INTEGER DEFAULT 0' }
      ];

      for (const col of columnsToAdd) {
        if (!columnNames.includes(col.name)) {
          this.db.exec(`ALTER TABLE knowledge ADD COLUMN ${col.name} ${col.def}`);
          logger.info(`Added column ${col.name} to knowledge table`);
        }
      }
    } catch (error) {
      // Ignore errors during migration - columns may already exist
      logger.debug('Version columns migration note:', error.message);
    }
  }

  /**
   * Migrate existing knowledge entries to FTS5 index (Sprint 1.1)
   * Called during schema creation to populate FTS from existing data
   */
  migrateExistingToFTS() {
    try {
      // Check if there are entries in knowledge that aren't in FTS
      const existingCount = this.db.prepare('SELECT COUNT(*) as count FROM knowledge').get().count;
      const ftsCount = this.db.prepare('SELECT COUNT(*) as count FROM knowledge_fts').get().count;

      if (existingCount > ftsCount) {
        logger.info(`🔄 Migrating ${existingCount - ftsCount} entries to FTS5 index...`);

        // Rebuild FTS index from knowledge table
        this.db.exec(`
          INSERT INTO knowledge_fts(knowledge_fts) VALUES('rebuild')
        `);

        logger.info('✅ FTS5 index migration complete');
      }
    } catch (error) {
      // FTS rebuild might fail on first run if table is empty, which is fine
      if (!error.message.includes('no such table')) {
        logger.warn('FTS5 migration note:', error.message);
      }
    }
  }

  /**
   * Rebuild FTS5 index from scratch (Sprint 1.3)
   * Use this after bulk imports or if index becomes corrupted
   */
  rebuildFTSIndex() {
    try {
      logger.info('🔄 Rebuilding FTS5 index...');

      // Delete all FTS entries and rebuild from knowledge table
      this.db.exec(`INSERT INTO knowledge_fts(knowledge_fts) VALUES('rebuild')`);

      const count = this.db.prepare('SELECT COUNT(*) as count FROM knowledge_fts').get().count;
      logger.info(`✅ FTS5 index rebuilt with ${count} entries`);

      return { success: true, entriesIndexed: count };
    } catch (error) {
      logger.error('Failed to rebuild FTS index:', error);
      return { success: false, error: error.message };
    }
  }

  // ===== CONTEXT OPERATIONS =====

  storeContext(contextId, context) {
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO contexts (id, data, timestamp, access_count, last_accessed, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        contextId,
        JSON.stringify(context.data || context),
        context.timestamp || Date.now(),
        context.accessCount || 0,
        context.lastAccessed || Date.now(),
        JSON.stringify(context.metadata || {})
      );

      return {
        id: contextId,
        changes: result.changes
      };
    } catch (error) {
      logger.error('Failed to store context:', error);
      throw error;
    }
  }

  retrieveContext(contextId) {
    try {
      // Retrieve and increment access count
      const updateStmt = this.db.prepare(`
        UPDATE contexts
        SET access_count = access_count + 1,
            last_accessed = ?
        WHERE id = ?
      `);

      updateStmt.run(Date.now(), contextId);

      const selectStmt = this.db.prepare(`
        SELECT * FROM contexts WHERE id = ?
      `);

      const row = selectStmt.get(contextId);

      if (!row) {
        return null;
      }

      return {
        id: row.id,
        data: JSON.parse(row.data),
        timestamp: row.timestamp,
        accessCount: row.access_count,
        lastAccessed: row.last_accessed,
        metadata: JSON.parse(row.metadata || '{}')
      };
    } catch (error) {
      logger.error('Failed to retrieve context:', error);
      throw error;
    }
  }

  cleanupExpiredContexts(maxAge = 3600000) {
    try {
      const cutoff = Date.now() - maxAge;

      const stmt = this.db.prepare(`
        DELETE FROM contexts WHERE timestamp < ?
      `);

      const result = stmt.run(cutoff);

      logger.info(`🧹 Cleaned up ${result.changes} expired contexts`);
      return result.changes;
    } catch (error) {
      logger.error('Failed to cleanup contexts:', error);
      throw error;
    }
  }

  // ===== KNOWLEDGE OPERATIONS =====

  /**
   * Store knowledge with version tracking and conflict detection (Sprint 2.3)
   * @param {string} key - Unique key for the knowledge entry
   * @param {Object} knowledge - Knowledge data to store
   * @param {Object} options - Storage options
   * @param {boolean} options.skipConflictCheck - Skip conflict detection (default: false)
   * @returns {Object} - Result with key, changes, and optional conflict resolution info
   */
  storeKnowledge(key, knowledge, options = {}) {
    try {
      // Get existing entry to check for conflicts
      const existing = this.retrieveKnowledgeRaw(key);

      // Prepare new entry
      const newData = knowledge.data || knowledge;
      const newSource = knowledge.source || knowledge.agentId || 'unknown';
      const now = Date.now();

      // Handle version vector
      let vectorClock;
      let version = 1;

      if (existing) {
        // Check for conflict if not skipped
        if (!options.skipConflictCheck) {
          const incomingEntry = {
            data: newData,
            timestamp: now,
            vectorClock: knowledge.vectorClock || {},
            source: newSource
          };

          const conflict = this.conflictResolver.detectConflict(key, existing, incomingEntry);

          if (conflict) {
            // Resolve conflict
            const resolution = this.conflictResolver.resolveConflict(conflict);

            if (resolution.status === ConflictStatus.RESOLVED) {
              // Use resolved data
              const resolvedData = resolution.resolved;
              version = (existing.version || 0) + 1;

              // Merge vector clocks and increment
              const existingVector = VersionVector.fromJSON(existing.vectorClock);
              const incomingVector = VersionVector.fromJSON(knowledge.vectorClock || {});
              vectorClock = existingVector.merge(incomingVector).increment(this.instanceId);

              return this.storeKnowledgeInternal(key, resolvedData, {
                confidence: knowledge.confidence,
                source: newSource,
                tags: knowledge.tags,
                metadata: knowledge.metadata,
                version,
                vectorClock: vectorClock.toJSON(),
                conflictResolved: 1
              });
            }
          }
        }

        // No conflict - normal update
        version = (existing.version || 0) + 1;
        vectorClock = VersionVector.fromJSON(existing.vectorClock).increment(this.instanceId);
      } else {
        // New entry
        vectorClock = VersionVector.create(this.instanceId);
      }

      return this.storeKnowledgeInternal(key, newData, {
        confidence: knowledge.confidence,
        source: newSource,
        tags: knowledge.tags,
        metadata: knowledge.metadata,
        version,
        vectorClock: vectorClock.toJSON(),
        conflictResolved: 0
      });
    } catch (error) {
      logger.error('Failed to store knowledge:', error);
      throw error;
    }
  }

  /**
   * Internal method to store knowledge (no conflict checking)
   */
  storeKnowledgeInternal(key, data, options = {}) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO knowledge (
        key, data, confidence, source, tags, metadata,
        version, vector_clock, last_modified_by, conflict_resolved
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      key,
      JSON.stringify(data),
      options.confidence || 0.8,
      options.source || 'unknown',
      JSON.stringify(options.tags || []),
      JSON.stringify(options.metadata || {}),
      options.version || 1,
      JSON.stringify(options.vectorClock || {}),
      this.instanceId,
      options.conflictResolved || 0
    );

    return {
      key,
      changes: result.changes,
      version: options.version,
      vectorClock: options.vectorClock,
      conflictResolved: options.conflictResolved === 1
    };
  }

  /**
   * Retrieve raw knowledge entry with version info (for internal use)
   */
  retrieveKnowledgeRaw(key) {
    try {
      const stmt = this.db.prepare(`SELECT * FROM knowledge WHERE key = ?`);
      const row = stmt.get(key);

      if (!row) {
        return null;
      }

      return {
        key: row.key,
        data: JSON.parse(row.data),
        confidence: row.confidence,
        source: row.source,
        tags: JSON.parse(row.tags || '[]'),
        timestamp: row.timestamp,
        metadata: JSON.parse(row.metadata || '{}'),
        version: row.version || 1,
        vectorClock: JSON.parse(row.vector_clock || '{}'),
        lastModifiedBy: row.last_modified_by,
        conflictResolved: row.conflict_resolved === 1
      };
    } catch (error) {
      logger.error('Failed to retrieve knowledge raw:', error);
      return null;
    }
  }

  retrieveKnowledge(key) {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM knowledge WHERE key = ?
      `);

      const row = stmt.get(key);

      if (!row) {
        return null;
      }

      return {
        key: row.key,
        data: JSON.parse(row.data),
        confidence: row.confidence,
        source: row.source,
        tags: JSON.parse(row.tags || '[]'),
        timestamp: row.timestamp,
        metadata: JSON.parse(row.metadata || '{}'),
        version: row.version || 1,
        vectorClock: JSON.parse(row.vector_clock || '{}'),
        lastModifiedBy: row.last_modified_by
      };
    } catch (error) {
      logger.error('Failed to retrieve knowledge:', error);
      throw error;
    }
  }

  /**
   * Get conflict resolver statistics and recent conflicts
   */
  getConflictStats() {
    return {
      statistics: this.conflictResolver.getStatistics(),
      recentConflicts: this.conflictResolver.getRecentConflicts(10),
      pendingConflicts: this.conflictResolver.getPendingConflicts()
    };
  }

  /**
   * List all conflicts
   */
  listConflicts(options = {}) {
    const { limit = 20, status } = options;
    let conflicts = this.conflictResolver.conflicts;

    if (status) {
      conflicts = conflicts.filter(c => c.status === status);
    }

    return conflicts.slice(-limit).reverse();
  }

  /**
   * Manually resolve a conflict
   */
  async resolveConflictManually(conflictId, resolution, resolvedBy) {
    return this.conflictResolver.manualResolve(conflictId, resolution, resolvedBy);
  }

  /**
   * Set merge strategy for a key pattern
   */
  setMergeStrategy(pattern, strategy) {
    this.conflictResolver.setStrategy(pattern, strategy);
  }

  /**
   * Search knowledge using FTS5 full-text search with BM25 ranking (Sprint 1.2)
   * Supports phrase search, boolean operators, prefix matching, and column-specific search
   *
   * Query syntax:
   *   - Simple: "authentication" - searches all indexed columns
   *   - Phrase: '"exact phrase"' - matches exact phrase
   *   - Boolean: "term1 AND term2", "term1 OR term2", "NOT term"
   *   - Prefix: "auth*" - matches words starting with "auth"
   *   - Column: "key:auth" - searches only in key column
   *
   * @param {string} query - FTS5 query string
   * @param {object} options - Search options
   * @param {string[]} options.tags - Filter by tags
   * @param {number} options.minConfidence - Minimum confidence threshold
   * @param {number} options.limit - Maximum results (default 10)
   * @param {string} options.searchMode - 'fts' (default) or 'simple' (LIKE fallback)
   * @returns {Array} Search results with BM25 relevance scores
   */
  searchKnowledgeFTS(query, options = {}) {
    try {
      const { tags = [], minConfidence = 0, limit = 10 } = options;

      // Sanitize query for FTS5 (escape special characters if needed)
      const sanitizedQuery = this.sanitizeFTSQuery(query);

      // FTS5 MATCH query with BM25 ranking
      // BM25 returns negative values where more negative = better match
      let sql = `
        SELECT k.*, bm25(knowledge_fts, 1.0, 0.75, 0.5) as rank
        FROM knowledge k
        JOIN knowledge_fts fts ON k.rowid = fts.rowid
        WHERE knowledge_fts MATCH ?
      `;
      const params = [sanitizedQuery];

      // Tag filtering (applied after FTS match)
      if (tags.length > 0) {
        tags.forEach(tag => {
          sql += ` AND k.tags LIKE ?`;
          params.push(`%"${tag}"%`);
        });
      }

      // Confidence filtering
      if (minConfidence > 0) {
        sql += ` AND k.confidence >= ?`;
        params.push(minConfidence);
      }

      // Order by BM25 rank (lower/more negative = better match), then confidence
      sql += ` ORDER BY rank ASC, k.confidence DESC LIMIT ?`;
      params.push(limit);

      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...params);

      // Convert BM25 rank to positive relevance score (0-1 range)
      const maxRank = rows.length > 0 ? Math.abs(rows[0].rank) : 1;

      return rows.map(row => ({
        key: row.key,
        knowledge: {
          data: JSON.parse(row.data),
          confidence: row.confidence,
          source: row.source,
          tags: JSON.parse(row.tags || '[]'),
          timestamp: row.timestamp
        },
        relevanceScore: Math.abs(row.rank) / maxRank, // Normalized 0-1 score
        bm25Rank: row.rank // Raw BM25 score for debugging
      }));
    } catch (error) {
      // If FTS fails (e.g., syntax error), fall back to simple search
      logger.warn('FTS5 search failed, falling back to LIKE search:', error.message);
      return this.searchKnowledgeSimple(query, options);
    }
  }

  /**
   * Sanitize query for FTS5 (handles common edge cases)
   */
  sanitizeFTSQuery(query) {
    if (!query || typeof query !== 'string') {
      return '*'; // Match all if no query
    }

    // Trim and handle empty
    let sanitized = query.trim();
    if (!sanitized) {
      return '*';
    }

    // If query contains FTS5 operators, use as-is (user knows what they're doing)
    if (/\b(AND|OR|NOT|NEAR)\b/.test(sanitized) || sanitized.includes('"') || sanitized.includes('*')) {
      return sanitized;
    }

    // For simple queries, wrap each word to search across all columns
    // This makes "auth user" search for entries containing both words
    const words = sanitized.split(/\s+/).filter(w => w.length > 0);
    if (words.length > 1) {
      return words.join(' AND ');
    }

    return sanitized;
  }

  /**
   * Simple LIKE-based search (fallback when FTS5 unavailable or fails)
   */
  searchKnowledgeSimple(query, options = {}) {
    try {
      const tags = options.tags || [];
      const minConfidence = options.minConfidence || 0;

      let sql = 'SELECT * FROM knowledge WHERE 1=1';
      const params = [];

      // Text search in key and data
      if (query) {
        sql += ` AND (key LIKE ? OR data LIKE ?)`;
        const queryPattern = `%${query}%`;
        params.push(queryPattern, queryPattern);
      }

      // Tag filtering
      if (tags.length > 0) {
        tags.forEach(tag => {
          sql += ` AND tags LIKE ?`;
          params.push(`%"${tag}"%`);
        });
      }

      // Confidence filtering
      if (minConfidence > 0) {
        sql += ` AND confidence >= ?`;
        params.push(minConfidence);
      }

      sql += ` ORDER BY confidence DESC, timestamp DESC LIMIT ?`;
      params.push(options.limit || 10);

      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...params);

      return rows.map(row => ({
        key: row.key,
        knowledge: {
          data: JSON.parse(row.data),
          confidence: row.confidence,
          source: row.source,
          tags: JSON.parse(row.tags || '[]'),
          timestamp: row.timestamp
        },
        relevanceScore: row.confidence // Use confidence as relevance for simple search
      }));
    } catch (error) {
      logger.error('Failed to search knowledge:', error);
      throw error;
    }
  }

  /**
   * Main search method - uses FTS5 by default, with LIKE fallback
   */
  searchKnowledge(query, options = {}) {
    const searchMode = options.searchMode || 'fts';

    if (searchMode === 'simple') {
      return this.searchKnowledgeSimple(query, options);
    }

    // Default to FTS5 search
    return this.searchKnowledgeFTS(query, options);
  }

  // ===== CONVERSATION OPERATIONS =====

  storeConversation(conversationId, messages) {
    try {
      const messagesArray = Array.isArray(messages) ? messages : [messages];

      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO conversations (id, messages, message_count, updated_at)
        VALUES (?, ?, ?, ?)
      `);

      const result = stmt.run(
        conversationId,
        JSON.stringify(messagesArray),
        messagesArray.length,
        Date.now()
      );

      return {
        id: conversationId,
        messageCount: messagesArray.length,
        changes: result.changes
      };
    } catch (error) {
      logger.error('Failed to store conversation:', error);
      throw error;
    }
  }

  retrieveConversation(conversationId) {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM conversations WHERE id = ?
      `);

      const row = stmt.get(conversationId);

      if (!row) {
        return null;
      }

      return {
        id: row.id,
        messages: JSON.parse(row.messages),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        messageCount: row.message_count
      };
    } catch (error) {
      logger.error('Failed to retrieve conversation:', error);
      throw error;
    }
  }

  // ===== TASK OPERATIONS (for Claude ↔ BUMBA coordination) =====

  storeTask(taskId, task) {
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO tasks (
          task_id, type, status, complexity, title, requirements,
          constraints, context, created_by, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        taskId,
        task.type,
        task.status || 'pending',
        task.complexity,
        task.title,
        JSON.stringify(task.requirements || []),
        JSON.stringify(task.constraints || []),
        JSON.stringify(task.context || {}),
        task.createdBy || 'unknown',
        JSON.stringify(task.metadata || {})
      );

      return {
        taskId,
        changes: result.changes
      };
    } catch (error) {
      logger.error('Failed to store task:', error);
      throw error;
    }
  }

  updateTaskProgress(taskId, updates) {
    try {
      const stmt = this.db.prepare(`
        UPDATE tasks
        SET status = COALESCE(?, status),
            progress = COALESCE(?, progress),
            results = COALESCE(?, results),
            updated_at = ?,
            updated_by = COALESCE(?, updated_by)
        WHERE task_id = ?
      `);

      const result = stmt.run(
        updates.status,
        JSON.stringify(updates.progress),
        JSON.stringify(updates.results),
        Date.now(),
        updates.updatedBy,
        taskId
      );

      return {
        taskId,
        changes: result.changes
      };
    } catch (error) {
      logger.error('Failed to update task progress:', error);
      throw error;
    }
  }

  getTaskStatus(taskId) {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM tasks WHERE task_id = ?
      `);

      const row = stmt.get(taskId);

      if (!row) {
        return null;
      }

      return {
        taskId: row.task_id,
        type: row.type,
        status: row.status,
        complexity: row.complexity,
        title: row.title,
        requirements: JSON.parse(row.requirements || '[]'),
        constraints: JSON.parse(row.constraints || '[]'),
        context: JSON.parse(row.context || '{}'),
        progress: JSON.parse(row.progress || 'null'),
        results: JSON.parse(row.results || 'null'),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        createdBy: row.created_by,
        updatedBy: row.updated_by
      };
    } catch (error) {
      logger.error('Failed to get task status:', error);
      throw error;
    }
  }

  listTasks(options = {}) {
    try {
      let sql = 'SELECT * FROM tasks WHERE 1=1';
      const params = [];

      // Filter by status
      if (options.status && options.status !== 'all') {
        sql += ` AND status = ?`;
        params.push(options.status);
      }

      // Filter by type
      if (options.type && options.type !== 'all') {
        sql += ` AND type = ?`;
        params.push(options.type);
      }

      // Sort - whitelist columns and direction to prevent SQL injection.
      // Tasks table columns that are sensible to sort by:
      const allowedSortColumns = new Set([
        'task_id',
        'type',
        'status',
        'complexity',
        'created_at',
        'updated_at'
      ]);
      const requestedSortBy = options.sortBy || 'updated_at';
      let sortBy;
      if (allowedSortColumns.has(requestedSortBy)) {
        sortBy = requestedSortBy;
      } else {
        sortBy = 'updated_at';
        logger.debug(
          `listTasks: invalid sortBy "${requestedSortBy}", falling back to updated_at`
        );
      }

      const requestedSortOrder = String(options.sortOrder || 'DESC').toUpperCase();
      const sortOrder =
        requestedSortOrder === 'ASC' || requestedSortOrder === 'DESC'
          ? requestedSortOrder
          : 'DESC';
      if (sortOrder !== requestedSortOrder && options.sortOrder !== undefined) {
        logger.debug(
          `listTasks: invalid sortOrder "${options.sortOrder}", falling back to DESC`
        );
      }

      sql += ` ORDER BY ${sortBy} ${sortOrder}`;

      // Pagination
      const limit = options.limit || 20;
      const offset = options.offset || 0;
      sql += ` LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...params);

      return rows.map(row => ({
        taskId: row.task_id,
        type: row.type,
        status: row.status,
        complexity: row.complexity,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }));
    } catch (error) {
      logger.error('Failed to list tasks:', error);
      throw error;
    }
  }

  // ===== UTILITY METHODS =====

  beginTransaction() {
    return this.db.transaction((callback) => callback());
  }

  vacuum() {
    this.db.exec('VACUUM');
    logger.info('🧹 Database vacuumed');
  }

  getStats() {
    try {
      const stats = {
        contexts: this.db.prepare('SELECT COUNT(*) as count FROM contexts').get().count,
        knowledge: this.db.prepare('SELECT COUNT(*) as count FROM knowledge').get().count,
        conversations: this.db.prepare('SELECT COUNT(*) as count FROM conversations').get().count,
        tasks: this.db.prepare('SELECT COUNT(*) as count FROM tasks').get().count,
        dbSize: fs.statSync(this.dbPath).size
      };

      return stats;
    } catch (error) {
      logger.error('Failed to get stats:', error);
      return {};
    }
  }

  close() {
    if (this.db) {
      this.db.close();
      this.initialized = false;
      logger.info('📦 SQLite storage closed');
    }
  }

  // ============================================
  // Generic CRUD Interface (for MCP compatibility)
  // ============================================

  /**
   * Store a generic memory entry (wrapper for storeKnowledge)
   */
  async store(key, data, options = {}) {
    return this.storeKnowledge(key, {
      data,
      tags: options.tags || [],
      confidence: options.confidence || 1.0,
      source: options.agentId || 'unknown',
      ttl: options.ttl
    });
  }

  /**
   * Retrieve a generic memory entry (wrapper for retrieveKnowledge)
   */
  async retrieve(key) {
    return this.retrieveKnowledge(key);
  }

  /**
   * Search memories (wrapper for searchKnowledge)
   */
  async search(query, tags = []) {
    const results = this.searchKnowledge(query, { tags, limit: 100 });
    return results;
  }

  /**
   * List recent memory entries
   */
  async list(options = {}) {
    const { limit = 20, offset = 0, agentId } = options;

    try {
      let sql = 'SELECT key, data, tags, confidence, source, timestamp, metadata FROM knowledge';
      const params = [];

      if (agentId) {
        sql += ' WHERE source = ?';
        params.push(agentId);
      }

      sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const rows = this.db.prepare(sql).all(...params);

      return rows.map(row => ({
        key: row.key,
        data: JSON.parse(row.data),
        tags: row.tags ? JSON.parse(row.tags) : [],
        confidence: row.confidence,
        source: row.source,
        timestamp: row.timestamp,
        metadata: row.metadata ? JSON.parse(row.metadata) : {}
      }));
    } catch (error) {
      logger.error('Failed to list memories:', error);
      return [];
    }
  }

  /**
   * Delete a memory entry
   */
  async delete(key) {
    try {
      const stmt = this.db.prepare('DELETE FROM knowledge WHERE key = ?');
      stmt.run(key);
      return true;
    } catch (error) {
      logger.error('Failed to delete memory:', error);
      return false;
    }
  }
}

module.exports = { SQLiteStorageAdapter };
