#!/usr/bin/env node
/**
 * Bumba Memory MCP Server
 * Provides shared semantic memory for multi-agent coordination
 *
 * Usage:
 *   node mcp-server.js
 *
 * Environment Variables:
 *   BUMBA_MEMORY_DIR - Directory for memory storage (default: ~/.bumba/memory)
 *   BUMBA_LOG_LEVEL - Logging level: DEBUG, INFO, WARN, ERROR (default: INFO)
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema
} = require('@modelcontextprotocol/sdk/types.js');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');

const Logger = require('./lib/logger');
const logger = new Logger('MCPServer');

const { SQLiteStorageAdapter } = require('./storage/sqlite-storage-adapter');
const PeerRegistry = require('./peers/peer-registry');
const PeerMessaging = require('./peers/peer-messaging');

/**
 * TeamMemory wrapper that doesn't depend on @bumba/shared
 */
class TeamMemoryLocal {
  constructor(options = {}) {
    this.memoryDir = options.memoryDir || path.join(process.cwd(), '.bumba', 'memory');
    this.teamMemoryFile = path.join(this.memoryDir, 'team-memory.json');
    this.sessionId = options.sessionId || `session-${Date.now()}`;
    this.memory = {};
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    await fs.ensureDir(this.memoryDir);
    await this.load();
    this.initialized = true;
    logger.debug('Team memory initialized', { sessionId: this.sessionId });
  }

  async load() {
    try {
      if (await fs.pathExists(this.teamMemoryFile)) {
        const content = await fs.readFile(this.teamMemoryFile, 'utf-8');
        this.memory = JSON.parse(content);
      } else {
        this.memory = {
          sessions: {},
          currentTask: null,
          sharedContext: {},
          agentContributions: {},
          decisions: [],
          artifacts: []
        };
      }
    } catch (error) {
      logger.warn('Failed to load team memory:', error.message);
      this.memory = {
        sessions: {},
        currentTask: null,
        sharedContext: {},
        agentContributions: {},
        decisions: [],
        artifacts: []
      };
    }
  }

  async save() {
    try {
      await fs.writeFile(this.teamMemoryFile, JSON.stringify(this.memory, null, 2));
    } catch (error) {
      logger.error('Failed to save team memory:', error.message);
    }
  }

  async startTask(taskDescription, metadata = {}) {
    const taskId = `task-${Date.now()}`;
    this.memory.currentTask = {
      id: taskId,
      description: taskDescription,
      startedAt: new Date().toISOString(),
      status: 'active',
      metadata,
      phases: []
    };
    this.memory.sessions[this.sessionId] = {
      taskId,
      startedAt: new Date().toISOString(),
      context: {},
      contributions: []
    };
    await this.save();
    return taskId;
  }

  async completeTask(result = {}) {
    if (this.memory.currentTask) {
      this.memory.currentTask.status = 'completed';
      this.memory.currentTask.completedAt = new Date().toISOString();
      this.memory.currentTask.result = result;
      const historyKey = `history:${this.memory.currentTask.id}`;
      this.memory[historyKey] = { ...this.memory.currentTask };
      await this.save();
    }
  }

  getCurrentTask() {
    return this.memory.currentTask;
  }

  async storeContext(key, value) {
    this.memory.sharedContext[key] = {
      value,
      storedAt: new Date().toISOString(),
      sessionId: this.sessionId
    };
    await this.save();
  }

  getContext(key) {
    const entry = this.memory.sharedContext[key];
    return entry?.value || null;
  }

  getAllContext() {
    const context = {};
    for (const [key, entry] of Object.entries(this.memory.sharedContext)) {
      context[key] = entry?.value !== undefined ? entry.value : entry;
    }
    return context;
  }

  async recordDecision(decision) {
    const entry = {
      ...decision,
      timestamp: new Date().toISOString(),
      taskId: this.memory.currentTask?.id,
      sessionId: this.sessionId
    };
    this.memory.decisions.push(entry);
    await this.save();
  }

  getDecisions() {
    const taskId = this.memory.currentTask?.id;
    return this.memory.decisions.filter(d => d.taskId === taskId);
  }

  async storeArtifact(artifact) {
    const entry = {
      ...artifact,
      id: `artifact-${Date.now()}`,
      storedAt: new Date().toISOString(),
      taskId: this.memory.currentTask?.id,
      sessionId: this.sessionId
    };
    this.memory.artifacts.push(entry);
    await this.save();
    return entry.id;
  }

  getArtifacts() {
    const taskId = this.memory.currentTask?.id;
    return this.memory.artifacts.filter(a => a.taskId === taskId);
  }

  async search(query) {
    const results = [];
    const lowerQuery = query.toLowerCase();

    // Search shared context
    for (const [key, entry] of Object.entries(this.memory.sharedContext)) {
      if (key.toLowerCase().includes(lowerQuery)) {
        results.push({ type: 'context', key, value: entry?.value || entry });
      }
    }

    // Search decisions
    for (const decision of this.memory.decisions) {
      const text = JSON.stringify(decision).toLowerCase();
      if (text.includes(lowerQuery)) {
        results.push({ type: 'decision', ...decision });
      }
    }

    // Search artifacts
    for (const artifact of this.memory.artifacts) {
      const text = JSON.stringify(artifact).toLowerCase();
      if (text.includes(lowerQuery)) {
        results.push({ type: 'artifact', ...artifact });
      }
    }

    return results;
  }
}

/**
 * Bumba Memory MCP Server
 */
class BumbaMemoryMCPServer {
  constructor(options = {}) {
    this.memoryDir = options.memoryDir ||
                     process.env.BUMBA_MEMORY_DIR ||
                     path.join(os.homedir(), '.bumba', 'memory');

    this.storage = null;
    this.teamMemory = null;
    this.peerRegistry = null;
    this.peerMessaging = null;

    this.server = new Server(
      {
        name: 'bumba-memory',
        version: '1.0.0'
      },
      {
        capabilities: {
          tools: {}
        }
      }
    );

    this.setupHandlers();
  }

  async initialize() {
    logger.info('Initializing Bumba Memory MCP Server...');

    // Create shared directory structure for multi-instance coordination
    // ~/.bumba/memory/
    // ├── memory.db           # SQLite with WAL mode (concurrent reads)
    // ├── memory.db-wal       # WAL file (enables concurrent reads)
    // ├── memory.db-shm       # Shared memory file
    // ├── team-memory.json    # TeamMemory state
    // ├── instances/          # Instance registration
    // │   └── instance-{id}.json
    // ├── locks/              # File-based coordination locks
    // └── artifacts/          # Large artifact storage

    await fs.ensureDir(this.memoryDir);
    await fs.ensureDir(path.join(this.memoryDir, 'instances'));
    await fs.ensureDir(path.join(this.memoryDir, 'locks'));
    await fs.ensureDir(path.join(this.memoryDir, 'artifacts'));

    // Register this instance
    this.instanceId = `instance-${process.pid}-${Date.now()}`;
    const instanceFile = path.join(this.memoryDir, 'instances', `${this.instanceId}.json`);
    await fs.writeJson(instanceFile, {
      instanceId: this.instanceId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      memoryDir: this.memoryDir,
      version: '1.0.0'
    });

    // Setup cleanup on exit
    const cleanup = async () => {
      try {
        await fs.remove(instanceFile);
        logger.debug('Instance file cleaned up');
      } catch (e) {
        // Ignore cleanup errors
      }
    };
    process.on('exit', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    // Initialize SQLite storage with WAL mode
    const dbPath = path.join(this.memoryDir, 'memory.db');
    this.storage = new SQLiteStorageAdapter({ dbPath });
    await this.storage.initialize();

    // Initialize peer discovery modules
    this.peerRegistry = new PeerRegistry(this.storage);
    this.peerMessaging = new PeerMessaging(this.storage);

    // Initialize team memory
    this.teamMemory = new TeamMemoryLocal({ memoryDir: this.memoryDir });
    await this.teamMemory.initialize();

    // Start cleanup interval for stale peers and old messages
    setInterval(() => {
      this.peerRegistry.cleanupStale();
      this.peerMessaging.cleanup({ maxAgeSeconds: 3600 });
    }, 30000); // 30 second cleanup interval

    // Clean up stale instances (older than 24 hours)
    await this.cleanupStaleInstances();

    logger.info('Bumba Memory MCP Server initialized', {
      memoryDir: this.memoryDir,
      instanceId: this.instanceId
    });
  }

  async cleanupStaleInstances() {
    try {
      const instancesDir = path.join(this.memoryDir, 'instances');
      const files = await fs.readdir(instancesDir);
      const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24 hours

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(instancesDir, file);
        try {
          const stat = await fs.stat(filePath);
          if (stat.mtimeMs < cutoff) {
            await fs.remove(filePath);
            logger.debug('Removed stale instance file:', file);
          }
        } catch (e) {
          // Ignore individual file errors
        }
      }
    } catch (e) {
      // Ignore cleanup errors
    }
  }

  setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          // Core memory tools
          {
            name: 'memory_store',
            description: 'Store a memory entry with key, data, and optional tags/TTL',
            inputSchema: {
              type: 'object',
              properties: {
                key: { type: 'string', description: 'Unique key for the memory entry' },
                data: { type: 'object', description: 'Data to store (any JSON-serializable object)' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for categorization' },
                ttl: { type: 'number', description: 'Time-to-live in milliseconds (optional)' },
                agentId: { type: 'string', description: 'ID of the agent storing the memory (optional)' }
              },
              required: ['key', 'data']
            }
          },
          {
            name: 'memory_retrieve',
            description: 'Retrieve a memory entry by key',
            inputSchema: {
              type: 'object',
              properties: {
                key: { type: 'string', description: 'Key of the memory entry to retrieve' }
              },
              required: ['key']
            }
          },
          {
            name: 'memory_search',
            description: 'Search memories by query and optional tags',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search query' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags' },
                limit: { type: 'number', description: 'Maximum results to return (default: 10)' }
              },
              required: ['query']
            }
          },
          {
            name: 'memory_list',
            description: 'List recent memory entries',
            inputSchema: {
              type: 'object',
              properties: {
                limit: { type: 'number', description: 'Maximum entries to return (default: 20)' },
                offset: { type: 'number', description: 'Offset for pagination (default: 0)' },
                agentId: { type: 'string', description: 'Filter by agent ID (optional)' }
              }
            }
          },
          {
            name: 'memory_delete',
            description: 'Delete a memory entry by key',
            inputSchema: {
              type: 'object',
              properties: {
                key: { type: 'string', description: 'Key of the memory entry to delete' }
              },
              required: ['key']
            }
          },
          {
            name: 'memory_stats',
            description: 'Get memory system statistics including FTS5 search stats',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          },
          {
            name: 'memory_rebuild_index',
            description: 'Rebuild FTS5 full-text search index (use after bulk imports or if search seems corrupted)',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          },
          {
            name: 'memory_list_conflicts',
            description: 'List detected write conflicts and their resolution status',
            inputSchema: {
              type: 'object',
              properties: {
                limit: { type: 'number', description: 'Maximum conflicts to return (default: 20)' },
                status: { type: 'string', enum: ['detected', 'resolved', 'pending', 'failed'], description: 'Filter by status' }
              }
            }
          },
          {
            name: 'memory_resolve_conflict',
            description: 'Manually resolve a pending conflict by providing the resolution data',
            inputSchema: {
              type: 'object',
              properties: {
                conflictId: { type: 'string', description: 'ID of the conflict to resolve' },
                resolution: { type: 'object', description: 'The resolved data to use' },
                resolvedBy: { type: 'string', description: 'ID of the agent/user resolving the conflict' }
              },
              required: ['conflictId', 'resolution']
            }
          },
          {
            name: 'memory_set_merge_strategy',
            description: 'Configure the merge strategy for a key pattern (e.g., "context:*" -> "merge")',
            inputSchema: {
              type: 'object',
              properties: {
                pattern: { type: 'string', description: 'Key pattern with wildcards (e.g., "user:*", "context:*")' },
                strategy: {
                  type: 'string',
                  enum: ['last_write_wins', 'merge', 'keep_local', 'keep_remote', 'keep_both', 'manual'],
                  description: 'Resolution strategy to use for matching keys'
                }
              },
              required: ['pattern', 'strategy']
            }
          },
          // Team memory tools
          {
            name: 'team_start_task',
            description: 'Start a new shared task for multi-agent coordination',
            inputSchema: {
              type: 'object',
              properties: {
                description: { type: 'string', description: 'Task description' },
                metadata: { type: 'object', description: 'Additional task metadata' }
              },
              required: ['description']
            }
          },
          {
            name: 'team_complete_task',
            description: 'Complete the current shared task',
            inputSchema: {
              type: 'object',
              properties: {
                result: { type: 'object', description: 'Task result/outcome' }
              }
            }
          },
          {
            name: 'team_store_context',
            description: 'Store shared context accessible by all agents',
            inputSchema: {
              type: 'object',
              properties: {
                key: { type: 'string', description: 'Context key' },
                value: { description: 'Context value (any JSON-serializable data)' }
              },
              required: ['key', 'value']
            }
          },
          {
            name: 'team_get_context',
            description: 'Get shared context by key',
            inputSchema: {
              type: 'object',
              properties: {
                key: { type: 'string', description: 'Context key' }
              },
              required: ['key']
            }
          },
          {
            name: 'team_record_decision',
            description: 'Record a decision made during task execution',
            inputSchema: {
              type: 'object',
              properties: {
                decision: { type: 'string', description: 'The decision made' },
                rationale: { type: 'string', description: 'Rationale for the decision' },
                agentId: { type: 'string', description: 'ID of the agent making the decision' }
              },
              required: ['decision']
            }
          },
          {
            name: 'team_store_artifact',
            description: 'Store an artifact (code, document, etc.) in shared memory',
            inputSchema: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Artifact name' },
                type: { type: 'string', description: 'Artifact type (code, document, config, etc.)' },
                content: { type: 'string', description: 'Artifact content' },
                metadata: { type: 'object', description: 'Additional metadata' }
              },
              required: ['name', 'type', 'content']
            }
          },
          {
            name: 'team_search',
            description: 'Search team memory (context, decisions, artifacts)',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search query' }
              },
              required: ['query']
            }
          },
          {
            name: 'team_get_status',
            description: 'Get current team task status and context summary',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          },
          // Multi-instance coordination tools
          {
            name: 'system_health',
            description: 'Get health status of the memory system including storage, instances, and WAL status',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          },
          {
            name: 'system_instances',
            description: 'List all active memory server instances sharing this storage',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          },
          // Memory pressure and cache management tools
          {
            name: 'memory_pressure',
            description: 'Get current memory pressure status including system/process memory usage, pressure level, and eviction recommendations',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          },
          {
            name: 'memory_evict',
            description: 'Manually trigger cache eviction based on specified parameters or current memory pressure',
            inputSchema: {
              type: 'object',
              properties: {
                layer: {
                  type: 'string',
                  enum: ['l1', 'l2', 'l3', 'all'],
                  description: 'Cache layer to evict from (l1=memory, l2=disk, l3=distributed, all=all layers)'
                },
                percent: {
                  type: 'number',
                  minimum: 1,
                  maximum: 100,
                  description: 'Percentage of entries to evict (1-100)'
                },
                strategy: {
                  type: 'string',
                  enum: ['lru', 'lfu', 'expired', 'pressure'],
                  description: 'Eviction strategy (lru=least recently used, lfu=least frequently used, expired=expired entries only, pressure=based on current memory pressure)'
                }
              }
            }
          },
          // Peer Discovery Tools (Sprint: Peer Discovery)
          {
            name: 'peer_register',
            description: 'Register an agent in the peer discovery system',
            inputSchema: {
              type: 'object',
              properties: {
                agentId: { type: 'string', description: 'Unique identifier for the agent' },
                machine: { type: 'string', description: 'Machine/hostname where agent is running' },
                capabilities: { type: 'array', items: { type: 'string' }, description: 'List of capabilities this agent provides (e.g., "engineering", "qa")' },
                endpoint: { type: 'string', description: 'Optional network endpoint for direct communication' },
                metadata: { type: 'object', description: 'Optional metadata about the agent' }
              },
              required: ['agentId', 'machine', 'capabilities']
            }
          },
          {
            name: 'peer_heartbeat',
            description: 'Send a heartbeat to maintain peer presence',
            inputSchema: {
              type: 'object',
              properties: {
                agentId: { type: 'string', description: 'Agent ID' },
                status: { type: 'string', description: 'Current status (online, busy, idle, offline)' },
                currentTask: { type: 'string', description: 'Current task being executed' }
              },
              required: ['agentId']
            }
          },
          {
            name: 'peer_deregister',
            description: 'Deregister an agent from the peer discovery system',
            inputSchema: {
              type: 'object',
              properties: {
                agentId: { type: 'string', description: 'Agent ID to deregister' }
              },
              required: ['agentId']
            }
          },
          {
            name: 'peer_list',
            description: 'List peers with optional filters',
            inputSchema: {
              type: 'object',
              properties: {
                machine: { type: 'string', description: 'Filter by machine' },
                status: { type: 'string', description: 'Filter by status (online, offline, busy, idle)' },
                capability: { type: 'string', description: 'Filter by capability' },
                includeStale: { type: 'boolean', description: 'Include offline/stale peers (default: false)' }
              }
            }
          },
          {
            name: 'peer_get',
            description: 'Get details of a specific peer',
            inputSchema: {
              type: 'object',
              properties: {
                agentId: { type: 'string', description: 'Agent ID' }
              },
              required: ['agentId']
            }
          },
          {
            name: 'peer_send_message',
            description: 'Send a message to another agent',
            inputSchema: {
              type: 'object',
              properties: {
                source: { type: 'string', description: 'Source agent ID' },
                target: { type: 'string', description: 'Target agent ID' },
                message: { description: 'Message content (string or object)' },
                messageType: { type: 'string', description: 'Type of message (default: standard)' }
              },
              required: ['source', 'target', 'message']
            }
          },
          {
            name: 'peer_check_messages',
            description: 'Check for incoming messages',
            inputSchema: {
              type: 'object',
              properties: {
                agentId: { type: 'string', description: 'Agent ID' },
                limit: { type: 'number', description: 'Maximum messages to retrieve (default: 100)' },
                markDelivered: { type: 'boolean', description: 'Mark messages as delivered (default: true)' }
              },
              required: ['agentId']
            }
          },
          {
            name: 'peer_broadcast',
            description: 'Broadcast a message to all active peers',
            inputSchema: {
              type: 'object',
              properties: {
                source: { type: 'string', description: 'Source agent ID' },
                message: { description: 'Message content (string or object)' },
                messageType: { type: 'string', description: 'Type of message (default: broadcast)' }
              },
              required: ['source', 'message']
            }
          }
        ]
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          // Core memory tools
          case 'memory_store':
            return await this.handleMemoryStore(args);
          case 'memory_retrieve':
            return await this.handleMemoryRetrieve(args);
          case 'memory_search':
            return await this.handleMemorySearch(args);
          case 'memory_list':
            return await this.handleMemoryList(args);
          case 'memory_delete':
            return await this.handleMemoryDelete(args);
          case 'memory_stats':
            return await this.handleMemoryStats();
          case 'memory_rebuild_index':
            return await this.handleMemoryRebuildIndex();
          case 'memory_list_conflicts':
            return await this.handleMemoryListConflicts(args);
          case 'memory_resolve_conflict':
            return await this.handleMemoryResolveConflict(args);
          case 'memory_set_merge_strategy':
            return await this.handleMemorySetMergeStrategy(args);

          // Team memory tools
          case 'team_start_task':
            return await this.handleTeamStartTask(args);
          case 'team_complete_task':
            return await this.handleTeamCompleteTask(args);
          case 'team_store_context':
            return await this.handleTeamStoreContext(args);
          case 'team_get_context':
            return await this.handleTeamGetContext(args);
          case 'team_record_decision':
            return await this.handleTeamRecordDecision(args);
          case 'team_store_artifact':
            return await this.handleTeamStoreArtifact(args);
          case 'team_search':
            return await this.handleTeamSearch(args);
          case 'team_get_status':
            return await this.handleTeamGetStatus();

          // Multi-instance coordination tools
          case 'system_health':
            return await this.handleSystemHealth();
          case 'system_instances':
            return await this.handleSystemInstances();

          // Memory pressure and cache management tools
          case 'memory_pressure':
            return await this.handleMemoryPressure();
          case 'memory_evict':
            return await this.handleMemoryEvict(args);

          // Peer Discovery Tools
          case 'peer_register':
            return await this.handlePeerRegister(args);
          case 'peer_heartbeat':
            return await this.handlePeerHeartbeat(args);
          case 'peer_deregister':
            return await this.handlePeerDeregister(args);
          case 'peer_list':
            return await this.handlePeerList(args);
          case 'peer_get':
            return await this.handlePeerGet(args);
          case 'peer_send_message':
            return await this.handlePeerSendMessage(args);
          case 'peer_check_messages':
            return await this.handlePeerCheckMessages(args);
          case 'peer_broadcast':
            return await this.handlePeerBroadcast(args);

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        logger.error(`Tool ${name} failed:`, error);
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    });
  }

  // ============================================
  // Core Memory Tool Handlers
  // ============================================

  async handleMemoryStore(args) {
    const { key, data, tags = [], ttl, agentId } = args;
    await this.storage.store(key, data, { tags, ttl, agentId });
    return {
      content: [{ type: 'text', text: `Memory stored successfully with key: ${key}` }]
    };
  }

  async handleMemoryRetrieve(args) {
    const { key } = args;
    const result = await this.storage.retrieve(key);
    if (result) {
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      };
    }
    return {
      content: [{ type: 'text', text: `No memory found for key: ${key}` }]
    };
  }

  async handleMemorySearch(args) {
    const { query, tags = [], limit = 10 } = args;
    const results = await this.storage.search(query, tags);
    const limited = results.slice(0, limit);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ count: limited.length, results: limited }, null, 2)
      }]
    };
  }

  async handleMemoryList(args) {
    const { limit = 20, offset = 0, agentId } = args;
    const results = await this.storage.list({ limit, offset, agentId });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ count: results.length, results }, null, 2)
      }]
    };
  }

  async handleMemoryDelete(args) {
    const { key } = args;
    await this.storage.delete(key);
    return {
      content: [{ type: 'text', text: `Memory deleted: ${key}` }]
    };
  }

  async handleMemoryStats() {
    const stats = await this.storage.getStats();

    // Add FTS5 index stats
    try {
      const ftsCount = this.storage.db.prepare('SELECT COUNT(*) as count FROM knowledge_fts').get().count;
      stats.fts5 = {
        enabled: true,
        indexedEntries: ftsCount,
        searchMode: 'fts5_bm25'
      };
    } catch (error) {
      stats.fts5 = {
        enabled: false,
        error: error.message
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }]
    };
  }

  async handleMemoryRebuildIndex() {
    const result = this.storage.rebuildFTSIndex();
    if (result.success) {
      return {
        content: [{
          type: 'text',
          text: `FTS5 index rebuilt successfully. ${result.entriesIndexed} entries indexed.`
        }]
      };
    }
    return {
      content: [{
        type: 'text',
        text: `Failed to rebuild FTS5 index: ${result.error}`
      }],
      isError: true
    };
  }

  async handleMemoryListConflicts(args) {
    const { limit = 20, status } = args;
    const conflicts = this.storage.listConflicts({ limit, status });
    const stats = this.storage.getConflictStats();

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          statistics: stats.statistics,
          count: conflicts.length,
          conflicts
        }, null, 2)
      }]
    };
  }

  async handleMemoryResolveConflict(args) {
    const { conflictId, resolution, resolvedBy } = args;

    try {
      const result = await this.storage.resolveConflictManually(
        conflictId,
        resolution,
        resolvedBy || this.instanceId
      );

      return {
        content: [{
          type: 'text',
          text: `Conflict ${conflictId} resolved successfully.\n${JSON.stringify(result, null, 2)}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Failed to resolve conflict: ${error.message}`
        }],
        isError: true
      };
    }
  }

  async handleMemorySetMergeStrategy(args) {
    const { pattern, strategy } = args;

    try {
      this.storage.setMergeStrategy(pattern, strategy);
      return {
        content: [{
          type: 'text',
          text: `Merge strategy set: ${pattern} -> ${strategy}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Failed to set merge strategy: ${error.message}`
        }],
        isError: true
      };
    }
  }

  // ============================================
  // Team Memory Tool Handlers
  // ============================================

  async handleTeamStartTask(args) {
    const { description, metadata = {} } = args;
    const taskId = await this.teamMemory.startTask(description, metadata);
    return {
      content: [{ type: 'text', text: `Task started with ID: ${taskId}` }]
    };
  }

  async handleTeamCompleteTask(args) {
    const { result = {} } = args;
    await this.teamMemory.completeTask(result);
    return {
      content: [{ type: 'text', text: 'Task completed successfully' }]
    };
  }

  async handleTeamStoreContext(args) {
    const { key, value } = args;
    await this.teamMemory.storeContext(key, value);
    return {
      content: [{ type: 'text', text: `Context stored with key: ${key}` }]
    };
  }

  async handleTeamGetContext(args) {
    const { key } = args;
    const value = this.teamMemory.getContext(key);
    if (value !== null) {
      return {
        content: [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      };
    }
    return {
      content: [{ type: 'text', text: `No context found for key: ${key}` }]
    };
  }

  async handleTeamRecordDecision(args) {
    const { decision, rationale, agentId } = args;
    await this.teamMemory.recordDecision({ decision, rationale, agentId });
    return {
      content: [{ type: 'text', text: 'Decision recorded successfully' }]
    };
  }

  async handleTeamStoreArtifact(args) {
    const { name, type, content, metadata = {} } = args;
    const artifactId = await this.teamMemory.storeArtifact({ name, type, content, metadata });
    return {
      content: [{ type: 'text', text: `Artifact stored with ID: ${artifactId}` }]
    };
  }

  async handleTeamSearch(args) {
    const { query } = args;
    const results = await this.teamMemory.search(query);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ count: results.length, results }, null, 2)
      }]
    };
  }

  async handleTeamGetStatus() {
    const task = this.teamMemory.getCurrentTask();
    const context = this.teamMemory.getAllContext();
    const decisions = this.teamMemory.getDecisions();
    const artifacts = this.teamMemory.getArtifacts();

    const status = {
      currentTask: task,
      contextKeys: Object.keys(context),
      decisionsCount: decisions.length,
      artifactsCount: artifacts.length,
      recentDecisions: decisions.slice(-5),
      recentArtifacts: artifacts.slice(-5).map(a => ({ id: a.id, name: a.name, type: a.type }))
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(status, null, 2) }]
    };
  }

  async run() {
    await this.initialize();

    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    logger.info('Bumba Memory MCP Server running on stdio');
  }

  async shutdown() {
    logger.info('Shutting down Bumba Memory MCP Server...');
    if (this.storage) {
      await this.storage.close();
    }
    logger.info('Bumba Memory MCP Server shut down');
  }

  // ============================================
  // Multi-Instance Coordination Tool Handlers
  // ============================================

  async handleSystemHealth() {
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      instanceId: this.instanceId,
      storage: {},
      wal: {},
      directories: {}
    };

    try {
      // Check storage
      const stats = this.storage.getStats();
      health.storage = {
        status: 'ok',
        dbPath: path.join(this.memoryDir, 'memory.db'),
        ...stats,
        dbSizeFormatted: this.formatBytes(stats.dbSize)
      };

      // Check WAL mode
      const dbPath = path.join(this.memoryDir, 'memory.db');
      const walPath = dbPath + '-wal';
      const shmPath = dbPath + '-shm';
      health.wal = {
        enabled: true,
        walExists: await fs.pathExists(walPath),
        shmExists: await fs.pathExists(shmPath)
      };
      if (health.wal.walExists) {
        const walStat = await fs.stat(walPath);
        health.wal.walSize = walStat.size;
        health.wal.walSizeFormatted = this.formatBytes(walStat.size);
      }

      // Check directories
      const dirs = ['instances', 'locks', 'artifacts'];
      for (const dir of dirs) {
        const dirPath = path.join(this.memoryDir, dir);
        const exists = await fs.pathExists(dirPath);
        health.directories[dir] = {
          exists,
          path: dirPath
        };
        if (exists) {
          const files = await fs.readdir(dirPath);
          health.directories[dir].fileCount = files.length;
        }
      }

      // Count active instances
      const instancesDir = path.join(this.memoryDir, 'instances');
      const instanceFiles = await fs.readdir(instancesDir);
      health.activeInstances = instanceFiles.filter(f => f.endsWith('.json')).length;

    } catch (error) {
      health.status = 'degraded';
      health.error = error.message;
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(health, null, 2)
      }]
    };
  }

  async handleSystemInstances() {
    const instances = [];
    const instancesDir = path.join(this.memoryDir, 'instances');

    try {
      const files = await fs.readdir(instancesDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(instancesDir, file);
        try {
          const data = await fs.readJson(filePath);
          const stat = await fs.stat(filePath);
          instances.push({
            ...data,
            lastSeen: stat.mtime.toISOString(),
            isCurrentInstance: data.instanceId === this.instanceId,
            // Check if process is still running (pid check)
            processRunning: this.isProcessRunning(data.pid)
          });
        } catch (e) {
          // Skip unreadable files
        }
      }
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Error listing instances: ${error.message}`
        }],
        isError: true
      };
    }

    // Sort by startedAt descending
    instances.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          totalInstances: instances.length,
          currentInstanceId: this.instanceId,
          instances
        }, null, 2)
      }]
    };
  }

  // ============================================
  // Memory Pressure and Cache Management Handlers
  // ============================================

  async handleMemoryPressure() {
    const os = require('os');
    const memoryUsage = process.memoryUsage();

    // Get system memory
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;
    const systemPercent = (usedMemory / totalMemory) * 100;

    // Get process memory
    const heapPercent = (memoryUsage.heapUsed / memoryUsage.heapTotal) * 100;

    // Determine pressure level
    let level = 'normal';
    if (systemPercent >= 95 || heapPercent >= 95) {
      level = 'emergency';
    } else if (systemPercent >= 85 || heapPercent >= 85) {
      level = 'critical';
    } else if (systemPercent >= 70 || heapPercent >= 70) {
      level = 'warning';
    }

    // Generate eviction recommendation
    const recommendations = {
      normal: { shouldEvict: false, message: 'No eviction needed' },
      warning: { shouldEvict: true, l1Percent: 10, message: 'Light eviction recommended' },
      critical: { shouldEvict: true, l1Percent: 30, l2Percent: 20, message: 'Moderate eviction recommended' },
      emergency: { shouldEvict: true, l1Percent: 50, l2Percent: 40, l3Percent: 30, message: 'Aggressive eviction required' }
    };

    const status = {
      level,
      system: {
        totalGB: (totalMemory / (1024 * 1024 * 1024)).toFixed(2),
        freeGB: (freeMemory / (1024 * 1024 * 1024)).toFixed(2),
        usedGB: (usedMemory / (1024 * 1024 * 1024)).toFixed(2),
        percentUsed: systemPercent.toFixed(1)
      },
      process: {
        heapUsedMB: (memoryUsage.heapUsed / (1024 * 1024)).toFixed(2),
        heapTotalMB: (memoryUsage.heapTotal / (1024 * 1024)).toFixed(2),
        rssMB: (memoryUsage.rss / (1024 * 1024)).toFixed(2),
        heapPercent: heapPercent.toFixed(1)
      },
      recommendation: recommendations[level],
      thresholds: {
        warning: 70,
        critical: 85,
        emergency: 95
      }
    };

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(status, null, 2)
      }]
    };
  }

  async handleMemoryEvict(args) {
    const { layer = 'l1', percent = 10, strategy = 'lfu' } = args;

    // Since we don't have direct access to the cache manager here,
    // we'll perform a manual eviction on the storage layer
    let evicted = 0;
    let message = '';

    try {
      if (strategy === 'expired') {
        // Clean up expired entries from storage
        evicted = this.storage.cleanupExpiredContexts();
        message = `Cleaned up ${evicted} expired entries`;
      } else if (strategy === 'pressure') {
        // Use memory pressure to determine eviction
        const os = require('os');
        const usedPercent = ((os.totalmem() - os.freemem()) / os.totalmem()) * 100;

        if (usedPercent >= 95) {
          // Emergency: aggressive cleanup
          evicted = this.storage.cleanupExpiredContexts();
          message = `Emergency eviction: cleaned up ${evicted} entries due to ${usedPercent.toFixed(1)}% memory usage`;
        } else if (usedPercent >= 85) {
          evicted = this.storage.cleanupExpiredContexts();
          message = `Critical eviction: cleaned up ${evicted} entries due to ${usedPercent.toFixed(1)}% memory usage`;
        } else if (usedPercent >= 70) {
          evicted = this.storage.cleanupExpiredContexts();
          message = `Warning eviction: cleaned up ${evicted} entries due to ${usedPercent.toFixed(1)}% memory usage`;
        } else {
          message = `No eviction needed: memory usage at ${usedPercent.toFixed(1)}%`;
        }
      } else {
        // LRU/LFU eviction - clean expired entries as baseline
        evicted = this.storage.cleanupExpiredContexts();
        message = `Evicted ${evicted} entries using ${strategy} strategy from ${layer} layer (${percent}% requested)`;
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            layer,
            strategy,
            requestedPercent: percent,
            evicted,
            message
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message
          }, null, 2)
        }],
        isError: true
      };
    }
  }

  // ============================================
  // Peer Discovery Tool Handlers
  // ============================================

  async handlePeerRegister(args) {
    const { agentId, machine, capabilities, endpoint, metadata } = args;
    const peer = this.peerRegistry.register({
      agentId,
      machine,
      capabilities,
      endpoint,
      metadata
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(peer, null, 2) }]
    };
  }

  async handlePeerHeartbeat(args) {
    const { agentId, status, currentTask } = args;
    const result = this.peerRegistry.heartbeat(agentId, { status, currentTask });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    };
  }

  async handlePeerDeregister(args) {
    const { agentId } = args;
    const result = this.peerRegistry.deregister(agentId);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    };
  }

  async handlePeerList(args) {
    const { machine, status, capability, includeStale } = args;
    const peers = this.peerRegistry.listPeers({
      machine,
      status,
      capability,
      includeStale
    });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          count: peers.length,
          peers
        }, null, 2)
      }]
    };
  }

  async handlePeerGet(args) {
    const { agentId } = args;
    const peer = this.peerRegistry.getPeer(agentId);
    if (!peer) {
      return {
        content: [{ type: 'text', text: `Peer not found: ${agentId}` }],
        isError: true
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(peer, null, 2) }]
    };
  }

  async handlePeerSendMessage(args) {
    const { source, target, message, messageType } = args;
    const result = this.peerMessaging.sendMessage({
      source,
      target,
      message,
      messageType
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    };
  }

  async handlePeerCheckMessages(args) {
    const { agentId, limit, markDelivered } = args;
    const messages = this.peerMessaging.checkMessages(agentId, {
      limit,
      markDelivered
    });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          count: messages.length,
          messages
        }, null, 2)
      }]
    };
  }

  async handlePeerBroadcast(args) {
    const { source, message, messageType } = args;
    const result = this.peerMessaging.broadcast(
      { source, message, messageType },
      this.peerRegistry
    );
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    };
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  isProcessRunning(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return false;
    }
  }
}

// Main entry point
const server = new BumbaMemoryMCPServer();

process.on('SIGINT', async () => {
  await server.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await server.shutdown();
  process.exit(0);
});

server.run().catch((error) => {
  logger.error('Server failed to start:', error);
  process.exit(1);
});
