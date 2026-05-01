/**
 * Version Vector Implementation
 * Sprint 2.1: Conflict Resolution Infrastructure
 *
 * Version vectors enable causality tracking in distributed systems.
 * Each instance maintains its own counter, and comparing vectors
 * reveals whether events are causally related or concurrent.
 *
 * Usage:
 *   const v1 = new VersionVector();
 *   v1.increment('instance-A');  // { 'instance-A': 1 }
 *   v1.increment('instance-A');  // { 'instance-A': 2 }
 *
 *   const v2 = new VersionVector();
 *   v2.increment('instance-B');  // { 'instance-B': 1 }
 *
 *   v1.compare(v2);  // 'concurrent' - neither dominates
 */

class VersionVector {
  /**
   * Create a new version vector
   * @param {Object} clock - Initial clock state (optional)
   */
  constructor(clock = {}) {
    this.clock = { ...clock };
  }

  /**
   * Increment the counter for a specific instance
   * @param {string} instanceId - The instance ID
   * @returns {VersionVector} - Returns this for chaining
   */
  increment(instanceId) {
    this.clock[instanceId] = (this.clock[instanceId] || 0) + 1;
    return this;
  }

  /**
   * Get the counter value for a specific instance
   * @param {string} instanceId - The instance ID
   * @returns {number} - The counter value (0 if not present)
   */
  get(instanceId) {
    return this.clock[instanceId] || 0;
  }

  /**
   * Set the counter value for a specific instance
   * @param {string} instanceId - The instance ID
   * @param {number} value - The counter value
   * @returns {VersionVector} - Returns this for chaining
   */
  set(instanceId, value) {
    this.clock[instanceId] = value;
    return this;
  }

  /**
   * Merge with another version vector (take max of each component)
   * @param {VersionVector|Object} other - The other version vector
   * @returns {VersionVector} - A new merged version vector
   */
  merge(other) {
    const otherClock = other instanceof VersionVector ? other.clock : other;
    const merged = new VersionVector({ ...this.clock });

    for (const [instanceId, value] of Object.entries(otherClock)) {
      merged.clock[instanceId] = Math.max(merged.clock[instanceId] || 0, value);
    }

    return merged;
  }

  /**
   * Compare this vector with another
   * @param {VersionVector|Object} other - The other version vector
   * @returns {string} - 'before', 'after', 'concurrent', or 'equal'
   *
   * Comparison rules:
   * - 'equal': All components are equal
   * - 'before': This vector is dominated by the other (other is causally after this)
   * - 'after': This vector dominates the other (this is causally after other)
   * - 'concurrent': Neither dominates - the events are concurrent
   */
  compare(other) {
    const otherClock = other instanceof VersionVector ? other.clock : other;

    // Collect all instance IDs from both vectors
    const allInstances = new Set([
      ...Object.keys(this.clock),
      ...Object.keys(otherClock)
    ]);

    let thisGreater = false;
    let otherGreater = false;

    for (const instanceId of allInstances) {
      const thisValue = this.clock[instanceId] || 0;
      const otherValue = otherClock[instanceId] || 0;

      if (thisValue > otherValue) {
        thisGreater = true;
      } else if (otherValue > thisValue) {
        otherGreater = true;
      }
    }

    if (thisGreater && otherGreater) {
      return 'concurrent';
    } else if (thisGreater) {
      return 'after';
    } else if (otherGreater) {
      return 'before';
    } else {
      return 'equal';
    }
  }

  /**
   * Check if this vector dominates another (is causally after)
   * @param {VersionVector|Object} other - The other version vector
   * @returns {boolean} - True if this vector dominates the other
   */
  dominates(other) {
    return this.compare(other) === 'after';
  }

  /**
   * Check if this vector is dominated by another (is causally before)
   * @param {VersionVector|Object} other - The other version vector
   * @returns {boolean} - True if this vector is dominated by the other
   */
  isDominatedBy(other) {
    return this.compare(other) === 'before';
  }

  /**
   * Check if this vector is concurrent with another
   * @param {VersionVector|Object} other - The other version vector
   * @returns {boolean} - True if vectors are concurrent (conflict potential)
   */
  isConcurrentWith(other) {
    return this.compare(other) === 'concurrent';
  }

  /**
   * Check if this vector equals another
   * @param {VersionVector|Object} other - The other version vector
   * @returns {boolean} - True if vectors are equal
   */
  equals(other) {
    return this.compare(other) === 'equal';
  }

  /**
   * Get all instance IDs in this vector
   * @returns {string[]} - Array of instance IDs
   */
  getInstances() {
    return Object.keys(this.clock);
  }

  /**
   * Get the total count across all instances (useful for ordering)
   * @returns {number} - Sum of all counters
   */
  getTotal() {
    return Object.values(this.clock).reduce((sum, v) => sum + v, 0);
  }

  /**
   * Create a copy of this version vector
   * @returns {VersionVector} - A new version vector with the same state
   */
  clone() {
    return new VersionVector({ ...this.clock });
  }

  /**
   * Convert to JSON-serializable object
   * @returns {Object} - The clock state
   */
  toJSON() {
    return { ...this.clock };
  }

  /**
   * Convert to string representation
   * @returns {string} - JSON string of the clock
   */
  toString() {
    return JSON.stringify(this.clock);
  }

  /**
   * Create a version vector from a JSON string or object
   * @param {string|Object} data - JSON string or object
   * @returns {VersionVector} - A new version vector
   */
  static fromJSON(data) {
    if (typeof data === 'string') {
      try {
        return new VersionVector(JSON.parse(data));
      } catch (e) {
        return new VersionVector();
      }
    }
    return new VersionVector(data || {});
  }

  /**
   * Create a version vector with an initial increment for an instance
   * @param {string} instanceId - The instance ID
   * @returns {VersionVector} - A new version vector
   */
  static create(instanceId) {
    return new VersionVector().increment(instanceId);
  }
}

module.exports = { VersionVector };
