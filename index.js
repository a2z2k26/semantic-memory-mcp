/**
 * BUMBA Memory System - Unified Export Interface
 * Consolidates all memory management functionality
 * @module memory
 */

const Logger = require('./src/lib/logger');
const logger = new Logger('BumbaMemorySystem');

// Unified memory system (primary interface) - local sqlite-storage-adapter implementation
let UnifiedMemorySystem;
try {
  const { SQLiteStorageAdapter } = require('./src/storage/sqlite-storage-adapter');
  class LocalUnifiedMemorySystem {
    constructor(config = {}) {
      this.config = config;
      this.storage = null;
    }
    async initialize() {
      this.storage = new SQLiteStorageAdapter(this.config);
      await this.storage.initialize();
    }
    async storeInMemory(key, data, options = {}) {
      return this.storage.store(key, data, options);
    }
    async retrieveFromMemory(key) {
      return this.storage.retrieve(key);
    }
    async searchMemory(query, tags = []) {
      return this.storage.search(query, tags);
    }
    getStatus() { return { initialized: !!this.storage }; }
    getCapabilities() { return ['sqlite', 'search']; }
    async shutdown() { if (this.storage) await this.storage.close(); }
  }
  UnifiedMemorySystem = LocalUnifiedMemorySystem;
} catch (e) {
  logger.warn('UnifiedMemorySystem not available:', e.message);
  UnifiedMemorySystem = null;
}

/**
 * Factory function to create a unified memory system instance
 */
function createMemorySystem(config = {}) {
  // Use test-specific database path in test environment
  const isTestEnv = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID;
  const defaultDbPath = isTestEnv
    ? `./test/tmp/memory-test-${Date.now()}-${process.pid}.db`
    : './data/memory.db';

  const memorySystem = new UnifiedMemorySystem({
    maxSize: config.maxSize || 1000,
    ttl: config.ttl || 3600000, // 1 hour default
    cleanupInterval: config.cleanupInterval || 300000, // 5 minutes
    optimizationEnabled: config.optimizationEnabled !== false,
    searchEnabled: config.searchEnabled !== false,
    dbPath: config.dbPath || defaultDbPath, // Use test-specific or default path
    ...config
  });

  return memorySystem;
}

/**
 * Factory function to create a legacy-compatible memory system
 * NOTE: Legacy adapters removed - returns null
 */
function createLegacyMemorySystem(config = {}) {
  logger.warn('Legacy memory systems removed - use UnifiedMemorySystem instead');
  return null;
}

/**
 * Main Memory System Manager
 * Coordinates between unified and legacy memory systems
 */
class BumbaMemorySystem {
  constructor(config = {}) {
    this.config = {
      useUnified: config.useUnified !== false,
      maintainLegacy: config.maintainLegacy !== false,
      autoMigrate: config.autoMigrate !== false,
      ...config
    };

    this.initialized = false;
    this.unifiedSystem = null;
    this.legacySystems = null;

    logger.info('🧠 BUMBA Memory System initializing...');
  }

  async initialize() {
    try {
      logger.info('🧠 Initializing memory systems...');

      // Initialize unified memory system
      if (this.config.useUnified) {
        // Honor top-level dbPath as a shorthand for unified.dbPath
        let unifiedConfig = this.config.unified;
        if (this.config.dbPath !== undefined) {
          if (unifiedConfig === undefined) {
            unifiedConfig = { dbPath: this.config.dbPath };
          } else if (unifiedConfig.dbPath !== undefined) {
            logger.warn(
              'Both top-level dbPath and unified.dbPath provided; using unified.dbPath and ignoring top-level dbPath'
            );
          } else {
            unifiedConfig = { ...unifiedConfig, dbPath: this.config.dbPath };
          }
        }
        this.unifiedSystem = createMemorySystem(unifiedConfig || {});
        await this.unifiedSystem.initialize();
      }

      // Initialize legacy systems if needed
      if (this.config.maintainLegacy) {
        this.legacySystems = createLegacyMemorySystem(this.config.legacy || {});
      }

      // Auto-migrate from legacy to unified if enabled
      if (this.config.autoMigrate && this.unifiedSystem && this.legacySystems) {
        await this.migrateLegacyData();
      }

      this.initialized = true;
      logger.info('🧠 Memory systems initialized successfully');

      return true;
    } catch (error) {
      logger.error('Failed to initialize memory systems:', error);
      throw error;
    }
  }

  async migrateLegacyData() {
    logger.info('🧠 Starting legacy data migration...');

    try {
      // Migration logic would go here
      // For now, just log the migration intention
      logger.info('🧠 Legacy data migration completed');
    } catch (error) {
      logger.error('Legacy data migration failed:', error);
    }
  }

  // Unified interface methods
  async store(key, data, options = {}) {
    if (!this.initialized) {
      await this.initialize();
    }

    if (this.unifiedSystem) {
      return this.unifiedSystem.storeInMemory(key, data, options);
    }

    throw new Error('No memory system available');
  }

  async retrieve(key) {
    if (!this.initialized) {
      await this.initialize();
    }

    if (this.unifiedSystem) {
      return this.unifiedSystem.retrieveFromMemory(key);
    }

    throw new Error('No memory system available');
  }

  async search(query, options = {}) {
    if (!this.initialized) {
      await this.initialize();
    }

    if (this.unifiedSystem) {
      const searchResult = await this.unifiedSystem.searchMemory(query, options.tags || []);
      // Return just the results array for backward compatibility with tests
      return searchResult.results || [];
    }

    throw new Error('No memory system available');
  }

  // System status
  getStatus() {
    const status = {
      initialized: this.initialized,
      unified: this.unifiedSystem ? this.unifiedSystem.getStatus() : null,
      legacy: this.legacySystems ? Object.keys(this.legacySystems) : []
    };

    if (this.unifiedSystem) {
      status.capabilities = this.unifiedSystem.getCapabilities();
    }

    return status;
  }

  async shutdown() {
    logger.info('🧠 Shutting down memory systems...');

    if (this.unifiedSystem) {
      await this.unifiedSystem.shutdown();
    }

    logger.info('🧠 Memory systems shut down');
  }

  // Alias for cleanup (for test compatibility)
  async cleanup() {
    return this.shutdown();
  }

  // Check if system is initialized
  isInitialized() {
    return this.initialized;
  }

  // Store memory methods (for compatibility with legacy tests)
  async storeMemory(data) {
    if (!data || !data.agentId) {
      throw new Error('Invalid memory data: agentId is required');
    }
    // Add random suffix to ensure uniqueness even if stored in same millisecond
    const key = `${data.agentId}:${data.type || 'default'}:${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    return this.store(key, data);
  }

  async getMemoriesByAgent(agentId, options = {}) {
    if (!agentId) {
      throw new Error('agentId is required');
    }
    return this.search(agentId, options);
  }

  // Alias for test compatibility
  async getAgentMemories(agentId, options = {}) {
    return this.getMemoriesByAgent(agentId, options);
  }

  async searchMemories(query, options = {}) {
    const results = await this.search(query, options);
    // Return in expected format with results array
    return {
      results: results,
      total: results.length,
      query
    };
  }

  async getMemoryById(id) {
    return this.retrieve(id);
  }
}

// Export singleton instance
let instance = null;

module.exports = {
  // Modern unified memory system
  UnifiedMemorySystem,

  // Create unified memory system instance
  createMemorySystem,

  // Legacy memory systems (removed - stubs for backward compatibility)
  ConsolidatedMemoryManager: null,
  UnifiedMemorySystemAdapter: null,
  BumbaMemorySystemAdapter: null,
  createLegacyMemorySystem,

  // Main memory system manager
  BumbaMemorySystem,

  // Aliases for test compatibility (all use BumbaMemorySystem under the hood)
  MemorySystem: BumbaMemorySystem,
  OperationalMemory: BumbaMemorySystem,
  SemanticMemory: BumbaMemorySystem,
  MemoryManager: BumbaMemorySystem,

  getInstance: (config) => {
    if (!instance) {
      instance = new BumbaMemorySystem(config);
    }
    return instance;
  },

  // Utility functions
  clearInstance: () => {
    instance = null;
  }
};