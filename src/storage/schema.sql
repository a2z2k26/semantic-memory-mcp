-- Bumba Memory MCP - SQLite Schema
-- Version: 1.0.0
-- Created: 2025-09-29

-- Enable foreign keys
PRAGMA foreign_keys = ON;

-- Enable WAL mode for better concurrency
PRAGMA journal_mode = WAL;

-- =============================================
-- AGENTS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    agent_type TEXT NOT NULL,
    role TEXT NOT NULL,
    parent_id TEXT,
    state TEXT DEFAULT '{}',
    capabilities TEXT DEFAULT '[]',
    metadata TEXT DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    last_active_at INTEGER,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (parent_id) REFERENCES agents(id) ON DELETE SET NULL
);

CREATE INDEX idx_agents_type ON agents(agent_type);
CREATE INDEX idx_agents_parent ON agents(parent_id);
CREATE INDEX idx_agents_active ON agents(is_active);
CREATE INDEX idx_agents_created ON agents(created_at);

-- =============================================
-- TASKS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    complexity INTEGER DEFAULT 1 CHECK(complexity BETWEEN 1 AND 10),
    assigned_agent_id TEXT,
    parent_task_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'queued', 'active', 'completed', 'failed', 'cancelled')),
    result TEXT,
    error_log TEXT,
    retry_count INTEGER DEFAULT 0,
    execution_time_ms INTEGER,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    started_at INTEGER,
    completed_at INTEGER,
    FOREIGN KEY (assigned_agent_id) REFERENCES agents(id) ON DELETE SET NULL,
    FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_agent ON tasks(assigned_agent_id);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);
CREATE INDEX idx_tasks_created ON tasks(created_at);
CREATE INDEX idx_tasks_complexity ON tasks(complexity);

-- =============================================
-- EXECUTIONS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    started_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    completed_at INTEGER,
    duration_ms INTEGER,
    success BOOLEAN,
    error_message TEXT,
    resources_used TEXT DEFAULT '{}',
    performance_score REAL,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX idx_executions_agent ON executions(agent_id);
CREATE INDEX idx_executions_task ON executions(task_id);
CREATE INDEX idx_executions_started ON executions(started_at);
CREATE INDEX idx_executions_success ON executions(success);

-- =============================================
-- COMMUNICATIONS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS communications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT UNIQUE NOT NULL,
    from_agent_id TEXT NOT NULL,
    to_agent_id TEXT NOT NULL,
    message_type TEXT NOT NULL,
    content TEXT NOT NULL,
    context TEXT DEFAULT '{}',
    success BOOLEAN DEFAULT 1,
    response_time_ms INTEGER,
    timestamp INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (from_agent_id) REFERENCES agents(id) ON DELETE CASCADE,
    FOREIGN KEY (to_agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX idx_comm_from ON communications(from_agent_id);
CREATE INDEX idx_comm_to ON communications(to_agent_id);
CREATE INDEX idx_comm_type ON communications(message_type);
CREATE INDEX idx_comm_timestamp ON communications(timestamp);

-- =============================================
-- PERFORMANCE_METRICS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS performance_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    metric_type TEXT NOT NULL,
    value REAL NOT NULL,
    aggregation TEXT DEFAULT 'instant' CHECK(aggregation IN ('instant', 'avg', 'sum', 'min', 'max')),
    period TEXT DEFAULT 'minute' CHECK(period IN ('second', 'minute', 'hour', 'day', 'week', 'month')),
    timestamp INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    metadata TEXT DEFAULT '{}',
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX idx_metrics_agent ON performance_metrics(agent_id);
CREATE INDEX idx_metrics_type ON performance_metrics(metric_type);
CREATE INDEX idx_metrics_timestamp ON performance_metrics(timestamp);
CREATE INDEX idx_metrics_agent_type_time ON performance_metrics(agent_id, metric_type, timestamp);

-- =============================================
-- SESSIONS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT '{}',
    active_agents TEXT DEFAULT '[]',
    configuration TEXT DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    ended_at INTEGER,
    is_active BOOLEAN DEFAULT 1
);

CREATE INDEX idx_sessions_active ON sessions(is_active);
CREATE INDEX idx_sessions_created ON sessions(created_at);

-- =============================================
-- CIRCUIT_BREAKERS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS circuit_breakers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_name TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('closed', 'open', 'half-open')),
    failure_count INTEGER DEFAULT 0,
    last_failure_at INTEGER,
    opened_at INTEGER,
    will_retry_at INTEGER,
    metadata TEXT DEFAULT '{}'
);

CREATE INDEX idx_breakers_service ON circuit_breakers(service_name);
CREATE INDEX idx_breakers_state ON circuit_breakers(state);

-- =============================================
-- LEARNED_PATTERNS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS learned_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern_type TEXT NOT NULL,
    pattern_data TEXT NOT NULL,
    success_rate REAL DEFAULT 0.0,
    usage_count INTEGER DEFAULT 0,
    last_used_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    metadata TEXT DEFAULT '{}'
);

CREATE INDEX idx_patterns_type ON learned_patterns(pattern_type);
CREATE INDEX idx_patterns_success ON learned_patterns(success_rate);
CREATE INDEX idx_patterns_usage ON learned_patterns(usage_count);

-- =============================================
-- AGENT_RELATIONSHIPS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS agent_relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_agent_id TEXT NOT NULL,
    child_agent_id TEXT NOT NULL,
    relationship_type TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    metadata TEXT DEFAULT '{}',
    FOREIGN KEY (parent_agent_id) REFERENCES agents(id) ON DELETE CASCADE,
    FOREIGN KEY (child_agent_id) REFERENCES agents(id) ON DELETE CASCADE,
    UNIQUE(parent_agent_id, child_agent_id, relationship_type)
);

CREATE INDEX idx_rel_parent ON agent_relationships(parent_agent_id);
CREATE INDEX idx_rel_child ON agent_relationships(child_agent_id);
CREATE INDEX idx_rel_type ON agent_relationships(relationship_type);

-- =============================================
-- MEMORY_METADATA TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS memory_metadata (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_type TEXT NOT NULL,
    memory_key TEXT NOT NULL,
    access_count INTEGER DEFAULT 0,
    last_accessed_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    expires_at INTEGER,
    tags TEXT DEFAULT '[]',
    importance_score REAL DEFAULT 0.5,
    UNIQUE(memory_type, memory_key)
);

CREATE INDEX idx_meta_type_key ON memory_metadata(memory_type, memory_key);
CREATE INDEX idx_meta_expires ON memory_metadata(expires_at);
CREATE INDEX idx_meta_importance ON memory_metadata(importance_score);

-- =============================================
-- VIEWS FOR COMMON QUERIES
-- =============================================

-- Active agents with their current task counts
CREATE VIEW IF NOT EXISTS v_active_agents AS
SELECT
    a.id,
    a.agent_type,
    a.role,
    COUNT(DISTINCT t.id) as active_tasks,
    MAX(t.created_at) as last_task_at
FROM agents a
LEFT JOIN tasks t ON a.id = t.assigned_agent_id AND t.status IN ('active', 'queued')
WHERE a.is_active = 1
GROUP BY a.id;

-- Agent performance summary
CREATE VIEW IF NOT EXISTS v_agent_performance AS
SELECT
    a.id,
    a.agent_type,
    COUNT(DISTINCT e.task_id) as total_tasks,
    SUM(CASE WHEN e.success = 1 THEN 1 ELSE 0 END) as successful_tasks,
    AVG(e.duration_ms) as avg_duration_ms,
    AVG(e.performance_score) as avg_performance_score
FROM agents a
LEFT JOIN executions e ON a.id = e.agent_id
GROUP BY a.id;

-- Task completion rates by complexity
CREATE VIEW IF NOT EXISTS v_task_complexity_stats AS
SELECT
    complexity,
    COUNT(*) as total_tasks,
    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_tasks,
    AVG(execution_time_ms) as avg_execution_time,
    AVG(retry_count) as avg_retries
FROM tasks
GROUP BY complexity;

-- Communication patterns
CREATE VIEW IF NOT EXISTS v_communication_patterns AS
SELECT
    from_agent_id,
    to_agent_id,
    message_type,
    COUNT(*) as message_count,
    AVG(response_time_ms) as avg_response_time,
    SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) as success_rate
FROM communications
GROUP BY from_agent_id, to_agent_id, message_type;