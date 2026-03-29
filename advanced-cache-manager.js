/**
 * Advanced Cache Manager
 * Implements multi-layer caching with different strategies and adaptive algorithms
 */

const EventEmitter = require('events');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const MemoryMonitor = require('./lib/memory-monitor');

// Promisify zlib functions for async/await
const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

// Simple logger wrapper (avoids external dependency)
const logger = {
  info: (...args) => console.log('[AdvancedCacheManager]', ...args),
  error: (...args) => console.error('[AdvancedCacheManager]', ...args),
  debug: (...args) => {}, // Silent by default
  warn: (...args) => console.warn('[AdvancedCacheManager]', ...args)
};

class AdvancedCacheManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      enabled: true,
      strategy: 'adaptive', // lru, lfu, lru-ttl, adaptive
      maxSize: 1000000, // 1MB
      layers: {
        l1: { type: 'memory', size: 100000, ttl: 300 }, // 100KB, 5min
        l2: { type: 'disk', size: 500000, ttl: 3600 }, // 500KB, 1hour
        l3: { type: 'distributed', size: 1000000, ttl: 86400 } // 1MB, 24hours
      },
      adaptive: {
        learningRate: 0.1,
        decayFactor: 0.95,
        rebalanceInterval: 30000 // 30 seconds
      },
      compression: {
        enabled: true,
        threshold: 1024, // Compress entries larger than 1KB
        algorithm: 'gzip'
      },
      memoryPressure: {
        enabled: true,
        warningPercent: 70,
        criticalPercent: 85,
        emergencyPercent: 95,
        checkInterval: 30000, // 30 seconds
        autoEvict: true // Automatically evict on pressure
      },
      ...config
    };

    this.logger = logger;

    // Cache layers
    this.layers = new Map();

    // Access patterns for adaptive caching
    this.accessPatterns = new Map();
    this.hotKeys = new Set();
    this.coldKeys = new Set();

    // Performance metrics
    this.metrics = {
      hits: { l1: 0, l2: 0, l3: 0 },
      misses: { l1: 0, l2: 0, l3: 0 },
      evictions: { l1: 0, l2: 0, l3: 0 },
      promotions: 0,
      demotions: 0,
      compressionRatio: 0,
      totalSize: 0,
      operations: 0,
      pressureEvictions: 0
    };

    // Memory monitor instance
    this.memoryMonitor = null;

    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;

    try {
      // Initialize cache layers
      await this.initializeLayers();

      // Start adaptive rebalancing if enabled
      if (this.config.strategy === 'adaptive') {
        this.startAdaptiveRebalancing();
      }

      // Start cleanup processes
      this.startCleanupProcesses();

      // Initialize memory pressure monitoring
      if (this.config.memoryPressure.enabled) {
        this.initializeMemoryMonitor();
      }

      this.initialized = true;
      this.logger.info('Advanced cache manager initialized');
    } catch (error) {
      this.logger.error('Failed to initialize cache manager:', error);
      throw error;
    }
  }

  /**
   * Initialize memory pressure monitoring
   */
  initializeMemoryMonitor() {
    const pressureConfig = this.config.memoryPressure;

    this.memoryMonitor = new MemoryMonitor({
      warningPercent: pressureConfig.warningPercent,
      criticalPercent: pressureConfig.criticalPercent,
      emergencyPercent: pressureConfig.emergencyPercent,
      checkInterval: pressureConfig.checkInterval,
      onPressureChange: (level, status) => {
        this.handleMemoryPressure(level, status);
      }
    });

    // Listen for events
    this.memoryMonitor.on('levelChange', (event) => {
      this.emit('memoryPressure', event);
      this.logger.warn(`Memory pressure changed: ${event.previousLevel} -> ${event.currentLevel}`);
    });

    // Start monitoring
    this.memoryMonitor.start();
    this.logger.info('Memory pressure monitoring started');
  }

  /**
   * Handle memory pressure changes
   */
  async handleMemoryPressure(level, status) {
    if (!this.config.memoryPressure.autoEvict) return;

    const recommendation = this.memoryMonitor.getEvictionRecommendation();

    if (!recommendation.shouldEvict) return;

    this.logger.warn(`Memory pressure (${level}): ${recommendation.message}`);

    // Evict from each layer based on recommendation
    if (recommendation.l1Percent > 0) {
      await this.evictPercent('l1', recommendation.l1Percent);
    }
    if (recommendation.l2Percent > 0) {
      await this.evictPercent('l2', recommendation.l2Percent);
    }
    if (recommendation.l3Percent > 0) {
      await this.evictPercent('l3', recommendation.l3Percent);
    }

    // Force GC if recommended
    if (recommendation.forceGC) {
      this.memoryMonitor.forceGC();
    }
  }

  /**
   * Evict a percentage of entries from a cache layer
   */
  async evictPercent(layerName, percent) {
    const layer = this.layers.get(layerName);
    if (!layer) return 0;

    const keys = layer.getKeys();
    const evictCount = Math.ceil(keys.length * (percent / 100));

    if (evictCount === 0) return 0;

    // Sort by access frequency (LFU) for smarter eviction
    const sortedKeys = await this.sortKeysByAccessFrequency(keys, layerName);

    // Evict the least accessed entries
    let evicted = 0;
    for (let i = 0; i < evictCount && i < sortedKeys.length; i++) {
      await layer.delete(sortedKeys[i]);
      evicted++;
    }

    this.metrics.evictions[layerName] += evicted;
    this.metrics.pressureEvictions += evicted;

    this.logger.info(`Evicted ${evicted} entries from ${layerName} (${percent}%)`);
    return evicted;
  }

  /**
   * Sort keys by access frequency (ascending - least accessed first)
   */
  async sortKeysByAccessFrequency(keys, layerName) {
    const layer = this.layers.get(layerName);
    if (!layer) return keys;

    const keyScores = [];
    for (const key of keys) {
      const accessPattern = this.accessPatterns.get(key);
      const score = accessPattern ? accessPattern.count : 0;
      keyScores.push({ key, score });
    }

    // Sort by score ascending (least accessed first)
    keyScores.sort((a, b) => a.score - b.score);

    return keyScores.map(ks => ks.key);
  }

  /**
   * Get memory pressure status
   */
  getMemoryPressureStatus() {
    if (!this.memoryMonitor) {
      return { enabled: false };
    }

    return {
      enabled: true,
      ...this.memoryMonitor.getStatus(),
      recommendation: this.memoryMonitor.getEvictionRecommendation(),
      trend: this.memoryMonitor.getMemoryTrend(),
      historyStats: this.memoryMonitor.getHistoryStats()
    };
  }

  /**
   * Manually trigger pressure-based eviction
   */
  async triggerPressureEviction() {
    if (!this.memoryMonitor) {
      throw new Error('Memory monitor not initialized');
    }

    const status = this.memoryMonitor.getStatus();
    await this.handleMemoryPressure(status.level, status);

    return {
      level: status.level,
      evicted: this.metrics.pressureEvictions
    };
  }

  /**
   * Initialize cache layers
   */
  async initializeLayers() {
    for (const [layerName, layerConfig] of Object.entries(this.config.layers)) {
      const layer = this.createCacheLayer(layerName, layerConfig);

      // Initialize layers that require async setup (disk, distributed)
      if (typeof layer.initialize === 'function') {
        await layer.initialize();
      }

      this.layers.set(layerName, layer);
    }

    this.logger.info('Cache layers initialized:', Array.from(this.layers.keys()));

    // Warm cache from persistent layers if configured
    if (this.config.warmOnStartup !== false) {
      await this.warmCache();
    }
  }

  /**
   * Warm L1 cache from persistent layers (L2 disk, L3 distributed)
   * Loads frequently accessed entries into memory for fast access
   */
  async warmCache() {
    const l1 = this.layers.get('l1');
    const l2 = this.layers.get('l2');
    const l3 = this.layers.get('l3');

    if (!l1) return;

    let warmedCount = 0;
    const maxWarmEntries = this.config.warmCacheLimit || 50;

    // Warm from L2 disk cache first (faster)
    if (l2 && typeof l2.getKeys === 'function') {
      const l2Keys = l2.getKeys().slice(0, maxWarmEntries);
      for (const key of l2Keys) {
        if (warmedCount >= maxWarmEntries) break;

        try {
          const entry = await l2.get(key);
          if (entry && !await l1.has(key)) {
            await l1.set(key, entry);
            warmedCount++;
          }
        } catch (error) {
          // Skip problematic entries
        }
      }
    }

    // Then from L3 distributed cache if space remains
    if (l3 && typeof l3.getKeys === 'function' && warmedCount < maxWarmEntries) {
      const l3Keys = l3.getKeys().slice(0, maxWarmEntries - warmedCount);
      for (const key of l3Keys) {
        if (warmedCount >= maxWarmEntries) break;

        try {
          const entry = await l3.get(key);
          if (entry && !await l1.has(key)) {
            await l1.set(key, entry);
            warmedCount++;
          }
        } catch (error) {
          // Skip problematic entries
        }
      }
    }

    if (warmedCount > 0) {
      this.logger.info(`Cache warmed with ${warmedCount} entries from persistent layers`);
    }
  }

  /**
   * Create cache layer based on type
   */
  createCacheLayer(name, config) {
    switch (config.type) {
      case 'memory':
        return new MemoryCacheLayer(name, config);
      case 'disk':
        return new DiskCacheLayer(name, config);
      case 'distributed':
        return new DistributedCacheLayer(name, config);
      default:
        throw new Error(`Unknown cache layer type: ${config.type}`);
    }
  }

  /**
   * Get value from cache with multi-layer lookup
   */
  async get(segment, key, options = {}) {
    this.metrics.operations++;

    try {
      const cacheKey = this.buildCacheKey(segment, key);

      // Record access pattern
      this.recordAccess(cacheKey);

      // Try each layer in order
      for (const [layerName, layer] of this.layers) {
        const entry = await layer.get(cacheKey);

        if (entry) {
          this.metrics.hits[layerName]++;

          // Promote to higher layers if beneficial
          if (this.shouldPromote(cacheKey, layerName)) {
            await this.promoteEntry(cacheKey, entry, layerName);
          }

          // Update access statistics
          this.updateAccessStats(cacheKey, true);

          // Decompress and parse the cached data
          const value = await this.deserializeCacheEntry(entry);
          return value;
        } else {
          this.metrics.misses[layerName]++;
        }
      }

      // Cache miss - update statistics
      this.updateAccessStats(cacheKey, false);
      return null;

    } catch (error) {
      this.logger.error(`Cache get failed for ${segment}:${key}:`, error);
      throw error;
    }
  }

  /**
   * Set value in cache with intelligent layer selection
   */
  async set(segment, key, value, options = {}) {
    this.metrics.operations++;

    try {
      const cacheKey = this.buildCacheKey(segment, key);

      // Create cache entry
      const entry = await this.createCacheEntry(value, options);

      // Select optimal layer based on strategy
      const targetLayer = this.selectOptimalLayer(cacheKey, entry, options);

      // Store in selected layer
      await this.storeInLayer(targetLayer, cacheKey, entry);

      // Update access patterns
      this.recordAccess(cacheKey);

      this.emit('set', { segment, key, layer: targetLayer, size: entry.size });

    } catch (error) {
      this.logger.error(`Cache set failed for ${segment}:${key}:`, error);
      throw error;
    }
  }

  /**
   * Create cache entry with compression if needed
   */
  async createCacheEntry(value, options = {}) {
    const serialized = JSON.stringify(value);
    const originalSize = Buffer.byteLength(serialized, 'utf8');

    let data = serialized;
    let compressed = false;

    // Apply compression if enabled and threshold met
    if (this.config.compression.enabled && originalSize > this.config.compression.threshold) {
      data = await this.compress(serialized);
      compressed = true;

      const compressedSize = Buffer.byteLength(data, 'utf8');
      this.metrics.compressionRatio = compressedSize / originalSize;
    }

    return {
      data,
      originalSize,
      size: Buffer.byteLength(data, 'utf8'),
      compressed,
      timestamp: Date.now(),
      ttl: options.ttl,
      accessCount: 0,
      lastAccess: Date.now(),
      checksum: this.calculateChecksum(data)
    };
  }

  /**
   * Deserialize cache entry back to original value
   */
  async deserializeCacheEntry(entry) {
    let data = entry.data;

    // Decompress if needed
    if (entry.compressed) {
      data = await this.decompress(data);
    }

    // Parse JSON back to original value
    return JSON.parse(data);
  }

  /**
   * Select optimal cache layer based on strategy and patterns
   */
  selectOptimalLayer(key, entry, options = {}) {
    // Use specified layer if provided
    if (options.layer && this.layers.has(options.layer)) {
      return options.layer;
    }

    switch (this.config.strategy) {
      case 'adaptive':
        return this.selectAdaptiveLayer(key, entry);
      case 'lru':
      case 'lfu':
      case 'lru-ttl':
        return this.selectBasedOnSize(entry);
      default:
        return 'l1'; // Default to L1
    }
  }

  /**
   * Select layer using adaptive algorithm
   */
  selectAdaptiveLayer(key, entry) {
    const pattern = this.accessPatterns.get(key);

    if (!pattern) {
      return 'l1'; // New keys start in L1
    }

    // Consider access frequency, recency, and size
    const frequency = pattern.accessCount / pattern.age;
    const recency = Date.now() - pattern.lastAccess;
    const size = entry.size;

    // Adaptive scoring algorithm
    let score = 0;
    score += frequency * 0.4; // 40% weight on frequency
    score += (1 / (recency + 1)) * 0.3; // 30% weight on recency (inverse)
    score += (1 / (size + 1)) * 0.2; // 20% weight on size (inverse)
    score += (this.hotKeys.has(key) ? 1 : 0) * 0.1; // 10% weight on hot key status

    if (score > 0.7) return 'l1';
    if (score > 0.4) return 'l2';
    return 'l3';
  }

  /**
   * Select layer based on entry size
   */
  selectBasedOnSize(entry) {
    for (const [layerName, layer] of this.layers) {
      if (entry.size <= layer.config.size) {
        return layerName;
      }
    }
    return Array.from(this.layers.keys()).pop(); // Use largest layer
  }

  /**
   * Store entry in specified layer
   */
  async storeInLayer(layerName, key, entry) {
    const layer = this.layers.get(layerName);
    if (!layer) {
      throw new Error(`Cache layer not found: ${layerName}`);
    }

    // Check if eviction is needed
    if (await layer.needsEviction(entry.size)) {
      await this.performEviction(layerName, entry.size);
    }

    await layer.set(key, entry);
    this.metrics.totalSize += entry.size;
  }

  /**
   * Promote entry to higher cache layer
   */
  async promoteEntry(key, entry, currentLayer) {
    const layers = Array.from(this.layers.keys());
    const currentIndex = layers.indexOf(currentLayer);

    if (currentIndex > 0) {
      const targetLayer = layers[currentIndex - 1];
      const targetLayerObj = this.layers.get(targetLayer);

      // Check if promotion is possible
      if (await targetLayerObj.canAccommodate(entry.size)) {
        await this.storeInLayer(targetLayer, key, entry);
        this.metrics.promotions++;

        this.logger.debug(`Promoted ${key} from ${currentLayer} to ${targetLayer}`);
      }
    }
  }

  /**
   * Should promote entry based on access patterns
   */
  shouldPromote(key, currentLayer) {
    const pattern = this.accessPatterns.get(key);
    if (!pattern) return false;

    // Promote if frequently accessed
    const frequency = pattern.accessCount / pattern.age;
    const promotionThreshold = currentLayer === 'l3' ? 0.3 : 0.5;

    return frequency > promotionThreshold;
  }

  /**
   * Perform cache eviction using configured strategy
   */
  async performEviction(layerName, requiredSpace) {
    const layer = this.layers.get(layerName);
    let evicted = 0;

    while (evicted < requiredSpace && layer.size > 0) {
      const victimKey = await this.selectEvictionVictim(layer);
      if (!victimKey) break;

      const entry = await layer.get(victimKey);
      await layer.delete(victimKey);

      if (entry) {
        evicted += entry.size;
        this.metrics.evictions[layerName]++;
        this.metrics.totalSize -= entry.size;

        // Optionally demote to lower layer
        await this.considerDemotion(victimKey, entry, layerName);
      }
    }

    this.logger.debug(`Evicted ${evicted} bytes from ${layerName}`);
  }

  /**
   * Select eviction victim based on strategy
   */
  async selectEvictionVictim(layer) {
    switch (this.config.strategy) {
      case 'lru':
        return layer.getLRUKey();
      case 'lfu':
        return layer.getLFUKey();
      case 'lru-ttl':
        return layer.getExpiredOrLRUKey();
      case 'adaptive':
        return this.selectAdaptiveVictim(layer);
      default:
        return layer.getLRUKey();
    }
  }

  /**
   * Select eviction victim using adaptive algorithm
   */
  selectAdaptiveVictim(layer) {
    // Implement adaptive victim selection based on access patterns
    const keys = layer.getKeys();
    let worstKey = null;
    let worstScore = Infinity;

    for (const key of keys) {
      const pattern = this.accessPatterns.get(key);
      if (!pattern) continue;

      const frequency = pattern.accessCount / pattern.age;
      const recency = Date.now() - pattern.lastAccess;

      // Lower score = better eviction candidate
      const score = frequency * 0.6 + (1 / (recency + 1)) * 0.4;

      if (score < worstScore) {
        worstScore = score;
        worstKey = key;
      }
    }

    return worstKey;
  }

  /**
   * Consider demoting evicted entry to lower layer
   */
  async considerDemotion(key, entry, currentLayer) {
    const layers = Array.from(this.layers.keys());
    const currentIndex = layers.indexOf(currentLayer);

    if (currentIndex < layers.length - 1) {
      const targetLayer = layers[currentIndex + 1];
      const targetLayerObj = this.layers.get(targetLayer);

      if (await targetLayerObj.canAccommodate(entry.size)) {
        await this.storeInLayer(targetLayer, key, entry);
        this.metrics.demotions++;

        this.logger.debug(`Demoted ${key} from ${currentLayer} to ${targetLayer}`);
      }
    }
  }

  /**
   * Record access pattern for adaptive caching
   */
  recordAccess(key) {
    const now = Date.now();
    const pattern = this.accessPatterns.get(key) || {
      accessCount: 0,
      firstAccess: now,
      lastAccess: now,
      age: 0
    };

    pattern.accessCount++;
    pattern.lastAccess = now;
    pattern.age = now - pattern.firstAccess;

    this.accessPatterns.set(key, pattern);

    // Update hot/cold key classification
    this.classifyKey(key, pattern);
  }

  /**
   * Classify key as hot or cold based on access pattern
   */
  classifyKey(key, pattern) {
    const frequency = pattern.accessCount / (pattern.age || 1);
    const hotThreshold = 0.5; // Configurable
    const coldThreshold = 0.1; // Configurable

    if (frequency > hotThreshold) {
      this.hotKeys.add(key);
      this.coldKeys.delete(key);
    } else if (frequency < coldThreshold) {
      this.coldKeys.add(key);
      this.hotKeys.delete(key);
    }
  }

  /**
   * Update access statistics
   */
  updateAccessStats(key, hit) {
    // Implementation for detailed access statistics
  }

  /**
   * Start adaptive rebalancing process
   */
  startAdaptiveRebalancing() {
    setInterval(async () => {
      await this.rebalanceLayers();
    }, this.config.adaptive.rebalanceInterval);

    this.logger.info('Adaptive rebalancing started');
  }

  /**
   * Rebalance cache layers based on access patterns
   */
  async rebalanceLayers() {
    try {
      // Analyze access patterns and rebalance hot/cold data
      for (const [key, pattern] of this.accessPatterns) {
        const currentLayer = await this.findKeyLayer(key);
        if (!currentLayer) continue;

        const optimalLayer = this.selectAdaptiveLayer(key, { size: 0 }); // Size 0 for analysis

        if (currentLayer !== optimalLayer) {
          await this.moveKeyBetweenLayers(key, currentLayer, optimalLayer);
        }
      }

      this.logger.debug('Cache layers rebalanced');
    } catch (error) {
      this.logger.error('Cache rebalancing failed:', error);
    }
  }

  /**
   * Find which layer contains a key
   */
  async findKeyLayer(key) {
    for (const [layerName, layer] of this.layers) {
      if (await layer.has(key)) {
        return layerName;
      }
    }
    return null;
  }

  /**
   * Move key between cache layers
   */
  async moveKeyBetweenLayers(key, fromLayer, toLayer) {
    const sourceLayer = this.layers.get(fromLayer);
    const targetLayer = this.layers.get(toLayer);

    if (!sourceLayer || !targetLayer) return;

    const entry = await sourceLayer.get(key);
    if (!entry) return;

    if (await targetLayer.canAccommodate(entry.size)) {
      await targetLayer.set(key, entry);
      await sourceLayer.delete(key);

      this.logger.debug(`Moved ${key} from ${fromLayer} to ${toLayer}`);
    }
  }

  /**
   * Start cleanup processes
   */
  startCleanupProcesses() {
    // TTL cleanup
    setInterval(async () => {
      await this.cleanupExpiredEntries();
    }, 60000); // Every minute

    // Pattern cleanup
    setInterval(() => {
      this.cleanupAccessPatterns();
    }, 300000); // Every 5 minutes

    this.logger.info('Cache cleanup processes started');
  }

  /**
   * Cleanup expired entries
   */
  async cleanupExpiredEntries() {
    const now = Date.now();

    for (const [layerName, layer] of this.layers) {
      await layer.cleanupExpired(now);
    }
  }

  /**
   * Cleanup old access patterns
   */
  cleanupAccessPatterns() {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours

    for (const [key, pattern] of this.accessPatterns) {
      if (now - pattern.lastAccess > maxAge) {
        this.accessPatterns.delete(key);
        this.hotKeys.delete(key);
        this.coldKeys.delete(key);
      }
    }
  }

  /**
   * Compress data using gzip
   * @param {string} data - The data to compress (should be serialized string)
   * @returns {string} - Base64-encoded compressed data
   */
  async compress(data) {
    try {
      const buffer = Buffer.from(data, 'utf-8');
      const compressed = await gzipAsync(buffer);
      return compressed.toString('base64');
    } catch (error) {
      this.logger.error('Compression failed:', error);
      // Return original data if compression fails
      return data;
    }
  }

  /**
   * Decompress data using gzip
   * @param {string} data - Base64-encoded compressed data
   * @returns {string} - Original decompressed data
   */
  async decompress(data) {
    try {
      const buffer = Buffer.from(data, 'base64');
      const decompressed = await gunzipAsync(buffer);
      return decompressed.toString('utf-8');
    } catch (error) {
      this.logger.error('Decompression failed:', error);
      // Return original data if decompression fails (might not be compressed)
      return data;
    }
  }

  /**
   * Calculate checksum
   */
  calculateChecksum(data) {
    return crypto.createHash('md5').update(data).digest('hex');
  }

  /**
   * Build cache key
   */
  buildCacheKey(segment, key) {
    return `${segment}:${key}`;
  }

  /**
   * Get cache statistics
   */
  getStatistics() {
    return {
      metrics: this.metrics,
      layers: Object.fromEntries(
        Array.from(this.layers.entries()).map(([name, layer]) => [
          name,
          layer.getStatistics()
        ])
      ),
      accessPatterns: this.accessPatterns.size,
      hotKeys: this.hotKeys.size,
      coldKeys: this.coldKeys.size,
      strategy: this.config.strategy,
      memoryPressure: this.getMemoryPressureStatus()
    };
  }

  /**
   * Cleanup cache
   */
  async cleanup() {
    await this.cleanupExpiredEntries();
    this.cleanupAccessPatterns();
  }

  /**
   * Shutdown cache manager
   */
  async shutdown() {
    // Stop memory monitor
    if (this.memoryMonitor) {
      this.memoryMonitor.stop();
    }

    // Shutdown all cache layers
    for (const [layerName, layer] of this.layers) {
      await layer.shutdown();
    }

    this.logger.info('Advanced cache manager shutdown complete');
  }

  /**
   * Calculate adaptive TTL based on access patterns and memory pressure
   */
  calculateAdaptiveTTL(key, baseTTL) {
    let multiplier = 1.0;

    // Adjust based on memory pressure
    if (this.memoryMonitor) {
      multiplier *= this.memoryMonitor.getAdaptiveTTLMultiplier();
    }

    // Adjust based on access frequency
    const accessPattern = this.accessPatterns.get(key);
    if (accessPattern) {
      // Frequently accessed keys get longer TTL (up to 3x)
      const frequencyMultiplier = Math.min(accessPattern.count / 10, 3);
      multiplier *= (1 + frequencyMultiplier * 0.5);

      // Recently accessed keys get bonus
      const recencyBonus = accessPattern.lastAccess > Date.now() - 60000 ? 1.2 : 1.0;
      multiplier *= recencyBonus;
    }

    // Apply multiplier with bounds
    const adaptedTTL = baseTTL * multiplier;

    // Cap at 24 hours max, 30 seconds min
    return Math.max(30, Math.min(adaptedTTL, 86400));
  }

  /**
   * Extend TTL on access (for frequently used entries)
   */
  async extendTTLOnAccess(key, layerName, currentTTL) {
    if (!this.config.memoryPressure.enabled) {
      return currentTTL;
    }

    // Only extend if memory pressure is normal
    if (this.memoryMonitor && this.memoryMonitor.getPressureLevel() !== 'normal') {
      return currentTTL;
    }

    // Extend by 25% up to max TTL
    const layer = this.layers.get(layerName);
    const maxTTL = layer ? layer.config.ttl : 86400;
    const newTTL = Math.min(currentTTL * 1.25, maxTTL);

    return newTTL;
  }
}

/**
 * Base cache layer class
 */
class CacheLayer {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this.data = new Map();
    this.accessOrder = [];
    this.size = 0;
  }

  async get(key) {
    const entry = this.data.get(key);
    if (!entry) return null;

    // Check TTL
    if (entry.ttl && Date.now() > entry.timestamp + entry.ttl * 1000) {
      await this.delete(key);
      return null;
    }

    // Update access order
    this.updateAccessOrder(key);
    entry.accessCount++;
    entry.lastAccess = Date.now();

    return entry;
  }

  async set(key, entry) {
    // Remove existing entry if present
    if (this.data.has(key)) {
      await this.delete(key);
    }

    this.data.set(key, entry);
    this.size += entry.size;
    this.updateAccessOrder(key);
  }

  async delete(key) {
    const entry = this.data.get(key);
    if (entry) {
      this.data.delete(key);
      this.size -= entry.size;
      this.removeFromAccessOrder(key);
    }
  }

  async has(key) {
    return this.data.has(key);
  }

  async needsEviction(requiredSize) {
    return this.size + requiredSize > this.config.size;
  }

  async canAccommodate(requiredSize) {
    return requiredSize <= this.config.size;
  }

  updateAccessOrder(key) {
    this.removeFromAccessOrder(key);
    this.accessOrder.push(key);
  }

  removeFromAccessOrder(key) {
    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
  }

  getLRUKey() {
    return this.accessOrder.length > 0 ? this.accessOrder[0] : null;
  }

  getLFUKey() {
    let lfu = null;
    let minAccess = Infinity;

    for (const [key, entry] of this.data) {
      if (entry.accessCount < minAccess) {
        minAccess = entry.accessCount;
        lfu = key;
      }
    }

    return lfu;
  }

  getExpiredOrLRUKey() {
    const now = Date.now();

    // First try to find expired entry
    for (const [key, entry] of this.data) {
      if (entry.ttl && now > entry.timestamp + entry.ttl * 1000) {
        return key;
      }
    }

    // Fall back to LRU
    return this.getLRUKey();
  }

  getKeys() {
    return Array.from(this.data.keys());
  }

  async cleanupExpired(now) {
    const keysToDelete = [];

    for (const [key, entry] of this.data) {
      if (entry.ttl && now > entry.timestamp + entry.ttl * 1000) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      await this.delete(key);
    }
  }

  getStatistics() {
    return {
      name: this.name,
      type: this.config.type,
      entries: this.data.size,
      size: this.size,
      maxSize: this.config.size,
      utilization: this.size / this.config.size
    };
  }

  async shutdown() {
    this.data.clear();
    this.accessOrder = [];
    this.size = 0;
  }
}

/**
 * Memory cache layer - fastest access
 */
class MemoryCacheLayer extends CacheLayer {
  constructor(name, config) {
    super(name, config);
  }
}

/**
 * Disk cache layer - persistent file-based storage (Sprint 3.1)
 */
class DiskCacheLayer extends CacheLayer {
  constructor(name, config) {
    super(name, config);
    const os = require('os');
    const path = require('path');

    this.cacheDir = config.cacheDir || path.join(os.homedir(), '.bumba', 'memory', 'cache', name);
    this.indexFile = path.join(this.cacheDir, 'index.json');
    this.dataDir = path.join(this.cacheDir, 'data');
    this.metaDir = path.join(this.cacheDir, 'meta');
    this.index = new Map();
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;

    const fs = require('fs-extra');

    await fs.ensureDir(this.dataDir);
    await fs.ensureDir(this.metaDir);
    await this.loadIndex();
    this.initialized = true;
  }

  async loadIndex() {
    const fs = require('fs-extra');

    try {
      if (await fs.pathExists(this.indexFile)) {
        const data = await fs.readJson(this.indexFile);
        this.index = new Map(Object.entries(data.index || {}));
        this.size = data.totalSize || 0;
      }
    } catch (error) {
      // Start with empty index if load fails
      this.index = new Map();
      this.size = 0;
    }
  }

  async saveIndex() {
    const fs = require('fs-extra');

    try {
      await fs.writeJson(this.indexFile, {
        index: Object.fromEntries(this.index),
        totalSize: this.size,
        updatedAt: Date.now()
      }, { spaces: 2 });
    } catch (error) {
      // Log but don't throw - index can be rebuilt
    }
  }

  generateFileId(key) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(key).digest('hex').substring(0, 16);
  }

  async get(key) {
    await this.initialize();
    const fs = require('fs-extra');
    const path = require('path');

    const fileId = this.index.get(key);
    if (!fileId) return null;

    const dataPath = path.join(this.dataDir, `${fileId}.json`);
    const metaPath = path.join(this.metaDir, `${fileId}.meta`);

    try {
      // Check if files exist
      if (!await fs.pathExists(dataPath)) {
        this.index.delete(key);
        await this.saveIndex();
        return null;
      }

      // Read metadata first to check TTL
      let meta = {};
      if (await fs.pathExists(metaPath)) {
        meta = await fs.readJson(metaPath);

        // Check TTL
        if (meta.ttl && Date.now() > meta.timestamp + meta.ttl * 1000) {
          await this.delete(key);
          return null;
        }
      }

      // Read entry data
      const entry = await fs.readJson(dataPath);

      // Update access metadata
      meta.accessCount = (meta.accessCount || 0) + 1;
      meta.lastAccessed = Date.now();
      await fs.writeJson(metaPath, meta);

      // Merge meta into entry
      return { ...entry, ...meta };
    } catch (error) {
      return null;
    }
  }

  async set(key, entry) {
    await this.initialize();
    const fs = require('fs-extra');
    const path = require('path');

    const fileId = this.generateFileId(key);
    const dataPath = path.join(this.dataDir, `${fileId}.json`);
    const metaPath = path.join(this.metaDir, `${fileId}.meta`);

    try {
      // Remove old entry size if exists
      if (this.index.has(key)) {
        const oldFileId = this.index.get(key);
        const oldDataPath = path.join(this.dataDir, `${oldFileId}.json`);
        if (await fs.pathExists(oldDataPath)) {
          const oldEntry = await fs.readJson(oldDataPath);
          this.size -= oldEntry.size || 0;
        }
      }

      // Write data and metadata
      await fs.writeJson(dataPath, entry, { spaces: 0 });
      await fs.writeJson(metaPath, {
        key,
        ttl: entry.ttl,
        timestamp: entry.timestamp || Date.now(),
        lastAccessed: Date.now(),
        accessCount: 0,
        size: entry.size
      });

      // Update index
      this.index.set(key, fileId);
      this.size += entry.size || 0;
      await this.saveIndex();
    } catch (error) {
      throw error;
    }
  }

  async delete(key) {
    await this.initialize();
    const fs = require('fs-extra');
    const path = require('path');

    const fileId = this.index.get(key);
    if (!fileId) return;

    const dataPath = path.join(this.dataDir, `${fileId}.json`);
    const metaPath = path.join(this.metaDir, `${fileId}.meta`);

    try {
      // Get entry size before deletion
      if (await fs.pathExists(dataPath)) {
        const entry = await fs.readJson(dataPath);
        this.size -= entry.size || 0;
      }

      await fs.remove(dataPath);
      await fs.remove(metaPath);

      this.index.delete(key);
      await this.saveIndex();
    } catch (error) {
      // Ignore deletion errors
    }
  }

  async has(key) {
    await this.initialize();
    return this.index.has(key);
  }

  getKeys() {
    return Array.from(this.index.keys());
  }

  async cleanupExpired(now) {
    await this.initialize();
    const fs = require('fs-extra');
    const path = require('path');

    for (const [key, fileId] of this.index) {
      const metaPath = path.join(this.metaDir, `${fileId}.meta`);

      try {
        if (await fs.pathExists(metaPath)) {
          const meta = await fs.readJson(metaPath);
          if (meta.ttl && now > meta.timestamp + meta.ttl * 1000) {
            await this.delete(key);
          }
        }
      } catch (error) {
        // Skip problematic entries
      }
    }
  }

  getStatistics() {
    return {
      name: this.name,
      type: 'disk',
      entries: this.index.size,
      size: this.size,
      maxSize: this.config.size,
      utilization: this.config.size > 0 ? this.size / this.config.size : 0,
      cacheDir: this.cacheDir
    };
  }

  async shutdown() {
    await this.saveIndex();
    this.index.clear();
    this.size = 0;
  }
}

/**
 * Distributed cache layer - file-based with locking for multi-instance sharing
 * Enables multiple MCP server instances to share cached data safely
 */
class DistributedCacheLayer extends CacheLayer {
  constructor(name, config) {
    super(name, config);
    const os = require('os');
    const path = require('path');

    this.sharedDir = config.sharedDir || path.join(os.homedir(), '.bumba', 'memory', 'shared-cache', name);
    this.dataDir = path.join(this.sharedDir, 'data');
    this.metaDir = path.join(this.sharedDir, 'meta');
    this.locksDir = path.join(this.sharedDir, 'locks');
    this.indexFile = path.join(this.sharedDir, 'index.json');

    // Instance identity for tracking writes
    this.instanceId = config.instanceId || `instance-${process.pid}-${Date.now().toString(36)}`;

    // Lock configuration
    this.lockTimeout = config.lockTimeout || 5000;
    this.lockRetryInterval = config.lockRetryInterval || 50;
    this.staleLockAge = config.staleLockAge || 30000; // 30 seconds

    this.initialized = false;
    this.index = new Map();
    this.size = 0;
  }

  async initialize() {
    if (this.initialized) return;

    const fs = require('fs-extra');

    try {
      await fs.ensureDir(this.dataDir);
      await fs.ensureDir(this.metaDir);
      await fs.ensureDir(this.locksDir);
      await this.loadIndex();
      this.initialized = true;
    } catch (error) {
      this.initialized = true; // Prevent repeated init attempts
    }
  }

  async loadIndex() {
    const fs = require('fs-extra');

    // Acquire shared lock for reading index
    const lockAcquired = await this.acquireLock('__index__', 'read');

    try {
      if (await fs.pathExists(this.indexFile)) {
        const data = await fs.readJson(this.indexFile);
        this.index = new Map(Object.entries(data.entries || {}));
        this.size = data.size || 0;
      }
    } catch (error) {
      this.index = new Map();
      this.size = 0;
    } finally {
      if (lockAcquired) {
        await this.releaseLock('__index__');
      }
    }
  }

  async saveIndex() {
    const fs = require('fs-extra');

    // Acquire exclusive lock for writing index
    const lockAcquired = await this.acquireLock('__index__', 'write');

    try {
      const data = {
        entries: Object.fromEntries(this.index),
        size: this.size,
        lastModifiedBy: this.instanceId,
        lastModified: Date.now()
      };
      await fs.writeJson(this.indexFile, data, { spaces: 0 });
    } finally {
      if (lockAcquired) {
        await this.releaseLock('__index__');
      }
    }
  }

  generateFileId(key) {
    return crypto.createHash('md5').update(key).digest('hex').substring(0, 16);
  }

  getLockPath(key) {
    const path = require('path');
    const fileId = key === '__index__' ? 'index' : this.generateFileId(key);
    return path.join(this.locksDir, `${fileId}.lock`);
  }

  async acquireLock(key, mode = 'write') {
    const fs = require('fs-extra');
    const lockPath = this.getLockPath(key);
    const startTime = Date.now();

    while (Date.now() - startTime < this.lockTimeout) {
      try {
        // Check for stale locks
        if (await fs.pathExists(lockPath)) {
          const lockInfo = await fs.readJson(lockPath);

          // Remove stale locks
          if (Date.now() - lockInfo.timestamp > this.staleLockAge) {
            await fs.remove(lockPath);
          } else if (mode === 'read' && lockInfo.mode === 'read') {
            // Multiple readers allowed
            lockInfo.readers = lockInfo.readers || [];
            lockInfo.readers.push(this.instanceId);
            await fs.writeJson(lockPath, lockInfo);
            return true;
          } else {
            // Wait for lock to be released
            await this.sleep(this.lockRetryInterval);
            continue;
          }
        }

        // Create lock file
        await fs.writeJson(lockPath, {
          mode,
          instanceId: this.instanceId,
          timestamp: Date.now(),
          readers: mode === 'read' ? [this.instanceId] : []
        });
        return true;
      } catch (error) {
        // Lock contention, retry
        await this.sleep(this.lockRetryInterval);
      }
    }

    // Timeout - return false but don't throw
    return false;
  }

  async releaseLock(key) {
    const fs = require('fs-extra');
    const lockPath = this.getLockPath(key);

    try {
      if (await fs.pathExists(lockPath)) {
        const lockInfo = await fs.readJson(lockPath);

        if (lockInfo.mode === 'read' && lockInfo.readers) {
          // Remove this instance from readers
          lockInfo.readers = lockInfo.readers.filter(id => id !== this.instanceId);

          if (lockInfo.readers.length > 0) {
            await fs.writeJson(lockPath, lockInfo);
          } else {
            await fs.remove(lockPath);
          }
        } else if (lockInfo.instanceId === this.instanceId) {
          await fs.remove(lockPath);
        }
      }
    } catch (error) {
      // Ignore lock release errors
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async get(key) {
    await this.initialize();
    const fs = require('fs-extra');
    const path = require('path');

    // First check if key exists in index (without lock for performance)
    await this.loadIndex(); // Reload to get latest from other instances

    const fileId = this.index.get(key);
    if (!fileId) return null;

    const dataPath = path.join(this.dataDir, `${fileId}.json`);
    const metaPath = path.join(this.metaDir, `${fileId}.meta`);

    // Acquire read lock
    const lockAcquired = await this.acquireLock(key, 'read');

    try {
      if (!await fs.pathExists(dataPath)) {
        return null;
      }

      // Check metadata for TTL
      let meta = {};
      if (await fs.pathExists(metaPath)) {
        meta = await fs.readJson(metaPath);

        // Check TTL
        if (meta.ttl && Date.now() > meta.timestamp + meta.ttl * 1000) {
          // Entry expired - schedule deletion but don't block
          setImmediate(() => this.delete(key));
          return null;
        }
      }

      // Read entry data
      const entry = await fs.readJson(dataPath);

      // Update access metadata asynchronously (don't block read)
      setImmediate(async () => {
        const writeLockAcquired = await this.acquireLock(key, 'write');
        if (writeLockAcquired) {
          try {
            meta.accessCount = (meta.accessCount || 0) + 1;
            meta.lastAccessed = Date.now();
            meta.lastAccessedBy = this.instanceId;
            await fs.writeJson(metaPath, meta);
          } catch (e) {
            // Ignore async metadata update errors
          } finally {
            await this.releaseLock(key);
          }
        }
      });

      return { ...entry, ...meta };
    } catch (error) {
      return null;
    } finally {
      if (lockAcquired) {
        await this.releaseLock(key);
      }
    }
  }

  async set(key, entry) {
    await this.initialize();
    const fs = require('fs-extra');
    const path = require('path');

    const fileId = this.generateFileId(key);
    const dataPath = path.join(this.dataDir, `${fileId}.json`);
    const metaPath = path.join(this.metaDir, `${fileId}.meta`);

    // Acquire exclusive write lock
    const lockAcquired = await this.acquireLock(key, 'write');
    if (!lockAcquired) {
      throw new Error(`Failed to acquire write lock for key: ${key}`);
    }

    try {
      // Reload index to get current state from other instances
      await this.loadIndex();

      // Remove old entry size if exists
      if (this.index.has(key)) {
        const oldFileId = this.index.get(key);
        const oldDataPath = path.join(this.dataDir, `${oldFileId}.json`);
        if (await fs.pathExists(oldDataPath)) {
          const oldEntry = await fs.readJson(oldDataPath);
          this.size -= oldEntry.size || 0;
        }
      }

      // Write entry data
      await fs.writeJson(dataPath, entry, { spaces: 0 });

      // Write metadata
      await fs.writeJson(metaPath, {
        key,
        ttl: entry.ttl,
        timestamp: entry.timestamp || Date.now(),
        lastAccessed: Date.now(),
        accessCount: 0,
        size: entry.size,
        writtenBy: this.instanceId,
        writtenAt: Date.now()
      });

      // Update index
      this.index.set(key, fileId);
      this.size += entry.size || 0;
      await this.saveIndex();
    } finally {
      await this.releaseLock(key);
    }
  }

  async delete(key) {
    await this.initialize();
    const fs = require('fs-extra');
    const path = require('path');

    // Reload index
    await this.loadIndex();

    const fileId = this.index.get(key);
    if (!fileId) return;

    const dataPath = path.join(this.dataDir, `${fileId}.json`);
    const metaPath = path.join(this.metaDir, `${fileId}.meta`);

    // Acquire exclusive write lock
    const lockAcquired = await this.acquireLock(key, 'write');

    try {
      // Get entry size before deletion
      if (await fs.pathExists(dataPath)) {
        const entry = await fs.readJson(dataPath);
        this.size -= entry.size || 0;
      }

      await fs.remove(dataPath);
      await fs.remove(metaPath);

      this.index.delete(key);
      await this.saveIndex();
    } catch (error) {
      // Ignore deletion errors
    } finally {
      if (lockAcquired) {
        await this.releaseLock(key);
      }
    }
  }

  async has(key) {
    await this.initialize();
    await this.loadIndex(); // Reload to check other instances' writes
    return this.index.has(key);
  }

  getKeys() {
    return Array.from(this.index.keys());
  }

  async cleanupExpired(now) {
    await this.initialize();
    await this.loadIndex();

    const fs = require('fs-extra');
    const path = require('path');

    for (const [key, fileId] of this.index) {
      const metaPath = path.join(this.metaDir, `${fileId}.meta`);

      try {
        if (await fs.pathExists(metaPath)) {
          const meta = await fs.readJson(metaPath);
          if (meta.ttl && now > meta.timestamp + meta.ttl * 1000) {
            await this.delete(key);
          }
        }
      } catch (error) {
        // Skip problematic entries
      }
    }
  }

  async cleanupStaleLocks() {
    const fs = require('fs-extra');
    const path = require('path');

    try {
      const lockFiles = await fs.readdir(this.locksDir);
      const now = Date.now();

      for (const lockFile of lockFiles) {
        const lockPath = path.join(this.locksDir, lockFile);
        try {
          const lockInfo = await fs.readJson(lockPath);
          if (now - lockInfo.timestamp > this.staleLockAge) {
            await fs.remove(lockPath);
          }
        } catch (error) {
          // Remove corrupted lock files
          await fs.remove(lockPath);
        }
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  }

  getStatistics() {
    return {
      name: this.name,
      type: 'distributed',
      entries: this.index.size,
      size: this.size,
      maxSize: this.config.size,
      utilization: this.config.size > 0 ? this.size / this.config.size : 0,
      sharedDir: this.sharedDir,
      instanceId: this.instanceId
    };
  }

  async shutdown() {
    await this.saveIndex();
    await this.cleanupStaleLocks();
    this.index.clear();
    this.size = 0;
  }
}

module.exports = {
  AdvancedCacheManager,
  CacheLayer,
  MemoryCacheLayer,
  DiskCacheLayer,
  DistributedCacheLayer
};