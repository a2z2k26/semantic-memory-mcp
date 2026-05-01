/**
 * PeerRegistry - Agent-to-Agent Registration and Discovery
 * Sprint: Peer Discovery (Task 2)
 */

const Logger = require('../lib/logger');

const STALE_THRESHOLD_SECONDS = 300; // 5 minutes
const logger = new Logger('PeerRegistry');

class PeerRegistry {
  constructor(storageAdapter) {
    this.storage = storageAdapter;
  }

  /**
   * Register an agent in the peer registry
   * @param {Object} options - Registration options
   * @returns {Object} Registered peer details
   */
  register({ agentId, machine, capabilities, endpoint, metadata = {} }) {
    try {
      // Validate endpoint URL if provided. Reject non-http(s) protocols
      // (e.g. file:, javascript:, data:) to prevent SSRF-adjacent attacks
      // when other peers follow this URL.
      if (endpoint !== undefined && endpoint !== null && endpoint !== '') {
        let parsed;
        try {
          parsed = new URL(endpoint);
        } catch (urlErr) {
          throw new Error(`Invalid endpoint URL: ${endpoint}`);
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error(
            `Invalid endpoint protocol "${parsed.protocol}" - only http: and https: are allowed`
          );
        }
      }

      const stmt = this.storage.db.prepare(`
        INSERT OR REPLACE INTO peers (
          agent_id,
          machine,
          status,
          capabilities,
          endpoint,
          last_seen,
          registered_at,
          metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const now = Date.now();
      stmt.run(
        agentId,
        machine,
        'online',
        JSON.stringify(Array.isArray(capabilities) ? capabilities : [capabilities]),
        endpoint || null,
        now,
        now,
        JSON.stringify(metadata)
      );

      logger.info(`✅ Peer registered: ${agentId} on ${machine}`);

      return {
        agentId,
        machine,
        status: 'online',
        capabilities,
        endpoint,
        registeredAt: now
      };
    } catch (error) {
      logger.error('Failed to register peer:', error);
      throw error;
    }
  }

  /**
   * Send heartbeat for a peer
   * @param {string} agentId - Agent ID
   * @param {Object} options - Heartbeat options (status, currentTask)
   * @returns {Object} Updated peer
   */
  heartbeat(agentId, { status, currentTask } = {}) {
    try {
      const now = Date.now();
      const updates = [];
      const values = [];

      updates.push('last_seen = ?');
      values.push(now);

      if (status) {
        updates.push('status = ?');
        values.push(status);
      }

      if (currentTask) {
        updates.push('current_task = ?');
        values.push(currentTask);
      }

      values.push(agentId);

      const stmt = this.storage.db.prepare(`
        UPDATE peers
        SET ${updates.join(', ')}
        WHERE agent_id = ?
      `);

      const result = stmt.run(...values);

      if (result.changes === 0) {
        logger.warn(`Heartbeat for unknown peer: ${agentId}`);
        return null;
      }

      logger.debug(`💓 Heartbeat from ${agentId}`);
      return { agentId, lastSeen: now, status, currentTask };
    } catch (error) {
      logger.error('Failed to send heartbeat:', error);
      throw error;
    }
  }

  /**
   * Deregister a peer
   * @param {string} agentId - Agent ID
   * @returns {Object} Deregisted peer info
   */
  deregister(agentId) {
    try {
      // Delete messages first to avoid foreign key constraint
      const deleteMessagesStmt = this.storage.db.prepare(`
        DELETE FROM peer_messages
        WHERE source_agent_id = ? OR target_agent_id = ?
      `);
      deleteMessagesStmt.run(agentId, agentId);

      // Then delete the peer
      const stmt = this.storage.db.prepare('DELETE FROM peers WHERE agent_id = ?');
      const result = stmt.run(agentId);

      if (result.changes > 0) {
        logger.info(`🔴 Peer deregistered: ${agentId}`);
        return { agentId, deregisteredAt: Date.now() };
      }

      logger.warn(`Attempted to deregister unknown peer: ${agentId}`);
      return null;
    } catch (error) {
      logger.error('Failed to deregister peer:', error);
      throw error;
    }
  }

  /**
   * Get a specific peer by ID
   * @param {string} agentId - Agent ID
   * @returns {Object} Peer details or null
   */
  getPeer(agentId) {
    try {
      const stmt = this.storage.db.prepare('SELECT * FROM peers WHERE agent_id = ?');
      const row = stmt.get(agentId);

      if (!row) {
        return null;
      }

      return this._formatPeerRow(row);
    } catch (error) {
      logger.error('Failed to get peer:', error);
      throw error;
    }
  }

  /**
   * List peers with optional filters
   * @param {Object} options - Filter options
   * @returns {Array} Array of peers
   */
  listPeers({ machine, status, capability, includeStale = false } = {}) {
    try {
      let query = 'SELECT * FROM peers WHERE 1=1';
      const params = [];

      if (machine) {
        query += ' AND machine = ?';
        params.push(machine);
      }

      if (status) {
        query += ' AND status = ?';
        params.push(status);
      }

      if (!includeStale) {
        const staleThreshold = Date.now() - STALE_THRESHOLD_SECONDS * 1000;
        query += ' AND last_seen > ?';
        params.push(staleThreshold);
      }

      query += ' ORDER BY last_seen DESC';

      const stmt = this.storage.db.prepare(query);
      const rows = stmt.all(...params);

      // Filter by capability if specified
      let peers = rows.map(row => this._formatPeerRow(row));

      if (capability) {
        peers = peers.filter(p =>
          p.capabilities.includes(capability)
        );
      }

      return peers;
    } catch (error) {
      logger.error('Failed to list peers:', error);
      throw error;
    }
  }

  /**
   * Clean up stale peers (no heartbeat for 5 minutes)
   * Marks them as offline instead of deleting
   * @returns {Object} Cleanup stats
   */
  cleanupStale() {
    try {
      const staleThreshold = Date.now() - STALE_THRESHOLD_SECONDS * 1000;

      const stmt = this.storage.db.prepare(`
        UPDATE peers
        SET status = 'offline'
        WHERE status = 'online' AND last_seen <= ?
      `);

      const result = stmt.run(staleThreshold);

      if (result.changes > 0) {
        logger.info(`🔄 Marked ${result.changes} peers as offline`);
      }

      return {
        markedOffline: result.changes,
        timestamp: Date.now()
      };
    } catch (error) {
      logger.error('Failed to cleanup stale peers:', error);
      throw error;
    }
  }

  /**
   * Get peer count
   * @returns {number} Total number of registered peers
   */
  count() {
    try {
      const stmt = this.storage.db.prepare('SELECT COUNT(*) as count FROM peers');
      return stmt.get().count;
    } catch (error) {
      logger.error('Failed to count peers:', error);
      throw error;
    }
  }

  /**
   * Format a database row into a peer object
   * @private
   */
  _formatPeerRow(row) {
    return {
      agentId: row.agent_id,
      machine: row.machine,
      status: row.status,
      capabilities: JSON.parse(row.capabilities || '[]'),
      endpoint: row.endpoint,
      lastSeen: row.last_seen,
      registeredAt: row.registered_at,
      currentTask: row.current_task,
      metadata: JSON.parse(row.metadata || '{}'),
      versionVector: JSON.parse(row.version_vector || '{}')
    };
  }
}

module.exports = PeerRegistry;
