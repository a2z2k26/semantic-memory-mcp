const fs = require('fs-extra');
const path = require('path');
const EventEmitter = require('events');
const Logger = require('../lib/bumba-logger');

class JsonDatabaseProvider extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      dataPath: path.join(process.cwd(), '.bumba', 'memory', 'database'),
      walMode: true,
      busyTimeout: 5000,
      maxConnections: 10,
      ...config
    };

    this.logger = new Logger('JsonDatabaseProvider');
    this.tables = new Map();
    this.transactions = new Map();
    this.locks = new Map();
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;

    try {
      await fs.ensureDir(this.config.dataPath);

      const schemaPath = path.join(this.config.dataPath, 'schema.json');
      if (await fs.pathExists(schemaPath)) {
        const schema = await fs.readJson(schemaPath);
        await this.loadSchema(schema);
      } else {
        await this.createDefaultSchema();
      }

      this.initialized = true;
      this.logger.info('JSON Database Provider initialized');
    } catch (error) {
      this.logger.error('Failed to initialize database:', error);
      throw error;
    }
  }

  async createDefaultSchema() {
    const tables = [
      'agents',
      'tasks',
      'executions',
      'semantic_memories',
      'communications',
      'performance_metrics',
      'sessions',
      'session_activities',
      'session_checkpoints',
      'crash_reports',
      'circuit_breakers',
      'learned_patterns',
      'agent_relationships',
      'agent_hierarchies',
      'memory_metadata'
    ];

    for (const tableName of tables) {
      await this.createTable(tableName);
    }

    await this.saveSchema();
  }

  async createTable(tableName) {
    const tablePath = path.join(this.config.dataPath, `${tableName}.json`);

    if (!await fs.pathExists(tablePath)) {
      await fs.writeJson(tablePath, {
        name: tableName,
        records: [],
        indexes: {},
        autoIncrement: 1,
        createdAt: Date.now()
      }, { spaces: 2 });
    }

    const tableData = await fs.readJson(tablePath);
    this.tables.set(tableName, tableData);
  }

  async loadSchema(schema) {
    for (const tableName of schema.tables) {
      const tablePath = path.join(this.config.dataPath, `${tableName}.json`);
      if (await fs.pathExists(tablePath)) {
        const tableData = await fs.readJson(tablePath);
        this.tables.set(tableName, tableData);
      }
    }
  }

  async saveSchema() {
    const schema = {
      version: '1.0.0',
      tables: Array.from(this.tables.keys()),
      createdAt: Date.now()
    };

    await fs.writeJson(
      path.join(this.config.dataPath, 'schema.json'),
      schema,
      { spaces: 2 }
    );
  }

  async insert(tableName, record) {
    await this.initialize();

    const table = this.tables.get(tableName);
    if (!table) {
      throw new Error(`Table ${tableName} does not exist`);
    }

    await this.acquireLock(tableName);

    try {
      const newRecord = {
        ...record,
        _id: record.id || `${tableName}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        _createdAt: Date.now()
      };

      table.records.push(newRecord);

      this.updateIndexes(table, newRecord);

      await this.persistTable(tableName, table);

      return newRecord;
    } finally {
      this.releaseLock(tableName);
    }
  }

  async bulkInsert(tableName, records) {
    await this.initialize();

    const table = this.tables.get(tableName);
    if (!table) {
      throw new Error(`Table ${tableName} does not exist`);
    }

    await this.acquireLock(tableName);

    try {
      const newRecords = records.map(record => ({
        ...record,
        _id: record.id || `${tableName}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        _createdAt: Date.now()
      }));

      table.records.push(...newRecords);

      for (const record of newRecords) {
        this.updateIndexes(table, record);
      }

      await this.persistTable(tableName, table);

      return newRecords;
    } finally {
      this.releaseLock(tableName);
    }
  }

  async select(tableName, query = {}, options = {}) {
    await this.initialize();

    const table = this.tables.get(tableName);
    if (!table) {
      throw new Error(`Table ${tableName} does not exist`);
    }

    let results = [...table.records];

    if (Object.keys(query).length > 0) {
      results = results.filter(record => this.matchesQuery(record, query));
    }

    if (options.orderBy) {
      results.sort((a, b) => {
        const field = options.orderBy.field;
        const order = options.orderBy.order === 'desc' ? -1 : 1;
        return (a[field] > b[field] ? 1 : -1) * order;
      });
    }

    if (options.limit) {
      const offset = options.offset || 0;
      results = results.slice(offset, offset + options.limit);
    }

    if (options.fields) {
      results = results.map(record => {
        const filtered = {};
        for (const field of options.fields) {
          filtered[field] = record[field];
        }
        return filtered;
      });
    }

    return results;
  }

  async selectOne(tableName, query) {
    const results = await this.select(tableName, query, { limit: 1 });
    return results[0] || null;
  }

  async update(tableName, query, updates) {
    await this.initialize();

    const table = this.tables.get(tableName);
    if (!table) {
      throw new Error(`Table ${tableName} does not exist`);
    }

    await this.acquireLock(tableName);

    try {
      let updatedCount = 0;

      for (let i = 0; i < table.records.length; i++) {
        if (this.matchesQuery(table.records[i], query)) {
          table.records[i] = {
            ...table.records[i],
            ...updates,
            _updatedAt: Date.now()
          };
          updatedCount++;
        }
      }

      if (updatedCount > 0) {
        this.rebuildIndexes(table);
        await this.persistTable(tableName, table);
      }

      return updatedCount;
    } finally {
      this.releaseLock(tableName);
    }
  }

  async delete(tableName, query) {
    await this.initialize();

    const table = this.tables.get(tableName);
    if (!table) {
      throw new Error(`Table ${tableName} does not exist`);
    }

    await this.acquireLock(tableName);

    try {
      const originalLength = table.records.length;
      table.records = table.records.filter(record => !this.matchesQuery(record, query));
      const deletedCount = originalLength - table.records.length;

      if (deletedCount > 0) {
        this.rebuildIndexes(table);
        await this.persistTable(tableName, table);
      }

      return deletedCount;
    } finally {
      this.releaseLock(tableName);
    }
  }

  async count(tableName, query = {}) {
    await this.initialize();

    const table = this.tables.get(tableName);
    if (!table) {
      throw new Error(`Table ${tableName} does not exist`);
    }

    if (Object.keys(query).length === 0) {
      return table.records.length;
    }

    return table.records.filter(record => this.matchesQuery(record, query)).length;
  }

  async aggregate(tableName, pipeline) {
    await this.initialize();

    const table = this.tables.get(tableName);
    if (!table) {
      throw new Error(`Table ${tableName} does not exist`);
    }

    let results = [...table.records];

    for (const stage of pipeline) {
      if (stage.$match) {
        results = results.filter(record => this.matchesQuery(record, stage.$match));
      } else if (stage.$group) {
        results = this.groupRecords(results, stage.$group);
      } else if (stage.$sort) {
        results = this.sortRecords(results, stage.$sort);
      } else if (stage.$limit) {
        results = results.slice(0, stage.$limit);
      } else if (stage.$skip) {
        results = results.slice(stage.$skip);
      }
    }

    return results;
  }

  groupRecords(records, groupSpec) {
    const groups = new Map();

    for (const record of records) {
      const key = groupSpec._id ? record[groupSpec._id] : 'all';

      if (!groups.has(key)) {
        groups.set(key, { _id: key });
      }

      const group = groups.get(key);

      for (const [field, operation] of Object.entries(groupSpec)) {
        if (field === '_id') continue;

        if (operation.$sum) {
          group[field] = (group[field] || 0) + (operation.$sum === 1 ? 1 : record[operation.$sum]);
        } else if (operation.$avg) {
          if (!group[`_${field}_sum`]) {
            group[`_${field}_sum`] = 0;
            group[`_${field}_count`] = 0;
          }
          group[`_${field}_sum`] += record[operation.$avg];
          group[`_${field}_count`]++;
          group[field] = group[`_${field}_sum`] / group[`_${field}_count`];
        } else if (operation.$min) {
          group[field] = group[field] === undefined
            ? record[operation.$min]
            : Math.min(group[field], record[operation.$min]);
        } else if (operation.$max) {
          group[field] = group[field] === undefined
            ? record[operation.$max]
            : Math.max(group[field], record[operation.$max]);
        }
      }
    }

    return Array.from(groups.values()).map(group => {
      const cleaned = { ...group };
      for (const key of Object.keys(cleaned)) {
        if (key.startsWith('_') && key.includes('_sum') || key.includes('_count')) {
          delete cleaned[key];
        }
      }
      return cleaned;
    });
  }

  sortRecords(records, sortSpec) {
    return records.sort((a, b) => {
      for (const [field, order] of Object.entries(sortSpec)) {
        const comparison = a[field] > b[field] ? 1 : a[field] < b[field] ? -1 : 0;
        if (comparison !== 0) {
          return comparison * order;
        }
      }
      return 0;
    });
  }

  matchesQuery(record, query) {
    for (const [field, condition] of Object.entries(query)) {
      if (typeof condition === 'object' && condition !== null) {
        if (condition.$gt !== undefined && !(record[field] > condition.$gt)) return false;
        if (condition.$gte !== undefined && !(record[field] >= condition.$gte)) return false;
        if (condition.$lt !== undefined && !(record[field] < condition.$lt)) return false;
        if (condition.$lte !== undefined && !(record[field] <= condition.$lte)) return false;
        if (condition.$ne !== undefined && record[field] === condition.$ne) return false;
        if (condition.$in !== undefined && !condition.$in.includes(record[field])) return false;
        if (condition.$nin !== undefined && condition.$nin.includes(record[field])) return false;
        if (condition.$regex !== undefined) {
          const regex = new RegExp(condition.$regex, condition.$options);
          if (!regex.test(record[field])) return false;
        }
      } else {
        if (record[field] !== condition) return false;
      }
    }
    return true;
  }

  updateIndexes(table, record) {
    // Simple indexing implementation
    if (!table.indexes) table.indexes = {};

    for (const [field, value] of Object.entries(record)) {
      if (!table.indexes[field]) {
        table.indexes[field] = new Map();
      }
      if (!table.indexes[field].has(value)) {
        table.indexes[field].set(value, []);
      }
      table.indexes[field].get(value).push(record._id);
    }
  }

  rebuildIndexes(table) {
    table.indexes = {};

    for (const record of table.records) {
      this.updateIndexes(table, record);
    }
  }

  async persistTable(tableName, table) {
    const tablePath = path.join(this.config.dataPath, `${tableName}.json`);

    const tableData = {
      ...table,
      indexes: {}
    };

    await fs.writeJson(tablePath, tableData, { spaces: 2 });

    this.emit('persisted', { table: tableName, records: table.records.length });
  }

  async acquireLock(tableName, timeout = 5000) {
    const startTime = Date.now();

    while (this.locks.get(tableName)) {
      if (Date.now() - startTime > timeout) {
        throw new Error(`Failed to acquire lock for table ${tableName}`);
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    this.locks.set(tableName, true);
  }

  releaseLock(tableName) {
    this.locks.delete(tableName);
  }

  async beginTransaction() {
    const transactionId = `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.transactions.set(transactionId, {
      id: transactionId,
      operations: [],
      startedAt: Date.now()
    });
    return transactionId;
  }

  async commit(transactionId) {
    const transaction = this.transactions.get(transactionId);
    if (!transaction) {
      throw new Error(`Transaction ${transactionId} not found`);
    }

    for (const operation of transaction.operations) {
      await operation();
    }

    this.transactions.delete(transactionId);
  }

  async rollback(transactionId) {
    this.transactions.delete(transactionId);
  }

  async vacuum() {
    for (const [tableName, table] of this.tables.entries()) {
      this.rebuildIndexes(table);
      await this.persistTable(tableName, table);
    }

    this.logger.info('Database vacuumed');
  }

  async getStatistics() {
    const stats = {
      tables: {},
      totalRecords: 0,
      totalSize: 0
    };

    for (const [tableName, table] of this.tables.entries()) {
      stats.tables[tableName] = {
        records: table.records.length,
        size: JSON.stringify(table).length
      };
      stats.totalRecords += table.records.length;
      stats.totalSize += stats.tables[tableName].size;
    }

    return stats;
  }

  async shutdown() {
    for (const [tableName, table] of this.tables.entries()) {
      await this.persistTable(tableName, table);
    }

    this.tables.clear();
    this.locks.clear();
    this.transactions.clear();

    this.initialized = false;
    this.logger.info('Database provider shut down');
  }

  // Provider interface methods for MemorySystem compatibility
  async store(key, data, options = {}) {
    await this.initialize();
    const tableName = options.table || 'memory_store';

    if (!this.tables.has(tableName)) {
      await this.createTable(tableName);
    }

    return await this.insert(tableName, {
      id: key,
      data: JSON.stringify(data),
      metadata: JSON.stringify(options.metadata || {}),
      timestamp: Date.now()
    });
  }

  async retrieve(key, options = {}) {
    await this.initialize();
    const tableName = options.table || 'memory_store';

    if (!this.tables.has(tableName)) {
      return null;
    }

    const record = await this.selectOne(tableName, { id: key });
    if (record && record.data) {
      try {
        return JSON.parse(record.data);
      } catch {
        return record.data;
      }
    }
    return null;
  }

  async search(query, options = {}) {
    await this.initialize();
    const tableName = options.table || 'memory_store';

    if (!this.tables.has(tableName)) {
      return [];
    }

    const records = await this.select(tableName, {});
    const results = [];

    for (const record of records) {
      try {
        const data = JSON.parse(record.data);
        if (this.matchesSearchQuery(data, query)) {
          results.push(data);
        }
      } catch {
        // Skip invalid records
      }
    }

    return results;
  }

  matchesSearchQuery(data, query) {
    if (typeof query === 'string') {
      const searchStr = JSON.stringify(data).toLowerCase();
      return searchStr.includes(query.toLowerCase());
    }
    return this.matchesQuery(data, query);
  }

  async getStats() {
    const stats = {
      tables: {},
      totalRecords: 0,
      dataPath: this.config.dataPath
    };

    for (const [tableName, table] of this.tables.entries()) {
      const count = table?.data?.length || 0;
      stats.tables[tableName] = count;
      stats.totalRecords += count;
    }

    return stats;
  }

  async close() {
    this.tables.clear();
    this.transactions.clear();
    this.locks.clear();
    this.initialized = false;
    this.logger.info('Database closed');
  }
}

module.exports = JsonDatabaseProvider;