/**
 * PeerMessaging - Agent-to-Agent Message Passing
 * Sprint: Peer Discovery (Task 3)
 */

const crypto = require('crypto');
const Logger = require('../lib/logger');

const logger = new Logger('PeerMessaging');

class PeerMessaging {
  constructor(storageAdapter) {
    this.storage = storageAdapter;
  }

  /**
   * Send a message from one agent to another
   * @param {Object} options - Message options
   * @returns {Object} Message details
   */
  sendMessage({ source, target, message, messageType = 'standard' }) {
    try {
      const messageId = crypto.randomUUID();
      const now = Date.now();

      const stmt = this.storage.db.prepare(`
        INSERT INTO peer_messages (
          message_id,
          source_agent_id,
          target_agent_id,
          message,
          message_type,
          created_at,
          delivered
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        messageId,
        source,
        target,
        typeof message === 'string' ? message : JSON.stringify(message),
        messageType,
        now,
        0
      );

      logger.info(`📤 Message sent from ${source} to ${target}`);

      return {
        messageId,
        source,
        target,
        messageType,
        createdAt: now,
        delivered: false
      };
    } catch (error) {
      logger.error('Failed to send message:', error);
      throw error;
    }
  }

  /**
   * Check incoming messages for an agent
   * Marks messages as delivered when retrieved
   * @param {string} agentId - Agent ID
   * @param {Object} options - Options (limit, markDelivered)
   * @returns {Array} Messages for the agent
   */
  checkMessages(agentId, { limit = 100, markDelivered = true } = {}) {
    try {
      const stmt = this.storage.db.prepare(`
        SELECT * FROM peer_messages
        WHERE target_agent_id = ? AND delivered = 0
        ORDER BY created_at ASC
        LIMIT ?
      `);

      let rows = stmt.all(agentId, limit);

      if (rows.length > 0 && markDelivered) {
        const now = Date.now();
        const updateStmt = this.storage.db.prepare(`
          UPDATE peer_messages
          SET delivered = 1, delivered_at = ?
          WHERE target_agent_id = ? AND delivered = 0
        `);

        updateStmt.run(now, agentId);

        logger.debug(`✅ Marked ${rows.length} messages as delivered for ${agentId}`);

        // Mark rows as delivered in-memory
        rows = rows.map(row => ({
          ...row,
          delivered: 1,
          delivered_at: now
        }));
      }

      return rows.map(row => this._formatMessageRow(row));
    } catch (error) {
      logger.error('Failed to check messages:', error);
      throw error;
    }
  }

  /**
   * Broadcast a message to all active peers
   * @param {Object} options - Message options
   * @param {Object} peerRegistry - PeerRegistry instance for getting peer list
   * @returns {Object} Broadcast stats
   */
  broadcast({ source, message, messageType = 'broadcast' }, peerRegistry) {
    try {
      const peers = peerRegistry.listPeers({ status: 'online' });
      const targetPeers = peers.filter(p => p.agentId !== source);

      let sentCount = 0;
      for (const peer of targetPeers) {
        this.sendMessage({
          source,
          target: peer.agentId,
          message,
          messageType
        });
        sentCount++;
      }

      logger.info(`📢 Broadcast from ${source} to ${sentCount} peers`);

      return {
        source,
        sentCount,
        totalPeers: peers.length,
        timestamp: Date.now()
      };
    } catch (error) {
      logger.error('Failed to broadcast message:', error);
      throw error;
    }
  }

  /**
   * Clean up old delivered messages
   * @param {Object} options - Cleanup options
   * @returns {Object} Cleanup stats
   */
  cleanup({ maxAgeSeconds = 3600 } = {}) {
    try {
      const cutoff = Date.now() - maxAgeSeconds * 1000;

      const stmt = this.storage.db.prepare(`
        DELETE FROM peer_messages
        WHERE delivered = 1 AND delivered_at < ?
      `);

      const result = stmt.run(cutoff);

      if (result.changes > 0) {
        logger.info(`🧹 Deleted ${result.changes} old delivered messages`);
      }

      return {
        deletedCount: result.changes,
        maxAgeSeconds,
        timestamp: Date.now()
      };
    } catch (error) {
      logger.error('Failed to cleanup messages:', error);
      throw error;
    }
  }

  /**
   * Format a message database row
   * @private
   */
  _formatMessageRow(row) {
    let parsedMessage = row.message;
    try {
      parsedMessage = JSON.parse(row.message);
    } catch (e) {
      // Keep as string if not valid JSON
    }

    return {
      messageId: row.message_id,
      source: row.source_agent_id,
      target: row.target_agent_id,
      message: parsedMessage,
      messageType: row.message_type,
      delivered: row.delivered === 1,
      deliveredAt: row.delivered_at,
      createdAt: row.created_at,
      metadata: JSON.parse(row.metadata || '{}')
    };
  }
}

module.exports = PeerMessaging;
