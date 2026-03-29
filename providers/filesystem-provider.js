const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const Logger = require('../lib/bumba-logger');

class FileSystemProvider {
  constructor(config = {}) {
    this.config = {
      basePath: path.join(process.cwd(), '.bumba', 'memory', 'filesystem'),
      maxFileSize: 10 * 1024 * 1024, // 10MB
      rotationSize: 100 * 1024 * 1024, // 100MB
      compressionEnabled: false,
      encryptionEnabled: false,
      ...config
    };

    this.logger = new Logger('FileSystemProvider');
    this.initialized = false;
    this.fileIndex = new Map();
    this.rotationCounter = 0;
  }

  async initialize() {
    if (this.initialized) return;

    try {
      await fs.ensureDir(this.config.basePath);
      await fs.ensureDir(path.join(this.config.basePath, 'data'));
      await fs.ensureDir(path.join(this.config.basePath, 'archives'));
      await fs.ensureDir(path.join(this.config.basePath, 'temp'));

      await this.loadIndex();

      this.initialized = true;
      this.logger.info('FileSystem Provider initialized');
    } catch (error) {
      this.logger.error('Failed to initialize FileSystem Provider:', error);
      throw error;
    }
  }

  async store(key, data, options = {}) {
    await this.initialize();

    try {
      const serialized = JSON.stringify({
        key,
        data,
        timestamp: Date.now(),
        checksum: this.calculateChecksum(data),
        metadata: options.metadata || {}
      });

      if (serialized.length > this.config.maxFileSize) {
        return await this.storeChunked(key, serialized, options);
      }

      const fileName = this.generateFileName(key, options.type);
      const filePath = path.join(this.config.basePath, 'data', fileName);

      await fs.writeFile(filePath, serialized, 'utf8');

      this.fileIndex.set(key, {
        fileName,
        size: serialized.length,
        timestamp: Date.now(),
        type: options.type || 'default'
      });

      await this.saveIndex();
      await this.checkRotation();

      this.logger.debug(`Stored ${key} to filesystem`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to store ${key}:`, error);
      throw error;
    }
  }

  async retrieve(key, options = {}) {
    await this.initialize();

    try {
      const indexEntry = this.fileIndex.get(key);
      if (!indexEntry) {
        return null;
      }

      const filePath = path.join(this.config.basePath, 'data', indexEntry.fileName);

      if (!await fs.pathExists(filePath)) {
        const archivePath = path.join(this.config.basePath, 'archives', indexEntry.fileName);
        if (await fs.pathExists(archivePath)) {
          return await this.retrieveFromArchive(key, archivePath);
        }
        return null;
      }

      const content = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(content);

      if (!this.verifyChecksum(parsed.data, parsed.checksum)) {
        this.logger.warn(`Checksum mismatch for ${key}`);
        if (options.strictChecksum) {
          throw new Error(`Data integrity check failed for ${key}`);
        }
      }

      return parsed.data;
    } catch (error) {
      this.logger.error(`Failed to retrieve ${key}:`, error);
      return null;
    }
  }

  async search(query, options = {}) {
    await this.initialize();

    const results = [];
    const dataDir = path.join(this.config.basePath, 'data');
    const files = await fs.readdir(dataDir);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const filePath = path.join(dataDir, file);
        const content = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(content);

        if (this.matchesQuery(parsed, query)) {
          results.push(parsed.data);

          if (options.limit && results.length >= options.limit) {
            break;
          }
        }
      } catch (error) {
        this.logger.warn(`Failed to search in file ${file}:`, error);
      }
    }

    return results;
  }

  async delete(key) {
    await this.initialize();

    const indexEntry = this.fileIndex.get(key);
    if (!indexEntry) {
      return false;
    }

    const filePath = path.join(this.config.basePath, 'data', indexEntry.fileName);

    try {
      if (await fs.pathExists(filePath)) {
        await fs.remove(filePath);
      }

      this.fileIndex.delete(key);
      await this.saveIndex();

      this.logger.debug(`Deleted ${key} from filesystem`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to delete ${key}:`, error);
      return false;
    }
  }

  async storeChunked(key, data, options) {
    const chunkSize = this.config.maxFileSize;
    const chunks = Math.ceil(data.length / chunkSize);
    const chunkFiles = [];

    for (let i = 0; i < chunks; i++) {
      const chunkData = data.slice(i * chunkSize, (i + 1) * chunkSize);
      const chunkKey = `${key}_chunk_${i}`;
      const fileName = this.generateFileName(chunkKey, 'chunk');
      const filePath = path.join(this.config.basePath, 'data', fileName);

      await fs.writeFile(filePath, chunkData, 'utf8');
      chunkFiles.push(fileName);
    }

    this.fileIndex.set(key, {
      fileName: chunkFiles,
      size: data.length,
      timestamp: Date.now(),
      type: 'chunked',
      chunks: chunks
    });

    await this.saveIndex();
    return true;
  }

  async retrieveChunked(key, indexEntry) {
    let fullData = '';

    for (const fileName of indexEntry.fileName) {
      const filePath = path.join(this.config.basePath, 'data', fileName);
      if (await fs.pathExists(filePath)) {
        const chunkData = await fs.readFile(filePath, 'utf8');
        fullData += chunkData;
      }
    }

    const parsed = JSON.parse(fullData);
    return parsed.data;
  }

  async checkRotation() {
    const dataDir = path.join(this.config.basePath, 'data');
    const stats = await this.getDirectorySize(dataDir);

    if (stats.size > this.config.rotationSize) {
      await this.rotateFiles();
    }
  }

  async rotateFiles() {
    const dataDir = path.join(this.config.basePath, 'data');
    const archiveDir = path.join(this.config.basePath, 'archives');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archiveName = `archive_${timestamp}_${++this.rotationCounter}`;
    const archivePath = path.join(archiveDir, archiveName);

    await fs.ensureDir(archivePath);

    const files = await fs.readdir(dataDir);
    const filesToArchive = files.slice(0, Math.floor(files.length / 2));

    for (const file of filesToArchive) {
      const sourcePath = path.join(dataDir, file);
      const destPath = path.join(archivePath, file);
      await fs.move(sourcePath, destPath);
    }

    this.logger.info(`Rotated ${filesToArchive.length} files to archive ${archiveName}`);
  }

  async retrieveFromArchive(key, archivePath) {
    try {
      const content = await fs.readFile(archivePath, 'utf8');
      const parsed = JSON.parse(content);
      return parsed.data;
    } catch (error) {
      this.logger.error(`Failed to retrieve ${key} from archive:`, error);
      return null;
    }
  }

  async loadIndex() {
    const indexPath = path.join(this.config.basePath, 'index.json');

    if (await fs.pathExists(indexPath)) {
      try {
        const indexData = await fs.readJson(indexPath);
        this.fileIndex = new Map(Object.entries(indexData));
        this.logger.debug(`Loaded index with ${this.fileIndex.size} entries`);
      } catch (error) {
        this.logger.warn('Failed to load index, starting fresh:', error);
        this.fileIndex = new Map();
      }
    } else {
      await this.rebuildIndex();
    }
  }

  async saveIndex() {
    const indexPath = path.join(this.config.basePath, 'index.json');
    const indexData = Object.fromEntries(this.fileIndex);

    await fs.writeJson(indexPath, indexData, { spaces: 2 });

    const backupPath = path.join(this.config.basePath, 'index.backup.json');
    await fs.copy(indexPath, backupPath, { overwrite: true });
  }

  async rebuildIndex() {
    this.logger.info('Rebuilding file index...');
    this.fileIndex = new Map();

    const dataDir = path.join(this.config.basePath, 'data');
    if (!await fs.pathExists(dataDir)) {
      return;
    }

    const files = await fs.readdir(dataDir);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const filePath = path.join(dataDir, file);
        const stats = await fs.stat(filePath);
        const content = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(content);

        this.fileIndex.set(parsed.key, {
          fileName: file,
          size: stats.size,
          timestamp: stats.mtimeMs,
          type: parsed.metadata?.type || 'default'
        });
      } catch (error) {
        this.logger.warn(`Failed to index file ${file}:`, error);
      }
    }

    await this.saveIndex();
    this.logger.info(`Rebuilt index with ${this.fileIndex.size} entries`);
  }

  generateFileName(key, type = 'default') {
    const sanitized = key.replace(/[^a-zA-Z0-9-_]/g, '_');
    const hash = crypto.createHash('md5').update(key).digest('hex').substring(0, 8);
    const timestamp = Date.now();
    return `${type}_${sanitized}_${hash}_${timestamp}.json`;
  }

  calculateChecksum(data) {
    const stringified = typeof data === 'string' ? data : JSON.stringify(data);
    return crypto.createHash('sha256').update(stringified).digest('hex');
  }

  verifyChecksum(data, checksum) {
    return this.calculateChecksum(data) === checksum;
  }

  matchesQuery(parsed, query) {
    if (typeof query === 'string') {
      const searchStr = JSON.stringify(parsed).toLowerCase();
      return searchStr.includes(query.toLowerCase());
    }

    if (typeof query === 'object') {
      for (const [key, value] of Object.entries(query)) {
        if (parsed.data?.[key] !== value && parsed.metadata?.[key] !== value) {
          return false;
        }
      }
      return true;
    }

    return false;
  }

  async getDirectorySize(dirPath) {
    let totalSize = 0;
    let fileCount = 0;

    const files = await fs.readdir(dirPath);

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stats = await fs.stat(filePath);

      if (stats.isFile()) {
        totalSize += stats.size;
        fileCount++;
      }
    }

    return { size: totalSize, files: fileCount };
  }

  async compact() {
    await this.initialize();

    const dataDir = path.join(this.config.basePath, 'data');
    const tempDir = path.join(this.config.basePath, 'temp');
    const files = await fs.readdir(dataDir);

    let compactedCount = 0;

    for (const file of files) {
      const filePath = path.join(dataDir, file);
      const tempPath = path.join(tempDir, file);

      try {
        const content = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(content);
        const compacted = JSON.stringify(parsed);

        await fs.writeFile(tempPath, compacted, 'utf8');

        const originalSize = (await fs.stat(filePath)).size;
        const compactedSize = (await fs.stat(tempPath)).size;

        if (compactedSize < originalSize) {
          await fs.move(tempPath, filePath, { overwrite: true });
          compactedCount++;
        } else {
          await fs.remove(tempPath);
        }
      } catch (error) {
        this.logger.warn(`Failed to compact ${file}:`, error);
      }
    }

    this.logger.info(`Compacted ${compactedCount} files`);
    return compactedCount;
  }

  async getStatistics() {
    const dataStats = await this.getDirectorySize(path.join(this.config.basePath, 'data'));
    const archiveStats = await this.getDirectorySize(path.join(this.config.basePath, 'archives'));

    return {
      dataFiles: dataStats.files,
      dataSize: dataStats.size,
      archiveFiles: archiveStats.files,
      archiveSize: archiveStats.size,
      totalSize: dataStats.size + archiveStats.size,
      indexEntries: this.fileIndex.size,
      rotationCounter: this.rotationCounter
    };
  }

  async shutdown() {
    await this.saveIndex();
    this.fileIndex.clear();
    this.initialized = false;
    this.logger.info('FileSystem Provider shut down');
  }
}

module.exports = FileSystemProvider;