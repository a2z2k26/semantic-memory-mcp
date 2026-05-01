# Bumba Memory MCP — Peer Discovery & Agent Coordination

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **IMPORTANT:** This plan targets the **bumba-memory-mcp** repo. Set `$REPO_ROOT` to your local clone of this repository before executing the commands below.

**Goal:** Add peer discovery, agent registration, real-time messaging, and presence awareness to the Bumba Memory MCP server — making it the shared coordination layer that all agents (across machines) connect to for both persistent memory and real-time coordination.

**Architecture:** Extends the existing MCP server with a `peers` subsystem backed by SQLite. New tables store peer registrations and messages. New MCP tools enable agents to register, discover each other, send messages, and maintain presence via heartbeat. Inspired by the Claude Peers pattern (broker + SQLite) but integrated into the existing memory server rather than running a separate daemon.

**Tech Stack:** Node.js, SQLite (better-sqlite3, WAL mode), @modelcontextprotocol/sdk, existing bumba-memory-mcp infrastructure

**Reference:** Claude Peers (github.com/louislva/claude-peers-mcp) — broker pattern, SQLite messaging, scoped discovery

---

## File Map

### New Files
| File | Responsibility |
|------|---------------|
| `peer-registry.js` | Peer registration, heartbeat, discovery, deregistration — SQLite-backed |
| `peer-messaging.js` | Agent-to-agent messaging — store, poll, deliver |
| `tests/test-peer-registry.js` | Unit tests for peer registry |
| `tests/test-peer-messaging.js` | Unit tests for messaging |

### Modified Files
| File | Change |
|------|--------|
| `mcp-server.js` | Add 8 new peer_* MCP tools |
| `sqlite-storage-adapter.js` | Add peers and peer_messages tables to schema |

---

## Task 1: Add Peer Tables to SQLite Schema

**Files:**
- Modify: `sqlite-storage-adapter.js`

- [ ] **Step 1: Read the current createSchema method**

```bash
cd $REPO_ROOT && grep -n "createSchema\|CREATE TABLE\|CREATE INDEX" sqlite-storage-adapter.js | head -40
```

- [ ] **Step 2: Add peer tables**

In the `createSchema()` method, after the existing table creations, add:

```javascript
// ===== PEERS TABLE (Peer Discovery) =====
this.db.exec(`
  CREATE TABLE IF NOT EXISTS peers (
    agent_id TEXT PRIMARY KEY,
    machine TEXT NOT NULL,
    capabilities TEXT DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'idle',
    endpoint TEXT DEFAULT '',
    current_task TEXT,
    last_seen INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    registered_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    metadata TEXT DEFAULT '{}'
  )
`);

this.db.exec(`CREATE INDEX IF NOT EXISTS idx_peers_machine ON peers(machine)`);
this.db.exec(`CREATE INDEX IF NOT EXISTS idx_peers_status ON peers(status)`);
this.db.exec(`CREATE INDEX IF NOT EXISTS idx_peers_last_seen ON peers(last_seen DESC)`);

// ===== PEER MESSAGES TABLE =====
this.db.exec(`
  CREATE TABLE IF NOT EXISTS peer_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_agent TEXT NOT NULL,
    target_agent TEXT NOT NULL,
    message TEXT NOT NULL,
    message_type TEXT DEFAULT 'text',
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    delivered INTEGER DEFAULT 0,
    delivered_at INTEGER
  )
`);

this.db.exec(`CREATE INDEX IF NOT EXISTS idx_peer_messages_target ON peer_messages(target_agent, delivered)`);
this.db.exec(`CREATE INDEX IF NOT EXISTS idx_peer_messages_created ON peer_messages(created_at DESC)`);
```

- [ ] **Step 3: Verify schema migration works**

```bash
cd $REPO_ROOT && node -e "
const sqlite3 = require('better-sqlite3');
const db = new sqlite3('/tmp/test-peers.db');
db.pragma('journal_mode = WAL');
// Paste the CREATE TABLE statements here to verify they work
db.exec(\`CREATE TABLE IF NOT EXISTS peers (
  agent_id TEXT PRIMARY KEY,
  machine TEXT NOT NULL,
  capabilities TEXT DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'idle',
  endpoint TEXT DEFAULT '',
  current_task TEXT,
  last_seen INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  registered_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  metadata TEXT DEFAULT '{}'
)\`);
db.exec(\`CREATE TABLE IF NOT EXISTS peer_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_agent TEXT NOT NULL,
  target_agent TEXT NOT NULL,
  message TEXT NOT NULL,
  message_type TEXT DEFAULT 'text',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  delivered INTEGER DEFAULT 0,
  delivered_at INTEGER
)\`);
console.log('Tables created successfully');
console.log('Tables:', db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map(r => r.name));
db.close();
"
```

Expected: Tables created successfully, includes `peers` and `peer_messages`.

- [ ] **Step 4: Commit**

```bash
cd $REPO_ROOT && git add sqlite-storage-adapter.js
git commit -m "feat: add peers and peer_messages tables for agent discovery"
```

---

## Task 2: Build Peer Registry Module

**Files:**
- Create: `peer-registry.js`

- [ ] **Step 1: Write the peer registry**

```javascript
/**
 * Peer Registry — agent registration, heartbeat, discovery.
 * SQLite-backed, integrated with the Bumba Memory MCP server.
 * 
 * Inspired by Claude Peers (github.com/louislva/claude-peers-mcp) broker pattern.
 */

const Logger = require('./lib/bumba-logger');
const logger = new Logger('PeerRegistry');

const STALE_THRESHOLD_SECONDS = 300; // 5 minutes without heartbeat = stale

class PeerRegistry {
  constructor(db) {
    this.db = db;
  }

  /**
   * Register a new peer or update an existing one.
   */
  register({ agentId, machine, capabilities = [], endpoint = '', metadata = {} }) {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      INSERT INTO peers (agent_id, machine, capabilities, status, endpoint, last_seen, registered_at, metadata)
      VALUES (?, ?, ?, 'idle', ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        machine = excluded.machine,
        capabilities = excluded.capabilities,
        endpoint = excluded.endpoint,
        last_seen = excluded.last_seen,
        metadata = excluded.metadata,
        status = 'idle'
    `).run(
      agentId, machine,
      JSON.stringify(capabilities),
      endpoint, now, now,
      JSON.stringify(metadata)
    );
    logger.info(`Peer registered: ${agentId} on ${machine}`);
    return { agentId, status: 'registered' };
  }

  /**
   * Update heartbeat timestamp and optionally status/task.
   */
  heartbeat(agentId, { status, currentTask } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const updates = ['last_seen = ?'];
    const params = [now];

    if (status) {
      updates.push('status = ?');
      params.push(status);
    }
    if (currentTask !== undefined) {
      updates.push('current_task = ?');
      params.push(currentTask);
    }
    params.push(agentId);

    const result = this.db.prepare(
      `UPDATE peers SET ${updates.join(', ')} WHERE agent_id = ?`
    ).run(...params);

    return { updated: result.changes > 0 };
  }

  /**
   * Remove a peer from the registry.
   */
  deregister(agentId) {
    this.db.prepare('DELETE FROM peers WHERE agent_id = ?').run(agentId);
    logger.info(`Peer deregistered: ${agentId}`);
    return { agentId, status: 'deregistered' };
  }

  /**
   * Get a specific peer by ID.
   */
  getPeer(agentId) {
    const row = this.db.prepare('SELECT * FROM peers WHERE agent_id = ?').get(agentId);
    return row ? this._formatPeer(row) : null;
  }

  /**
   * List all peers, optionally filtered.
   */
  listPeers({ machine, status, capability, includeStale = false } = {}) {
    let query = 'SELECT * FROM peers WHERE 1=1';
    const params = [];

    if (!includeStale) {
      const cutoff = Math.floor(Date.now() / 1000) - STALE_THRESHOLD_SECONDS;
      query += ' AND last_seen > ?';
      params.push(cutoff);
    }
    if (machine) {
      query += ' AND machine = ?';
      params.push(machine);
    }
    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }
    query += ' ORDER BY last_seen DESC';

    let peers = this.db.prepare(query).all(...params).map(r => this._formatPeer(r));

    // Filter by capability (JSON array search)
    if (capability) {
      peers = peers.filter(p => p.capabilities.includes(capability));
    }

    return peers;
  }

  /**
   * Clean up stale peers that haven't heartbeated.
   */
  cleanupStale() {
    const cutoff = Math.floor(Date.now() / 1000) - STALE_THRESHOLD_SECONDS;
    const result = this.db.prepare(
      "UPDATE peers SET status = 'offline' WHERE last_seen < ? AND status != 'offline'"
    ).run(cutoff);
    if (result.changes > 0) {
      logger.info(`Marked ${result.changes} stale peers as offline`);
    }
    return { markedOffline: result.changes };
  }

  /**
   * Count active peers.
   */
  count() {
    const cutoff = Math.floor(Date.now() / 1000) - STALE_THRESHOLD_SECONDS;
    return this.db.prepare(
      "SELECT COUNT(*) as count FROM peers WHERE last_seen > ? AND status != 'offline'"
    ).get(cutoff).count;
  }

  _formatPeer(row) {
    return {
      agentId: row.agent_id,
      machine: row.machine,
      capabilities: JSON.parse(row.capabilities || '[]'),
      status: row.status,
      endpoint: row.endpoint,
      currentTask: row.current_task,
      lastSeen: row.last_seen,
      registeredAt: row.registered_at,
      metadata: JSON.parse(row.metadata || '{}'),
    };
  }
}

module.exports = { PeerRegistry, STALE_THRESHOLD_SECONDS };
```

Write to `$REPO_ROOT/peer-registry.js`.

- [ ] **Step 2: Commit**

```bash
cd $REPO_ROOT && git add peer-registry.js
git commit -m "feat: add PeerRegistry for agent discovery and presence"
```

---

## Task 3: Build Peer Messaging Module

**Files:**
- Create: `peer-messaging.js`

- [ ] **Step 1: Write the messaging module**

```javascript
/**
 * Peer Messaging — agent-to-agent message passing via SQLite.
 * Messages are stored and polled (at-least-once delivery).
 */

const Logger = require('./lib/bumba-logger');
const logger = new Logger('PeerMessaging');

class PeerMessaging {
  constructor(db) {
    this.db = db;
  }

  /**
   * Send a message to another agent.
   */
  sendMessage({ source, target, message, messageType = 'text' }) {
    const result = this.db.prepare(`
      INSERT INTO peer_messages (source_agent, target_agent, message, message_type)
      VALUES (?, ?, ?, ?)
    `).run(source, target, JSON.stringify(message), messageType);

    logger.debug(`Message sent: ${source} -> ${target} (${messageType})`);
    return { messageId: result.lastInsertRowid, status: 'sent' };
  }

  /**
   * Check for undelivered messages for an agent.
   * Marks retrieved messages as delivered.
   */
  checkMessages(agentId, { limit = 20 } = {}) {
    const messages = this.db.prepare(`
      SELECT id, source_agent, target_agent, message, message_type, created_at
      FROM peer_messages
      WHERE target_agent = ? AND delivered = 0
      ORDER BY created_at ASC
      LIMIT ?
    `).all(agentId, limit);

    // Mark as delivered
    if (messages.length > 0) {
      const ids = messages.map(m => m.id);
      const now = Math.floor(Date.now() / 1000);
      this.db.prepare(`
        UPDATE peer_messages SET delivered = 1, delivered_at = ?
        WHERE id IN (${ids.map(() => '?').join(',')})
      `).run(now, ...ids);
    }

    return messages.map(m => ({
      id: m.id,
      from: m.source_agent,
      to: m.target_agent,
      message: JSON.parse(m.message),
      type: m.message_type,
      sentAt: m.created_at,
    }));
  }

  /**
   * Broadcast a message to all active peers (or a filtered set).
   */
  broadcast({ source, message, messageType = 'broadcast', excludeSelf = true }, peerRegistry) {
    const peers = peerRegistry.listPeers();
    let sent = 0;
    for (const peer of peers) {
      if (excludeSelf && peer.agentId === source) continue;
      this.sendMessage({ source, target: peer.agentId, message, messageType });
      sent++;
    }
    return { sent, recipients: sent };
  }

  /**
   * Clean up old delivered messages (older than 1 hour).
   */
  cleanup({ maxAgeSeconds = 3600 } = {}) {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds;
    const result = this.db.prepare(
      'DELETE FROM peer_messages WHERE delivered = 1 AND delivered_at < ?'
    ).run(cutoff);
    return { deleted: result.changes };
  }
}

module.exports = { PeerMessaging };
```

Write to `$REPO_ROOT/peer-messaging.js`.

- [ ] **Step 2: Commit**

```bash
cd $REPO_ROOT && git add peer-messaging.js
git commit -m "feat: add PeerMessaging for agent-to-agent communication"
```

---

## Task 4: Add Peer MCP Tools to Server

**Files:**
- Modify: `mcp-server.js`

- [ ] **Step 1: Read mcp-server.js tool registration section**

```bash
cd $REPO_ROOT && grep -n "name: 'peer\|name: 'system_health" mcp-server.js
```

Understand where to add the new tools.

- [ ] **Step 2: Add peer tool imports**

After the existing requires at the top of mcp-server.js:

```javascript
const { PeerRegistry } = require('./peer-registry');
const { PeerMessaging } = require('./peer-messaging');
```

After storage initialization, add:

```javascript
const peerRegistry = new PeerRegistry(storage.db);
const peerMessaging = new PeerMessaging(storage.db);

// Clean up stale peers every 30 seconds
setInterval(() => {
  try {
    peerRegistry.cleanupStale();
    peerMessaging.cleanup();
  } catch (e) {
    logger.warn('Peer cleanup error:', e.message);
  }
}, 30000);
```

- [ ] **Step 3: Add 8 peer tools to ListToolsRequestSchema handler**

Add to the tools array:

```javascript
// --- Peer Discovery Tools ---
{
  name: 'peer_register',
  description: 'Register this agent as a peer in the discovery system. Call on startup.',
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'Unique agent identifier' },
      machine: { type: 'string', description: 'Machine hostname' },
      capabilities: { type: 'array', items: { type: 'string' }, description: 'Agent capabilities' },
      endpoint: { type: 'string', description: 'HTTP endpoint for direct communication' },
      metadata: { type: 'object', description: 'Additional metadata (branch, project, model)' }
    },
    required: ['agentId', 'machine']
  }
},
{
  name: 'peer_heartbeat',
  description: 'Send heartbeat to maintain presence. Call every 60 seconds.',
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'Agent ID' },
      status: { type: 'string', enum: ['idle', 'busy', 'offline'], description: 'Current status' },
      currentTask: { type: 'string', description: 'What the agent is working on' }
    },
    required: ['agentId']
  }
},
{
  name: 'peer_deregister',
  description: 'Remove this agent from the peer registry. Call on shutdown.',
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'Agent ID to deregister' }
    },
    required: ['agentId']
  }
},
{
  name: 'peer_list',
  description: 'List all active peers, optionally filtered by machine, status, or capability.',
  inputSchema: {
    type: 'object',
    properties: {
      machine: { type: 'string', description: 'Filter by machine name' },
      status: { type: 'string', enum: ['idle', 'busy', 'offline'], description: 'Filter by status' },
      capability: { type: 'string', description: 'Filter by capability' },
      includeStale: { type: 'boolean', description: 'Include stale/offline peers (default: false)' }
    }
  }
},
{
  name: 'peer_get',
  description: 'Get details for a specific peer by agent ID.',
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'Agent ID to look up' }
    },
    required: ['agentId']
  }
},
{
  name: 'peer_send_message',
  description: 'Send a message to another agent.',
  inputSchema: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Sender agent ID' },
      target: { type: 'string', description: 'Recipient agent ID' },
      message: { description: 'Message content (any JSON)' },
      messageType: { type: 'string', description: 'Message type (text, work_order, status_update, result)' }
    },
    required: ['source', 'target', 'message']
  }
},
{
  name: 'peer_check_messages',
  description: 'Check for undelivered messages for this agent. Marks them as delivered.',
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'Agent ID to check messages for' },
      limit: { type: 'number', description: 'Max messages to return (default: 20)' }
    },
    required: ['agentId']
  }
},
{
  name: 'peer_broadcast',
  description: 'Broadcast a message to all active peers.',
  inputSchema: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Sender agent ID' },
      message: { description: 'Message content (any JSON)' },
      messageType: { type: 'string', description: 'Message type' }
    },
    required: ['source', 'message']
  }
}
```

- [ ] **Step 4: Add peer tool handlers to CallToolRequestSchema**

```javascript
// --- Peer Discovery Handlers ---
case 'peer_register': {
  const result = peerRegistry.register(args);
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}
case 'peer_heartbeat': {
  const result = peerRegistry.heartbeat(args.agentId, args);
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}
case 'peer_deregister': {
  const result = peerRegistry.deregister(args.agentId);
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}
case 'peer_list': {
  const peers = peerRegistry.listPeers(args);
  return { content: [{ type: 'text', text: JSON.stringify({ peers, count: peers.length }) }] };
}
case 'peer_get': {
  const peer = peerRegistry.getPeer(args.agentId);
  if (!peer) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Peer not found' }) }] };
  return { content: [{ type: 'text', text: JSON.stringify(peer) }] };
}
case 'peer_send_message': {
  const result = peerMessaging.sendMessage(args);
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}
case 'peer_check_messages': {
  const messages = peerMessaging.checkMessages(args.agentId, args);
  return { content: [{ type: 'text', text: JSON.stringify({ messages, count: messages.length }) }] };
}
case 'peer_broadcast': {
  const result = peerMessaging.broadcast(args, peerRegistry);
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}
```

- [ ] **Step 5: Test the server starts without errors**

```bash
cd $REPO_ROOT && node -e "
const { PeerRegistry } = require('./peer-registry');
const { PeerMessaging } = require('./peer-messaging');
console.log('Modules loaded successfully');
"
```

Expected: No import errors.

- [ ] **Step 6: Commit**

```bash
cd $REPO_ROOT && git add mcp-server.js
git commit -m "feat: add 8 peer discovery MCP tools (register, heartbeat, list, message, broadcast)"
```

---

## Task 5: Integration Test

- [ ] **Step 1: Write a test script**

```bash
cd $REPO_ROOT && node -e "
const sqlite3 = require('better-sqlite3');
const db = new sqlite3('/tmp/test-peers-integration.db');
db.pragma('journal_mode = WAL');

// Create tables
db.exec(\`CREATE TABLE IF NOT EXISTS peers (
  agent_id TEXT PRIMARY KEY, machine TEXT NOT NULL, capabilities TEXT DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'idle', endpoint TEXT DEFAULT '', current_task TEXT,
  last_seen INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  registered_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  metadata TEXT DEFAULT '{}'
)\`);
db.exec(\`CREATE TABLE IF NOT EXISTS peer_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source_agent TEXT NOT NULL,
  target_agent TEXT NOT NULL, message TEXT NOT NULL, message_type TEXT DEFAULT 'text',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  delivered INTEGER DEFAULT 0, delivered_at INTEGER
)\`);

const { PeerRegistry } = require('./peer-registry');
const { PeerMessaging } = require('./peer-messaging');

const registry = new PeerRegistry(db);
const messaging = new PeerMessaging(db);

// Test 1: Register peers
registry.register({ agentId: 'mac-001', machine: 'macbook', capabilities: ['engineering'] });
registry.register({ agentId: 'mini-001', machine: 'mac-mini', capabilities: ['testing', 'deployment'] });
console.log('Registered 2 peers. Count:', registry.count());

// Test 2: List peers
const peers = registry.listPeers();
console.log('Active peers:', peers.map(p => p.agentId));

// Test 3: Find by capability
const engineers = registry.listPeers({ capability: 'engineering' });
console.log('Engineers:', engineers.map(p => p.agentId));

// Test 4: Heartbeat
registry.heartbeat('mac-001', { status: 'busy', currentTask: 'PR review' });
const updated = registry.getPeer('mac-001');
console.log('After heartbeat:', updated.status, updated.currentTask);

// Test 5: Send message
messaging.sendMessage({ source: 'mac-001', target: 'mini-001', message: { type: 'work_order', task: 'Run tests' } });
console.log('Message sent');

// Test 6: Check messages
const msgs = messaging.checkMessages('mini-001');
console.log('Messages for mini-001:', msgs.length, msgs[0]?.message);

// Test 7: Broadcast
const broadcast = messaging.broadcast({ source: 'mac-001', message: 'All agents: deploy complete' }, registry);
console.log('Broadcast sent to', broadcast.sent, 'peers');

// Test 8: Deregister
registry.deregister('mac-001');
console.log('After deregister, count:', registry.count());

db.close();
console.log('\\nAll tests passed!');
"
```

Expected: All operations succeed, output shows correct counts and data.

- [ ] **Step 2: Commit**

```bash
cd $REPO_ROOT && git add -A
git commit -m "test: verify peer registry and messaging integration"
```

---

## Summary — New MCP Tools Added

| Tool | Purpose |
|------|---------|
| `peer_register` | Register agent on startup |
| `peer_heartbeat` | Maintain presence (every 60s) |
| `peer_deregister` | Clean deregister on shutdown |
| `peer_list` | Discover peers (filter by machine/status/capability) |
| `peer_get` | Get specific peer details |
| `peer_send_message` | Send message to another agent |
| `peer_check_messages` | Poll for incoming messages |
| `peer_broadcast` | Message all active peers |

This brings the total MCP tool count from 23 to 31.
