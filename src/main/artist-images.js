const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { normalizeArtistName, artistNamesMatch, primaryArtist } = require('../shared/artist-name');

const MISS_RETRY_MS = 14 * 24 * 60 * 60 * 1000;
const MIN_MB_SCORE = 90;
const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// Artist photos from fanart.tv (via MusicBrainz MBID) with Deezer as fallback,
// cached on disk under userData/artist-images. Network functions are injected.
class ArtistImages {
  constructor(userDataPath, { searchArtists, fetchJson, fetchBinary, getApiKey, now = Date.now }) {
    this.dir = path.join(userDataPath, 'artist-images');
    this.indexPath = path.join(this.dir, 'index.json');
    this.searchArtists = searchArtists;
    this.fetchJson = fetchJson;
    this.fetchBinary = fetchBinary;
    this.getApiKey = getApiKey;
    this.now = now;
    this.index = null; // lazy loaded
    this._inflight = new Map();
  }

  _key(name) {
    return normalizeArtistName(primaryArtist(name));
  }

  async _load() {
    if (this.index) return;
    try {
      this.index = JSON.parse(await fs.readFile(this.indexPath, 'utf-8'));
    } catch {
      this.index = {};
    }
  }

  async _save() {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = this.indexPath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(this.index, null, 2));
    await fs.rename(tmp, this.indexPath);
  }

  async _result(entry) {
    if (!entry || entry.removed || !entry.file) return null;
    const filePath = path.join(this.dir, entry.file);
    try {
      await fs.access(filePath);
    } catch {
      return null;
    }
    return {
      url: `${pathToFileURL(filePath).href}?v=${entry.fetchedAt}`,
      source: entry.source,
      candidateCount: entry.candidates.length,
    };
  }

  // Share one in-flight operation per artist so concurrent callers don't double-fetch.
  _once(key, fn) {
    if (this._inflight.has(key)) return this._inflight.get(key);
    const p = fn().finally(() => this._inflight.delete(key));
    this._inflight.set(key, p);
    return p;
  }

  async get(name) {
    const key = this._key(name);
    if (!key) return null;
    await this._load();
    return this._result(this.index[key]);
  }

  find(name) {
    const key = this._key(name);
    if (!key) return Promise.resolve(null);
    return this._once(key, () => this._find(key, primaryArtist(name)));
  }

  async _find(key, name) {
    await this._load();
    const entry = this.index[key];
    if (entry) {
      if (entry.removed) return null;
      if (entry.file) {
        const r = await this._result(entry);
        if (r) return r;
      } else if (entry.miss && this.now() - entry.checkedAt < MISS_RETRY_MS) {
        return null;
      }
    }

    let candidates, mbid;
    try {
      ({ candidates, mbid } = await this._lookup(name));
    } catch (err) {
      // Offline or service trouble: record nothing so we try again next time.
      console.warn('artist image lookup failed for', name, err.message);
      return null;
    }

    if (candidates.length === 0) {
      this.index[key] = { miss: true, checkedAt: this.now() };
      await this._save();
      return null;
    }
    return this._useCandidate(key, { candidates, mbid, index: 0 });
  }

  async _lookup(name) {
    const candidates = [];
    let mbid = null;
    const apiKey = this.getApiKey();
    if (apiKey) {
      const artists = await this.searchArtists(name);
      const match = artists.find(a => a.score >= MIN_MB_SCORE && artistNamesMatch(a.name, name));
      if (match) {
        mbid = match.mbid;
        let art = null;
        try {
          art = await this.fetchJson(`https://webservice.fanart.tv/v3/music/${mbid}?api_key=${encodeURIComponent(apiKey)}`);
        } catch (err) {
          if (err.statusCode !== 404) throw err; // 404 = fanart.tv has nothing for this artist
        }
        for (const type of ['artistbackground', 'artistthumb']) {
          const images = (art && Array.isArray(art[type])) ? art[type].slice() : [];
          images.sort((a, b) => (parseInt(b.likes, 10) || 0) - (parseInt(a.likes, 10) || 0));
          for (const img of images) if (img.url) candidates.push({ source: 'fanart', url: img.url });
        }
      }
    }
    const deezer = await this.fetchJson(`https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}`);
    for (const a of (deezer && deezer.data) || []) {
      if (a.picture_xl && artistNamesMatch(a.name, name)) candidates.push({ source: 'deezer', url: a.picture_xl });
    }
    return { candidates, mbid };
  }

  // Download candidates[index] and make it the artist's photo. Returns null on failure, changing nothing.
  async _useCandidate(key, { candidates, mbid, index }) {
    const candidate = candidates[index];
    let data, contentType;
    try {
      ({ data, contentType } = await this.fetchBinary(candidate.url));
    } catch (err) {
      console.warn('artist image download failed', candidate.url, err.message);
      return null;
    }
    const ext = EXTENSIONS[(contentType || '').split(';')[0].trim().toLowerCase()] || 'jpg';
    const hash = crypto.createHash('sha1').update(key).digest('hex');
    const file = `${hash}-${index}.${ext}`;
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, file), data);

    const previous = this.index[key];
    if (previous && previous.file && previous.file !== file) {
      await fs.unlink(path.join(this.dir, previous.file)).catch(() => {});
    }
    this.index[key] = { file, source: candidate.source, mbid, fetchedAt: this.now(), candidates, index };
    await this._save();
    return this._result(this.index[key]);
  }

  next(name) {
    const key = this._key(name);
    if (!key) return Promise.resolve(null);
    return this._once(key, async () => {
      await this._load();
      const entry = this.index[key];
      if (!entry || !entry.candidates || entry.candidates.length === 0) return null;
      const index = (entry.index + 1) % entry.candidates.length;
      const r = await this._useCandidate(key, { candidates: entry.candidates, mbid: entry.mbid, index });
      return r || this._result(entry);
    });
  }

  async remove(name) {
    const key = this._key(name);
    if (!key) return;
    await this._load();
    this.index[key] = { ...(this.index[key] || {}), removed: true };
    await this._save();
  }

  async restore(name) {
    const key = this._key(name);
    if (!key) return null;
    await this._load();
    const entry = this.index[key];
    if (entry && entry.removed) {
      delete entry.removed;
      if (!entry.file) delete this.index[key];
      await this._save();
    }
    return this.find(name);
  }

  async clear() {
    this._inflight.clear();
    this.index = {};
    await fs.rm(this.dir, { recursive: true, force: true });
    await this._save();
  }
}

module.exports = { ArtistImages };
