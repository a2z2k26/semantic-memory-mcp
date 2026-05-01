/**
 * Team Memory System
 * Shared memory for multi-agent coordination
 * Enables context sharing and incremental knowledge building
 */

const fs = require('fs');
const path = require('path');
const Logger = require('../lib/logger');

const logger = new Logger('TeamMemory');

class TeamMemory {
  constructor(options = {}) {
    this.memoryDir = options.memoryDir || path.join(process.cwd(), '.bumba', 'memory');
    this.teamMemoryFile = path.join(this.memoryDir, 'team-memory.json');
    this.sessionId = options.sessionId || `session-${Date.now()}`;
    this.memory = {};
    this.initialized = false;
  }

  /**
   * Initialize team memory
   */
  async initialize() {
    if (this.initialized) return;

    // Ensure memory directory exists
    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true });
    }

    // Load existing memory
    await this.load();
    this.initialized = true;

    logger.debug('Team memory initialized', { sessionId: this.sessionId });
  }

  /**
   * Load memory from disk
   */
  async load() {
    try {
      if (fs.existsSync(this.teamMemoryFile)) {
        const content = fs.readFileSync(this.teamMemoryFile, 'utf-8');
        this.memory = JSON.parse(content);
      } else {
        this.memory = {
          sessions: {},
          currentTask: null,
          sharedContext: {},
          agentContributions: {},
          decisions: [],
          artifacts: []
        };
      }
    } catch (error) {
      logger.warn('Failed to load team memory:', error.message);
      this.memory = {
        sessions: {},
        currentTask: null,
        sharedContext: {},
        agentContributions: {},
        decisions: [],
        artifacts: []
      };
    }
  }

  /**
   * Save memory to disk
   */
  async save() {
    try {
      fs.writeFileSync(this.teamMemoryFile, JSON.stringify(this.memory, null, 2));
    } catch (error) {
      logger.error('Failed to save team memory:', error.message);
    }
  }

  // ============================================
  // TASK MANAGEMENT
  // ============================================

  /**
   * Start a new team task - stores initial context
   */
  async startTask(taskDescription, metadata = {}) {
    const taskId = `task-${Date.now()}`;

    this.memory.currentTask = {
      id: taskId,
      description: taskDescription,
      startedAt: new Date().toISOString(),
      status: 'active',
      metadata,
      phases: []
    };

    // Initialize session for this task
    this.memory.sessions[this.sessionId] = {
      taskId,
      startedAt: new Date().toISOString(),
      context: {},
      contributions: []
    };

    await this.save();

    return taskId;
  }

  /**
   * Complete the current task
   */
  async completeTask(result = {}) {
    if (this.memory.currentTask) {
      this.memory.currentTask.status = 'completed';
      this.memory.currentTask.completedAt = new Date().toISOString();
      this.memory.currentTask.result = result;

      // Archive to history
      const historyKey = `history:${this.memory.currentTask.id}`;
      this.memory[historyKey] = { ...this.memory.currentTask };

      await this.save();
    }
  }

  /**
   * Get current task context
   */
  getCurrentTask() {
    return this.memory.currentTask;
  }

  // ============================================
  // PHASE MANAGEMENT
  // ============================================

  /**
   * Start a new phase (management, execution, review)
   */
  async startPhase(phaseName, context = {}) {
    const phase = {
      name: phaseName,
      startedAt: new Date().toISOString(),
      context,
      agentOutputs: [],
      status: 'active'
    };

    if (this.memory.currentTask) {
      this.memory.currentTask.phases.push(phase);
    }

    // Store phase context for easy retrieval
    this.memory.sharedContext[`phase:${phaseName}`] = context;

    await this.save();

    return phase;
  }

  /**
   * Complete a phase with results
   */
  async completePhase(phaseName, results = {}) {
    if (this.memory.currentTask) {
      const phase = this.memory.currentTask.phases.find(p => p.name === phaseName && p.status === 'active');
      if (phase) {
        phase.status = 'completed';
        phase.completedAt = new Date().toISOString();
        phase.results = results;

        // Store phase results in shared context for next phase
        this.memory.sharedContext[`phase:${phaseName}:results`] = results;
      }
    }

    await this.save();
  }

  /**
   * Get previous phase results (for context chaining)
   */
  getPhaseResults(phaseName) {
    return this.memory.sharedContext[`phase:${phaseName}:results`] || null;
  }

  // ============================================
  // AGENT CONTRIBUTIONS
  // ============================================

  /**
   * Store an agent's contribution
   */
  async storeAgentContribution(agentId, contribution) {
    const entry = {
      agentId,
      timestamp: new Date().toISOString(),
      contribution,
      taskId: this.memory.currentTask?.id
    };

    // Store in agent-specific bucket
    if (!this.memory.agentContributions[agentId]) {
      this.memory.agentContributions[agentId] = [];
    }
    this.memory.agentContributions[agentId].push(entry);

    // Also store in current phase if active
    if (this.memory.currentTask) {
      const activePhase = this.memory.currentTask.phases.find(p => p.status === 'active');
      if (activePhase) {
        activePhase.agentOutputs.push(entry);
      }
    }

    // Store in session
    if (this.memory.sessions[this.sessionId]) {
      this.memory.sessions[this.sessionId].contributions.push(entry);
    }

    await this.save();
  }

  /**
   * Get contributions from a specific agent
   */
  getAgentContributions(agentId) {
    return this.memory.agentContributions[agentId] || [];
  }

  /**
   * Get all contributions for current task
   */
  getAllContributions() {
    if (!this.memory.currentTask) return [];

    const contributions = [];
    for (const phase of this.memory.currentTask.phases) {
      contributions.push(...(phase.agentOutputs || []));
    }
    return contributions;
  }

  // ============================================
  // SHARED CONTEXT
  // ============================================

  /**
   * Store shared context (accessible by all agents)
   */
  async storeContext(key, value) {
    this.memory.sharedContext[key] = {
      value,
      storedAt: new Date().toISOString(),
      sessionId: this.sessionId
    };
    await this.save();
  }

  /**
   * Retrieve shared context
   */
  getContext(key) {
    const entry = this.memory.sharedContext[key];
    return entry?.value || null;
  }

  /**
   * Get all shared context
   */
  getAllContext() {
    const context = {};
    for (const [key, entry] of Object.entries(this.memory.sharedContext)) {
      context[key] = entry?.value !== undefined ? entry.value : entry;
    }
    return context;
  }

  /**
   * Append to shared context (for incremental building)
   */
  async appendContext(key, value) {
    const existing = this.getContext(key);

    if (Array.isArray(existing)) {
      await this.storeContext(key, [...existing, value]);
    } else if (typeof existing === 'object' && existing !== null) {
      await this.storeContext(key, { ...existing, ...value });
    } else if (typeof existing === 'string') {
      await this.storeContext(key, existing + '\n' + value);
    } else {
      await this.storeContext(key, value);
    }
  }

  // ============================================
  // DECISIONS
  // ============================================

  /**
   * Record a decision made during execution
   */
  async recordDecision(decision) {
    const entry = {
      ...decision,
      timestamp: new Date().toISOString(),
      taskId: this.memory.currentTask?.id,
      sessionId: this.sessionId
    };

    this.memory.decisions.push(entry);
    await this.save();
  }

  /**
   * Get decisions for current task
   */
  getDecisions() {
    const taskId = this.memory.currentTask?.id;
    return this.memory.decisions.filter(d => d.taskId === taskId);
  }

  // ============================================
  // ARTIFACTS
  // ============================================

  /**
   * Store an artifact (file, code, document)
   */
  async storeArtifact(artifact) {
    const entry = {
      ...artifact,
      id: `artifact-${Date.now()}`,
      storedAt: new Date().toISOString(),
      taskId: this.memory.currentTask?.id,
      sessionId: this.sessionId
    };

    this.memory.artifacts.push(entry);
    await this.save();

    return entry.id;
  }

  /**
   * Get artifacts for current task
   */
  getArtifacts() {
    const taskId = this.memory.currentTask?.id;
    return this.memory.artifacts.filter(a => a.taskId === taskId);
  }

  // ============================================
  // CONTEXT SUMMARY FOR AGENTS
  // ============================================

  /**
   * Generate a context summary for an agent
   * This is injected into the agent's system prompt
   */
  generateAgentContext(agentType = 'worker') {
    const context = [];

    // Current task info
    if (this.memory.currentTask) {
      context.push(`## Current Task`);
      context.push(`Task: ${this.memory.currentTask.description}`);
      context.push(`Status: ${this.memory.currentTask.status}`);
      context.push('');
    }

    // Previous phase results
    const phases = this.memory.currentTask?.phases || [];
    const completedPhases = phases.filter(p => p.status === 'completed');

    if (completedPhases.length > 0) {
      context.push(`## Previous Phase Results`);
      for (const phase of completedPhases.slice(-3)) { // Last 3 phases
        context.push(`### ${phase.name}`);
        if (phase.results) {
          const summary = typeof phase.results === 'string'
            ? phase.results.substring(0, 500)
            : JSON.stringify(phase.results).substring(0, 500);
          context.push(summary);
        }
        context.push('');
      }
    }

    // Key decisions
    const decisions = this.getDecisions();
    if (decisions.length > 0) {
      context.push(`## Key Decisions Made`);
      for (const d of decisions.slice(-5)) { // Last 5 decisions
        context.push(`- ${d.description || d.decision || JSON.stringify(d)}`);
      }
      context.push('');
    }

    // Shared context items
    const sharedKeys = Object.keys(this.memory.sharedContext).filter(k => !k.startsWith('phase:'));
    if (sharedKeys.length > 0) {
      context.push(`## Shared Context`);
      for (const key of sharedKeys.slice(-5)) { // Last 5 shared items
        const value = this.getContext(key);
        const summary = typeof value === 'string'
          ? value.substring(0, 200)
          : JSON.stringify(value).substring(0, 200);
        context.push(`- ${key}: ${summary}`);
      }
      context.push('');
    }

    // Memory usage instructions
    context.push(`## Memory Instructions`);
    context.push(`You have access to shared team memory. Use the memory_operations tool to:`);
    context.push(`- Store important findings: { operation: 'store', key: 'finding:<topic>', value: <your finding> }`);
    context.push(`- Retrieve context: { operation: 'retrieve', key: '<key>' }`);
    context.push(`- Search memory: { operation: 'search', key: '<search term>' }`);
    context.push(`Store any important decisions, discoveries, or artifacts for other agents to use.`);
    context.push('');

    return context.join('\n');
  }

  /**
   * Get a compact context summary (for token efficiency)
   */
  getCompactContext() {
    return {
      task: this.memory.currentTask?.description,
      phases: (this.memory.currentTask?.phases || []).map(p => ({
        name: p.name,
        status: p.status
      })),
      decisionCount: this.getDecisions().length,
      contributionCount: this.getAllContributions().length,
      sharedKeys: Object.keys(this.memory.sharedContext).slice(-10)
    };
  }

  // ============================================
  // HISTORY & SEARCH
  // ============================================

  /**
   * Get task history
   */
  getHistory(limit = 10) {
    const historyKeys = Object.keys(this.memory)
      .filter(k => k.startsWith('history:'))
      .sort()
      .reverse()
      .slice(0, limit);

    return historyKeys.map(k => this.memory[k]);
  }

  /**
   * Search memory by keyword
   */
  search(query) {
    const results = [];
    const queryLower = query.toLowerCase();

    // Search shared context
    for (const [key, entry] of Object.entries(this.memory.sharedContext)) {
      const value = entry?.value !== undefined ? entry.value : entry;
      const valueStr = typeof value === 'string' ? value : JSON.stringify(value);

      if (key.toLowerCase().includes(queryLower) || valueStr.toLowerCase().includes(queryLower)) {
        results.push({ type: 'context', key, value, match: 'shared_context' });
      }
    }

    // Search decisions
    for (const decision of this.memory.decisions) {
      const decisionStr = JSON.stringify(decision).toLowerCase();
      if (decisionStr.includes(queryLower)) {
        results.push({ type: 'decision', ...decision, match: 'decision' });
      }
    }

    // Search artifacts
    for (const artifact of this.memory.artifacts) {
      const artifactStr = JSON.stringify(artifact).toLowerCase();
      if (artifactStr.includes(queryLower)) {
        results.push({ type: 'artifact', ...artifact, match: 'artifact' });
      }
    }

    return results;
  }

  /**
   * Clear current session memory (but keep history)
   */
  async clearSession() {
    this.memory.currentTask = null;
    this.memory.sharedContext = {};
    this.memory.agentContributions = {};
    delete this.memory.sessions[this.sessionId];
    await this.save();
  }
}

// Singleton instance
let instance = null;

function getInstance(options = {}) {
  if (!instance) {
    instance = new TeamMemory(options);
  }
  return instance;
}

function createTeamMemory(options = {}) {
  return new TeamMemory(options);
}

module.exports = {
  TeamMemory,
  getInstance,
  createTeamMemory
};
