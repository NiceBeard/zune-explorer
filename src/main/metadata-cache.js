const fs = require('fs/promises');
const path = require('path');

class MetadataCache {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, 'metadata-cache.json');
    this.cache = null; // lazy loaded
  }

  async _load() {
    if (this.cache) return;
    try {
      const data = await fs.readFile(this.filePath, 'utf-8');
      this.cache = JSON.parse(data);
    } catch {
      this.cache = {};
    }
  }

  async _save() {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.cache, null, 2));
  }

  _key(artist, album) {
    return `${(artist || '').toLowerCase().trim()}|${(album || '').toLowerCase().trim()}`;
  }

  async get(artist, album) {
    await this._load();
    return this.cache[this._key(artist, album)] || null;
  }

  async set(artist, album, data) {
    await this._load();
    this.cache[this._key(artist, album)] = {
      ...data,
      updatedAt: new Date().toISOString(),
    };
    await this._save();
  }

  async getAll() {
    await this._load();
    return { ...this.cache };
  }
}

module.exports = { MetadataCache };
