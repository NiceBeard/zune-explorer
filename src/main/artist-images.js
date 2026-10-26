const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { artistNamesMatch, primaryArtist, artistCacheKey } = require('../shared/artist-name');

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
    this._inflight = new Map(); // key -> shared find() promise
    this._queues = new Map();   // key -> tail of that artist's operation queue
    this._epoch = 0;            // bumped by clear(); older operations then write nothing
    this._saving = Promise.resolve();
  }

  // '' for names that must never be looked up (placeholders like "Various Artists").
  _key(name) {
    return artistCacheKey(name);
  }

  async _load() {
    if (this.index) return;
    try {
      this.index = JSON.parse(await fs.readFile(this.indexPath, 'utf-8'));
    } catch {
      this.index = {};
    }
  }

  // Saves run one at a time so concurrent lookups never race on the temp file.
  _save() {
    const run = this._saving.then(async () => {
      await fs.mkdir(this.dir, { recursive: true });
      const tmp = this.indexPath + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(this.index, null, 2));
      await fs.rename(tmp, this.indexPath);
    });
    this._saving = run.catch(() => {});
    return run;
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

  // Operations on one artist run one after another, so next/remove can't interleave with a find.
  _enqueue(key, fn) {
    const prev = this._queues.get(key) || Promise.resolve();
    const run = prev.then(fn);
    const tail = run.catch(() => {});
    this._queues.set(key, tail);
    tail.then(() => { if (this._queues.get(key) === tail) this._queues.delete(key); });
    return run;
  }

  // 'removed' (user removed the photo), 'cached' (photo on disk) or 'none'.
  async state(name) {
    const key = this._key(name);
    if (!key) return 'none';
    await this._load();
    const entry = this.index[key];
    if (entry && entry.removed) return 'removed';
    return (await this._result(entry)) ? 'cached' : 'none';
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
    // Concurrent finds for the same artist share one lookup.
    if (this._inflight.has(key)) return this._inflight.get(key);
    const p = this._enqueue(key, () => this._find(key, primaryArtist(name)))
      .finally(() => this._inflight.delete(key));
    this._inflight.set(key, p);
    return p;
  }

  async _find(key, name) {
    const epoch = this._epoch;
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

    let candidates, mbid, complete;
    try {
      ({ candidates, mbid, complete } = await this._lookup(name));
    } catch (err) {
      // Offline or service trouble: record nothing so we try again next time.
      console.warn('artist image lookup failed for', name, err.message);
      return null;
    }

    if (epoch !== this._epoch) return null; // cleared meanwhile
    if (candidates.length === 0) {
      // Only a clean "nothing found" from every source counts as a miss.
      if (!complete) return null;
      this.index[key] = { miss: true, checkedAt: this.now() };
      await this._save();
      return null;
    }
    return this._useFirstWorking(key, { candidates, mbid, order: candidates.map((_, i) => i), epoch });
  }

  // Try candidates in `order` until one downloads; dead links are skipped.
  async _useFirstWorking(key, { candidates, mbid, order, epoch }) {
    for (const index of order) {
      const r = await this._useCandidate(key, { candidates, mbid, index, epoch });
      if (r) return r;
    }
    return null;
  }

  // complete is false when fanart.tv/MusicBrainz failed, so an empty result isn't a real miss.
  // Deezer failures throw: with nothing trustworthy, the caller records nothing.
  async _lookup(name) {
    const candidates = [];
    let mbid = null;
    let complete = true;
    const apiKey = this.getApiKey();
    if (apiKey) {
      try {
        const found = await this._fanartCandidates(name, apiKey);
        mbid = found.mbid;
        candidates.push(...found.candidates);
      } catch (err) {
        console.warn('fanart.tv lookup failed for', name, err.message);
        complete = false;
      }
    }
    const deezer = await this.fetchJson(`https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}`);
    if (deezer && deezer.error) {
      throw new Error(`Deezer: ${deezer.error.message || deezer.error.type || 'error'}`);
    }
    for (const a of (deezer && deezer.data) || []) {
      // Artists without a picture get a placeholder silhouette with an empty hash: /artist//
      if (a.picture_xl && !a.picture_xl.includes('/artist//') && artistNamesMatch(a.name, name)) {
        candidates.push({ source: 'deezer', url: a.picture_xl });
      }
    }
    return { candidates, mbid, complete };
  }

  async _fanartCandidates(name, apiKey) {
    const candidates = [];
    const artists = await this.searchArtists(name);
    const match = artists.find(a => a.score >= MIN_MB_SCORE && artistNamesMatch(a.name, name));
    if (!match) return { mbid: null, candidates };
    let art = null;
    try {
      art = await this.fetchJson(`https://webservice.fanart.tv/v3/music/${match.mbid}?api_key=${encodeURIComponent(apiKey)}`);
    } catch (err) {
      if (err.statusCode !== 404) throw err; // 404 = fanart.tv has nothing for this artist
    }
    for (const type of ['artistbackground', 'artistthumb']) {
      const images = (art && Array.isArray(art[type])) ? art[type].slice() : [];
      images.sort((a, b) => (parseInt(b.likes, 10) || 0) - (parseInt(a.likes, 10) || 0));
      for (const img of images) if (img.url) candidates.push({ source: 'fanart', url: img.url });
    }
    return { mbid: match.mbid, candidates };
  }

  // Download candidates[index] and make it the artist's photo. Returns null on failure, changing nothing.
  async _useCandidate(key, { candidates, mbid, index, epoch }) {
    const candidate = candidates[index];
    let data, contentType;
    try {
      ({ data, contentType } = await this.fetchBinary(candidate.url));
    } catch (err) {
      console.warn('artist image download failed', candidate.url, err.message);
      return null;
    }
    if (epoch !== this._epoch) return null; // cleared while downloading
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
    return this._enqueue(key, async () => {
      const epoch = this._epoch;
      await this._load();
      const entry = this.index[key];
      if (!entry || !entry.candidates || entry.candidates.length === 0) return null;
      const n = entry.candidates.length;
      const order = Array.from({ length: n - 1 }, (_, i) => (entry.index + 1 + i) % n);
      const r = await this._useFirstWorking(key, { candidates: entry.candidates, mbid: entry.mbid, order, epoch });
      return r || this._result(entry);
    });
  }

  remove(name) {
    const key = this._key(name);
    if (!key) return Promise.resolve();
    return this._enqueue(key, async () => {
      await this._load();
      this.index[key] = { ...(this.index[key] || {}), removed: true };
      await this._save();
    });
  }

  async restore(name) {
    const key = this._key(name);
    if (!key) return null;
    await this._enqueue(key, async () => {
      await this._load();
      const entry = this.index[key];
      if (entry && entry.removed) {
        delete entry.removed;
        if (!entry.file) delete this.index[key];
        await this._save();
      }
    });
    return this.find(name);
  }

  async clear() {
    this._epoch++;
    this._inflight.clear();
    this.index = {};
    await fs.rm(this.dir, { recursive: true, force: true });
    await this._save();
  }
}

module.exports = { ArtistImages };
