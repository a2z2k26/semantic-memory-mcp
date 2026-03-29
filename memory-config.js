const path = require('path');

const memoryConfig = {
  development: {
    enabled: true,
    dataDir: path.join(process.cwd(), '.bumba', 'memory'),
    cache: {
      stdTTL: 300,
      checkperiod: 60,
      errorOnMissing: false,
      useClones: true
    },
    operational: {
      type: 'filesystem',
      path: 'operational',
      compression: false
    },
    semantic: {
      type: 'filesystem',
      path: 'semantic',
      embeddingModel: 'text-embedding-ada-002',
      chunkSize: 1000,
      chunkOverlap: 200
    },
    retention: {
      maxAge: 30,
      maxSize: 1000000,
      cleanupInterval: 3600000
    },
    backup: {
      enabled: true,
      interval: 86400000,
      maxBackups: 7
    }
  },

  production: {
    enabled: true,
    dataDir: path.join(process.cwd(), '.bumba', 'memory'),
    cache: {
      stdTTL: 600,
      checkperiod: 120,
      errorOnMissing: false,
      useClones: true
    },
    operational: {
      type: 'sqlite',
      path: path.join(process.cwd(), '.bumba', 'memory', '40-thieves.db'),
      walMode: true,
      busyTimeout: 5000,
      connectionPoolSize: 10
    },
    semantic: {
      type: 'chroma',
      host: process.env.CHROMA_HOST || 'localhost',
      port: process.env.CHROMA_PORT || 8000,
      collection: '40-thieves-memories',
      embeddingModel: 'text-embedding-ada-002'
    },
    retention: {
      maxAge: 90,
      maxSize: 10000000,
      cleanupInterval: 86400000
    },
    backup: {
      enabled: true,
      interval: 86400000,
      maxBackups: 30
    }
  },

  test: {
    enabled: true,
    dataDir: path.join(process.cwd(), '.test', 'memory'),
    cache: {
      stdTTL: 60,
      checkperiod: 10
    },
    operational: {
      type: 'filesystem',
      path: 'test-operational'
    },
    semantic: {
      type: 'filesystem',
      path: 'test-semantic'
    },
    retention: {
      maxAge: 1,
      maxSize: 1000,
      cleanupInterval: 60000
    },
    backup: {
      enabled: false
    }
  }
};

function getMemoryConfig(environment = process.env.NODE_ENV || 'development') {
  return memoryConfig[environment] || memoryConfig.development;
}

module.exports = {
  getMemoryConfig,
  memoryConfig
};