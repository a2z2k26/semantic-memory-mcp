# bumba-memory-mcp

Shared semantic memory MCP server for multi-agent coordination. Lets multiple Claude Code instances (worktrees, sandboxes, separate sessions) share memory, hand off work, and coordinate through a single SQLite-backed semantic memory layer.

## Quick Start

```bash
git clone https://github.com/a2z2k26/bumba-memory-mcp.git
cd bumba-memory-mcp
npm install
npm install -g .   # optional: installs the `bumba-memory-server` bin
```

Then add the server to your Claude Code MCP config (see [MCP Configuration](#mcp-configuration)).

## What It Does

- Persistent shared memory across Claude Code sessions, worktrees, and sandboxes
- Concurrent multi-instance access via SQLite WAL mode
- Full-text semantic search with BM25 ranking (FTS5)
- Automatic conflict detection and pluggable resolution strategies
- Peer discovery and inter-agent messaging primitives
- Team-level coordination: shared tasks, decisions, and artifacts

## Features

- **SQLite + WAL mode** — concurrent reads from any number of MCP server instances
- **FTS5 full-text search** — phrase, boolean, prefix, and column-scoped queries with BM25 ranking
- **Conflict resolution** — version vectors plus six configurable merge strategies (`last_write_wins`, `merge`, `keep_local`, `keep_remote`, `keep_both`, `manual`)
- **Multi-instance coordination** — instance registration, health checks, automatic stale-instance cleanup
- **Peer discovery** — agent registry, heartbeats, capability filtering, direct messaging, and broadcasts
- **Team memory** — shared tasks, contexts, decisions, and artifact storage
- **Memory pressure monitoring** — system/process memory tracking with eviction recommendations

## Installation

Requires Node.js >= 14.

```bash
git clone https://github.com/a2z2k26/bumba-memory-mcp.git
cd bumba-memory-mcp
npm install
```

To make the server invocable as the `bumba-memory-server` command anywhere on your system:

```bash
npm install -g .
```

## MCP Configuration

Add the server to your Claude Code MCP config (typically `~/.claude/claude_desktop_config.json` or your platform's equivalent).

**Using the global bin** (recommended, after `npm install -g .`):

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

**Using an absolute path to a local clone:**

```json
{
  "mcpServers": {
    "bumba-memory": {
      "command": "node",
      "args": ["/absolute/path/to/bumba-memory-mcp/src/mcp-server.js"],
      "env": {
        "BUMBA_MEMORY_DIR": "~/.bumba/memory",
        "BUMBA_LOG_LEVEL": "INFO"
      }
    }
  }
}
```

## Available Tools

The server registers **30 MCP tools** across four categories.

### Core Memory (12)

| Tool | Description |
|------|-------------|
| `memory_store` | Store a memory entry with key, data, optional tags and TTL |
| `memory_retrieve` | Retrieve a memory entry by key |
| `memory_search` | FTS5 full-text search with BM25 ranking; supports tag filters |
| `memory_list` | List recent entries, optionally filtered by agent ID |
| `memory_delete` | Delete an entry by key |
| `memory_stats` | Storage statistics including FTS5 index status |
| `memory_rebuild_index` | Rebuild the FTS5 index (after bulk imports or corruption) |
| `memory_list_conflicts` | List detected write conflicts and their status |
| `memory_resolve_conflict` | Manually resolve a pending conflict |
| `memory_set_merge_strategy` | Configure the merge strategy for a key pattern |
| `memory_pressure` | Current memory pressure status with eviction recommendations |
| `memory_evict` | Trigger cache eviction by strategy (`lru`, `lfu`, `expired`, `pressure`) |

### Team Coordination (8)

| Tool | Description |
|------|-------------|
| `team_start_task` | Start a shared task for multi-agent coordination |
| `team_complete_task` | Complete the current task with results |
| `team_store_context` | Store shared context accessible by all agents |
| `team_get_context` | Retrieve shared context by key |
| `team_record_decision` | Record a decision with rationale |
| `team_store_artifact` | Store an artifact (code, config, document) |
| `team_search` | Search team memory (context, decisions, artifacts) |
| `team_get_status` | Current task status and context summary |

### Peer Discovery (8)

| Tool | Description |
|------|-------------|
| `peer_register` | Register an agent with machine, capabilities, and optional endpoint |
| `peer_heartbeat` | Maintain peer presence with status and current task |
| `peer_deregister` | Remove an agent from the registry |
| `peer_list` | List peers, filterable by machine, status, or capability |
| `peer_get` | Get full details for a specific peer |
| `peer_send_message` | Send a message to another agent |
| `peer_check_messages` | Check for incoming messages |
| `peer_broadcast` | Broadcast a message to all active peers |

### System (2)

| Tool | Description |
|------|-------------|
| `system_health` | Storage, WAL, instance, and directory health |
| `system_instances` | List all active memory server instances sharing this storage |

## FTS5 Search Syntax

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

## Conflict Resolution

When multiple instances write to the same key concurrently, conflicts are detected via version vectors and resolved per a configurable strategy.

| Strategy | Behavior |
|----------|----------|
| `last_write_wins` | Use the entry with the most recent timestamp (default) |
| `merge` | Deep-merge objects, union arrays |
| `keep_local` | Always prefer the existing local data |
| `keep_remote` | Always prefer the incoming remote data |
| `keep_both` | Store both versions in an array |
| `manual` | Mark as pending and require manual resolution |

Default strategies by key prefix:

- `user:*` → `last_write_wins`
- `context:*` → `merge`
- `decision:*` → `keep_both`
- `artifact:*` → `last_write_wins`

Override per pattern with `memory_set_merge_strategy`.

## Memory Key Conventions

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

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BUMBA_MEMORY_DIR` | `~/.bumba/memory` | Directory for all memory storage |
| `BUMBA_LOG_LEVEL` | `INFO` | Log level: `DEBUG`, `INFO`, `WARN`, `ERROR` |

## Directory Structure

```
~/.bumba/memory/
├── memory.db           # SQLite database (WAL mode)
├── memory.db-wal       # WAL file (concurrent reads)
├── memory.db-shm       # Shared memory file
├── team-memory.json    # Team memory state
├── instances/          # Active instance registration files
├── locks/              # File-based coordination locks
└── artifacts/          # Large artifact storage
```

## Memory Bridge (HTTP)

The Memory Bridge is an optional HTTP front-end useful for environments that cannot speak MCP directly — for example, isolated sandboxes that need to push and pull context from the host.

```bash
npm run bridge          # or: node src/memory-bridge-server.js
```

**Endpoints:**

- `POST /sync-in` — push context into a sandbox before spawn
- `POST /sync-out` — pull context out of a sandbox at close
- `GET /context/:key` — fetch a specific context entry
- `POST /store` — store a memory entry
- `POST /search` — search memories
- `GET /health` — health check
- `GET /status` — detailed status including team info

### Security

The Memory Bridge binds to `127.0.0.1` only and is **unauthenticated**. Do not expose it via a reverse proxy, port forward, or to any non-loopback interface without first adding authentication and access control. It is intended exclusively for local-only sandbox synchronization on the same host.

## Library API

You can also use the memory system directly from Node.js by `require`-ing this repo as a local clone (it is not currently published to npm):

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

The `BumbaMemorySystem` constructor accepts a config object whose `unified` field is forwarded to the underlying storage adapter. `dbPath` must be nested under `unified`.

## Optional: Claude Code Integration

This repo ships with optional Claude Code workspace assets under `.claude/`. They are **not** installed automatically — to use them, copy the files into your own Claude Code project workspace:

- `.claude/commands/memory.md` — defines the `/memory` slash command for direct memory operations (`/memory store`, `/memory search`, `/memory team`, etc.)
- `.claude/skills/memory-patterns.md` — best-practice guidance for context handoff, decision recording, search-before-create, and cross-instance awareness

Copy them into the corresponding `.claude/` directory of your project to get the slash command and skill in your Claude Code sessions.

## License

MIT — see [LICENSE](./LICENSE).

## Credits

Author: Andrew Zellinger.

The peer discovery design (registry, heartbeats, messaging, broadcast) is inspired by [claude-peers-mcp](https://github.com/louislva/claude-peers-mcp).
