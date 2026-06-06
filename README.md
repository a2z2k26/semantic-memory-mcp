```
 ____  _____ __  __    _    _   _ _____ ___ ____
/ ___|| ____|  \/  |  / \  | \ | |_   _|_ _/ ___|
\___ \|  _| | |\/| | / _ \ |  \| | | |  | | |
 ___) | |___| |  | |/ ___ \| |\  | | |  | | |___
|____/|_____|_|  |_/_/   \_\_| \_| |_| |___\____|

 __  __ _____ __  __  ___  ______   __  __  __  ____ ____
|  \/  | ____|  \/  |/ _ \|  _ \ \ / / |  \/  |/ ___|  _ \
| |\/| |  _| | |\/| | | | | |_) \ V /  | |\/| | |   | |_) |
| |  | | |___| |  | | |_| |  _ < | |   | |  | | |___|  __/
|_|  |_|_____|_|  |_|\___/|_| \_\|_|   |_|  |_|\____|_|
```

[![Node](https://img.shields.io/badge/node-14+-green.svg)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

<br>

### Shared semantic memory for multi-agent coordination. Lets multiple Claude Code instances — worktrees, sandboxes, or separate sessions — share memory, hand off work, and coordinate through a single SQLite-backed semantic memory layer with FTS5 search, conflict resolution, and peer discovery. ###

---

### What It Does ###

- Persistent shared memory across Claude Code sessions, worktrees, and sandboxes
- Concurrent multi-instance access via SQLite WAL mode
- Full-text semantic search with BM25 ranking (FTS5)
- Automatic conflict detection with pluggable resolution strategies
- Peer discovery and inter-agent messaging
- Team-level coordination: shared tasks, decisions, and artifacts

---

### Features ###

- **SQLite + WAL mode** — concurrent reads from any number of MCP server instances
- **FTS5 full-text search** — phrase, boolean, prefix, and column-scoped queries with BM25 ranking
- **Conflict resolution** — version vectors plus six configurable merge strategies
- **Multi-instance coordination** — instance registration, health checks, automatic stale-instance cleanup
- **Peer discovery** — agent registry, heartbeats, capability filtering, direct messaging, and broadcasts
- **Team memory** — shared tasks, contexts, decisions, and artifact storage
- **Memory pressure monitoring** — system/process memory tracking with eviction recommendations

---

### Installation ###

Requires Node.js 14+.

```bash
git clone https://github.com/a2z2k26/semantic-memory-mcp.git
cd semantic-memory-mcp
npm install
npm install -g .   # optional: installs the `bumba-memory-server` bin
```

---

### MCP Configuration ###

Add the server to your Claude Code MCP config (typically `~/.claude/claude_desktop_config.json`).

**Using the global bin** (after `npm install -g .`):

```json
{
  "mcpServers": {
    "bumba-memory": {
      "command": "bumba-memory-server",
      "env": {
        "BUMBA_MEMORY_DIR": "~/.bumba/memory",
        "BUMBA_LOG_LEVEL": "INFO"
      }
    }
  }
}
```

**Using an absolute path:**

```json
{
  "mcpServers": {
    "bumba-memory": {
      "command": "node",
      "args": ["/absolute/path/to/semantic-memory-mcp/src/mcp-server.js"],
      "env": { "BUMBA_MEMORY_DIR": "~/.bumba/memory" }
    }
  }
}
```

---

### Available Tools ###

The server registers **30 MCP tools** across four categories.

**Core Memory (12)** — `memory_store`, `memory_retrieve`, `memory_search`, `memory_list`, `memory_delete`, `memory_stats`, `memory_rebuild_index`, `memory_list_conflicts`, `memory_resolve_conflict`, `memory_set_merge_strategy`, `memory_pressure`, `memory_evict`

**Team Coordination (8)** — `team_start_task`, `team_complete_task`, `team_store_context`, `team_get_context`, `team_record_decision`, `team_store_artifact`, `team_search`, `team_get_status`

**Peer Discovery (8)** — `peer_register`, `peer_heartbeat`, `peer_deregister`, `peer_list`, `peer_get`, `peer_send_message`, `peer_check_messages`, `peer_broadcast`

**System (2)** — `system_health`, `system_instances`

---

### FTS5 Search Syntax ###

`memory_search` supports the full FTS5 query grammar:

| Pattern | Example | Behavior |
|---------|---------|----------|
| Simple | `authentication` | Search all indexed fields |
| Phrase | `"exact phrase"` | Match exact phrase |
| Boolean AND | `term1 AND term2` | Both terms required |
| Boolean OR | `term1 OR term2` | Either term matches |
| Negation | `term1 NOT term2` | Exclude `term2` |
| Prefix | `auth*` | Matches `auth`, `authentication`, etc. |
| Column-scoped | `key:auth` | Search only the `key` column |

---

### Conflict Resolution ###

When multiple instances write the same key concurrently, conflicts are detected via version vectors and resolved per a configurable strategy.

| Strategy | Behavior |
|----------|----------|
| `last_write_wins` | Use the entry with the most recent timestamp (default) |
| `merge` | Deep-merge objects, union arrays |
| `keep_local` | Prefer existing local data |
| `keep_remote` | Prefer incoming remote data |
| `keep_both` | Store both versions in an array |
| `manual` | Mark pending and require manual resolution |

Default strategies by key prefix: `user:*` → `last_write_wins`, `context:*` → `merge`, `decision:*` → `keep_both`, `artifact:*` → `last_write_wins`. Override with `memory_set_merge_strategy`.

---

### Memory Key Conventions ###

| Prefix | Purpose |
|--------|---------|
| `context:` | Shared state, project config |
| `handoff:` | Work-in-progress for another agent |
| `decision:` | Recorded decisions with rationale |
| `artifact:` | Generated outputs, code snippets |
| `sandbox:{id}:` | Results from sandboxed agents |
| `session:{date}:` | Session summaries |
| `user:` | User preferences, settings |
| `agent:{id}:` | Agent-specific memory |

---

### Environment Variables ###

| Variable | Default | Description |
|----------|---------|-------------|
| `BUMBA_MEMORY_DIR` | `~/.bumba/memory` | Directory for all memory storage |
| `BUMBA_LOG_LEVEL` | `INFO` | Log level: `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `BUMBA_BRIDGE_TOKEN` | _generated_ | Bridge auth token (auto-generated if unset) |
| `BUMBA_BRIDGE_MAX_BODY` | `5242880` | Max bridge request body in bytes (5 MiB) |

---

### Directory Structure ###

```
~/.bumba/memory/
├── memory.db           # SQLite database (WAL mode)
├── memory.db-wal       # WAL file (concurrent reads)
├── memory.db-shm       # Shared memory file
├── team-memory.json    # Team memory state
├── bridge-token        # Memory Bridge auth token (mode 0600)
├── instances/          # Active instance registration files
├── locks/              # File-based coordination locks
└── artifacts/          # Large artifact storage
```

---

### Memory Bridge (HTTP) ###

Optional HTTP front-end for environments that cannot speak MCP directly — typically isolated sandboxes that need to push and pull context from the host.

```bash
npm run bridge          # or: node src/memory-bridge-server.js
```

**Endpoints:** `POST /sync-in`, `POST /sync-out`, `GET /context/:key`, `POST /store`, `POST /search`, `GET /health`, `GET /status`.

All endpoints except `GET /health` require an `X-Bridge-Token` header. The token is auto-generated on startup, printed once to stderr, and persisted to `<memoryDir>/bridge-token` with mode `0600`. Override via `BUMBA_BRIDGE_TOKEN`.

---

### Security ###

The Memory Bridge is designed for **local-only** use. It binds to `127.0.0.1`, requires a per-instance auth token (`X-Bridge-Token`), rejects non-loopback `Host` headers as DNS-rebinding mitigation, and caps request bodies at 5 MiB.

Do **not** expose the bridge via a reverse proxy, port forward, or to any non-loopback interface without first adding TLS and additional authentication. The MCP server itself communicates only over stdio with its parent process — no network surface.

See [SECURITY.md](./SECURITY.md) for the full threat model and reporting process.

---

### Library API ###

The memory system is also usable directly from Node.js by requiring this repo as a local clone (not currently published to npm):

```javascript
const { BumbaMemorySystem } = require('./index.js');

const memory = new BumbaMemorySystem({
  unified: { dbPath: './memory.db' }
});

await memory.initialize();
await memory.store('agent-1:task-1', {
  type: 'task_result',
  content: 'Completed code review',
  tags: ['code-review', 'backend']
});
const results = await memory.search('code review');
await memory.shutdown();
```

`dbPath` must be nested under `unified`.

---

### Claude Code Integration (Optional) ###

This repo ships with optional Claude Code workspace assets under `.claude/`. They are **not** installed automatically — copy them into your own project's `.claude/` directory:

- `commands/memory.md` — defines the `/memory` slash command (`/memory store`, `/memory search`, `/memory team`, etc.)
- `skills/memory-patterns.md` — best-practice guidance for context handoff, decision recording, search-before-create, and cross-instance awareness

---

### Project Layout ###

```
src/
├── mcp-server.js              # MCP server (the bin)
├── memory-bridge-server.js    # Optional HTTP bridge
├── storage/                   # SQLite adapter + schema reference
├── memory/                    # Team memory coordination
├── peers/                     # Peer registration & messaging
└── lib/                       # Logger, conflict resolver, version vectors
test/                          # Integration tests
.claude/                       # Optional Claude Code workspace assets
```

---

### License ###

MIT — see [LICENSE](./LICENSE).

---

### Credits ###

Author: **Andrew Zellinger**.

Peer discovery design (registry, heartbeats, messaging, broadcast) inspired by [claude-peers-mcp](https://github.com/louislva/claude-peers-mcp).
