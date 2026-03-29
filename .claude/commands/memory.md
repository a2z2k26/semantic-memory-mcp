---
name: memory
description: Interact with shared Bumba Memory MCP system
arguments:
  - name: action
    description: "Action: store, retrieve, search, list, stats, health, team, handoff, decide, sync, sandboxes"
    required: true
  - name: key
    description: Memory key (for store/retrieve/handoff actions)
  - name: value
    description: Value to store (JSON string for store action)
  - name: query
    description: Search query (for search action)
  - name: decision
    description: Decision text (for decide action)
  - name: rationale
    description: Rationale for decision (for decide action)
---

# Bumba Memory Command

Execute memory operations against the shared Bumba Memory MCP server.

## Available Actions

### Core Memory Operations
- `store` - Store a memory entry: `/memory store mykey '{"data": "value"}'`
- `retrieve` - Get a memory by key: `/memory retrieve mykey`
- `search` - Search memories: `/memory search "search query"`
- `list` - List recent memories: `/memory list`
- `stats` - Get storage statistics: `/memory stats`
- `health` - Check system health: `/memory health`

### Team Coordination
- `team` - Show team status and context: `/memory team`
- `handoff` - Create work handoff for another agent: `/memory handoff task-name`
- `decide` - Record a decision with rationale: `/memory decide "Use SQLite" "Better concurrency"`

### Sandbox Integration
- `sync` - Check Memory Bridge status for E2B sandboxes: `/memory sync`
- `sandboxes` - List sandbox memories: `/memory sandboxes`

## Usage Examples

```
/memory store user:preferences '{"theme": "dark", "lang": "en"}'
/memory retrieve user:preferences
/memory search "API configuration"
/memory list
/memory stats
/memory health
/memory team
/memory handoff feature-implementation
/memory decide "Use FTS5 for search" "Best balance of simplicity and performance"
/memory sync
/memory sandboxes
```

## When to Use Memory

1. **Store important findings** - When you discover something that future agents or sessions should know
2. **Record decisions** - Document architectural decisions, design choices, rationale
3. **Share context** - Pass information between different Claude sessions/worktrees
4. **Track artifacts** - Store code snippets, configurations, outputs for reference
5. **Create handoffs** - When passing incomplete work to another agent
6. **Check sandbox results** - Access work from E2B sandbox agents

## Action: $ARGUMENTS.action

Key: $ARGUMENTS.key
Value: $ARGUMENTS.value
Query: $ARGUMENTS.query
Decision: $ARGUMENTS.decision
Rationale: $ARGUMENTS.rationale

Based on the action requested, use the appropriate MCP tool:
- For `store`: Use `memory_store` with the key and parsed JSON value
- For `retrieve`: Use `memory_retrieve` with the key
- For `search`: Use `memory_search` with the query
- For `list`: Use `memory_list`
- For `stats`: Use `memory_stats`
- For `health`: Use `system_health`
- For `team`: Use `team_get_status`
- For `handoff`: Use `team_store_context` with key `handoff:{key}` containing:
  - status: 'in_progress'
  - handoffAt: current timestamp
  - description: Ask user what to include
  - completed: List of completed items
  - remaining: List of remaining items
  - notes: Any relevant context
- For `decide`: Use `team_record_decision` with:
  - decision: The decision text
  - rationale: The rationale provided
  - agentId: Current agent identifier
- For `sync`: Check Memory Bridge server at http://127.0.0.1:3847/status
  Report whether bridge is running and show active sandboxes
- For `sandboxes`: Use `memory_search` with query "sandbox:*"
  List all memories from E2B sandboxes
