#!/usr/bin/env node
/**
 * Bumba Memory Bridge Server
 *
 * HTTP API that proxies memory operations for E2B sandboxes.
 * E2B sandboxes are completely isolated and cannot access the host filesystem,
 * so this bridge provides HTTP endpoints for memory sync operations.
 *
 * SECURITY NOTICE
 * ---------------
 * This bridge is intended for LOCAL-ONLY use. It binds to 127.0.0.1 and
 * requires a per-instance auth token for every endpoint except `/health`.
 *
 * DO NOT expose this server via a reverse proxy, port-forward it to a
 * non-loopback interface, or otherwise make it reachable from the network.
 * Doing so would allow remote callers to read/write the entire local
 * memory store. The auth token, body size cap, and Host header check are
 * defense-in-depth measures — they assume a localhost threat model
 * (cohabitating processes / browser tabs / DNS rebinding), not a
 * hardened internet-facing service.
 *
 * Token handling:
 *   - Generated at startup (32 bytes hex via crypto.randomBytes), or
 *     overridden via the BUMBA_BRIDGE_TOKEN env var.
 *   - Printed once at startup and written to <memoryDir>/bridge-token
 *     with mode 0600 so the orchestrator/sandbox runner can read it.
 *   - Required as `X-Bridge-Token: <token>` on every request other
 *     than `GET /health`. Compared with crypto.timingSafeEqual.
 *
 * Usage:
 *   node memory-bridge-server.js [--port PORT]
 *
 * Endpoints:
 *   POST /sync-in     - Push context TO sandbox (before spawn)
 *   POST /sync-out    - Pull context FROM sandbox (at close)
 *   GET  /context/:key - Get specific context
 *   POST /store       - Store memory entry
 *   POST /search      - Search memories
 *   GET  /health      - Health check (no auth required)
 *   GET  /status      - Detailed status with team info
 */

const http = require('http');
const url = require('url');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const { SQLiteStorageAdapter } = require('./storage/sqlite-storage-adapter');
const TeamMemory = require('./memory/team-memory');
const Logger = require('./lib/logger');

const logger = new Logger('MemoryBridge');

// Configuration
const DEFAULT_PORT = parseInt(process.env.MEMORY_BRIDGE_PORT) || 3847;
const MEMORY_DIR = process.env.BUMBA_MEMORY_DIR || path.join(os.homedir(), '.bumba', 'memory');
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_BODY_BYTES = (() => {
  const raw = process.env.BUMBA_BRIDGE_MAX_BODY;
  if (!raw) return DEFAULT_MAX_BODY_BYTES;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_BODY_BYTES;
  return parsed;
})();

class MemoryBridgeServer {
  constructor(options = {}) {
    this.port = options.port || DEFAULT_PORT;
    this.memoryDir = options.memoryDir || MEMORY_DIR;
    this.storage = null;
    this.teamMemory = null;
    this.server = null;
    this.activeSandboxes = new Map(); // Track active sandbox contexts
    this.authToken = null;
    this.authTokenBuffer = null; // Pre-encoded buffer for timingSafeEqual
    this.maxBodyBytes = options.maxBodyBytes || MAX_BODY_BYTES;
  }

  async initialize() {
    logger.info(`Initializing Memory Bridge Server...`);
    logger.info(`Memory directory: ${this.memoryDir}`);

    // Ensure memory directory exists
    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true });
    }

    // Initialize SQLite storage
    const dbPath = path.join(this.memoryDir, 'memory.db');
    this.storage = new SQLiteStorageAdapter({ dbPath });
    await this.storage.initialize();

    // Initialize team memory
    const teamMemoryPath = path.join(this.memoryDir, 'team-memory.json');
    this.teamMemory = new TeamMemory({ storagePath: teamMemoryPath });

    // Initialize auth token (env override or freshly generated)
    this.initializeAuthToken();

    logger.info('Memory systems initialized');
  }

  initializeAuthToken() {
    const envToken = process.env.BUMBA_BRIDGE_TOKEN;
    if (envToken && envToken.length > 0) {
      this.authToken = envToken;
      logger.info('Using auth token from BUMBA_BRIDGE_TOKEN env var');
    } else {
      this.authToken = crypto.randomBytes(32).toString('hex');
    }
    this.authTokenBuffer = Buffer.from(this.authToken, 'utf8');

    // Persist to <memoryDir>/bridge-token with 0600 perms so the
    // orchestrator/sandbox runner can read it but other users cannot.
    const tokenPath = path.join(this.memoryDir, 'bridge-token');
    try {
      fs.writeFileSync(tokenPath, this.authToken, { mode: 0o600 });
      // Re-chmod in case the file already existed with broader perms.
      fs.chmodSync(tokenPath, 0o600);
    } catch (e) {
      logger.warn(`Failed to persist bridge token to ${tokenPath}: ${e.message}`);
    }
  }

  async start() {
    await this.initialize();

    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    this.server.listen(this.port, '127.0.0.1', () => {
      logger.info(`Memory Bridge Server running at http://127.0.0.1:${this.port}`);
      // Print the auth token exactly once so the operator can copy it.
      // Subsequent reads should come from <memoryDir>/bridge-token.
      logger.info(`Bridge auth token: ${this.authToken}`);
      logger.info(`Token file: ${path.join(this.memoryDir, 'bridge-token')} (mode 0600)`);
      logger.info(`Max body size: ${this.maxBodyBytes} bytes`);
      logger.info('Endpoints:');
      logger.info('  POST /sync-in     - Push context to sandbox');
      logger.info('  POST /sync-out    - Pull context from sandbox');
      logger.info('  GET  /context/:key - Get specific context');
      logger.info('  POST /store       - Store memory entry');
      logger.info('  POST /search      - Search memories');
      logger.info('  GET  /health      - Health check (no auth)');
      logger.info('  GET  /status      - Detailed status');
    });

    return this.server;
  }

  // Reject requests whose Host header is not a loopback name+port pair.
  // Defends against DNS rebinding attacks where a remote name resolves to
  // 127.0.0.1 — the loopback bind alone does not stop those.
  isHostAllowed(hostHeader) {
    if (!hostHeader || typeof hostHeader !== 'string') return false;
    const allowed = new Set([
      `127.0.0.1:${this.port}`,
      `localhost:${this.port}`
    ]);
    return allowed.has(hostHeader);
  }

  // Constant-time token comparison. Returns true iff the supplied token
  // matches the configured one.
  isTokenValid(suppliedToken) {
    if (!suppliedToken || typeof suppliedToken !== 'string') return false;
    const supplied = Buffer.from(suppliedToken, 'utf8');
    if (supplied.length !== this.authTokenBuffer.length) return false;
    try {
      return crypto.timingSafeEqual(supplied, this.authTokenBuffer);
    } catch (_e) {
      return false;
    }
  }

  async handleRequest(req, res) {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // 1. Host header check (DNS rebinding mitigation). Applied to ALL
    //    requests, including /health, since rebinding attacks would
    //    otherwise still succeed against the unauthenticated endpoint.
    if (!this.isHostAllowed(req.headers.host)) {
      return this.sendJson(res, 421, { error: 'misdirected request' });
    }

    // 2. Auth check. /health is intentionally exempt so that liveness
    //    probes (which may not have the token) keep working. Every
    //    other endpoint requires a valid X-Bridge-Token header.
    const isHealth = pathname === '/health' && req.method === 'GET';
    if (!isHealth) {
      const supplied = req.headers['x-bridge-token'];
      if (!this.isTokenValid(supplied)) {
        return this.sendJson(res, 401, { error: 'unauthorized' });
      }
    }

    try {
      // Route requests
      if (pathname === '/health' && req.method === 'GET') {
        return this.handleHealth(req, res);
      }
      if (pathname === '/status' && req.method === 'GET') {
        return this.handleStatus(req, res);
      }
      if (pathname === '/sync-in' && req.method === 'POST') {
        return this.handleSyncIn(req, res);
      }
      if (pathname === '/sync-out' && req.method === 'POST') {
        return this.handleSyncOut(req, res);
      }
      if (pathname.startsWith('/context/') && req.method === 'GET') {
        const key = decodeURIComponent(pathname.slice(9));
        return this.handleGetContext(req, res, key);
      }
      if (pathname === '/store' && req.method === 'POST') {
        return this.handleStore(req, res);
      }
      if (pathname === '/search' && req.method === 'POST') {
        return this.handleSearch(req, res);
      }
      if (pathname === '/team/status' && req.method === 'GET') {
        return this.handleTeamStatus(req, res);
      }
      if (pathname === '/team/artifact' && req.method === 'POST') {
        return this.handleStoreArtifact(req, res);
      }
      if (pathname === '/team/decision' && req.method === 'POST') {
        return this.handleRecordDecision(req, res);
      }

      // 404 for unknown routes
      this.sendJson(res, 404, { error: 'Not found', path: pathname });
    } catch (error) {
      // Surface body-too-large as 413, everything else as 500.
      if (error && error.code === 'PAYLOAD_TOO_LARGE') {
        return this.sendJson(res, 413, { error: 'payload too large' });
      }
      logger.error(`Request error: ${error.message}`);
      this.sendJson(res, 500, { error: error.message });
    }
  }

  async readBody(req) {
    const limit = this.maxBodyBytes;
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      let aborted = false;

      req.on('data', chunk => {
        if (aborted) return;
        // chunk is a Buffer by default; .length is byte length.
        total += chunk.length;
        if (total > limit) {
          aborted = true;
          const err = new Error(`Request body exceeds ${limit} bytes`);
          err.code = 'PAYLOAD_TOO_LARGE';
          // Stop accepting more data and surface the 413 quickly.
          req.destroy();
          return reject(err);
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (aborted) return;
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve(body ? JSON.parse(body) : {});
        } catch (e) {
          reject(new Error('Invalid JSON body'));
        }
      });
      req.on('error', err => {
        if (aborted) return;
        reject(err);
      });
    });
  }

  sendJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
  }

  // Health check endpoint
  handleHealth(req, res) {
    this.sendJson(res, 200, {
      status: 'healthy',
      service: 'bumba-memory-bridge',
      timestamp: new Date().toISOString()
    });
  }

  // Detailed status endpoint
  async handleStatus(req, res) {
    const teamStatus = this.teamMemory.getStatus();
    const stats = await this.storage.getStats();

    this.sendJson(res, 200, {
      status: 'running',
      service: 'bumba-memory-bridge',
      port: this.port,
      memoryDir: this.memoryDir,
      activeSandboxes: Array.from(this.activeSandboxes.keys()),
      team: teamStatus,
      storage: stats,
      timestamp: new Date().toISOString()
    });
  }

  // Sync context INTO sandbox (called before spawn)
  async handleSyncIn(req, res) {
    const body = await this.readBody(req);
    const { sandboxId, contextKeys = [], includeTeamStatus = true } = body;

    if (!sandboxId) {
      return this.sendJson(res, 400, { error: 'sandboxId is required' });
    }

    logger.info(`Sync-in for sandbox: ${sandboxId}`);

    const context = {
      sandboxId,
      syncedAt: new Date().toISOString(),
      contexts: {},
      teamStatus: null
    };

    // Fetch requested context keys
    for (const key of contextKeys) {
      try {
        // Try team context first
        const teamContext = this.teamMemory.getContext(key);
        if (teamContext) {
          context.contexts[key] = teamContext;
        } else {
          // Fall back to memory storage
          const stored = await this.storage.retrieve(key);
          if (stored) {
            context.contexts[key] = stored;
          }
        }
      } catch (e) {
        logger.warn(`Failed to fetch context key ${key}: ${e.message}`);
      }
    }

    // Include team status if requested
    if (includeTeamStatus) {
      context.teamStatus = this.teamMemory.getStatus();
    }

    // Track active sandbox
    this.activeSandboxes.set(sandboxId, {
      startedAt: new Date().toISOString(),
      contextKeys
    });

    this.sendJson(res, 200, context);
  }

  // Sync context OUT from sandbox (called at close)
  async handleSyncOut(req, res) {
    const body = await this.readBody(req);
    const { sandboxId, summary, artifacts = [], decisions = [], contexts = {} } = body;

    if (!sandboxId) {
      return this.sendJson(res, 400, { error: 'sandboxId is required' });
    }

    logger.info(`Sync-out for sandbox: ${sandboxId}`);

    const results = {
      stored: [],
      errors: []
    };

    // Store summary
    if (summary) {
      try {
        const summaryKey = `sandbox:${sandboxId}:summary`;
        await this.storage.store(summaryKey, {
          ...summary,
          sandboxId,
          syncedAt: new Date().toISOString()
        });
        results.stored.push(summaryKey);
      } catch (e) {
        results.errors.push({ type: 'summary', error: e.message });
      }
    }

    // Store artifacts
    for (const artifact of artifacts) {
      try {
        const artifactId = this.teamMemory.storeArtifact({
          ...artifact,
          metadata: {
            ...artifact.metadata,
            sandboxId,
            source: 'e2b-sandbox'
          }
        });
        results.stored.push(`artifact:${artifactId}`);
      } catch (e) {
        results.errors.push({ type: 'artifact', name: artifact.name, error: e.message });
      }
    }

    // Record decisions
    for (const decision of decisions) {
      try {
        this.teamMemory.recordDecision({
          ...decision,
          agentId: sandboxId
        });
        results.stored.push(`decision:${decision.decision?.slice(0, 30)}...`);
      } catch (e) {
        results.errors.push({ type: 'decision', error: e.message });
      }
    }

    // Store contexts
    for (const [key, value] of Object.entries(contexts)) {
      try {
        const contextKey = key.startsWith('sandbox:') ? key : `sandbox:${sandboxId}:${key}`;
        this.teamMemory.storeContext(contextKey, value);
        results.stored.push(contextKey);
      } catch (e) {
        results.errors.push({ type: 'context', key, error: e.message });
      }
    }

    // Remove from active sandboxes
    this.activeSandboxes.delete(sandboxId);

    this.sendJson(res, 200, {
      success: results.errors.length === 0,
      sandboxId,
      results
    });
  }

  // Get specific context
  async handleGetContext(req, res, key) {
    logger.info(`Get context: ${key}`);

    // Try team context first
    const teamContext = this.teamMemory.getContext(key);
    if (teamContext) {
      return this.sendJson(res, 200, { key, value: teamContext, source: 'team' });
    }

    // Try memory storage
    const stored = await this.storage.retrieve(key);
    if (stored) {
      return this.sendJson(res, 200, { key, value: stored, source: 'storage' });
    }

    this.sendJson(res, 404, { error: 'Context not found', key });
  }

  // Store memory entry
  async handleStore(req, res) {
    const body = await this.readBody(req);
    const { key, data, tags = [], ttl } = body;

    if (!key || !data) {
      return this.sendJson(res, 400, { error: 'key and data are required' });
    }

    logger.info(`Store: ${key}`);

    await this.storage.store(key, data, { tags, ttl });

    this.sendJson(res, 200, { success: true, key });
  }

  // Search memories
  async handleSearch(req, res) {
    const body = await this.readBody(req);
    const { query, tags = [], limit = 20 } = body;

    if (!query) {
      return this.sendJson(res, 400, { error: 'query is required' });
    }

    logger.info(`Search: ${query}`);

    const results = await this.storage.searchKnowledgeFTS(query, { limit });

    // Also search team memory
    const teamResults = this.teamMemory.search(query);

    this.sendJson(res, 200, {
      query,
      results: results.results || [],
      teamResults,
      total: (results.results?.length || 0) + teamResults.length
    });
  }

  // Team status endpoint
  handleTeamStatus(req, res) {
    const status = this.teamMemory.getStatus();
    this.sendJson(res, 200, status);
  }

  // Store artifact via team memory
  async handleStoreArtifact(req, res) {
    const body = await this.readBody(req);
    const { name, type, content, metadata } = body;

    if (!name || !content) {
      return this.sendJson(res, 400, { error: 'name and content are required' });
    }

    const artifactId = this.teamMemory.storeArtifact({ name, type, content, metadata });

    this.sendJson(res, 200, { success: true, artifactId });
  }

  // Record decision via team memory
  async handleRecordDecision(req, res) {
    const body = await this.readBody(req);
    const { decision, rationale, alternatives, agentId } = body;

    if (!decision) {
      return this.sendJson(res, 400, { error: 'decision is required' });
    }

    this.teamMemory.recordDecision({ decision, rationale, alternatives, agentId });

    this.sendJson(res, 200, { success: true });
  }

  async stop() {
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          logger.info('Memory Bridge Server stopped');
          resolve();
        });
      });
    }
  }
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  let port = DEFAULT_PORT;

  // Parse --port argument
  const portIndex = args.indexOf('--port');
  if (portIndex !== -1 && args[portIndex + 1]) {
    port = parseInt(args[portIndex + 1]);
  }

  const server = new MemoryBridgeServer({ port });

  server.start().catch(err => {
    logger.error(`Failed to start server: ${err.message}`);
    process.exit(1);
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down...');
    await server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Shutting down...');
    await server.stop();
    process.exit(0);
  });
}

module.exports = { MemoryBridgeServer };
