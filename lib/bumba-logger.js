/**
 * Bumba Logger
 * Simple logger wrapper for the Bumba Memory system
 * Provides consistent logging across all modules without external dependencies
 *
 * Usage:
 *   const Logger = require('../lib/bumba-logger');
 *   const logger = new Logger('ComponentName');
 *   logger.info('Message');
 */

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  SILENT: 4
};

// Default log level from environment or INFO
const currentLevel = LOG_LEVELS[process.env.BUMBA_LOG_LEVEL?.toUpperCase()] || LOG_LEVELS.INFO;

class Logger {
  constructor(component = 'Bumba') {
    this.component = component;
  }

  formatMessage(level, args) {
    const timestamp = new Date().toISOString();
    const prefix = `[${this.component}]`;
    return [`${timestamp} ${level} ${prefix}`, ...args];
  }

  debug(...args) {
    if (currentLevel <= LOG_LEVELS.DEBUG) {
      process.stderr.write(this.formatMessage('DEBUG', args).join(' ') + '\n');
    }
  }

  info(...args) {
    if (currentLevel <= LOG_LEVELS.INFO) {
      process.stderr.write(this.formatMessage('INFO', args).join(' ') + '\n');
    }
  }

  warn(...args) {
    if (currentLevel <= LOG_LEVELS.WARN) {
      process.stderr.write(this.formatMessage('WARN', args).join(' ') + '\n');
    }
  }

  error(...args) {
    if (currentLevel <= LOG_LEVELS.ERROR) {
      process.stderr.write(this.formatMessage('ERROR', args).join(' ') + '\n');
    }
  }
}

// Export the class
module.exports = Logger;
module.exports.LOG_LEVELS = LOG_LEVELS;
