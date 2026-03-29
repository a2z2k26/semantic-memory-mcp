/**
 * Memory Pressure Monitor
 * Monitors system and process memory to trigger cache eviction
 */

const os = require('os');
const EventEmitter = require('events');

class MemoryMonitor extends EventEmitter {
  constructor(options = {}) {
    super();

    this.thresholds = {
      warning: options.warningPercent || 70,
      critical: options.criticalPercent || 85,
      emergency: options.emergencyPercent || 95
    };

    this.checkInterval = options.checkInterval || 30000; // 30 seconds
    this.processHeapLimit = options.processHeapLimit || 512 * 1024 * 1024; // 512MB

    this.currentLevel = 'normal';
    this.history = [];
    this.maxHistory = options.maxHistory || 100;
    this.intervalId = null;

    // Callback for when pressure level changes
    this.onPressureChange = options.onPressureChange || null;
  }

  /**
   * Get system memory usage
   */
  getSystemMemory() {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;

    return {
      total,
      free,
      used,
      percentUsed: (used / total) * 100,
      totalGB: (total / (1024 * 1024 * 1024)).toFixed(2),
      freeGB: (free / (1024 * 1024 * 1024)).toFixed(2),
      usedGB: (used / (1024 * 1024 * 1024)).toFixed(2)
    };
  }

  /**
   * Get process memory usage
   */
  getProcessMemory() {
    const usage = process.memoryUsage();

    return {
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      external: usage.external,
      rss: usage.rss,
      arrayBuffers: usage.arrayBuffers || 0,
      heapUsedMB: (usage.heapUsed / (1024 * 1024)).toFixed(2),
      heapTotalMB: (usage.heapTotal / (1024 * 1024)).toFixed(2),
      rssMB: (usage.rss / (1024 * 1024)).toFixed(2),
      heapPercentUsed: (usage.heapUsed / usage.heapTotal) * 100,
      heapLimitPercent: (usage.heapUsed / this.processHeapLimit) * 100
    };
  }

  /**
   * Get current memory pressure level
   */
  getPressureLevel() {
    const system = this.getSystemMemory();
    const process = this.getProcessMemory();

    // Check both system and process memory
    const systemPercent = system.percentUsed;
    const processPercent = process.heapLimitPercent;

    // Use the higher of the two
    const effectivePercent = Math.max(systemPercent, processPercent);

    if (effectivePercent >= this.thresholds.emergency) {
      return 'emergency';
    }
    if (effectivePercent >= this.thresholds.critical) {
      return 'critical';
    }
    if (effectivePercent >= this.thresholds.warning) {
      return 'warning';
    }
    return 'normal';
  }

  /**
   * Get comprehensive memory status
   */
  getStatus() {
    const system = this.getSystemMemory();
    const process = this.getProcessMemory();
    const level = this.getPressureLevel();

    return {
      level,
      system,
      process,
      thresholds: this.thresholds,
      timestamp: Date.now()
    };
  }

  /**
   * Record current state to history
   */
  recordHistory() {
    const status = this.getStatus();

    this.history.push({
      timestamp: status.timestamp,
      level: status.level,
      systemPercent: status.system.percentUsed,
      heapPercent: status.process.heapPercentUsed
    });

    // Trim history if needed
    while (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    return status;
  }

  /**
   * Check memory and emit events if level changes
   */
  check() {
    const status = this.recordHistory();
    const previousLevel = this.currentLevel;

    if (status.level !== previousLevel) {
      this.currentLevel = status.level;
      this.emit('levelChange', {
        previousLevel,
        currentLevel: status.level,
        status
      });

      // Call callback if provided
      if (this.onPressureChange) {
        this.onPressureChange(status.level, status);
      }
    }

    // Always emit status update
    this.emit('status', status);

    return status;
  }

  /**
   * Start automatic monitoring
   */
  start() {
    if (this.intervalId) return;

    // Initial check
    this.check();

    // Start interval
    this.intervalId = setInterval(() => {
      this.check();
    }, this.checkInterval);

    this.emit('started');
    return this;
  }

  /**
   * Stop automatic monitoring
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.emit('stopped');
    }
    return this;
  }

  /**
   * Get eviction recommendation based on pressure level
   */
  getEvictionRecommendation() {
    const level = this.getPressureLevel();

    switch (level) {
      case 'emergency':
        return {
          shouldEvict: true,
          l1Percent: 50,
          l2Percent: 40,
          l3Percent: 30,
          forceGC: true,
          message: 'Emergency: Aggressive eviction required'
        };
      case 'critical':
        return {
          shouldEvict: true,
          l1Percent: 30,
          l2Percent: 20,
          l3Percent: 0,
          forceGC: true,
          message: 'Critical: Moderate eviction recommended'
        };
      case 'warning':
        return {
          shouldEvict: true,
          l1Percent: 10,
          l2Percent: 0,
          l3Percent: 0,
          forceGC: false,
          message: 'Warning: Light eviction recommended'
        };
      default:
        return {
          shouldEvict: false,
          l1Percent: 0,
          l2Percent: 0,
          l3Percent: 0,
          forceGC: false,
          message: 'Normal: No eviction needed'
        };
    }
  }

  /**
   * Calculate adaptive TTL based on memory pressure
   */
  getAdaptiveTTLMultiplier() {
    const level = this.getPressureLevel();

    switch (level) {
      case 'emergency':
        return 0.25; // Reduce TTL to 25%
      case 'critical':
        return 0.5; // Reduce TTL to 50%
      case 'warning':
        return 0.75; // Reduce TTL to 75%
      default:
        return 1.0; // Normal TTL
    }
  }

  /**
   * Get memory trend (rising, stable, falling)
   */
  getMemoryTrend() {
    if (this.history.length < 5) {
      return 'unknown';
    }

    const recent = this.history.slice(-5);
    const first = recent[0].systemPercent;
    const last = recent[recent.length - 1].systemPercent;
    const diff = last - first;

    if (diff > 5) return 'rising';
    if (diff < -5) return 'falling';
    return 'stable';
  }

  /**
   * Get statistics about memory history
   */
  getHistoryStats() {
    if (this.history.length === 0) {
      return null;
    }

    const systemPercents = this.history.map(h => h.systemPercent);
    const heapPercents = this.history.map(h => h.heapPercent);

    const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
    const max = arr => Math.max(...arr);
    const min = arr => Math.min(...arr);

    return {
      samples: this.history.length,
      system: {
        avg: avg(systemPercents).toFixed(2),
        max: max(systemPercents).toFixed(2),
        min: min(systemPercents).toFixed(2)
      },
      heap: {
        avg: avg(heapPercents).toFixed(2),
        max: max(heapPercents).toFixed(2),
        min: min(heapPercents).toFixed(2)
      },
      trend: this.getMemoryTrend(),
      levelCounts: this.history.reduce((acc, h) => {
        acc[h.level] = (acc[h.level] || 0) + 1;
        return acc;
      }, {})
    };
  }

  /**
   * Force garbage collection if available
   */
  forceGC() {
    if (global.gc) {
      global.gc();
      return true;
    }
    return false;
  }
}

module.exports = MemoryMonitor;
