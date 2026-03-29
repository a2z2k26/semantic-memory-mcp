/**
 * Resilience Memory - Compatibility Wrapper
 *
 * This module was consolidated into the main resilience system.
 * This wrapper provides backward compatibility for existing tests.
 *
 * NOTE: New code should use the resilience system directly from src/core/resilience
 */

const EventEmitter = require('events');

// Stub implementations for @bumba/shared components
// These provide basic functionality without the external dependency

class EnhancedCircuitBreaker {
  constructor(options = {}) {
    this.state = 'closed';
    this.failures = 0;
    this.maxFailures = options.maxFailures || 5;
    this.resetTimeout = options.resetTimeout || 60000;
  }

  recordFailure() {
    this.failures++;
    if (this.failures >= this.maxFailures) {
      this.state = 'open';
    }
  }

  recordSuccess() {
    this.state = 'closed';
    this.failures = 0;
  }

  canExecute() {
    return this.state === 'closed' || this.state === 'half-open';
  }
}

class BumbaResilienceManager {
  constructor() {
    this.circuitBreakers = new Map();
  }

  getCircuitBreaker(name) {
    if (!this.circuitBreakers.has(name)) {
      this.circuitBreakers.set(name, new EnhancedCircuitBreaker());
    }
    return this.circuitBreakers.get(name);
  }
}

// Singleton resilience manager
let resilienceManagerInstance = null;

function getResilienceManager() {
  if (!resilienceManagerInstance) {
    resilienceManagerInstance = new BumbaResilienceManager();
  }
  return resilienceManagerInstance;
}

/**
 * Resilience Memory System (Legacy Compatibility Layer)
 */
class ResilienceMemory extends EventEmitter {
  constructor(memoryManager) {
    super();

    this.memoryManager = memoryManager;
    this.failurePatterns = new Map();
    this.recoveryStrategies = new Map();
    this.circuitBreakers = new Map();

    this.config = {
      maxFailures: 5,
      resetTimeout: 60000,
      retentionDays: 7
    };

    this.metrics = {
      totalFailures: 0,
      totalRecoveries: 0,
      predictedFailures: 0,
      preventedFailures: 0,
      avgRecoveryTime: 0
    };

    this.resilienceManager = getResilienceManager();
  }

  /**
   * Record a failure pattern
   */
  async recordFailure(agentId, errorType, details, metadata = {}) {
    this.metrics.totalFailures++;

    // Get or create failure pattern
    let pattern = this.failurePatterns.get(errorType);
    if (!pattern) {
      pattern = {
        errorType,
        frequency: 0,
        occurrences: []
      };
      this.failurePatterns.set(errorType, pattern);
    }

    // Record occurrence
    pattern.frequency++;
    pattern.occurrences.push({
      agentId,
      timestamp: Date.now(),
      details,
      metadata
    });

    // Emit failure event
    this.emit('failure:recorded', {
      agentId,
      errorType,
      details,
      metadata,
      pattern
    });

    // Update circuit breaker
    await this.updateCircuitBreaker(agentId);

    // Store in memory if memory manager available
    if (this.memoryManager && this.memoryManager.addSemanticMemory) {
      await this.memoryManager.addSemanticMemory({
        agentId,
        content: `Failure: ${errorType} - ${details}`,
        type: 'failure_pattern',
        metadata: { errorType, ...metadata }
      });
    }

    return {
      recorded: true,
      pattern
    };
  }

  /**
   * Record a successful recovery
   */
  async recordRecovery(agentId, errorType, strategy, duration, successful) {
    this.metrics.totalRecoveries++;

    // Update average recovery time
    const totalRecoveries = this.metrics.totalRecoveries;
    this.metrics.avgRecoveryTime =
      (this.metrics.avgRecoveryTime * (totalRecoveries - 1) + duration) / totalRecoveries;

    // Get or create recovery strategy
    let strategyData = this.recoveryStrategies.get(errorType);
    if (!strategyData) {
      strategyData = {
        strategies: [],
        successRate: 0,
        totalAttempts: 0,
        successfulAttempts: 0
      };
      this.recoveryStrategies.set(errorType, strategyData);
    }

    // Update strategy
    strategyData.strategies.push({ strategy, duration });
    strategyData.totalAttempts++;
    if (successful) {
      strategyData.successfulAttempts++;
    }
    strategyData.successRate = strategyData.successfulAttempts / strategyData.totalAttempts;

    // Reset circuit breaker on successful recovery
    if (successful) {
      const breaker = this.circuitBreakers.get(agentId);
      if (breaker && breaker.state === 'half-open') {
        breaker.state = 'closed';
        breaker.failures = 0;
      }
    }

    return {
      recorded: true,
      strategy: strategyData
    };
  }

  /**
   * Update circuit breaker for agent
   */
  async updateCircuitBreaker(agentId) {
    let breaker = this.circuitBreakers.get(agentId);
    if (!breaker) {
      breaker = {
        agentId,
        state: 'closed',
        failures: 0,
        lastFailure: null,
        resetTimer: null
      };
      this.circuitBreakers.set(agentId, breaker);
    }

    breaker.failures++;
    breaker.lastFailure = Date.now();

    if (breaker.failures >= this.config.maxFailures) {
      breaker.state = 'open';
      this.emit('circuit:opened', { agentId, failures: breaker.failures });

      // Schedule reset to half-open
      clearTimeout(breaker.resetTimer);
      breaker.resetTimer = setTimeout(() => {
        breaker.state = 'half-open';
        this.emit('circuit:half-open', { agentId });
      }, this.config.resetTimeout);
    }
  }

  /**
   * Get circuit breaker status
   */
  getCircuitBreakerStatus(agentId) {
    const breaker = this.circuitBreakers.get(agentId);
    if (!breaker) {
      return { state: 'closed', healthy: true, failures: 0 };
    }

    return {
      state: breaker.state,
      healthy: breaker.state === 'closed',
      failures: breaker.failures,
      lastFailure: breaker.lastFailure
    };
  }

  /**
   * Predict failure escalation
   */
  async predictFailureEscalation(errorType) {
    const pattern = this.failurePatterns.get(errorType);
    if (!pattern || pattern.occurrences.length < 2) {
      return {
        probability: 0,
        isAccelerating: false,
        recommendation: 'Insufficient data for prediction'
      };
    }

    // Check if failures are accelerating
    const occurrences = pattern.occurrences;
    const intervals = [];
    for (let i = 1; i < occurrences.length; i++) {
      intervals.push(occurrences[i].timestamp - occurrences[i - 1].timestamp);
    }

    // Simple acceleration check: are intervals getting shorter?
    let isAccelerating = false;
    let accelerationRatio = 1.0;

    if (intervals.length >= 2) {
      const midpoint = Math.floor(intervals.length / 2);
      const avgEarly = intervals.slice(0, midpoint)
        .reduce((a, b) => a + b, 0) / midpoint;
      const avgLate = intervals.slice(midpoint)
        .reduce((a, b) => a + b, 0) / (intervals.length - midpoint);

      isAccelerating = avgLate < avgEarly;
      accelerationRatio = avgEarly > 0 ? avgEarly / Math.max(avgLate, 1) : 1.0;
    }

    // Calculate probability based on acceleration
    const baseProbability = pattern.frequency >= 5 ? 0.6 : 0.3;
    const probability = isAccelerating ? Math.min(baseProbability * accelerationRatio, 0.95) : baseProbability;
    const recommendation = isAccelerating
      ? `Implement circuit breaker for ${errorType}`
      : `Monitor ${errorType} patterns`;

    // Emit prediction if high probability
    if (probability > 0.5) {
      this.emit('failure:predicted', {
        errorType,
        probability,
        isAccelerating,
        recommendation
      });
    }

    return {
      probability,
      isAccelerating,
      recommendation
    };
  }

  /**
   * Get best recovery strategy for error type
   */
  getBestRecoveryStrategy(errorType) {
    const strategy = this.recoveryStrategies.get(errorType);
    if (strategy && strategy.strategies.length > 0) {
      // Find fastest successful strategy
      const fastest = strategy.strategies.reduce((best, current) =>
        current.duration < best.duration ? current : best
      );

      const alternatives = strategy.strategies
        .filter(s => s.strategy !== fastest.strategy)
        .map(s => s.strategy);

      return {
        strategy: fastest.strategy,
        expectedDuration: fastest.duration,
        successRate: strategy.successRate,
        alternatives
      };
    }

    // Return default strategy
    return this.getDefaultRecoveryStrategy(errorType);
  }

  /**
   * Get default recovery strategy for error type
   */
  getDefaultRecoveryStrategy(errorType) {
    const strategies = {
      'timeout': { strategy: 'retry-with-backoff', expectedDuration: 5000 },
      'api-timeout': { strategy: 'retry-with-backoff', expectedDuration: 5000 },
      'connection': { strategy: 'retry', expectedDuration: 3000 },
      'network-error': { strategy: 'retry', expectedDuration: 3000 },
      'out-of-memory': { strategy: 'garbage-collection', expectedDuration: 2000 },
      'memory-leak': { strategy: 'garbage-collection', expectedDuration: 2000 },
      'memory-overflow': { strategy: 'garbage-collection', expectedDuration: 2000 }
    };

    return strategies[errorType] || {
      strategy: 'retry',
      expectedDuration: 3000,
      successRate: 0.5
    };
  }

  /**
   * Get fallback agent for failed agent
   */
  async getFallbackAgent(failedAgentId, task) {
    if (!this.memoryManager || !this.memoryManager.searchSemanticMemories) {
      return null;
    }

    const results = await this.memoryManager.searchSemanticMemories(
      `successful ${task.type} agent performance`
    );

    if (results.results && results.results.length > 0) {
      // Find agent with best performance
      const best = results.results
        .filter(r => r.agentId !== failedAgentId)
        .sort((a, b) => (b.metadata?.performance || 0) - (a.metadata?.performance || 0))[0];

      if (best) {
        this.emit('fallback:selected', {
          failed: failedAgentId,
          fallback: best.agentId,
          task
        });

        return best.agentId;
      }
    }

    return null;
  }

  /**
   * Learn from failure resolution
   */
  async learnFromFailure(errorType, resolution) {
    this.emit('learning:captured', {
      errorType,
      ...resolution
    });

    if (this.memoryManager && this.memoryManager.addSemanticMemory) {
      await this.memoryManager.addSemanticMemory({
        agentId: resolution.agentId,
        content: `Learned: ${resolution.lesson}`,
        type: 'learning',
        metadata: { errorType, strategy: resolution.strategy }
      });
    }
  }

  /**
   * Get resilience metrics
   */
  getMetrics() {
    return { ...this.metrics };
  }

  /**
   * Cleanup old failure data
   */
  async cleanup() {
    const cutoffTime = Date.now() - (this.config.retentionDays * 24 * 60 * 60 * 1000);

    for (const [errorType, pattern] of this.failurePatterns.entries()) {
      pattern.occurrences = pattern.occurrences.filter(
        occ => occ.timestamp > cutoffTime
      );

      if (pattern.occurrences.length === 0) {
        this.failurePatterns.delete(errorType);
      } else {
        pattern.frequency = pattern.occurrences.length;
      }
    }
  }
}

module.exports = ResilienceMemory;
