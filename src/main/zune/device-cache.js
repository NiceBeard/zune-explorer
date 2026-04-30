const fs = require('fs/promises');
const path = require('path');

class DeviceCache {
  constructor(userDataPath) {
    this.cacheDir = path.join(userDataPath, 'device-cache');
  }

  getDeviceKey(productId, maxCapacity) {
    const pidHex = productId.toString(16).toUpperCase().padStart(4, '0');
    return `${pidHex}-${maxCapacity}`;
  }

  _filePath(deviceKey) {
    return path.join(this.cacheDir, `${deviceKey}.json`);
  }

  async load(deviceKey) {
    try {
      const data = await fs.readFile(this._filePath(deviceKey), 'utf-8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async save(deviceKey, data) {
    await fs.mkdir(this.cacheDir, { recursive: true });
    const payload = {
      deviceKey,
      lastScanned: new Date().toISOString(),
      ...data,
    };
    await fs.writeFile(this._filePath(deviceKey), JSON.stringify(payload));
  }

  async invalidate(deviceKey) {
    try {
      await fs.unlink(this._filePath(deviceKey));
    } catch {
      // File may not exist
    }
  }

  async clear() {
    try {
      const entries = await fs.readdir(this.cacheDir);
      await Promise.all(
        entries
          .filter(e => e.endsWith('.json'))
          .map(e => fs.unlink(path.join(this.cacheDir, e)).catch(() => {}))
      );
    } catch {
      // cacheDir may not exist yet — nothing to clear
    }
  }
}

module.exports = { DeviceCache };
