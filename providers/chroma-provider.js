// [OPTIONAL] SemanticMemory - not available in standalone mode
let SemanticMemory = null;

const Logger = require('../lib/bumba-logger');

class ChromaProvider {
  constructor(config = {}) {
    this.config = {
      name: 'chroma',
      ...config
    };
    this.logger = new Logger('ChromaProvider');
    this.semanticMemory = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;

    if (!SemanticMemory) {
      this.logger.warn('SemanticMemory module not available, ChromaProvider disabled');
      return;
    }

    try {
      this.semanticMemory = new SemanticMemory(this.config);
      await this.semanticMemory.initialize();
      this.initialized = true;
      this.logger.info('ChromaProvider initialized');
    } catch (error) {
      this.logger.error('Failed to initialize ChromaProvider:', error);
      throw error;
    }
  }

  /**
   * Store a memory
   */
  async store(key, value, metadata = {}) {
    await this.initialize();

    if (!this.semanticMemory) {
      this.logger.warn('SemanticMemory not available, skipping store operation');
      return null;
    }

    const memory = {
      content: typeof value === 'string' ? value : JSON.stringify(value),
      agentId: metadata.agentId || 'system',
      taskId: metadata.taskId || null,
      type: metadata.type || 'general',
      importance: metadata.importance || 5,
      success: metadata.success !== undefined ? metadata.success : true,
      metadata: {
        key,
        ...metadata
      }
    };

    const result = await this.semanticMemory.addMemory(memory);
    return result.id;
  }

  /**
   * Store multiple memories
   */
  async storeBatch(items) {
    await this.initialize();

    if (!this.semanticMemory) {
      this.logger.warn('SemanticMemory not available, skipping storeBatch operation');
      return [];
    }

    const memories = items.map(item => ({
      content: typeof item.value === 'string' ? item.value : JSON.stringify(item.value),
      agentId: item.metadata?.agentId || 'system',
      taskId: item.metadata?.taskId || null,
      type: item.metadata?.type || 'general',
      importance: item.metadata?.importance || 5,
      success: item.metadata?.success !== undefined ? item.metadata.success : true,
      metadata: {
        key: item.key,
        ...item.metadata
      }
    }));

    const results = await this.semanticMemory.addMemories(memories);
    return results.map(r => r.id);
  }

  /**
   * Retrieve memories by semantic search
   */
  async retrieve(query, options = {}) {
    await this.initialize();

    if (!this.semanticMemory) {
      this.logger.warn('SemanticMemory not available, skipping retrieve operation');
      return [];
    }

    const searchOptions = {
      nResults: options.limit || 10,
      filter: options.filter || {},
      similarityThreshold: options.threshold || 0.7,
      category: options.category || null
    };

    const results = await this.semanticMemory.searchMemories(query, searchOptions);

    return results.results.map(memory => ({
      id: memory.id,
      key: memory.metadata.key || memory.id,
      value: memory.content,
      metadata: memory.metadata,
      score: memory.relevanceScore
    }));
  }

  /**
   * Retrieve by metadata filters
   */
  async retrieveByMetadata(filters, limit = 10) {
    await this.initialize();

    if (!this.semanticMemory) {
      this.logger.warn('SemanticMemory not available, skipping retrieveByMetadata operation');
      return [];
    }

    const results = await this.semanticMemory.searchByMetadata(filters, limit);

    return results.results.map(memory => ({
      id: memory.id,
      key: memory.metadata?.key || memory.id,
      value: memory.content,
      metadata: memory.metadata
    }));
  }

  /**
   * Find similar memories
   */
  async findSimilar(memoryId, limit = 5) {
    await this.initialize();

    if (!this.semanticMemory) {
      this.logger.warn('SemanticMemory not available, skipping findSimilar operation');
      return [];
    }

    const results = await this.semanticMemory.getSimilarMemories(memoryId, limit);

    return results.results.map(memory => ({
      id: memory.id,
      key: memory.metadata?.key || memory.id,
      value: memory.content,
      metadata: memory.metadata,
      score: memory.relevanceScore
    }));
  }

  /**
   * Delete memories (not supported in vector DB, only marks as deleted)
   */
  async delete(key) {
    await this.initialize();

    // Mark as deleted in metadata
    const memories = await this.retrieveByMetadata({ key }, 1);
    if (memories.length > 0) {
      const memory = memories[0];
      memory.metadata.deleted = true;
      memory.metadata.deletedAt = new Date().toISOString();

      // Re-store with deleted flag
      await this.store(key, memory.value, memory.metadata);
      return true;
    }
    return false;
  }

  /**
   * Check if key exists
   */
  async exists(key) {
    const memories = await this.retrieveByMetadata({ key }, 1);
    return memories.length > 0 && !memories[0].metadata?.deleted;
  }

  /**
   * Get statistics
   */
  async getStats() {
    await this.initialize();

    if (!this.semanticMemory) {
      this.logger.warn('SemanticMemory not available, returning empty stats');
      return { total: 0, collections: [] };
    }

    return await this.semanticMemory.getStats();
  }

  /**
   * Clear all memories
   */
  async clear() {
    await this.initialize();

    if (!this.semanticMemory) {
      this.logger.warn('SemanticMemory not available, skipping clear operation');
      return false;
    }

    return await this.semanticMemory.clear();
  }

  /**
   * Close provider
   */
  async close() {
    this.initialized = false;
    this.logger.info('ChromaProvider closed');
  }
}

module.exports = ChromaProvider;