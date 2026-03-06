# Metadata Enrichment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add manual MusicBrainz + Cover Art Archive metadata lookup to enrich albums and artists with corrected metadata and cover art.

**Architecture:** New `MetadataCache` module in main process handles MusicBrainz API calls and persistent JSON caching. Renderer adds right-click "Look up metadata" on album tiles/detail and artist rows, plus a match picker modal for disambiguation. Cached metadata merges over embedded tags at render time.

**Tech Stack:** MusicBrainz API (REST, no key), Cover Art Archive (REST), Node.js `https` module, Electron IPC, JSON file cache.

---

### Task 1: Create MetadataCache module

**Files:**
- Create: `src/main/metadata-cache.js`

**Step 1: Create the MetadataCache class**

This module handles persistent storage of enriched metadata. It follows the same pattern as `src/main/zune/device-cache.js`.

```javascript
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
```

**Step 2: Commit**

```bash
git add src/main/metadata-cache.js
git commit -m "feat(metadata): add MetadataCache persistent storage module"
```

---

### Task 2: Create MusicBrainz API client

**Files:**
- Create: `src/main/musicbrainz.js`

**Step 1: Create the MusicBrainz lookup module**

This module handles all MusicBrainz and Cover Art Archive API calls with rate limiting (1 req/sec).

```javascript
const https = require('https');

const USER_AGENT = 'ZuneExplorer/1.1.0 (https://github.com/NiceBeard/zune-explorer)';
let lastRequestTime = 0;

function rateLimitedFetch(url) {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    const wait = Math.max(0, 1100 - (now - lastRequestTime));

    setTimeout(() => {
      lastRequestTime = Date.now();
      const req = https.get(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          rateLimitedFetch(res.headers.location).then(resolve, reject);
          return;
        }
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error('Invalid JSON response')); }
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timeout')); });
    }, wait);
  });
}

function fetchBinary(url) {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    const wait = Math.max(0, 1100 - (now - lastRequestTime));

    setTimeout(() => {
      lastRequestTime = Date.now();
      const req = https.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchBinary(res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ data: Buffer.concat(chunks), contentType: res.headers['content-type'] }));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
    }, wait);
  });
}

async function searchReleases(album, artist) {
  const query = encodeURIComponent(`release:"${album}" AND artist:"${artist}"`);
  const url = `https://musicbrainz.org/ws/2/release/?query=${query}&limit=5&fmt=json`;
  const data = await rateLimitedFetch(url);
  return (data.releases || []).map(r => ({
    mbid: r.id,
    title: r.title,
    artist: (r['artist-credit'] || []).map(a => a.name).join(', '),
    year: r.date ? r.date.slice(0, 4) : '',
    label: (r['label-info'] || []).map(l => l.label?.name).filter(Boolean).join(', '),
    country: r.country || '',
    trackCount: (r['track-count'] || r.media?.reduce((sum, m) => sum + (m['track-count'] || 0), 0)) || 0,
  }));
}

async function getRelease(mbid) {
  const url = `https://musicbrainz.org/ws/2/release/${mbid}?inc=recordings+artist-credits+genres&fmt=json`;
  const data = await rateLimitedFetch(url);

  const tracks = [];
  for (const medium of (data.media || [])) {
    for (const track of (medium.tracks || [])) {
      tracks.push({
        position: track.position,
        title: track.title,
        duration: track.length || 0, // milliseconds
        artist: (track['artist-credit'] || data['artist-credit'] || []).map(a => a.name).join(', '),
      });
    }
  }

  const genres = (data.genres || []).map(g => g.name);

  return {
    mbid: data.id,
    title: data.title,
    artist: (data['artist-credit'] || []).map(a => a.name).join(', '),
    date: data.date || '',
    year: data.date ? parseInt(data.date.slice(0, 4), 10) : 0,
    genres,
    genre: genres[0] || '',
    tracks,
  };
}

async function getCoverArt(mbid) {
  try {
    const url = `https://coverartarchive.org/release/${mbid}`;
    const data = await rateLimitedFetch(url);
    const front = (data.images || []).find(img => img.front);
    const imageUrl = front ? (front.thumbnails?.large || front.thumbnails?.small || front.image) : null;
    if (!imageUrl) return null;

    const { data: imgData, contentType } = await fetchBinary(imageUrl);
    const base64 = imgData.toString('base64');
    return `data:${contentType};base64,${base64}`;
  } catch {
    return null; // No cover art available
  }
}

module.exports = { searchReleases, getRelease, getCoverArt };
```

**Step 2: Commit**

```bash
git add src/main/musicbrainz.js
git commit -m "feat(metadata): add MusicBrainz/Cover Art Archive API client"
```

---

### Task 3: Add IPC handlers for metadata lookup

**Files:**
- Modify: `src/main/main.js` (require MetadataCache + musicbrainz, add IPC handlers)
- Modify: `src/main/preload.js` (expose new API methods)

**Step 1: Add requires and initialize MetadataCache in main.js**

Near the top of main.js where other modules are required, add:

```javascript
const { MetadataCache } = require('./metadata-cache.js');
const musicbrainz = require('./musicbrainz.js');
```

Where `deviceCache` is initialized (around where `app.getPath('userData')` is used), add:

```javascript
let metadataCache;
```

And in the app ready handler where deviceCache is created, add:

```javascript
metadataCache = new MetadataCache(app.getPath('userData'));
```

**Step 2: Add IPC handlers in main.js**

Add these handlers near the other `ipcMain.handle` calls:

```javascript
// Metadata enrichment
ipcMain.handle('metadata-search', async (event, album, artist) => {
  try {
    const results = await musicbrainz.searchReleases(album, artist);
    return { success: true, results };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('metadata-fetch', async (event, mbid) => {
  try {
    const release = await musicbrainz.getRelease(mbid);
    const albumArt = await musicbrainz.getCoverArt(mbid);
    const result = { ...release, albumArt };
    return { success: true, result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('metadata-cache-get', async (event, artist, album) => {
  const data = await metadataCache.get(artist, album);
  return { success: true, data };
});

ipcMain.handle('metadata-cache-set', async (event, artist, album, data) => {
  await metadataCache.set(artist, album, data);
  return { success: true };
});

ipcMain.handle('metadata-cache-get-all', async () => {
  const data = await metadataCache.getAll();
  return { success: true, data };
});
```

**Step 3: Expose in preload.js**

Add to the `electronAPI` object:

```javascript
// Metadata enrichment
metadataSearch: (album, artist) => ipcRenderer.invoke('metadata-search', album, artist),
metadataFetch: (mbid) => ipcRenderer.invoke('metadata-fetch', mbid),
metadataCacheGet: (artist, album) => ipcRenderer.invoke('metadata-cache-get', artist, album),
metadataCacheSet: (artist, album, data) => ipcRenderer.invoke('metadata-cache-set', artist, album, data),
metadataCacheGetAll: () => ipcRenderer.invoke('metadata-cache-get-all'),
```

**Step 4: Commit**

```bash
git add src/main/main.js src/main/preload.js
git commit -m "feat(metadata): add IPC handlers for MusicBrainz lookup and cache"
```

---

### Task 4: Add match picker modal HTML and CSS

**Files:**
- Modify: `src/renderer/index.html` (add modal markup before closing `</body>`)
- Modify: `src/assets/css/styles.css` (add modal styles)

**Step 1: Add modal HTML in index.html**

Before the closing `</body>` tag, add:

```html
<!-- Metadata Lookup Modal -->
<div class="metadata-modal-overlay" id="metadata-modal" style="display:none">
    <div class="metadata-modal">
        <div class="metadata-modal-header">
            <h3 class="metadata-modal-title">Look up metadata</h3>
            <button class="metadata-modal-close" id="metadata-modal-close">&times;</button>
        </div>
        <div class="metadata-modal-status" id="metadata-modal-status">Searching...</div>
        <div class="metadata-modal-results" id="metadata-modal-results"></div>
    </div>
</div>
```

**Step 2: Add modal CSS in styles.css**

Add at the end of the file:

```css
/* Metadata lookup modal */
.metadata-modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    z-index: 2000;
    display: flex;
    align-items: center;
    justify-content: center;
}

.metadata-modal {
    background: #111;
    border: 1px solid rgba(255, 105, 0, 0.3);
    border-radius: 8px;
    width: 500px;
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.metadata-modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 20px;
    border-bottom: 1px solid #222;
}

.metadata-modal-title {
    font-size: 16px;
    font-weight: 400;
    color: #fff;
    margin: 0;
}

.metadata-modal-close {
    background: none;
    border: none;
    color: #666;
    font-size: 22px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
}

.metadata-modal-close:hover {
    color: #fff;
}

.metadata-modal-status {
    padding: 12px 20px;
    color: #888;
    font-size: 13px;
}

.metadata-modal-results {
    overflow-y: auto;
    padding: 0 20px 16px;
}

.metadata-match-item {
    padding: 12px;
    border: 1px solid #222;
    border-radius: 6px;
    margin-bottom: 8px;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
}

.metadata-match-item:hover {
    border-color: var(--zune-orange);
    background: rgba(255, 105, 0, 0.08);
}

.metadata-match-title {
    color: #fff;
    font-size: 14px;
    margin-bottom: 4px;
}

.metadata-match-detail {
    color: #888;
    font-size: 12px;
}

.metadata-match-applying {
    pointer-events: none;
    opacity: 0.5;
}
```

**Step 3: Commit**

```bash
git add src/renderer/index.html src/assets/css/styles.css
git commit -m "feat(metadata): add match picker modal HTML and CSS"
```

---

### Task 5: Add right-click "Look up metadata" to album tiles, detail, and artist rows

**Files:**
- Modify: `src/assets/js/renderer.js`

**Step 1: Add a `_showMetadataLookup` method to ZuneExplorer**

Add this method before `showContextMenu`:

```javascript
async showMetadataLookup(albumName, artistName) {
    const modal = document.getElementById('metadata-modal');
    const status = document.getElementById('metadata-modal-status');
    const results = document.getElementById('metadata-modal-results');
    const closeBtn = document.getElementById('metadata-modal-close');

    modal.style.display = 'flex';
    status.textContent = `Searching for "${albumName}" by ${artistName}...`;
    status.style.display = 'block';
    results.textContent = '';

    const onClose = () => { modal.style.display = 'none'; };
    closeBtn.onclick = onClose;
    modal.addEventListener('click', (e) => { if (e.target === modal) onClose(); });

    const searchResult = await window.electronAPI.metadataSearch(albumName, artistName);
    if (!searchResult.success || searchResult.results.length === 0) {
        status.textContent = searchResult.success ? 'No matches found.' : `Error: ${searchResult.error}`;
        return;
    }

    status.textContent = `Found ${searchResult.results.length} match${searchResult.results.length !== 1 ? 'es' : ''} — pick one:`;

    for (const match of searchResult.results) {
        const item = document.createElement('div');
        item.className = 'metadata-match-item';

        const title = document.createElement('div');
        title.className = 'metadata-match-title';
        title.textContent = match.title;

        const detail = document.createElement('div');
        detail.className = 'metadata-match-detail';
        const parts = [match.artist];
        if (match.year) parts.push(match.year);
        if (match.label) parts.push(match.label);
        if (match.trackCount) parts.push(`${match.trackCount} tracks`);
        detail.textContent = parts.join(' — ');

        item.appendChild(title);
        item.appendChild(detail);

        item.addEventListener('click', async () => {
            item.classList.add('metadata-match-applying');
            status.textContent = 'Fetching metadata and cover art...';

            const fetchResult = await window.electronAPI.metadataFetch(match.mbid);
            if (!fetchResult.success) {
                status.textContent = `Error: ${fetchResult.error}`;
                item.classList.remove('metadata-match-applying');
                return;
            }

            // Save to cache
            await window.electronAPI.metadataCacheSet(artistName, albumName, fetchResult.result);

            // Apply to in-memory library
            this.applyMetadataToLibrary(artistName, albumName, fetchResult.result);

            modal.style.display = 'none';
        });

        results.appendChild(item);
    }
}

applyMetadataToLibrary(artistName, albumName, metadata) {
    const albumKey = `${albumName.toLowerCase()}||${artistName.toLowerCase()}`;
    const album = this.musicLibrary.albums.get(albumKey);
    if (album) {
        if (metadata.albumArt) album.albumArt = metadata.albumArt;
        if (metadata.year) album.year = metadata.year;
        if (metadata.genre) album.genre = metadata.genre;
    }

    // Update artist art if this is the first enriched art
    const artistKey = artistName.toLowerCase();
    const artist = this.musicLibrary.artists.get(artistKey);
    if (artist && metadata.albumArt && !artist.enrichedArt) {
        artist.albumArt = metadata.albumArt;
        artist.enrichedArt = true;
    }

    // Re-render current view
    if (this.currentCategory === 'music' && this.currentView === 'content') {
        this.renderMusicSubContent();
    }
}
```

**Step 2: Add right-click handler to album tiles**

In `renderMusicAlbumsView`, after the click handler on the tile (around where `tile.addEventListener('click', ...)` is), add:

```javascript
tile.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    this.showMetadataLookup(album.name, album.artist);
});
```

**Step 3: Add right-click handler to artist rows**

In `renderMusicArtistsView`, after the click handler on the row, add:

```javascript
row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    // Look up first album for this artist
    const firstAlbumKey = [...artist.albums][0];
    const firstAlbum = firstAlbumKey ? this.musicLibrary.albums.get(firstAlbumKey) : null;
    if (firstAlbum) {
        this.showMetadataLookup(firstAlbum.name, artist.name);
    }
});
```

**Step 4: Add a "look up metadata" link in album detail view**

In `renderAlbumDetail`, after the play all button is created, add a lookup link:

```javascript
const lookupLink = document.createElement('button');
lookupLink.className = 'music-lookup-btn';
lookupLink.textContent = 'look up metadata';
lookupLink.addEventListener('click', () => {
    this.showMetadataLookup(album.name, album.artist);
});
info.appendChild(lookupLink);
```

Add corresponding CSS:

```css
.music-lookup-btn {
    background: none;
    border: none;
    color: #666;
    font-size: 12px;
    cursor: pointer;
    padding: 4px 0;
    margin-top: 8px;
    display: block;
}

.music-lookup-btn:hover {
    color: var(--zune-orange);
}
```

**Step 5: Commit**

```bash
git add src/assets/js/renderer.js src/assets/css/styles.css
git commit -m "feat(metadata): add MusicBrainz lookup UI with match picker"
```

---

### Task 6: Load metadata cache on startup and merge with library

**Files:**
- Modify: `src/assets/js/renderer.js`

**Step 1: Load cache after music library scan completes**

In `scanMusicLibrary`, in the `onMusicScanProgress` callback where `lib.scanState = 'complete'` is set, add a call to apply cached metadata:

```javascript
if (data.scanned >= data.total) {
    progressEl.style.display = 'none';
    lib.scanState = 'complete';
    this.applyCachedMetadata();
}
```

**Step 2: Add `applyCachedMetadata` method**

```javascript
async applyCachedMetadata() {
    const result = await window.electronAPI.metadataCacheGetAll();
    if (!result.success || !result.data) return;

    for (const [cacheKey, metadata] of Object.entries(result.data)) {
        const [artistNorm, albumNorm] = cacheKey.split('|');
        // Find matching album in library
        for (const [albumKey, album] of this.musicLibrary.albums) {
            const matchesAlbum = album.name.toLowerCase().trim() === albumNorm;
            const matchesArtist = album.artist.toLowerCase().trim() === artistNorm;
            if (matchesAlbum && matchesArtist) {
                if (metadata.albumArt) album.albumArt = metadata.albumArt;
                if (metadata.year) album.year = metadata.year;
                if (metadata.genre) album.genre = metadata.genre;
                break;
            }
        }
    }

    // Re-render if currently viewing music
    if (this.currentCategory === 'music' && this.currentView === 'content') {
        this.renderMusicSubContent();
    }
}
```

**Step 3: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat(metadata): load cached metadata on startup and merge with library"
```

---

### Task 7: Use cached metadata during Zune sync

**Files:**
- Modify: `src/main/zune/zune-manager.js`

**Step 1: Accept metadataCache in ZuneManager constructor or via setter**

In the ZuneManager constructor or initialization, accept a reference to metadataCache. In main.js where ZuneManager is created, pass it in. Then when sending files to the device, check the cache for enriched metadata.

Find the method that sets MTP properties on the device during sync (the part that creates album objects and sets artist/album/genre/track number). Before setting properties, check:

```javascript
// In the sync/send method, before setting album properties:
if (this.metadataCache) {
    const cached = await this.metadataCache.get(track.artist, track.album);
    if (cached) {
        if (cached.genre) genre = cached.genre;
        if (cached.year) year = cached.year;
        if (cached.albumArt) {
            // Convert base64 data URL back to Buffer for RepresentativeSampleData
            const base64Match = cached.albumArt.match(/^data:[^;]+;base64,(.+)$/);
            if (base64Match) {
                albumArtBuffer = Buffer.from(base64Match[1], 'base64');
            }
        }
    }
}
```

The exact insertion point depends on the current sync code structure. Look for where `RepresentativeSampleData` is set and where genre/year are passed to MTP property setters.

**Step 2: Pass metadataCache to ZuneManager in main.js**

Where ZuneManager is constructed, pass the cache:

```javascript
zuneManager.metadataCache = metadataCache;
```

**Step 3: Commit**

```bash
git add src/main/zune/zune-manager.js src/main/main.js
git commit -m "feat(metadata): use cached metadata during Zune device sync"
```

---

### Summary of Changes

| File | Change |
|------|--------|
| `src/main/metadata-cache.js` | New — persistent JSON cache for enriched metadata |
| `src/main/musicbrainz.js` | New — MusicBrainz/Cover Art Archive API client with rate limiting |
| `src/main/main.js` | IPC handlers for search, fetch, cache get/set |
| `src/main/preload.js` | Expose metadata API methods to renderer |
| `src/renderer/index.html` | Match picker modal HTML |
| `src/assets/css/styles.css` | Modal styles + lookup button style |
| `src/assets/js/renderer.js` | Lookup UI, right-click handlers, cache merge on startup |
| `src/main/zune/zune-manager.js` | Use cached metadata during device sync |
