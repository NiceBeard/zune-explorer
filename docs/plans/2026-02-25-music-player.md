# Music Player Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a built-in music player with a persistent bottom bar mini-player and a full-screen Now Playing panel inspired by the Zune HD.

**Architecture:** An `AudioPlayer` class wraps HTML5 `<audio>` with queue management and event emitting. The renderer wires it into a bottom bar (persistent mini-player) and a full-screen Now Playing panel. Metadata extraction happens in the main process via `music-metadata` npm package over IPC.

**Tech Stack:** Electron IPC, HTML5 Audio API, `music-metadata` npm package, CSS animations (equalizer bars)

---

### Task 1: Install music-metadata, Add IPC Handler, Update CSP

**Files:**
- Modify: `package.json` — add `music-metadata` dependency
- Modify: `src/main/main.js` — add `get-audio-metadata` IPC handler
- Modify: `src/main/preload.js` — expose `getAudioMetadata` channel
- Modify: `src/renderer/index.html` — add `media-src 'self' file:` to CSP

**Step 1: Install music-metadata**

Run: `npm install music-metadata`

This adds the package for reading ID3 tags (artist, album, title, duration, embedded album art) from audio files.

**Step 2: Add IPC handler in main.js**

Add at the top of `src/main/main.js`, after existing requires:

```javascript
const { parseFile } = require('music-metadata');
```

Add before the `window-minimize` handler (around line 211):

```javascript
ipcMain.handle('get-audio-metadata', async (event, filePath) => {
  if (!isAllowedPath(filePath)) {
    return { success: false, error: 'Access denied' };
  }
  try {
    const metadata = await parseFile(filePath);
    const result = {
      success: true,
      title: metadata.common.title || path.basename(filePath, path.extname(filePath)),
      artist: metadata.common.artist || 'Unknown Artist',
      album: metadata.common.album || 'Unknown Album',
      duration: metadata.format.duration || 0,
    };

    // Extract embedded album art as data URL
    if (metadata.common.picture && metadata.common.picture.length > 0) {
      const pic = metadata.common.picture[0];
      const base64 = pic.data.toString('base64');
      result.albumArt = `data:${pic.format};base64,${base64}`;
    } else {
      result.albumArt = null;
    }

    return result;
  } catch (error) {
    // Fallback: return filename-based metadata
    return {
      success: true,
      title: path.basename(filePath, path.extname(filePath)),
      artist: 'Unknown Artist',
      album: 'Unknown Album',
      duration: 0,
      albumArt: null,
    };
  }
});
```

**Step 3: Expose in preload.js**

Add to the `contextBridge.exposeInMainWorld` object in `src/main/preload.js`:

```javascript
getAudioMetadata: (path) => ipcRenderer.invoke('get-audio-metadata', path),
```

**Step 4: Update CSP in index.html**

In `src/renderer/index.html`, change the CSP meta tag from:

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' file: data:; font-src 'self';
```

To:

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' file: data:; font-src 'self'; media-src 'self' file:;
```

**Step 5: Verify**

Run: `npm start`
Expected: App launches without CSP errors. Check DevTools console — no new errors.

**Step 6: Commit**

```bash
git add package.json package-lock.json src/main/main.js src/main/preload.js src/renderer/index.html
git commit -m "feat: add music metadata IPC handler and update CSP for audio playback"
```

---

### Task 2: AudioPlayer Class

**Files:**
- Create: `src/assets/js/audio-player.js`

**Step 1: Create the AudioPlayer class**

Create `src/assets/js/audio-player.js`:

```javascript
class AudioPlayer {
  constructor() {
    this.audio = new Audio();
    this.queue = [];
    this.currentIndex = -1;
    this.isPlaying = false;
    this.shuffle = false;
    this.repeat = 'none'; // 'none', 'all', 'one'
    this.currentMetadata = null;
    this._listeners = {};

    this.audio.addEventListener('timeupdate', () => {
      this.emit('timeupdate', {
        currentTime: this.audio.currentTime,
        duration: this.audio.duration || 0,
      });
    });

    this.audio.addEventListener('ended', () => {
      if (this.repeat === 'one') {
        this.audio.currentTime = 0;
        this.audio.play();
      } else {
        this.next();
      }
    });

    this.audio.addEventListener('loadedmetadata', () => {
      this.emit('loaded', { duration: this.audio.duration });
    });

    this.audio.addEventListener('error', (e) => {
      console.error('Audio playback error:', e);
      this.emit('error', e);
    });
  }

  on(event, callback) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(callback);
  }

  emit(event, data) {
    if (this._listeners[event]) {
      this._listeners[event].forEach(cb => cb(data));
    }
  }

  async play(file, queue) {
    this.queue = queue || [file];
    this.currentIndex = this.queue.findIndex(f => f.path === file.path);
    if (this.currentIndex === -1) this.currentIndex = 0;
    await this.loadAndPlay(this.queue[this.currentIndex]);
  }

  async loadAndPlay(file) {
    try {
      const metadata = await window.electronAPI.getAudioMetadata(file.path);
      this.currentMetadata = metadata;
      this.audio.src = `file://${file.path}`;
      await this.audio.play();
      this.isPlaying = true;
      this.emit('trackchange', { file, metadata, index: this.currentIndex, queue: this.queue });
      this.emit('play');
    } catch (error) {
      console.error('Error loading track:', error);
      this.emit('error', error);
    }
  }

  pause() {
    this.audio.pause();
    this.isPlaying = false;
    this.emit('pause');
  }

  resume() {
    this.audio.play();
    this.isPlaying = true;
    this.emit('play');
  }

  togglePlayPause() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.resume();
    }
  }

  async next() {
    if (this.queue.length === 0) return;

    let nextIndex;
    if (this.shuffle) {
      nextIndex = Math.floor(Math.random() * this.queue.length);
    } else {
      nextIndex = this.currentIndex + 1;
    }

    if (nextIndex >= this.queue.length) {
      if (this.repeat === 'all') {
        nextIndex = 0;
      } else {
        this.isPlaying = false;
        this.emit('queueend');
        return;
      }
    }

    this.currentIndex = nextIndex;
    await this.loadAndPlay(this.queue[this.currentIndex]);
  }

  async previous() {
    if (this.queue.length === 0) return;

    // If more than 3 seconds in, restart current track
    if (this.audio.currentTime > 3) {
      this.audio.currentTime = 0;
      return;
    }

    let prevIndex = this.currentIndex - 1;
    if (prevIndex < 0) {
      if (this.repeat === 'all') {
        prevIndex = this.queue.length - 1;
      } else {
        prevIndex = 0;
      }
    }

    this.currentIndex = prevIndex;
    await this.loadAndPlay(this.queue[this.currentIndex]);
  }

  seek(percent) {
    if (this.audio.duration) {
      this.audio.currentTime = this.audio.duration * (percent / 100);
    }
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    this.emit('shufflechange', this.shuffle);
  }

  toggleRepeat() {
    const modes = ['none', 'all', 'one'];
    const currentIdx = modes.indexOf(this.repeat);
    this.repeat = modes[(currentIdx + 1) % modes.length];
    this.emit('repeatchange', this.repeat);
  }

  formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  getCurrentFile() {
    return this.queue[this.currentIndex] || null;
  }
}
```

**Step 2: Add script tag in index.html**

In `src/renderer/index.html`, add before the renderer.js script tag:

```html
<script src="../assets/js/audio-player.js"></script>
```

**Step 3: Verify**

Run: `npm start`
Expected: App launches. In DevTools console, `new AudioPlayer()` creates an instance without errors.

**Step 4: Commit**

```bash
git add src/assets/js/audio-player.js src/renderer/index.html
git commit -m "feat: add AudioPlayer class with queue management and event system"
```

---

### Task 3: Bottom Bar HTML and CSS

**Files:**
- Modify: `src/renderer/index.html` — add bottom bar markup
- Modify: `src/assets/css/styles.css` — add bottom bar and equalizer styles

**Step 1: Add bottom bar HTML**

In `src/renderer/index.html`, add just before the context menu div (`<div class="context-menu"`):

```html
<!-- Music Player Bottom Bar -->
<div class="player-bottom-bar" id="player-bottom-bar">
    <div class="player-bar-art" id="player-bar-art">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" class="player-bar-art-placeholder">
            <rect width="24" height="24" rx="4" fill="#1a1a1a"/>
            <path d="M12 6v8.5M12 6l4 2v6.5" stroke="#666" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            <circle cx="8" cy="14.5" r="2.5" stroke="#666" stroke-width="1.5"/>
            <circle cx="16" cy="12.5" r="2.5" stroke="#666" stroke-width="1.5"/>
        </svg>
        <img id="player-bar-art-img" class="player-bar-art-img" style="display:none" alt="Album art"/>
    </div>
    <div class="player-bar-info" id="player-bar-info">
        <div class="player-bar-title" id="player-bar-title">Not Playing</div>
        <div class="player-bar-artist" id="player-bar-artist"></div>
    </div>
    <div class="player-bar-progress">
        <span class="player-bar-time" id="player-bar-elapsed">0:00</span>
        <div class="player-bar-progress-track" id="player-bar-progress-track">
            <div class="player-bar-progress-fill" id="player-bar-progress-fill"></div>
        </div>
        <span class="player-bar-time" id="player-bar-remaining">0:00</span>
    </div>
    <div class="player-bar-controls">
        <button class="player-btn" id="player-bar-prev" title="Previous">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/>
            </svg>
        </button>
        <button class="player-btn player-btn-play" id="player-bar-play" title="Play/Pause">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                <path id="player-bar-play-path" d="M8 5v14l11-7z"/>
            </svg>
        </button>
        <button class="player-btn" id="player-bar-next" title="Next">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/>
            </svg>
        </button>
    </div>
    <div class="player-equalizer" id="player-equalizer">
        <span class="eq-bar"></span>
        <span class="eq-bar"></span>
        <span class="eq-bar"></span>
        <span class="eq-bar"></span>
    </div>
</div>
```

**Step 2: Add bottom bar CSS**

Add to the end of `src/assets/css/styles.css`:

```css
/* ==============================
   Music Player - Bottom Bar
   ============================== */
.player-bottom-bar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 64px;
    background: rgba(10, 10, 10, 0.98);
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    display: none;
    align-items: center;
    gap: 16px;
    padding: 0 20px;
    z-index: 500;
    cursor: pointer;
    backdrop-filter: blur(20px);
}

.player-bottom-bar.visible {
    display: flex;
}

.player-bar-art {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    border-radius: 4px;
    overflow: hidden;
    background: #1a1a1a;
    display: flex;
    align-items: center;
    justify-content: center;
}

.player-bar-art-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.player-bar-info {
    flex: 0 0 180px;
    min-width: 0;
    overflow: hidden;
}

.player-bar-title {
    font-size: 14px;
    font-weight: 500;
    color: var(--zune-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.player-bar-artist {
    font-size: 12px;
    color: var(--zune-text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.player-bar-progress {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
}

.player-bar-time {
    font-size: 11px;
    color: var(--zune-text-dim);
    font-variant-numeric: tabular-nums;
    min-width: 36px;
    text-align: center;
}

.player-bar-progress-track {
    flex: 1;
    height: 4px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
    cursor: pointer;
    position: relative;
}

.player-bar-progress-track:hover {
    height: 6px;
}

.player-bar-progress-fill {
    height: 100%;
    background: var(--zune-orange);
    border-radius: 2px;
    width: 0%;
    transition: width 0.1s linear;
}

.player-bar-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
}

.player-btn {
    background: none;
    border: none;
    color: var(--zune-text-secondary);
    cursor: pointer;
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    transition: all 0.2s ease;
}

.player-btn:hover {
    color: var(--zune-text);
    background: rgba(255, 255, 255, 0.1);
}

.player-btn-play {
    width: 42px;
    height: 42px;
    background: rgba(255, 105, 0, 0.2);
    color: var(--zune-orange);
}

.player-btn-play:hover {
    background: rgba(255, 105, 0, 0.35);
    color: var(--zune-orange);
}

/* Equalizer bars */
.player-equalizer {
    display: flex;
    align-items: flex-end;
    gap: 3px;
    height: 20px;
    flex-shrink: 0;
    padding-right: 4px;
}

.eq-bar {
    width: 3px;
    background: var(--zune-orange);
    border-radius: 1px;
    animation: eq-bounce 0.8s ease-in-out infinite alternate;
}

.eq-bar:nth-child(1) { height: 8px; animation-delay: 0s; animation-duration: 0.7s; }
.eq-bar:nth-child(2) { height: 14px; animation-delay: 0.15s; animation-duration: 0.55s; }
.eq-bar:nth-child(3) { height: 10px; animation-delay: 0.3s; animation-duration: 0.65s; }
.eq-bar:nth-child(4) { height: 6px; animation-delay: 0.1s; animation-duration: 0.8s; }

.player-equalizer.paused .eq-bar {
    animation-play-state: paused;
}

@keyframes eq-bounce {
    0% { height: 4px; }
    100% { height: 20px; }
}

/* Adjust content area when bottom bar is visible */
body.player-active .content-area {
    padding-bottom: 80px;
}

body.player-active .recent-panel {
    padding-bottom: 80px;
}
```

**Step 3: Verify**

Run: `npm start`
Expected: App launches. Bottom bar is hidden (no music playing). Inspect element in DevTools to confirm the HTML is present.

**Step 4: Commit**

```bash
git add src/renderer/index.html src/assets/css/styles.css
git commit -m "feat: add bottom bar mini-player HTML and CSS with equalizer animation"
```

---

### Task 4: Now Playing Panel HTML and CSS

**Files:**
- Modify: `src/renderer/index.html` — add Now Playing panel markup
- Modify: `src/assets/css/styles.css` — add Now Playing panel styles

**Step 1: Add Now Playing panel HTML**

In `src/renderer/index.html`, add just after the bottom bar div and before the context menu:

```html
<!-- Now Playing Panel -->
<div class="now-playing-panel" id="now-playing-panel">
    <button class="np-back-btn" id="np-back-btn" title="Close Now Playing">
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
            <circle cx="24" cy="24" r="22" stroke="currentColor" stroke-width="2"/>
            <path d="M28 16L20 24L28 32" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
    </button>

    <div class="np-content">
        <div class="np-track-info">
            <div class="np-artist" id="np-artist">UNKNOWN ARTIST</div>
            <div class="np-album" id="np-album">Unknown Album</div>
        </div>

        <div class="np-art-container">
            <div class="np-art" id="np-art">
                <svg width="200" height="200" viewBox="0 0 24 24" fill="none" class="np-art-placeholder">
                    <rect width="24" height="24" rx="4" fill="#1a1a1a"/>
                    <path d="M12 6v8.5M12 6l4 2v6.5" stroke="#444" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                    <circle cx="8" cy="14.5" r="2.5" stroke="#444" stroke-width="1.5"/>
                    <circle cx="16" cy="12.5" r="2.5" stroke="#444" stroke-width="1.5"/>
                </svg>
                <img id="np-art-img" class="np-art-img" style="display:none" alt="Album art"/>
            </div>
        </div>

        <div class="np-progress">
            <span class="np-time" id="np-elapsed">0:00</span>
            <div class="np-progress-track" id="np-progress-track">
                <div class="np-progress-fill" id="np-progress-fill"></div>
            </div>
            <span class="np-time" id="np-remaining">0:00</span>
        </div>

        <div class="np-title" id="np-title">Not Playing</div>

        <div class="np-controls">
            <button class="np-ctrl-btn" id="np-shuffle" title="Shuffle">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/>
                    <polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/>
                    <line x1="4" y1="4" x2="9" y2="9"/>
                </svg>
            </button>
            <button class="np-ctrl-btn" id="np-prev" title="Previous">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/>
                </svg>
            </button>
            <button class="np-ctrl-btn np-play-btn" id="np-play" title="Play/Pause">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor">
                    <path id="np-play-path" d="M8 5v14l11-7z"/>
                </svg>
            </button>
            <button class="np-ctrl-btn" id="np-next" title="Next">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/>
                </svg>
            </button>
            <button class="np-ctrl-btn" id="np-repeat" title="Repeat">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/>
                    <polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>
                </svg>
            </button>
        </div>

        <div class="np-queue" id="np-queue">
            <div class="np-queue-header">Up Next</div>
            <div class="np-queue-list" id="np-queue-list"></div>
        </div>
    </div>
</div>
```

**Step 2: Add Now Playing panel CSS**

Add to the end of `src/assets/css/styles.css`:

```css
/* ==============================
   Music Player - Now Playing Panel
   ============================== */
.now-playing-panel {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: var(--zune-black);
    z-index: 600;
    transform: translateY(100%);
    transition: transform 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94);
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.now-playing-panel.open {
    transform: translateY(0);
}

body.platform-win32 .now-playing-panel {
    top: 32px;
}

/* Zune HD circular back button */
.np-back-btn {
    position: absolute;
    top: 30px;
    left: 30px;
    background: none;
    border: none;
    color: var(--zune-text-secondary);
    cursor: pointer;
    transition: all 0.3s ease;
    z-index: 10;
    padding: 0;
}

.np-back-btn:hover {
    color: var(--zune-orange);
    transform: scale(1.1);
}

.np-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 80px 40px 40px;
    overflow-y: auto;
}

.np-track-info {
    text-align: center;
    margin-bottom: 30px;
}

.np-artist {
    font-size: 28px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 3px;
    color: var(--zune-text);
}

.np-album {
    font-size: 16px;
    font-weight: 300;
    color: var(--zune-text-dim);
    margin-top: 6px;
}

.np-art-container {
    margin-bottom: 30px;
}

.np-art {
    width: 300px;
    height: 300px;
    border-radius: 8px;
    overflow: hidden;
    background: #111;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
}

.np-art-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.np-title {
    font-size: 20px;
    font-weight: 400;
    color: var(--zune-text);
    margin-bottom: 24px;
    text-align: center;
}

.np-progress {
    width: 100%;
    max-width: 400px;
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
}

.np-time {
    font-size: 13px;
    color: var(--zune-text-dim);
    font-variant-numeric: tabular-nums;
    min-width: 40px;
    text-align: center;
}

.np-progress-track {
    flex: 1;
    height: 4px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
    cursor: pointer;
    position: relative;
}

.np-progress-track:hover {
    height: 6px;
}

.np-progress-fill {
    height: 100%;
    background: var(--zune-orange);
    border-radius: 2px;
    width: 0%;
    transition: width 0.1s linear;
}

.np-controls {
    display: flex;
    align-items: center;
    gap: 20px;
    margin-bottom: 40px;
}

.np-ctrl-btn {
    background: none;
    border: none;
    color: var(--zune-text-secondary);
    cursor: pointer;
    width: 48px;
    height: 48px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    transition: all 0.2s ease;
}

.np-ctrl-btn:hover {
    color: var(--zune-text);
    background: rgba(255, 255, 255, 0.1);
}

.np-ctrl-btn.active {
    color: var(--zune-orange);
}

.np-play-btn {
    width: 64px;
    height: 64px;
    background: rgba(255, 105, 0, 0.2);
    color: var(--zune-orange);
}

.np-play-btn:hover {
    background: rgba(255, 105, 0, 0.35);
    color: var(--zune-orange);
    transform: scale(1.05);
}

/* Queue */
.np-queue {
    width: 100%;
    max-width: 500px;
}

.np-queue-header {
    font-size: 14px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 2px;
    color: var(--zune-text-dim);
    margin-bottom: 12px;
}

.np-queue-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.2s ease;
}

.np-queue-item:hover {
    background: rgba(255, 255, 255, 0.05);
}

.np-queue-item.active {
    background: rgba(255, 105, 0, 0.1);
}

.np-queue-item-num {
    font-size: 13px;
    color: var(--zune-text-dim);
    min-width: 24px;
    text-align: center;
}

.np-queue-item-title {
    font-size: 15px;
    color: var(--zune-text);
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.np-queue-item-duration {
    font-size: 13px;
    color: var(--zune-text-dim);
    font-variant-numeric: tabular-nums;
}

.np-queue-item.active .np-queue-item-title {
    color: var(--zune-orange);
}
```

**Step 3: Verify**

Run: `npm start`
Expected: App launches. Panel is hidden (`translateY(100%)`). Inspect element in DevTools to confirm HTML is present and panel exists off-screen.

**Step 4: Commit**

```bash
git add src/renderer/index.html src/assets/css/styles.css
git commit -m "feat: add Now Playing panel HTML and CSS with Zune HD circular back button"
```

---

### Task 5: Wire Up Player to Renderer

**Files:**
- Modify: `src/assets/js/renderer.js` — integrate AudioPlayer, bottom bar, Now Playing

This is the main integration task. The renderer needs to:
1. Create an AudioPlayer instance
2. Intercept music file clicks to play instead of opening externally
3. Update bottom bar and Now Playing panel in response to player events
4. Handle all transport controls and progress bar seeking

**Step 1: Add player properties to constructor**

In `src/assets/js/renderer.js`, add to the constructor after `this.smartRoots = [];`:

```javascript
this.audioPlayer = null;
this.nowPlayingOpen = false;
```

**Step 2: Initialize player and UI wiring in init()**

In `src/assets/js/renderer.js`, add at the end of `init()`, after `this.focusMenu();`:

```javascript
this.setupPlayer();
```

**Step 3: Add setupPlayer method**

Add the following method to the ZuneExplorer class (after `setupKeyboardNavigation`):

```javascript
setupPlayer() {
    this.audioPlayer = new AudioPlayer();

    // Bottom bar click opens Now Playing
    const bottomBar = document.getElementById('player-bottom-bar');
    bottomBar.addEventListener('click', (e) => {
        // Don't open Now Playing if clicking controls
        if (e.target.closest('.player-bar-controls') || e.target.closest('.player-bar-progress-track')) return;
        this.openNowPlaying();
    });

    // Bottom bar controls
    document.getElementById('player-bar-prev').addEventListener('click', (e) => {
        e.stopPropagation();
        this.audioPlayer.previous();
    });
    document.getElementById('player-bar-play').addEventListener('click', (e) => {
        e.stopPropagation();
        this.audioPlayer.togglePlayPause();
    });
    document.getElementById('player-bar-next').addEventListener('click', (e) => {
        e.stopPropagation();
        this.audioPlayer.next();
    });

    // Bottom bar progress seek
    document.getElementById('player-bar-progress-track').addEventListener('click', (e) => {
        e.stopPropagation();
        const track = e.currentTarget;
        const rect = track.getBoundingClientRect();
        const percent = ((e.clientX - rect.left) / rect.width) * 100;
        this.audioPlayer.seek(percent);
    });

    // Now Playing controls
    document.getElementById('np-back-btn').addEventListener('click', () => this.closeNowPlaying());
    document.getElementById('np-prev').addEventListener('click', () => this.audioPlayer.previous());
    document.getElementById('np-play').addEventListener('click', () => this.audioPlayer.togglePlayPause());
    document.getElementById('np-next').addEventListener('click', () => this.audioPlayer.next());
    document.getElementById('np-shuffle').addEventListener('click', () => this.audioPlayer.toggleShuffle());
    document.getElementById('np-repeat').addEventListener('click', () => this.audioPlayer.toggleRepeat());

    // Now Playing progress seek
    document.getElementById('np-progress-track').addEventListener('click', (e) => {
        const track = e.currentTarget;
        const rect = track.getBoundingClientRect();
        const percent = ((e.clientX - rect.left) / rect.width) * 100;
        this.audioPlayer.seek(percent);
    });

    // Player events
    this.audioPlayer.on('trackchange', (data) => this.onTrackChange(data));
    this.audioPlayer.on('play', () => this.onPlayStateChange(true));
    this.audioPlayer.on('pause', () => this.onPlayStateChange(false));
    this.audioPlayer.on('timeupdate', (data) => this.onTimeUpdate(data));
    this.audioPlayer.on('shufflechange', (active) => {
        document.getElementById('np-shuffle').classList.toggle('active', active);
    });
    this.audioPlayer.on('repeatchange', (mode) => {
        const btn = document.getElementById('np-repeat');
        btn.classList.toggle('active', mode !== 'none');
        btn.title = mode === 'one' ? 'Repeat One' : mode === 'all' ? 'Repeat All' : 'Repeat';
    });
    this.audioPlayer.on('queueend', () => this.onPlayStateChange(false));
}
```

**Step 4: Add player UI update methods**

Add these methods to the ZuneExplorer class:

```javascript
onTrackChange(data) {
    const { metadata } = data;

    // Show bottom bar
    document.getElementById('player-bottom-bar').classList.add('visible');
    document.body.classList.add('player-active');

    // Update bottom bar
    document.getElementById('player-bar-title').textContent = metadata.title;
    document.getElementById('player-bar-artist').textContent = metadata.artist;

    // Update Now Playing
    document.getElementById('np-artist').textContent = metadata.artist.toUpperCase();
    document.getElementById('np-album').textContent = metadata.album;
    document.getElementById('np-title').textContent = metadata.title;

    // Album art
    const barImg = document.getElementById('player-bar-art-img');
    const barPlaceholder = document.querySelector('.player-bar-art-placeholder');
    const npImg = document.getElementById('np-art-img');
    const npPlaceholder = document.querySelector('.np-art-placeholder');

    if (metadata.albumArt) {
        barImg.src = metadata.albumArt;
        barImg.style.display = 'block';
        if (barPlaceholder) barPlaceholder.style.display = 'none';

        npImg.src = metadata.albumArt;
        npImg.style.display = 'block';
        if (npPlaceholder) npPlaceholder.style.display = 'none';
    } else {
        barImg.style.display = 'none';
        if (barPlaceholder) barPlaceholder.style.display = 'block';

        npImg.style.display = 'none';
        if (npPlaceholder) npPlaceholder.style.display = 'block';
    }

    // Update queue display
    this.updateQueueDisplay();
}

onPlayStateChange(playing) {
    const playPath = playing ? 'M6 4h4v16H6zm8 0h4v16h-4z' : 'M8 5v14l11-7z';

    // Update SVG paths via setAttribute (DOM-safe)
    document.getElementById('player-bar-play-path').setAttribute('d', playPath);
    document.getElementById('np-play-path').setAttribute('d', playPath);

    // Equalizer animation
    const eq = document.getElementById('player-equalizer');
    eq.classList.toggle('paused', !playing);
}

onTimeUpdate(data) {
    const { currentTime, duration } = data;
    const percent = duration ? (currentTime / duration) * 100 : 0;
    const remaining = duration - currentTime;

    // Bottom bar
    document.getElementById('player-bar-progress-fill').style.width = percent + '%';
    document.getElementById('player-bar-elapsed').textContent = this.audioPlayer.formatTime(currentTime);
    document.getElementById('player-bar-remaining').textContent = '-' + this.audioPlayer.formatTime(remaining);

    // Now Playing
    document.getElementById('np-progress-fill').style.width = percent + '%';
    document.getElementById('np-elapsed').textContent = this.audioPlayer.formatTime(currentTime);
    document.getElementById('np-remaining').textContent = '-' + this.audioPlayer.formatTime(remaining);
}

updateQueueDisplay() {
    const queueList = document.getElementById('np-queue-list');
    const queue = this.audioPlayer.queue;
    const currentIndex = this.audioPlayer.currentIndex;

    // Clear existing queue items
    while (queueList.firstChild) {
        queueList.removeChild(queueList.firstChild);
    }

    // Show upcoming tracks (current + next 20)
    const startIdx = currentIndex;
    const endIdx = Math.min(queue.length, currentIndex + 21);

    for (let i = startIdx; i < endIdx; i++) {
        const track = queue[i];
        const item = document.createElement('div');
        item.className = 'np-queue-item' + (i === currentIndex ? ' active' : '');

        const num = document.createElement('span');
        num.className = 'np-queue-item-num';
        num.textContent = (i + 1).toString();
        item.appendChild(num);

        const title = document.createElement('span');
        title.className = 'np-queue-item-title';
        // Use filename without extension as display name
        const fileName = track.name || track.path.split(/[/\\]/).pop();
        const dotIdx = fileName.lastIndexOf('.');
        title.textContent = dotIdx > 0 ? fileName.substring(0, dotIdx) : fileName;
        item.appendChild(title);

        item.addEventListener('click', () => {
            this.audioPlayer.currentIndex = i;
            this.audioPlayer.loadAndPlay(queue[i]);
        });

        queueList.appendChild(item);
    }
}

openNowPlaying() {
    document.getElementById('now-playing-panel').classList.add('open');
    this.nowPlayingOpen = true;
}

closeNowPlaying() {
    document.getElementById('now-playing-panel').classList.remove('open');
    this.nowPlayingOpen = false;
}
```

**Step 5: Modify handleFileClick to intercept music files**

Replace the existing `handleFileClick` method in `src/assets/js/renderer.js`:

```javascript
handleFileClick(e, file) {
    // Check if this is a music file
    if (this.fileExtensions.music.includes(file.extension)) {
        // Build queue from all music files in current view
        const queue = this.currentCategory === 'music'
            ? this.categorizedFiles.music
            : this.categorizedFiles[this.currentCategory].filter(f =>
                this.fileExtensions.music.includes(f.extension)
              );
        this.audioPlayer.play(file, queue.length > 0 ? queue : [file]);
    } else {
        // Open non-music files externally
        window.electronAPI.openFile(file.path);
    }

    this.selectedFile = file;
    this.addToRecentFiles(file);
    this.updateRecentFiles();
}
```

**Step 6: Add Escape key handling for Now Playing**

In the `handleContentKeyboard` method, add a check at the top for closing Now Playing:

In the `setupKeyboardNavigation` `keydown` handler, add before the switch statement:

```javascript
// Escape closes Now Playing panel from any view
if (e.key === 'Escape' && this.nowPlayingOpen) {
    e.preventDefault();
    this.closeNowPlaying();
    return;
}
```

**Step 7: Verify**

Run: `npm start`
Expected:
- Navigate to Music category
- Click a music file — bottom bar appears, music plays
- Equalizer bars animate while playing
- Click bottom bar — Now Playing panel slides up
- Transport controls work (play/pause, next, prev)
- Progress bar updates and is seekable
- Circular back button closes Now Playing
- Escape key closes Now Playing

**Step 8: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat: wire up audio player to bottom bar and Now Playing panel"
```

---

### Task 6: Polish and Edge Cases

**Files:**
- Modify: `src/assets/js/renderer.js` — handle edge cases
- Modify: `src/assets/css/styles.css` — responsive tweaks

**Step 1: Handle space bar for play/pause**

In the `setupKeyboardNavigation` `keydown` handler, add after the Now Playing Escape check:

```javascript
// Space bar toggles play/pause when player is active
if (e.key === ' ' && this.audioPlayer && this.audioPlayer.isPlaying !== undefined && this.audioPlayer.queue.length > 0 && this.currentView !== 'menu') {
    e.preventDefault();
    this.audioPlayer.togglePlayPause();
    return;
}
```

**Step 2: Handle recent file clicks for music**

In the recent file item click handlers (where `this.handleFileClick(null, file)` is called), the existing handleFileClick already checks for music extensions, so this should work automatically. Verify by clicking a music file from the recent panel.

**Step 3: Verify all edge cases**

Run: `npm start`
Test:
- Play a song, switch to a different category — bottom bar stays visible
- Click a non-music file — opens externally, player keeps playing
- Queue exhausts — player stops, equalizer freezes
- Click a music file from recent files — plays correctly
- Space bar pauses/resumes when not on menu
- Album art displays for files with embedded art, placeholder for files without
- Progress bar seek works on both bottom bar and Now Playing

**Step 4: Commit**

```bash
git add src/assets/js/renderer.js src/assets/css/styles.css
git commit -m "feat: add keyboard shortcuts and edge case handling for music player"
```
