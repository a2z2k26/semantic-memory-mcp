---
name: memory-patterns
description: Patterns and best practices for using Bumba Memory in multi-agent workflows
---

# Bumba Memory Patterns

This skill documents patterns for effectively using the Bumba Memory MCP server in multi-agent coordination scenarios.

## Pattern 1: Context Handoff

**Use when:** Passing context from one agent/session to another

```javascript
// Ending session - store context for successor
await memory_store({
  key: "handoff:feature-auth",
  data: {
    status: "in_progress",
    completedSteps: ["schema", "api-endpoints"],
    pendingSteps: ["frontend-integration", "tests"],
    blockers: [],
    notes: "JWT implementation working, need frontend forms"
  },
  tags: ["handoff", "auth-feature"]
});

// Starting session - retrieve handoff
const context = await memory_retrieve({ key: "handoff:feature-auth" });
```

## Pattern 2: Decision Recording

**Use when:** Making architectural or design decisions that affect future work

```javascript
await team_record_decision({
  decision: "Use SQLite with WAL mode for persistence",
  rationale: "Provides concurrent read access for multiple Claude instances without external database",
  agentId: "architect",
  alternatives: ["PostgreSQL", "MongoDB", "Redis"],
  impact: "All memory operations will be local, no network latency"
});
```

## Pattern 3: Artifact Storage

**Use when:** Creating code, configs, or outputs that should be preserved

```javascript
await team_store_artifact({
  name: "api-schema.yaml",
  type: "openapi",
  content: "openapi: 3.0.0\ninfo:\n  title: Memory API...",
  metadata: {
    version: "1.0",
    generatedBy: "api-designer"
  }
});
```

## Pattern 4: Search Before Create

**Use when:** Starting work that might duplicate existing efforts

```javascript
// Before implementing a feature, check if prior work exists
const existing = await memory_search({
  query: "authentication implementation",
  tags: ["auth", "security"]
});

if (existing.length > 0) {
  // Review existing work before proceeding
  console.log("Found prior work:", existing);
}
```

## Pattern 5: Phase Boundary Context

**Use when:** Transitioning between work phases (planning → execution → review)

```javascript
// End planning phase
await team_complete_task({
  result: {
    plan: ["Step 1: Create schema", "Step 2: Implement API"],
    estimatedComplexity: "medium",
    risks: ["Database migration needed"]
  }
});

// Start execution phase
await team_start_task("Execute authentication feature", {
  phase: "execution",
  basedOn: "planning-task-123"
});
```

## Pattern 6: Cross-Instance Awareness

**Use when:** Multiple Claude instances are working in parallel

```javascript
// Check who else is active
const instances = await system_instances();
console.log(`${instances.totalInstances} instances active`);

// Store work-in-progress marker to avoid conflicts
await memory_store({
  key: `wip:${instanceId}:file-auth.ts`,
  data: { editing: true, startedAt: new Date().toISOString() },
  tags: ["wip", "lock"]
});

// Check for conflicts before editing
const wipMarkers = await memory_search({
  query: "file-auth.ts",
  tags: ["wip"]
});
```

## Memory Key Conventions

Use consistent key prefixes for organization:

| Prefix | Purpose | Example |
|--------|---------|---------|
| `user:` | User preferences/settings | `user:preferences` |
| `context:` | Shared context data | `context:project-config` |
| `decision:` | Recorded decisions | `decision:auth-method` |
| `artifact:` | Generated artifacts | `artifact:schema-v2` |
| `handoff:` | Session handoff data | `handoff:feature-xyz` |
| `wip:` | Work-in-progress markers | `wip:instance-123:file` |
| `cache:` | Cached computations | `cache:dependency-graph` |

## Tag Conventions

Use consistent tags for searchability:

- **Phase tags:** `planning`, `execution`, `review`, `done`
- **Domain tags:** `auth`, `api`, `database`, `frontend`, `testing`
- **Priority tags:** `critical`, `high`, `medium`, `low`
- **Type tags:** `decision`, `artifact`, `context`, `handoff`

## Best Practices

1. **Be specific with keys** - Use namespaced keys like `feature:auth:schema` not just `schema`
2. **Include metadata** - Add agentId, timestamp, version info
3. **Use tags liberally** - Makes search much more effective
4. **Clean up when done** - Delete WIP markers, outdated handoffs
5. **Search before storing** - Avoid duplicating existing information
6. **Record reasoning** - Include rationale with decisions, not just outcomes
