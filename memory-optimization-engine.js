/**
 * BUMBA Memory Optimization Engine
 * Advanced memory management, caching strategies, and performance optimization
 */

const zlib = require('zlib');
const { promisify } = require('util');
const Logger = require('./lib/bumba-logger');

// Promisify zlib functions for async/await
const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

// Create logger instance
const logger = new Logger('MemoryOptimizationEngine');

/**
 * Memory optimization strategies
 */
const OptimizationStrategy = {
  LRU_EVICTION: 'lru-eviction',
  TTL_CLEANUP: 'ttl-cleanup',
  SIZE_BASED: 'size-based',
  FREQUENCY_BASED: 'frequency-based',
  INTELLIGENT_PREFETCH: 'intelligent-prefetch'
};

/**
 * Memory tier levels for hierarchical storage
 */
const MemoryTier = {
  HOT: 'hot',      // Frequently accessed, in-memory
  WARM: 'warm',    // Occasionally accessed, compressed memory
  COLD: 'cold',    // Rarely accessed, disk storage
  FROZEN: 'frozen' // Archived, compressed disk storage
};

/**
 * Memory Optimization Engine
 * Provides intelligent memory management and optimization
 */
class MemoryOptimizationEngine {
  constructor(options = {}) {
    this.options = {
      maxHotMemory: options.maxHotMemory || 500, // Number of hot items
      maxWarmMemory: options.maxWarmMemory || 2000, // Number of warm items
      optimizationInterval: options.optimizationInterval || 60000, // 1 minute
      compressionEnabled: options.compressionEnabled !== false,
      analyticsEnabled: options.analyticsEnabled !== false,
      ...options
    };

    // Memory analytics
    this.analytics = {
      accessPatterns: new Map(),
      tierTransitions: new Map(),
      optimizationHistory: [],
      performanceMetrics: {
        avgAccessTime: 0,
        cacheHitRate: 0,
        memoryUtilization: 0,
        optimizationCount: 0
      }
    };

    // Memory tiers
    this.tiers = {
      [MemoryTier.HOT]: new Map(),
      [MemoryTier.WARM]: new Map(),
      [MemoryTier.COLD]: new Map(),
      [MemoryTier.FROZEN]: new Map()
    };

    // Access tracking
    this.accessTracker = new Map();
    this.optimizationTimer = null;

    this.logger = logger;
  }

  async initialize() {
    this.logger.info('🚀 Memory optimization engine initializing...');

    // Start optimization timer
    this.startOptimizationScheduler();

    this.logger.info('🚀 Memory optimization engine initialized');
    return true;
  }

  /**
   * Optimize memory layout based on access patterns
   */
  async optimizeMemoryLayout() {
    const startTime = Date.now();
    let optimizationsApplied = 0;

    try {
      // Analyze access patterns
      const accessAnalysis = this.analyzeAccessPatterns();

      // Apply tier-based optimization
      optimizationsApplied += await this.optimizeTiers(accessAnalysis);

      // Apply compression optimization
      if (this.options.compressionEnabled) {
        optimizationsApplied += await this.optimizeCompression();
      }

      // Cleanup expired items
      optimizationsApplied += await this.cleanupExpiredItems();

      // Update performance metrics
      this.updatePerformanceMetrics(Date.now() - startTime, optimizationsApplied);

      this.logger.info(`🚀 Memory optimization completed: ${optimizationsApplied} optimizations applied`);

      return {
        optimizationsApplied,
        executionTime: Date.now() - startTime,
        memoryUtilization: this.calculateMemoryUtilization(),
        tierDistribution: this.getTierDistribution()
      };

    } catch (error) {
      this.logger.error('Memory optimization failed:', error);
      throw error;
    }
  }

  /**
   * Analyze memory access patterns to identify optimization opportunities
   */
  analyzeAccessPatterns() {
    const analysis = {
      hotItems: [],
      coldItems: [],
      accessFrequency: new Map(),
      lastAccessTime: new Map()
    };

    const now = Date.now();

    for (const [key, accessInfo] of this.accessTracker) {
      const frequency = accessInfo.count;
      const lastAccess = accessInfo.lastAccess;
      const timeSinceLastAccess = now - lastAccess;

      analysis.accessFrequency.set(key, frequency);
      analysis.lastAccessTime.set(key, timeSinceLastAccess);

      // Classify as hot or cold based on frequency and recency
      if (frequency > 10 && timeSinceLastAccess < 300000) { // 5 minutes
        analysis.hotItems.push({ key, frequency, lastAccess });
      } else if (frequency < 3 && timeSinceLastAccess > 1800000) { // 30 minutes
        analysis.coldItems.push({ key, frequency, lastAccess });
      }
    }

    // Sort by relevance
    analysis.hotItems.sort((a, b) => b.frequency - a.frequency);
    analysis.coldItems.sort((a, b) => a.frequency - b.frequency);

    return analysis;
  }

  /**
   * Optimize memory tiers based on access patterns
   */
  async optimizeTiers(accessAnalysis) {
    let optimizations = 0;

    // Promote hot items to hot tier
    for (const item of accessAnalysis.hotItems.slice(0, this.options.maxHotMemory)) {
      if (await this.promoteToTier(item.key, MemoryTier.HOT)) {
        optimizations++;
      }
    }

    // Demote cold items to cold tier
    for (const item of accessAnalysis.coldItems) {
      if (await this.demoteToTier(item.key, MemoryTier.COLD)) {
        optimizations++;
      }
    }

    // Balance tier sizes
    optimizations += await this.balanceTierSizes();

    return optimizations;
  }

  /**
   * Promote item to a higher tier
   */
  async promoteToTier(key, targetTier) {
    const currentTier = this.findItemTier(key);
    if (!currentTier || currentTier === targetTier) {
      return false;
    }

    const item = this.tiers[currentTier].get(key);
    if (!item) {
      return false;
    }

    // Move item to target tier
    this.tiers[currentTier].delete(key);
    this.tiers[targetTier].set(key, item);

    // Track tier transition
    this.trackTierTransition(key, currentTier, targetTier);

    return true;
  }

  /**
   * Demote item to a lower tier
   */
  async demoteToTier(key, targetTier) {
    const currentTier = this.findItemTier(key);
    if (!currentTier || this.getTierLevel(currentTier) >= this.getTierLevel(targetTier)) {
      return false;
    }

    const item = this.tiers[currentTier].get(key);
    if (!item) {
      return false;
    }

    // Compress item if moving to cold storage
    if (targetTier === MemoryTier.COLD || targetTier === MemoryTier.FROZEN) {
      item.compressed = await this.compressItem(item);
    }

    // Move item to target tier
    this.tiers[currentTier].delete(key);
    this.tiers[targetTier].set(key, item);

    // Track tier transition
    this.trackTierTransition(key, currentTier, targetTier);

    return true;
  }

  /**
   * Balance tier sizes to maintain optimal distribution
   */
  async balanceTierSizes() {
    let optimizations = 0;

    // Ensure hot tier doesn't exceed maximum
    const hotTier = this.tiers[MemoryTier.HOT];
    if (hotTier.size > this.options.maxHotMemory) {
      const excess = hotTier.size - this.options.maxHotMemory;
      const itemsToMove = Array.from(hotTier.keys()).slice(-excess);

      for (const key of itemsToMove) {
        if (await this.demoteToTier(key, MemoryTier.WARM)) {
          optimizations++;
        }
      }
    }

    // Ensure warm tier doesn't exceed maximum
    const warmTier = this.tiers[MemoryTier.WARM];
    if (warmTier.size > this.options.maxWarmMemory) {
      const excess = warmTier.size - this.options.maxWarmMemory;
      const itemsToMove = Array.from(warmTier.keys()).slice(-excess);

      for (const key of itemsToMove) {
        if (await this.demoteToTier(key, MemoryTier.COLD)) {
          optimizations++;
        }
      }
    }

    return optimizations;
  }

  /**
   * Apply compression optimization to appropriate tiers
   */
  async optimizeCompression() {
    let optimizations = 0;

    // Compress items in warm tier that haven't been accessed recently
    const warmTier = this.tiers[MemoryTier.WARM];
    const now = Date.now();

    for (const [key, item] of warmTier) {
      const accessInfo = this.accessTracker.get(key);
      if (accessInfo && (now - accessInfo.lastAccess) > 600000 && !item.compressed) { // 10 minutes
        item.compressed = await this.compressItem(item);
        optimizations++;
      }
    }

    return optimizations;
  }

  /**
   * Clean up expired items from all tiers
   */
  async cleanupExpiredItems() {
    let cleaned = 0;
    const now = Date.now();

    for (const tier of Object.values(this.tiers)) {
      for (const [key, item] of tier) {
        if (item.expiry && now > item.expiry) {
          tier.delete(key);
          this.accessTracker.delete(key);
          cleaned++;
        }
      }
    }

    return cleaned;
  }

  /**
   * Track memory access for optimization
   */
  trackAccess(key, operation = 'read') {
    const now = Date.now();
    const accessInfo = this.accessTracker.get(key) || {
      count: 0,
      lastAccess: now,
      operations: { read: 0, write: 0 }
    };

    accessInfo.count++;
    accessInfo.lastAccess = now;
    accessInfo.operations[operation]++;

    this.accessTracker.set(key, accessInfo);
  }

  /**
   * Store item in optimal tier based on expected access pattern
   */
  storeOptimally(key, data, options = {}) {
    const tier = this.determineOptimalTier(options.accessPattern || 'normal');

    const item = {
      data,
      timestamp: Date.now(),
      expiry: options.ttl ? Date.now() + options.ttl : null,
      compressed: false,
      accessPattern: options.accessPattern || 'normal'
    };

    this.tiers[tier].set(key, item);
    this.trackAccess(key, 'write');

    return { tier, key };
  }

  /**
   * Retrieve item from any tier with automatic promotion
   */
  async retrieveOptimally(key) {
    const tier = this.findItemTier(key);
    if (!tier) {
      return null;
    }

    const item = this.tiers[tier].get(key);
    if (!item) {
      return null;
    }

    // Track access
    this.trackAccess(key, 'read');

    // Decompress if needed
    let data = item.data;
    if (item.compressed) {
      data = await this.decompressItem(item);
    }

    // Consider promotion based on access pattern
    if (tier !== MemoryTier.HOT && this.shouldPromote(key)) {
      await this.promoteToTier(key, MemoryTier.HOT);
    }

    return data;
  }

  /**
   * Determine optimal tier for new data
   */
  determineOptimalTier(accessPattern) {
    switch (accessPattern) {
      case 'hot':
      case 'frequent':
        return MemoryTier.HOT;
      case 'warm':
      case 'occasional':
        return MemoryTier.WARM;
      case 'cold':
      case 'archive':
        return MemoryTier.COLD;
      default:
        return MemoryTier.WARM;
    }
  }

  /**
   * Find which tier contains the specified key
   */
  findItemTier(key) {
    for (const [tierName, tier] of Object.entries(this.tiers)) {
      if (tier.has(key)) {
        return tierName;
      }
    }
    return null;
  }

  /**
   * Get numeric level for tier comparison
   */
  getTierLevel(tier) {
    switch (tier) {
      case MemoryTier.HOT: return 4;
      case MemoryTier.WARM: return 3;
      case MemoryTier.COLD: return 2;
      case MemoryTier.FROZEN: return 1;
      default: return 0;
    }
  }

  /**
   * Check if item should be promoted based on access pattern
   */
  shouldPromote(key) {
    const accessInfo = this.accessTracker.get(key);
    if (!accessInfo) {
      return false;
    }

    const recentAccesses = accessInfo.count;
    const timeSinceLastAccess = Date.now() - accessInfo.lastAccess;

    // Promote if accessed frequently and recently
    return recentAccesses > 5 && timeSinceLastAccess < 300000; // 5 minutes
  }

  /**
   * Compress item data using gzip
   * @param {Object} item - The item to compress
   * @returns {Object} - Item with compressed data and compression metadata
   */
  async compressItem(item) {
    try {
      const jsonStr = JSON.stringify(item.data);
      const originalBuffer = Buffer.from(jsonStr, 'utf-8');
      const compressedBuffer = await gzipAsync(originalBuffer);

      const originalSize = originalBuffer.length;
      const compressedSize = compressedBuffer.length;
      const compressionRatio = compressedSize / originalSize;

      return {
        ...item,
        data: compressedBuffer.toString('base64'),
        originalSize,
        compressedSize,
        compressionRatio,
        compressed: true
      };
    } catch (error) {
      logger.error('Compression failed:', error);
      // Return item unchanged if compression fails
      return item;
    }
  }

  /**
   * Decompress item data using gzip
   * @param {Object} item - The item with compressed data
   * @returns {*} - The original uncompressed data
   */
  async decompressItem(item) {
    try {
      // If not compressed, return data as-is
      if (!item.compressed) {
        return item.data;
      }

      // Handle base64-encoded gzip data
      const compressedBuffer = Buffer.from(item.data, 'base64');
      const decompressedBuffer = await gunzipAsync(compressedBuffer);
      const jsonStr = decompressedBuffer.toString('utf-8');

      return JSON.parse(jsonStr);
    } catch (error) {
      logger.error('Decompression failed:', error);
      // Return data as-is if decompression fails (might already be uncompressed)
      return item.data;
    }
  }

  /**
   * Track tier transitions for analytics
   */
  trackTierTransition(key, fromTier, toTier) {
    const transition = `${fromTier}->${toTier}`;
    const count = this.analytics.tierTransitions.get(transition) || 0;
    this.analytics.tierTransitions.set(transition, count + 1);
  }

  /**
   * Calculate current memory utilization
   */
  calculateMemoryUtilization() {
    const totalItems = Object.values(this.tiers).reduce((sum, tier) => sum + tier.size, 0);
    const maxCapacity = this.options.maxHotMemory + this.options.maxWarmMemory + 10000; // Assume cold/frozen can be much larger
    return totalItems / maxCapacity;
  }

  /**
   * Get distribution of items across tiers
   */
  getTierDistribution() {
    return {
      [MemoryTier.HOT]: this.tiers[MemoryTier.HOT].size,
      [MemoryTier.WARM]: this.tiers[MemoryTier.WARM].size,
      [MemoryTier.COLD]: this.tiers[MemoryTier.COLD].size,
      [MemoryTier.FROZEN]: this.tiers[MemoryTier.FROZEN].size
    };
  }

  /**
   * Update performance metrics
   */
  updatePerformanceMetrics(executionTime, optimizationsApplied) {
    const metrics = this.analytics.performanceMetrics;
    metrics.optimizationCount++;

    // Update averages (simple moving average)
    const alpha = 0.1; // Smoothing factor
    metrics.avgAccessTime = metrics.avgAccessTime * (1 - alpha) + executionTime * alpha;
    metrics.memoryUtilization = this.calculateMemoryUtilization();

    // Calculate cache hit rate based on tier access
    const hotAccess = this.countTierAccesses(MemoryTier.HOT);
    const totalAccess = this.countTotalAccesses();
    metrics.cacheHitRate = totalAccess > 0 ? hotAccess / totalAccess : 0;
  }

  /**
   * Count accesses to a specific tier
   */
  countTierAccesses(tier) {
    let count = 0;
    for (const key of this.tiers[tier].keys()) {
      const accessInfo = this.accessTracker.get(key);
      if (accessInfo) {
        count += accessInfo.count;
      }
    }
    return count;
  }

  /**
   * Count total accesses across all tiers
   */
  countTotalAccesses() {
    let total = 0;
    for (const accessInfo of this.accessTracker.values()) {
      total += accessInfo.count;
    }
    return total;
  }

  /**
   * Start optimization scheduler
   */
  startOptimizationScheduler() {
    this.optimizationTimer = setInterval(async () => {
      try {
        await this.optimizeMemoryLayout();
      } catch (error) {
        this.logger.error('Scheduled memory optimization failed:', error);
      }
    }, this.options.optimizationInterval);
  }

  /**
   * Get comprehensive optimization analytics
   */
  getAnalytics() {
    return {
      accessPatterns: Array.from(this.analytics.accessPatterns.entries()),
      tierTransitions: Array.from(this.analytics.tierTransitions.entries()),
      performanceMetrics: this.analytics.performanceMetrics,
      tierDistribution: this.getTierDistribution(),
      memoryUtilization: this.calculateMemoryUtilization(),
      optimizationHistory: this.analytics.optimizationHistory.slice(-10) // Last 10 optimizations
    };
  }

  /**
   * Shutdown optimization engine
   */
  async shutdown() {
    if (this.optimizationTimer) {
      clearInterval(this.optimizationTimer);
      this.optimizationTimer = null;
    }

    // Perform final optimization
    await this.optimizeMemoryLayout();

    this.logger.info('🚀 Memory optimization engine shut down');
  }
}

module.exports = {
  MemoryOptimizationEngine,
  OptimizationStrategy,
  MemoryTier
};