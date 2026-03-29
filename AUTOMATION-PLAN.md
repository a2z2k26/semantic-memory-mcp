# Bumba Memory Automation Plan

## Conceptual Proposal: Automated Shared Memory Integration

This plan outlines how to automate memory sharing across your multi-environment workflow: primary sessions, git worktrees, and E2B sandboxes.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         PRIMARY CLAUDE SESSION                          │
│  • Orchestrates work                                                    │
│  • Queries shared memory for agent results                              │
│  • Makes final decisions based on aggregated context                    │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
                    ▼               ▼               ▼
        ┌───────────────┐ ┌───────────────┐ ┌───────────────┐
        │  Git Worktree │ │  Git Worktree │ │  E2B Sandbox  │
        │   Agent #1    │ │   Agent #2    │ │   Agent #3    │
        │               │ │               │ │               │
        │ Local FS      │ │ Local FS      │ │ Isolated FS   │
        │ Same ~/.bumba │ │ Same ~/.bumba │ │ Synced memory │
        └───────────────┘ └───────────────┘ └───────────────┘
                    │               │               │
                    └───────────────┼───────────────┘
                                    ▼
                    ┌───────────────────────────────┐
                    │     SHARED BUMBA MEMORY       │
                    │   ~/.bumba/memory/memory.db   │
                    │                               │
                    │  • SQLite with WAL mode       │
                    │  • FTS5 search index          │
                    │  • Conflict resolution        │
                    └───────────────────────────────┘
```

---

## Environment Types & Memory Access

### 1. Git Worktrees (Shared Filesystem)
**Memory Access**: Native - same `~/.bumba/memory` directory
**Complexity**: Low - just needs MCP configured

Git worktrees share the same filesystem, so they naturally share the same memory database. The WAL mode in SQLite enables concurrent reads from multiple worktree agents.

### 2. E2B Sandboxes (Isolated Filesystem)
**Memory Access**: Requires sync mechanism
**Complexity**: Medium - need to sync on exit

E2B sandboxes duplicate the code directory but run in isolation. Two approaches:

**Option A: Mount shared volume (if E2B supports)**
- Mount `~/.bumba/memory` from host into sandbox
- Agents read/write directly to shared memory

**Option B: Sync on session boundaries**
- Sandbox has local memory copy
- On sandbox close, export context to primary session
- Primary session writes to shared memory

---

## Automation Hooks Plan

### Hook 1: SessionStart - Context Loading

**Location**: `.claude/hooks/session-start-memory.md`

**Purpose**: When any agent (worktree or sandbox) starts, load relevant context from shared memory.

```yaml
---
hook: SessionStart
description: Load relevant context from shared memory on session start
---
```

**Behavior**:
1. Call `team_get_status` to check for active tasks
2. Call `memory_search` with project-relevant keywords
3. Inject retrieved context into agent's initial state
4. Log session start to `system_instances`

### Hook 2: SubagentStop - Worktree Agent Summary

**Location**: `.claude/hooks/subagent-stop-memory.md`

**Purpose**: When a worktree agent completes, summarize and store its work.

```yaml
---
hook: SubagentStop
description: Store agent work summary to shared memory
---
```

**Behavior**:
1. Generate summary of agent's actions and outputs
2. Call `team_store_artifact` with:
   - name: `{agent-type}-{task-id}-result`
   - type: `agent-output`
   - content: Summary + key files changed
3. Call `team_record_decision` for any decisions made
4. Call `memory_store` with key `agent:{id}:summary`

### Hook 3: E2B Sandbox Close - Context Export

**Location**: `.claude/hooks/e2b-close-memory.md`

**Purpose**: Before E2B sandbox closes, export all context to shared memory.

**Behavior**:
1. Collect all files created/modified in sandbox
2. Generate comprehensive work summary
3. Call `team_store_artifact` for each significant output
4. Call `team_store_context` with sandbox state
5. Call `team_record_decision` for choices made
6. Store with keys prefixed: `sandbox:{sandbox-id}:`

### Hook 4: PreToolUse - Memory-Aware Decisions

**Location**: `.claude/hooks/pre-tool-memory.md`

**Purpose**: Before major actions, check if relevant context exists in memory.

```yaml
---
hook: PreToolUse
matchTools:
  - Write
  - Edit
  - Task
---
```

**Behavior**:
1. Extract intent from pending action
2. Call `memory_search` for similar past work
3. If relevant context found, inject into decision-making
4. Avoid duplicating work already done by other agents

### Hook 5: Stop - Session End Summary

**Location**: `.claude/hooks/session-end-memory.md`

**Purpose**: When primary session ends, create comprehensive session summary.

```yaml
---
hook: Stop
description: Store session summary to shared memory
---
```

**Behavior**:
1. Summarize entire session's work
2. List all decisions made
3. Store under `session:{date}:{id}`
4. Update `context:current-project` with latest state

---

## Key Patterns for Memory Usage

### Pattern 1: Search Before Create
Before creating any significant artifact, search memory first:
```
memory_search("similar feature OR existing implementation")
```
Prevents duplicate work across agents.

### Pattern 2: Decision Recording
Every architectural or design decision gets recorded:
```
team_record_decision({
  decision: "Use SQLite FTS5 for search",
  rationale: "Best balance of simplicity and performance",
  agentId: "worktree-agent-2"
})
```

### Pattern 3: Phase Boundary Context
At the end of each work phase, store comprehensive context:
```
team_store_context("phase:implementation", {
  completed: [...],
  pending: [...],
  blockers: [...],
  nextSteps: [...]
})
```

### Pattern 4: Cross-Instance Awareness
Agents check for other active instances:
```
system_instances() → see who else is working
memory_search("in_progress:*") → see active tasks
```

---

## E2B Sandbox Integration Details

### Sandbox Initialization
When spawning E2B sandbox:
1. Include Bumba Memory MCP in sandbox config
2. Pass current project context as initialization data
3. Set environment variable: `BUMBA_SANDBOX_ID={unique-id}`

### Sandbox Memory Directory Options

**Option A: Ephemeral + Sync**
```
Sandbox uses: /tmp/bumba-sandbox-{id}/memory
On close: Sync to host ~/.bumba/memory
```

**Option B: Shared Mount (if supported)**
```
Mount host ~/.bumba/memory → /sandbox/.bumba/memory
Direct read/write to shared DB
```

### Sandbox Close Protocol
1. Agent generates work summary
2. Agent calls `team_store_artifact` with all outputs
3. Agent calls `team_store_context` with final state
4. Primary session receives notification
5. Primary session can query: `memory_search("sandbox:{id}")`

---

## Implementation Priority

### Phase 1: Core Hooks (Immediate)
1. `SubagentStop` hook for worktree agents
2. `Stop` hook for session summaries
3. `SessionStart` hook for context loading

### Phase 2: E2B Integration (Next)
1. E2B sandbox memory configuration
2. Sandbox close sync mechanism
3. Cross-sandbox search capability

### Phase 3: Advanced Automation (Later)
1. `PreToolUse` for memory-aware decisions
2. Automatic conflict resolution
3. Memory compaction and cleanup automation

---

## Configuration Requirements

### MCP Config for All Environments
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

### Environment Variables
```bash
BUMBA_MEMORY_DIR=~/.bumba/memory    # Shared memory location
BUMBA_AGENT_ID={unique-id}          # Per-agent identifier
BUMBA_SANDBOX_ID={sandbox-id}       # For E2B sandboxes
```

---

## Questions to Resolve

1. **E2B Mount Support**: Can E2B mount host directories? If not, sync approach needed.

2. **Conflict Frequency**: How often will concurrent writes occur? May need to tune merge strategies.

3. **Memory Retention**: How long to keep agent outputs? Need TTL policy.

4. **Search Scope**: Should agents see all history or only recent/relevant?

---

## Next Steps

1. Review this plan and provide feedback
2. Create the Phase 1 hooks
3. Test with a simple worktree scenario
4. Extend to E2B once core hooks are working
