/**
 * Conflict Resolver for Bumba Memory
 * Sprint 2.2: Adapted from bumba-components/systems/design-catalog/conflict-resolver.js
 *
 * Handles concurrent write conflicts in multi-instance memory scenarios.
 * Uses version vectors for causality detection and provides multiple
 * resolution strategies.
 */

const EventEmitter = require('events');
const crypto = require('crypto');
const Logger = require('./logger');
const { VersionVector } = require('./version-vector');

const logger = new Logger('ConflictResolver');

/**
 * Conflict Types for memory operations
 */
const ConflictType = {
  CONCURRENT_MODIFICATION: 'concurrent_modification',
  RAPID_UPDATES: 'rapid_updates',
  VERSION_MISMATCH: 'version_mismatch',
  STALE_WRITE: 'stale_write',
  DATA_CORRUPTION: 'data_corruption'
};

/**
 * Resolution Strategies
 */
const ResolutionStrategy = {
  LAST_WRITE_WINS: 'last_write_wins',
  MERGE: 'merge',
  KEEP_LOCAL: 'keep_local',
  KEEP_REMOTE: 'keep_remote',
  KEEP_BOTH: 'keep_both',
  MANUAL: 'manual'
};

/**
 * Conflict Status
 */
const ConflictStatus = {
  DETECTED: 'detected',
  RESOLVED: 'resolved',
  PENDING: 'pending',
  FAILED: 'failed'
};

/**
 * Conflict Resolution Result
 */
class ConflictResolution {
  constructor(data = {}) {
    this.conflictId = data.conflictId || `conflict_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.key = data.key;
    this.type = data.type;
    this.strategy = data.strategy;
    this.status = data.status || ConflictStatus.DETECTED;
    this.local = data.local;
    this.remote = data.remote;
    this.resolved = data.resolved || null;
    this.timestamp = data.timestamp || new Date().toISOString();
    this.localVector = data.localVector;
    this.remoteVector = data.remoteVector;
    this.resolutionDetails = data.resolutionDetails || {};
  }

  toJSON() {
    return {
      conflictId: this.conflictId,
      key: this.key,
      type: this.type,
      strategy: this.strategy,
      status: this.status,
      local: this.local,
      remote: this.remote,
      resolved: this.resolved,
      timestamp: this.timestamp,
      localVector: this.localVector,
      remoteVector: this.remoteVector,
      resolutionDetails: this.resolutionDetails
    };
  }
}

/**
 * Conflict Resolver
 * Detects and resolves conflicts in memory data
 */
class ConflictResolver extends EventEmitter {
  constructor(options = {}) {
    super();

    this.defaultStrategy = options.defaultStrategy || ResolutionStrategy.LAST_WRITE_WINS;
    this.autoResolve = options.autoResolve !== false; // Default true
    this.instanceId = options.instanceId || `resolver-${process.pid}`;

    // Strategy rules for different key patterns
    this.strategyRules = options.strategyRules || this.getDefaultStrategyRules();

    // Conflict history
    this.conflicts = [];
    this.maxHistorySize = options.maxHistorySize || 100;

    // Statistics
    this.stats = {
      totalConflicts: 0,
      autoResolved: 0,
      manualResolved: 0,
      failed: 0,
      byType: {},
      byStrategy: {}
    };
  }

  /**
   * Get default strategy rules for different key patterns
   */
  getDefaultStrategyRules() {
    return {
      'user:*': ResolutionStrategy.LAST_WRITE_WINS,
      'context:*': ResolutionStrategy.MERGE,
      'decision:*': ResolutionStrategy.KEEP_BOTH,
      'artifact:*': ResolutionStrategy.LAST_WRITE_WINS,
      'handoff:*': ResolutionStrategy.LAST_WRITE_WINS,
      'wip:*': ResolutionStrategy.LAST_WRITE_WINS,
      'cache:*': ResolutionStrategy.LAST_WRITE_WINS,
      '*': ResolutionStrategy.LAST_WRITE_WINS  // Default
    };
  }

  /**
   * Get strategy for a specific key based on pattern rules
   */
  getStrategyForKey(key) {
    for (const [pattern, strategy] of Object.entries(this.strategyRules)) {
      if (pattern === '*') continue;
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      if (regex.test(key)) {
        return strategy;
      }
    }
    return this.strategyRules['*'] || this.defaultStrategy;
  }

  /**
   * Detect if there's a conflict between local and incoming data
   * @param {string} key - Memory key
   * @param {Object} localEntry - Existing entry in memory
   * @param {Object} incomingEntry - New entry being written
   * @returns {Object|null} - Conflict object if detected, null otherwise
   */
  detectConflict(key, localEntry, incomingEntry) {
    // No conflict if local doesn't exist
    if (!localEntry) {
      return null;
    }

    // Get version vectors
    const localVector = VersionVector.fromJSON(localEntry.vectorClock || localEntry.vector_clock || {});
    const incomingVector = VersionVector.fromJSON(incomingEntry.vectorClock || incomingEntry.vector_clock || {});

    // Compare vectors
    const comparison = localVector.compare(incomingVector);

    // No conflict if incoming dominates local (normal update)
    if (comparison === 'before' || comparison === 'equal') {
      return null;
    }

    // Conflict detected!
    let conflictType = ConflictType.CONCURRENT_MODIFICATION;

    // Determine specific conflict type
    if (comparison === 'after') {
      // Local is newer - stale write attempt
      conflictType = ConflictType.STALE_WRITE;
    } else if (comparison === 'concurrent') {
      // True concurrent modification
      const timeDiff = Math.abs(
        (localEntry.timestamp || 0) - (incomingEntry.timestamp || Date.now())
      );
      if (timeDiff < 5000) {
        conflictType = ConflictType.RAPID_UPDATES;
      }
    }

    // Calculate data hashes
    const localHash = this.calculateHash(localEntry.data);
    const incomingHash = this.calculateHash(incomingEntry.data);

    // No conflict if data is identical
    if (localHash === incomingHash) {
      return null;
    }

    const conflict = {
      key,
      type: conflictType,
      local: {
        data: localEntry.data,
        timestamp: localEntry.timestamp,
        version: localEntry.version,
        vectorClock: localVector.toJSON(),
        hash: localHash,
        source: localEntry.source
      },
      remote: {
        data: incomingEntry.data,
        timestamp: incomingEntry.timestamp || Date.now(),
        version: incomingEntry.version || 1,
        vectorClock: incomingVector.toJSON(),
        hash: incomingHash,
        source: incomingEntry.source || incomingEntry.agentId
      }
    };

    this.stats.totalConflicts++;
    this.stats.byType[conflictType] = (this.stats.byType[conflictType] || 0) + 1;

    logger.warn('Conflict detected:', {
      key,
      type: conflictType,
      comparison
    });

    return conflict;
  }

  /**
   * Resolve a conflict using the appropriate strategy
   * @param {Object} conflict - The conflict object
   * @returns {ConflictResolution} - Resolution result
   */
  async resolveConflict(conflict) {
    const strategy = this.getStrategyForKey(conflict.key);
    const resolution = new ConflictResolution({
      key: conflict.key,
      type: conflict.type,
      strategy,
      local: conflict.local,
      remote: conflict.remote,
      localVector: conflict.local.vectorClock,
      remoteVector: conflict.remote.vectorClock
    });

    try {
      const result = this.applyStrategy(strategy, conflict);

      resolution.resolved = result.data;
      resolution.status = ConflictStatus.RESOLVED;
      resolution.resolutionDetails = {
        strategy,
        action: result.action,
        winner: result.winner,
        merged: result.merged || false
      };

      // Track resolution
      this.conflicts.push(resolution);
      this.trimHistory();

      this.stats.autoResolved++;
      this.stats.byStrategy[strategy] = (this.stats.byStrategy[strategy] || 0) + 1;

      // Emit events
      this.emit('conflict:detected', conflict);
      this.emit('conflict:resolved', resolution);

      logger.info('Conflict resolved:', {
        conflictId: resolution.conflictId,
        key: conflict.key,
        strategy,
        action: result.action
      });

    } catch (error) {
      logger.error('Conflict resolution failed:', error);

      resolution.status = ConflictStatus.FAILED;
      resolution.resolutionDetails.error = error.message;

      this.conflicts.push(resolution);
      this.stats.failed++;

      this.emit('conflict:failed', resolution);
    }

    return resolution;
  }

  /**
   * Apply a resolution strategy
   */
  applyStrategy(strategy, conflict) {
    switch (strategy) {
      case ResolutionStrategy.LAST_WRITE_WINS:
        return this.lastWriteWins(conflict);

      case ResolutionStrategy.MERGE:
        return this.merge(conflict);

      case ResolutionStrategy.KEEP_LOCAL:
        return this.keepLocal(conflict);

      case ResolutionStrategy.KEEP_REMOTE:
        return this.keepRemote(conflict);

      case ResolutionStrategy.KEEP_BOTH:
        return this.keepBoth(conflict);

      case ResolutionStrategy.MANUAL:
        throw new Error('Manual resolution required');

      default:
        logger.warn(`Unknown strategy: ${strategy}, using LAST_WRITE_WINS`);
        return this.lastWriteWins(conflict);
    }
  }

  /**
   * Last Write Wins - use the most recent timestamp
   */
  lastWriteWins(conflict) {
    const localTime = conflict.local.timestamp || 0;
    const remoteTime = conflict.remote.timestamp || 0;

    if (remoteTime >= localTime) {
      return {
        data: conflict.remote.data,
        action: 'replaced_with_remote',
        winner: 'remote'
      };
    }
    return {
      data: conflict.local.data,
      action: 'kept_local',
      winner: 'local'
    };
  }

  /**
   * Merge strategy - deep merge objects, union arrays
   */
  merge(conflict) {
    const localData = conflict.local.data;
    const remoteData = conflict.remote.data;

    // Handle arrays - union
    if (Array.isArray(localData) && Array.isArray(remoteData)) {
      return this.mergeArrays(localData, remoteData);
    }

    // Handle objects - deep merge
    if (typeof localData === 'object' && typeof remoteData === 'object' &&
        localData !== null && remoteData !== null) {
      return this.mergeObjects(localData, remoteData);
    }

    // Fall back to last write wins for primitives
    return this.lastWriteWins(conflict);
  }

  /**
   * Merge arrays by union (deduplicated)
   */
  mergeArrays(localArr, remoteArr) {
    // Create lookup by id, name, or stringified value
    const getKey = (item) => {
      if (typeof item === 'object' && item !== null) {
        return item.id || item.name || item.key || JSON.stringify(item);
      }
      return String(item);
    };

    const merged = new Map();
    const added = [];
    const kept = [];

    // Add all local items
    for (const item of localArr) {
      const key = getKey(item);
      merged.set(key, item);
      kept.push(key);
    }

    // Add/update with remote items
    for (const item of remoteArr) {
      const key = getKey(item);
      if (!merged.has(key)) {
        added.push(key);
      }
      merged.set(key, item); // Remote takes precedence
    }

    return {
      data: Array.from(merged.values()),
      action: 'merged_arrays',
      winner: 'both',
      merged: true,
      details: { added: added.length, kept: kept.length }
    };
  }

  /**
   * Deep merge objects
   */
  mergeObjects(localObj, remoteObj) {
    const merged = { ...localObj };

    for (const [key, value] of Object.entries(remoteObj)) {
      if (key in merged) {
        // Recursively merge nested objects
        if (typeof merged[key] === 'object' && typeof value === 'object' &&
            merged[key] !== null && value !== null && !Array.isArray(merged[key])) {
          merged[key] = this.mergeObjects(merged[key], value).data;
        } else if (Array.isArray(merged[key]) && Array.isArray(value)) {
          merged[key] = this.mergeArrays(merged[key], value).data;
        } else {
          // Remote takes precedence for primitives
          merged[key] = value;
        }
      } else {
        merged[key] = value;
      }
    }

    return {
      data: merged,
      action: 'merged_objects',
      winner: 'both',
      merged: true
    };
  }

  /**
   * Keep Local - always prefer local data
   */
  keepLocal(conflict) {
    return {
      data: conflict.local.data,
      action: 'kept_local',
      winner: 'local'
    };
  }

  /**
   * Keep Remote - always prefer remote/incoming data
   */
  keepRemote(conflict) {
    return {
      data: conflict.remote.data,
      action: 'kept_remote',
      winner: 'remote'
    };
  }

  /**
   * Keep Both - store both versions as an array
   */
  keepBoth(conflict) {
    return {
      data: {
        _conflictMerged: true,
        _mergedAt: new Date().toISOString(),
        versions: [
          { source: 'local', timestamp: conflict.local.timestamp, data: conflict.local.data },
          { source: 'remote', timestamp: conflict.remote.timestamp, data: conflict.remote.data }
        ]
      },
      action: 'kept_both',
      winner: 'both',
      merged: true
    };
  }

  /**
   * Calculate hash of data for comparison
   */
  calculateHash(data) {
    if (data === null || data === undefined) {
      return crypto.createHash('sha256').update('null').digest('hex').substring(0, 16);
    }

    let str;
    if (typeof data === 'object' && !Array.isArray(data)) {
      // Sort keys for consistent hashing
      str = JSON.stringify(data, Object.keys(data).sort());
    } else {
      str = JSON.stringify(data);
    }

    return crypto.createHash('sha256').update(str).digest('hex').substring(0, 16);
  }

  /**
   * Get conflict by ID
   */
  getConflict(conflictId) {
    return this.conflicts.find(c => c.conflictId === conflictId);
  }

  /**
   * Get recent conflicts
   */
  getRecentConflicts(limit = 10) {
    return this.conflicts.slice(-limit).reverse();
  }

  /**
   * Get pending conflicts requiring manual resolution
   */
  getPendingConflicts() {
    return this.conflicts.filter(c => c.status === ConflictStatus.PENDING);
  }

  /**
   * Manually resolve a conflict
   */
  async manualResolve(conflictId, resolvedData, resolvedBy) {
    const conflict = this.getConflict(conflictId);
    if (!conflict) {
      throw new Error(`Conflict not found: ${conflictId}`);
    }

    conflict.status = ConflictStatus.RESOLVED;
    conflict.resolved = resolvedData;
    conflict.resolutionDetails.manual = true;
    conflict.resolutionDetails.resolvedBy = resolvedBy;
    conflict.resolutionDetails.resolvedAt = new Date().toISOString();

    this.stats.manualResolved++;

    this.emit('conflict:manually_resolved', conflict);

    logger.info('Conflict manually resolved:', conflictId);

    return conflict;
  }

  /**
   * Set strategy for a key pattern
   */
  setStrategy(pattern, strategy) {
    if (!Object.values(ResolutionStrategy).includes(strategy)) {
      throw new Error(`Invalid strategy: ${strategy}`);
    }
    this.strategyRules[pattern] = strategy;
    logger.info(`Strategy set: ${pattern} -> ${strategy}`);
  }

  /**
   * Get statistics
   */
  getStatistics() {
    const total = this.stats.totalConflicts;

    return {
      ...this.stats,
      autoResolveRate: total > 0
        ? ((this.stats.autoResolved / total) * 100).toFixed(2) + '%'
        : '0%',
      failureRate: total > 0
        ? ((this.stats.failed / total) * 100).toFixed(2) + '%'
        : '0%',
      pending: this.getPendingConflicts().length,
      historySize: this.conflicts.length
    };
  }

  /**
   * Clear conflict history
   */
  clearHistory() {
    this.conflicts = [];
    logger.info('Conflict history cleared');
    this.emit('history:cleared');
  }

  /**
   * Trim conflict history to max size
   */
  trimHistory() {
    if (this.conflicts.length > this.maxHistorySize) {
      const removed = this.conflicts.length - this.maxHistorySize;
      this.conflicts = this.conflicts.slice(-this.maxHistorySize);
      logger.debug(`Trimmed ${removed} conflicts from history`);
    }
  }
}

module.exports = {
  ConflictResolver,
  ConflictType,
  ResolutionStrategy,
  ConflictStatus,
  ConflictResolution
};
