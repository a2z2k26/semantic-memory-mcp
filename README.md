# Bumba Memory MCP Server

Shared semantic memory system for multi-agent coordination. Enables multiple Claude instances (worktrees, sandboxes, separate sessions) to share memory and coordinate through a unified semantic memory layer.

**Comparable to:** LangChain Memory, Mem0

## Features

- **SQLite with WAL mode** - Concurrent read access for multiple instances
- **FTS5 Full-Text Search** - BM25-ranked semantic search with phrase/boolean/prefix support
- **Conflict Resolution** - Version vectors and merge strategies for concurrent writes
- **22 MCP tools** - Core memory, team coordination, conflict resolution, system monitoring, and cache management
- **Multi-instance coordination** - Instance registration, health checks, stale cleanup
- **Team memory** - Shared tasks, context, decisions, artifacts
- **Real gzip compression** - Efficient storage for large data
- **Memory pressure monitoring** - Automatic eviction based on system/process memory usage

## Installation

```bash
cd /path/to/Bumba\ Memory
npm install
```

## Usage

### As MCP Server

Add to your Claude Code MCP configuration:

```json
{
  "mcpServers": {
    "bumba-memory": {
      "command": "node",
      "args": ["/path/to/Bumba Memory/mcp-server.js"],
      "env": {
        "BUMBA_MEMORY_DIR": "~/.bumba/memory"
      }
    }
  }
}
```

### Direct Execution

```bash
node mcp-server.js
```

## Available Tools

### Core Memory (12 tools)

| Tool | Description |
|------|-------------|
| `memory_store` | Store a memory entry with key, data, and optional tags/TTL |
| `memory_retrieve` | Retrieve a memory entry by key |
| `memory_search` | Search memories using FTS5 full-text search with BM25 ranking |
| `memory_list` | List recent memory entries |
| `memory_delete` | Delete a memory entry |
| `memory_stats` | Get storage statistics including FTS5 index status |
| `memory_rebuild_index` | Rebuild FTS5 search index (use after bulk imports) |
| `memory_list_conflicts` | List detected write conflicts and their resolution status |
| `memory_resolve_conflict` | Manually resolve a pending conflict |
| `memory_set_merge_strategy` | Configure merge strategy for key patterns |
| `memory_pressure` | Get current memory pressure status and eviction recommendations |
| `memory_evict` | Manually trigger cache eviction with configurable strategy |

### FTS5 Search Syntax

The `memory_search` tool supports advanced FTS5 query syntax:

```
Simple search:     "authentication"           - searches all fields
Phrase search:     '"exact phrase"'           - matches exact phrase
Boolean AND:       "term1 AND term2"          - both terms required
Boolean OR:        "term1 OR term2"           - either term matches
Negation:          "term1 NOT term2"          - exclude term2
Prefix matching:   "auth*"                    - matches auth, authentication, etc.
Column search:     "key:auth"                 - search only in key column
```

### Conflict Resolution Strategies

When multiple instances write to the same key concurrently, conflicts are resolved using configurable strategies:

| Strategy | Description |
|----------|-------------|
| `last_write_wins` | Use the entry with the most recent timestamp (default) |
| `merge` | Deep merge objects, union arrays |
| `keep_local` | Always prefer existing data |
| `keep_remote` | Always prefer incoming data |
| `keep_both` | Store both versions in an array |
| `manual` | Require manual resolution |

Default strategy rules by key prefix:
- `user:*` → last_write_wins
- `context:*` → merge
- `decision:*` → keep_both
- `artifact:*` → last_write_wins

### Team Coordination (8 tools)

| Tool | Description |
|------|-------------|
| `team_start_task` | Start a shared task for multi-agent coordination |
| `team_complete_task` | Complete the current task with results |
| `team_store_context` | Store shared context accessible by all agents |
| `team_get_context` | Retrieve shared context by key |
| `team_record_decision` | Record a decision made during execution |
| `team_store_artifact` | Store an artifact (code, config, document) |
| `team_search` | Search team memory by keyword |
| `team_get_status` | Get current team task status and context summary |

### Multi-Instance Coordination (2 tools)

| Tool | Description |
|------|-------------|
| `system_health` | Get health status including storage, WAL, and instances |
| `system_instances` | List all active memory server instances |

## Directory Structure

```
~/.bumba/memory/
├── memory.db           # SQLite database with WAL mode
├── memory.db-wal       # WAL file (enables concurrent reads)
├── memory.db-shm       # Shared memory file
├── team-memory.json    # Team memory state
├── instances/          # Instance registration files
├── locks/              # File-based coordination locks
└── artifacts/          # Large artifact storage
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BUMBA_MEMORY_DIR` | `~/.bumba/memory` | Directory for all memory storage |
| `BUMBA_LOG_LEVEL` | `INFO` | Logging level: DEBUG, INFO, WARN, ERROR |

## Multi-Layer Caching

The advanced cache manager implements a three-tier caching system:

| Layer | Type | Storage | TTL | Use Case |
|-------|------|---------|-----|----------|
| **L1** | Memory | In-process | 5 min | Hot data, sub-millisecond access |
| **L2** | Disk | `~/.bumba/memory/cache/l2` | 1 hour | Warm data, persists across restarts |
| **L3** | Distributed | `~/.bumba/memory/shared-cache` | 24 hours | Cross-instance sharing with locks |

Features:
- **Cache warming** - L1 populated from L2/L3 on startup
- **Automatic promotion** - Frequently accessed data moves up layers
- **TTL management** - Entries expire automatically per layer config
- **File-based locking** - L3 supports concurrent multi-instance access

## Architecture

```
memory/
├── mcp-server.js                 # MCP server with 22 tools
├── index.js                      # Main entry (library mode)
├── sqlite-storage-adapter.js     # SQLite backend with WAL + FTS5
├── memory-optimization-engine.js # Optimization + compression
├── advanced-cache-manager.js     # Multi-layer caching (L1/L2/L3)
├── resilience-memory.js          # Failure handling
├── team-memory.js                # Multi-agent coordination
└── lib/
    ├── bumba-logger.js           # Logging utility
    ├── version-vector.js         # Causality tracking for conflicts
    ├── conflict-resolver.js      # Multi-instance conflict resolution
    └── memory-monitor.js         # Memory pressure monitoring
```

## Claude Code Integration

### Memory Command

Use the `/memory` command for quick operations:

```
/memory store mykey '{"data": "value"}'
/memory retrieve mykey
/memory search "search query"
/memory list
/memory stats
/memory health
/memory team
/memory handoff feature-name       # Create work handoff
/memory decide "Decision" "Reason" # Record decision
/memory sync                       # Check E2B bridge status
/memory sandboxes                  # List sandbox memories
```

### Remember Command (Natural Language)

Use `/remember` for conversational memory access:

```
/remember what did we decide about authentication
/remember this - stores current context
/remember recall the API design decisions
/remember what work did the sandbox agents do
/remember find anything about database schema
```

### Memory Patterns Skill

Refer to `.claude/skills/memory-patterns.md` for best practices on:
- Context handoff between sessions
- Decision recording
- Artifact storage
- Search before create
- Phase boundary context
- Cross-instance awareness

## Automated Memory Hooks

The system includes automation hooks that prompt Claude to preserve context at key moments:

### SessionStart Hook
When a session starts, checks for:
- Active tasks in progress
- Pending work handoffs
- Recent decisions

Outputs a systemMessage suggesting relevant memory queries.

### SubagentStop Hook
When a subagent (worktree agent, Task agent) completes:
- Prompts to store artifacts of accomplishments
- Prompts to record any decisions made
- Prompts to create handoff if work is incomplete

### Stop Hook
When the main session ends:
- Prompts to complete or handoff active tasks
- Prompts to record key decisions
- Prompts to store session summary

### Hook Configuration

Hooks are configured in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{"matcher": "*", "hooks": [{"type": "command", "command": "bash ~/.claude/hooks/memory-session-start.sh"}]}],
    "SubagentStop": [{"matcher": "*", "hooks": [{"type": "command", "command": "bash ~/.claude/hooks/memory-subagent-stop.sh"}]}],
    "Stop": [{"matcher": "*", "hooks": [{"type": "command", "command": "bash ~/.claude/hooks/memory-session-stop.sh"}]}]
  }
}
```

## E2B Sandbox Integration

E2B sandboxes are completely isolated and cannot access the host filesystem. The Memory Bridge HTTP API provides sync capabilities.

### Memory Bridge Server

Start the bridge server:

```bash
node memory-bridge-server.js [--port 3847]
```

**Endpoints:**
- `POST /sync-in` - Push context TO sandbox before spawn
- `POST /sync-out` - Pull context FROM sandbox at close
- `GET /context/:key` - Get specific context
- `POST /store` - Store memory entry
- `POST /search` - Search memories
- `GET /health` - Health check
- `GET /status` - Detailed status with team info

### Sandbox Lifecycle Integration

When using Bumba-Sandbox-MCP:

1. **On sandbox_init/sandbox_create:**
   - Memory Bridge is called with `/sync-in`
   - Context is written to `/workspace/.bumba-context.json`
   - Notes directory created at `/workspace/.bumba-notes/`

2. **During sandbox work:**
   - Agent reads context from `.bumba-context.json`
   - Agent writes notes to `.bumba-notes/`
   - Agent creates summary in `.bumba-summary.json`

3. **On sandbox_kill:**
   - Summary and notes are read from sandbox
   - Memory Bridge is called with `/sync-out`
   - All artifacts/decisions/contexts stored to shared memory

### Sandbox Context File Format

**Input context (`/workspace/.bumba-context.json`):**
```json
{
  "sandboxId": "abc123",
  "syncedAt": "2024-01-15T10:00:00Z",
  "contexts": {
    "context:current-task": {...},
    "handoff:feature-x": {...}
  },
  "teamStatus": {
    "currentTask": {...},
    "recentDecisions": [...]
  }
}
```

**Output summary (`/workspace/.bumba-summary.json`):**
```json
{
  "summary": {
    "accomplishments": ["Implemented X", "Fixed Y"],
    "filesCreated": ["src/new.ts"]
  },
  "artifacts": [
    {"name": "implementation", "type": "code", "content": "..."}
  ],
  "decisions": [
    {"decision": "Used approach A", "rationale": "Because..."}
  ],
  "contexts": {
    "progress": {"completed": true}
  }
}
```

## Memory Key Conventions

| Prefix | Purpose |
|--------|---------|
| `context:` | Shared state, project config |
| `handoff:` | Work-in-progress for another agent |
| `decision:` | Recorded decisions with rationale |
| `artifact:` | Generated outputs, code snippets |
| `sandbox:{id}:` | Results from E2B sandboxes |
| `session:{date}:` | Session summaries |
| `user:` | User preferences, settings |
| `agent:{id}:` | Agent-specific memory |

## Library API

```javascript
const { BumbaMemorySystem } = require('@bumba/memory');

const memory = new BumbaMemorySystem({
  dbPath: './data/memory.db'
});

await memory.initialize();

// Store memories
await memory.store('agent-1:task-1', {
  type: 'task_result',
  content: 'Completed code review',
  tags: ['code-review', 'backend']
});

// Search memories
const results = await memory.search('code review');
```

## License

MIT
