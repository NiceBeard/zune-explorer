# Pins, Playlists & Now Playing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add pinnable sidebar items, user-created playlists under the Music tab, and a persistent Now Playing queue.

**Architecture:** Three independent features sharing a common context menu extension point. Pins persist as a flat JSON file in userData. Playlists persist as individual JSON files in a `playlists/` subdirectory. Now Playing is a special in-memory playlist persisted to `now-playing.json`. All three use the existing IPC invoke pattern for main-renderer communication.

**Tech Stack:** Electron IPC (invoke/handle), Node.js fs, crypto.randomUUID(), vanilla DOM, CSS flexbox/grid.

**Note:** All DOM content is built using safe methods (createElement, textContent). The only innerHTML usage is `container.innerHTML = ''` to clear containers, consistent with the existing codebase pattern.

---

## Task 1: Pins Data Layer (IPC + Persistence)

**Files:**
- Modify: `src/main/main.js` — add IPC handlers for pin CRUD
- Modify: `src/main/preload.js` — expose pin API to renderer

**Step 1: Add IPC handlers in main.js**

Add after the existing `pick-pull-destination` handler (~line 523). Follow the same `app.getPath('userData')` + JSON file pattern:

```javascript
// --- Pins ---
const pinsPath = path.join(app.getPath('userData'), 'pins.json');

ipcMain.handle('pins-load', async () => {
  try {
    const data = await fs.readFile(pinsPath, 'utf-8');
    return { success: true, data: JSON.parse(data) };
  } catch {
    return { success: true, data: [] };
  }
});

ipcMain.handle('pins-save', async (event, pins) => {
  try {
    await fs.writeFile(pinsPath, JSON.stringify(pins, null, 2));
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});
```

**Step 2: Expose in preload.js**

Add to the `electronAPI` object (alongside existing methods ~line 34):

```javascript
pinsLoad: () => ipcRenderer.invoke('pins-load'),
pinsSave: (pins) => ipcRenderer.invoke('pins-save', pins),
```

**Step 3: Verify**

Run `npm start`, open DevTools, confirm `window.electronAPI.pinsLoad` and `window.electronAPI.pinsSave` exist.

**Step 4: Commit**

```
feat(pins): add IPC handlers for pin persistence
```

---

## Task 2: Pins State & Sidebar UI

**Files:**
- Modify: `src/assets/js/renderer.js` — add pins state, load/save, render pinned section
- Modify: `src/renderer/index.html` — add pinned section above recent
- Modify: `src/assets/css/styles.css` — style pinned header and section

**Step 1: Add HTML structure for pinned section**

In `index.html`, inside `.recent-panel` (line 24), add a pinned section above the existing recent content. Replace the current panel internals:

```html
<div class="panel recent-panel">
    <div class="pinned-section" id="pinned-section" style="display:none">
        <h2 class="panel-subheader">pinned</h2>
        <div class="pinned-scroll" id="pinned-files"></div>
    </div>
    <h2 class="panel-subheader" id="recent-header">recent</h2>
    <div class="recent-content">
        <div class="recent-scroll" id="recent-files">
            <div class="empty-state">no recent files</div>
        </div>
    </div>
</div>
```

Remove the existing `<h1 class="panel-header">recent</h1>` (line 25) — replace with the two `panel-subheader` elements above.

**Step 2: Add CSS for pinned section and muted white headers**

Add to `styles.css` near the existing `.panel-header` styles (~line 60):

```css
.panel-subheader {
    font-size: 42px;
    font-weight: 100;
    color: rgba(255, 255, 255, 0.55);
    padding: 15px 20px 10px;
    margin: 0;
    text-transform: lowercase;
    letter-spacing: 1px;
}

.pinned-section {
    margin-bottom: 10px;
}

.pinned-scroll {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 15px;
    padding: 0 20px;
}
```

Remove or override the old `.panel-header` gradient text style for the recent panel since both headers are now muted white `panel-subheader` elements.

**Step 3: Add pins state and loading to renderer.js**

In the constructor (~line 1854), add:

```javascript
this.pinnedItems = [];
```

Add a `loadPins()` method:

```javascript
async loadPins() {
    const result = await window.electronAPI.pinsLoad();
    if (result.success) {
        this.pinnedItems = result.data;
    }
    this.updatePinnedPanel();
}
```

Add a `savePins()` method:

```javascript
async savePins() {
    await window.electronAPI.pinsSave(this.pinnedItems);
}
```

Call `this.loadPins()` in the `init()` method alongside `this.loadRecentFiles()`.

**Step 4: Implement `updatePinnedPanel()`**

```javascript
updatePinnedPanel() {
    const section = document.getElementById('pinned-section');
    const container = document.getElementById('pinned-files');

    if (this.pinnedItems.length === 0) {
        section.style.display = 'none';
        return;
    }

    section.style.display = 'block';
    this.clearElement(container);

    this.pinnedItems.forEach(pin => {
        const el = this.createPinnedElement(pin);
        container.appendChild(el);
    });
}
```

**Step 5: Implement `createPinnedElement(pin)`**

Similar to `createRecentFileElement()` (lines 2850-2891) but handles different pin types:

```javascript
createPinnedElement(pin) {
    const div = document.createElement('div');
    div.className = 'recent-file pinned-item';
    div.dataset.pinId = pin.id;

    // Draggable for file/folder types
    if (pin.type === 'file' || pin.type === 'folder') {
        div.draggable = true;
        div.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('application/x-zune-paths', JSON.stringify([pin.path]));
            e.dataTransfer.effectAllowed = 'copy';
        });
    }

    // Thumbnail for pictures or albums with art
    if (pin.type === 'file' && pin.meta && pin.meta.category === 'pictures') {
        const img = document.createElement('img');
        img.className = 'recent-file-thumb';
        img.src = `file://${pin.path}`;
        img.onerror = () => { img.style.display = 'none'; };
        div.appendChild(img);
    }

    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = pin.label;

    const detail = document.createElement('div');
    detail.className = 'file-details';
    detail.textContent = pin.type;

    div.appendChild(name);
    div.appendChild(detail);

    div.addEventListener('click', () => this.navigateToPin(pin));
    div.addEventListener('contextmenu', (e) => this.showPinContextMenu(e, pin));

    return div;
}
```

**Step 6: Implement `navigateToPin(pin)`**

```javascript
navigateToPin(pin) {
    switch (pin.type) {
        case 'file':
            this.handleFileClick(null, { path: pin.path, name: pin.label });
            break;
        case 'folder':
            this.currentCategory = pin.meta.category || 'documents';
            this.showContent();
            this.browsingMode = true;
            this.currentPath = pin.path;
            this.renderDirectoryContents();
            break;
        case 'album':
            this.currentCategory = 'music';
            this.showContent();
            this.musicSubView = 'albums';
            this.musicDrillDown = { type: 'album', key: pin.meta.albumKey };
            this.renderMusicView();
            break;
        case 'artist':
            this.currentCategory = 'music';
            this.showContent();
            this.musicSubView = 'artists';
            this.musicDrillDown = { type: 'artist', name: pin.meta.artistName };
            this.renderMusicView();
            break;
        case 'genre':
            this.currentCategory = 'music';
            this.showContent();
            this.musicSubView = 'genres';
            this.musicDrillDown = { type: 'genre', name: pin.meta.genreName };
            this.renderMusicView();
            break;
        case 'playlist':
            this.currentCategory = 'music';
            this.showContent();
            this.musicSubView = 'playlists';
            this.musicDrillDown = { type: 'playlist', id: pin.meta.playlistId };
            this.renderMusicView();
            break;
    }
}
```

**Step 7: Verify**

Run `npm start`. Confirm the sidebar shows "recent" in muted white. Pinned section should be hidden (no pins yet).

**Step 8: Commit**

```
feat(pins): sidebar UI with pinned section above recent
```

---

## Task 3: Pins Context Menu Integration

**Files:**
- Modify: `src/assets/js/renderer.js` — add pin/unpin to context menu, dynamic context menu builder, showPinContextMenu
- Modify: `src/renderer/index.html` — add pin context menu item

**Step 1: Implement `showDynamicContextMenu()`**

A reusable method that replaces the static context menu with dynamically built items. This will be used by pins, playlists, and music context menus:

```javascript
showDynamicContextMenu(e, items) {
    e.preventDefault();
    e.stopPropagation();

    const menu = document.getElementById('context-menu');
    this.clearElement(menu);

    items.forEach(item => {
        if (item.separator) {
            const sep = document.createElement('div');
            sep.className = 'context-menu-separator';
            menu.appendChild(sep);
            return;
        }
        const btn = document.createElement('button');
        btn.className = 'context-menu-item';
        btn.textContent = item.label;
        btn.addEventListener('click', () => {
            item.action();
            this.hideContextMenu();
        });
        menu.appendChild(btn);
    });

    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    menu.style.display = 'block';

    // Adjust if off-screen
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${e.clientX - rect.width}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${e.clientY - rect.height}px`;
}
```

**Step 2: Refactor `showContextMenu()` to use dynamic builder**

Convert the existing static context menu to build items dynamically. This replaces the current `showContextMenu()` method:

```javascript
showContextMenu(e, file) {
    e.preventDefault();
    e.stopPropagation();
    this.selectedFile = file;

    const items = [
        { label: 'Open', action: () => this.handleContextMenuAction({ target: { dataset: { action: 'open' } } }) },
        { label: 'Show in Finder', action: () => this.handleContextMenuAction({ target: { dataset: { action: 'show-in-folder' } } }) },
    ];

    // Zune send option
    if (this.zunePanel && this.zunePanel.state === 'connected') {
        items.push({ label: 'Send to Zune', action: () => this.handleContextMenuAction({ target: { dataset: { action: 'send-to-zune' } } }) });
    }

    // Music file options
    const category = this.getFileCategory(file);
    if (category === 'music') {
        items.push({ separator: true });
        items.push({ label: 'Add to Now Playing', action: () => this.addToNowPlaying([file]) });
        items.push(...this.buildPlaylistSubmenuItems([file]));
    }

    items.push({ separator: true });

    // Pin/Unpin
    const isPinned = this.pinnedItems.some(p => p.path === file.path);
    items.push({
        label: isPinned ? 'Unpin from sidebar' : 'Pin to sidebar',
        action: () => isPinned ? this.unpinItem(file.path) : this.pinItem(file),
    });

    items.push({ separator: true });
    items.push({ label: 'Delete', action: () => this.handleContextMenuAction({ target: { dataset: { action: 'delete' } } }) });

    this.showDynamicContextMenu(e, items);
}
```

Note: `buildPlaylistSubmenuItems()` is implemented in Task 9. For this task, just add the pin/unpin items. The playlist items can be added as a no-op stub that gets filled in later.

**Step 3: Implement `pinItem()` and `unpinItem()`**

```javascript
async pinItem(file) {
    const category = this.getFileCategory(file);
    const pin = {
        id: crypto.randomUUID(),
        type: file.isDirectory ? 'folder' : 'file',
        label: file.name,
        path: file.path,
        meta: { category },
        createdAt: new Date().toISOString(),
    };

    if (this.pinnedItems.some(p => p.path === pin.path)) return;

    this.pinnedItems.push(pin);
    await this.savePins();
    this.updatePinnedPanel();
}

async unpinItem(path) {
    this.pinnedItems = this.pinnedItems.filter(p => p.path !== path);
    await this.savePins();
    this.updatePinnedPanel();
}
```

**Step 4: Implement `pinMusicItem()` for albums/artists/genres**

```javascript
async pinMusicItem(type, data) {
    const pin = {
        id: crypto.randomUUID(),
        type,
        label: data.label,
        path: null,
        meta: data.meta,
        createdAt: new Date().toISOString(),
    };

    const isDuplicate = this.pinnedItems.some(p => {
        if (p.type !== type) return false;
        if (type === 'album') return p.meta.albumKey === data.meta.albumKey;
        if (type === 'artist') return p.meta.artistName === data.meta.artistName;
        if (type === 'genre') return p.meta.genreName === data.meta.genreName;
        if (type === 'playlist') return p.meta.playlistId === data.meta.playlistId;
        return false;
    });
    if (isDuplicate) return;

    this.pinnedItems.push(pin);
    await this.savePins();
    this.updatePinnedPanel();
}
```

**Step 5: Implement `showPinContextMenu()` for pinned sidebar items**

```javascript
showPinContextMenu(e, pin) {
    this.showDynamicContextMenu(e, [
        { label: 'Unpin', action: () => {
            this.pinnedItems = this.pinnedItems.filter(p => p.id !== pin.id);
            this.savePins();
            this.updatePinnedPanel();
        }},
    ]);
}
```

**Step 6: Verify**

Run `npm start`. Right-click a file in any category, see "Pin to sidebar" / "Unpin from sidebar". Pin a file, see it in the sidebar. Unpin it. Test with folders too.

**Step 7: Commit**

```
feat(pins): context menu pin/unpin with dynamic menu builder
```

---

## Task 4: Playlists Data Layer (IPC + Persistence)

**Files:**
- Modify: `src/main/main.js` — add IPC handlers for playlist CRUD
- Modify: `src/main/preload.js` — expose playlist API

**Step 1: Add playlist IPC handlers in main.js**

Add after the pins handlers. Playlists stored as individual JSON files in a `playlists/` subdirectory of userData, keyed by UUID:

```javascript
// --- Playlists ---
const playlistsDir = path.join(app.getPath('userData'), 'playlists');

ipcMain.handle('playlists-load-all', async () => {
  try {
    await fs.mkdir(playlistsDir, { recursive: true });
    const files = await fs.readdir(playlistsDir);
    const playlists = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = await fs.readFile(path.join(playlistsDir, file), 'utf-8');
        playlists.push(JSON.parse(data));
      } catch { /* skip corrupt files */ }
    }
    return { success: true, data: playlists };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('playlist-save', async (event, playlist) => {
  try {
    await fs.mkdir(playlistsDir, { recursive: true });
    const filename = playlist.id + '.json';
    await fs.writeFile(
      path.join(playlistsDir, filename),
      JSON.stringify(playlist, null, 2)
    );
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('playlist-delete', async (event, playlistId) => {
  try {
    const filename = playlistId + '.json';
    await fs.unlink(path.join(playlistsDir, filename));
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});
```

**Step 2: Add Now Playing persistence handlers**

```javascript
// --- Now Playing ---
const nowPlayingPath = path.join(app.getPath('userData'), 'now-playing.json');

ipcMain.handle('now-playing-load', async () => {
  try {
    const data = await fs.readFile(nowPlayingPath, 'utf-8');
    return { success: true, data: JSON.parse(data) };
  } catch {
    return { success: true, data: { tracks: [], currentIndex: 0 } };
  }
});

ipcMain.handle('now-playing-save', async (event, nowPlaying) => {
  try {
    await fs.writeFile(nowPlayingPath, JSON.stringify(nowPlaying, null, 2));
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});
```

**Step 3: Expose in preload.js**

```javascript
playlistsLoadAll: () => ipcRenderer.invoke('playlists-load-all'),
playlistSave: (playlist) => ipcRenderer.invoke('playlist-save', playlist),
playlistDelete: (id) => ipcRenderer.invoke('playlist-delete', id),
nowPlayingLoad: () => ipcRenderer.invoke('now-playing-load'),
nowPlayingSave: (data) => ipcRenderer.invoke('now-playing-save', data),
```

**Step 4: Verify**

Run `npm start`, check DevTools: `window.electronAPI.playlistsLoadAll`, etc. exist.

**Step 5: Commit**

```
feat(playlists): add IPC handlers for playlist and now-playing persistence
```

---

## Task 5: Playlists State & Tab Integration

**Files:**
- Modify: `src/assets/js/renderer.js` — add playlists state, load on init, add PLAYLISTS tab

**Step 1: Add playlists state to constructor**

Near the `musicLibrary` initialization (~line 1903):

```javascript
this.playlists = [];
this.nowPlaying = { tracks: [], currentIndex: 0 };
```

**Step 2: Load playlists and now playing on init**

Add `loadPlaylists()` and `loadNowPlaying()` methods, call both from `init()`:

```javascript
async loadPlaylists() {
    const result = await window.electronAPI.playlistsLoadAll();
    if (result.success) {
        this.playlists = result.data;
    }
}

async loadNowPlaying() {
    const result = await window.electronAPI.nowPlayingLoad();
    if (result.success) {
        this.nowPlaying = result.data;
    }
}
```

**Step 3: Add PLAYLISTS to tab array**

In `renderMusicView()` (~line 3464), change:

```javascript
const tabNames = ['albums', 'artists', 'songs', 'genres'];
```

to:

```javascript
const tabNames = ['albums', 'artists', 'songs', 'genres', 'playlists'];
```

**Step 4: Add playlists case to renderMusicSubContent()**

In the switch statement (~line 3510):

```javascript
case 'playlists': this.renderMusicPlaylistsView(container); break;
```

**Step 5: Add stub `renderMusicPlaylistsView()`**

```javascript
renderMusicPlaylistsView(container) {
    const msg = document.createElement('div');
    msg.style.cssText = 'color: var(--zune-text-dim); padding: 20px;';
    msg.textContent = 'Playlists coming soon';
    container.appendChild(msg);
}
```

**Step 6: Verify**

Run `npm start`, navigate to Music, confirm PLAYLISTS tab appears and is clickable.

**Step 7: Commit**

```
feat(playlists): add playlists tab to music sub-navigation
```

---

## Task 6: Now Playing Queue Integration

**Files:**
- Modify: `src/assets/js/renderer.js` — wire playback to use nowPlaying queue

**Step 1: Add `saveNowPlaying()` method**

```javascript
async saveNowPlaying() {
    await window.electronAPI.nowPlayingSave(this.nowPlaying);
}
```

**Step 2: Add `playWithNowPlaying(file, queue)` method**

Replaces Now Playing and starts playback:

```javascript
async playWithNowPlaying(file, queue) {
    this.nowPlaying.tracks = queue.map(f => ({
        path: f.path,
        title: f.title || f.name,
        artist: f.artist || '',
        album: f.album || '',
        duration: f.duration || 0,
    }));
    this.nowPlaying.currentIndex = queue.findIndex(f => f.path === file.path);
    if (this.nowPlaying.currentIndex === -1) this.nowPlaying.currentIndex = 0;
    await this.saveNowPlaying();
    await this.audioPlayer.play(file, queue);
}
```

**Step 3: Replace direct `this.audioPlayer.play()` calls**

Find all places where `this.audioPlayer.play(file, files)` is called and replace with `this.playWithNowPlaying(file, files)`. Key locations:
- Album detail track click (~line 3925)
- Songs list track click (~line 3637)
- Artist detail track click
- Genre detail track click
- Any other playback triggers

**Step 4: Track advancement syncs currentIndex**

In `setupPlayer()` (~line 2081), listen for trackchange:

```javascript
this.audioPlayer.on('trackchange', ({ index }) => {
    this.nowPlaying.currentIndex = index;
    this.saveNowPlaying();
});
```

**Step 5: Add `addToNowPlaying(tracks)` method**

Appends tracks without interrupting playback:

```javascript
async addToNowPlaying(tracks) {
    const newTracks = tracks.map(f => ({
        path: f.path,
        title: f.title || f.name,
        artist: f.artist || '',
        album: f.album || '',
        duration: f.duration || 0,
    }));
    this.nowPlaying.tracks.push(...newTracks);
    // Also update the audio player's live queue
    this.audioPlayer.queue.push(...tracks);
    await this.saveNowPlaying();
}
```

**Step 6: Verify**

Run `npm start`. Play a song. Check that `now-playing.json` is created in userData directory. Close and reopen the app. Confirm `this.nowPlaying` loads with the previous queue but doesn't auto-play.

**Step 7: Commit**

```
feat(now-playing): wire playback to persistent Now Playing queue
```

---

## Task 7: Playlist List View

**Files:**
- Modify: `src/assets/js/renderer.js` — implement `renderMusicPlaylistsView()`
- Modify: `src/assets/css/styles.css` — playlist list styles

**Step 1: Implement `renderMusicPlaylistsView()`**

Replace the stub from Task 5. Build the view with:
- Now Playing as a special entry at top (muted white, larger text)
- Divider
- "+ new playlist" row
- Sorted list of user playlists (name + "N songs - MM min" subtext)

Each playlist row: click drills down, right-click shows "Delete Playlist".

Now Playing row: click drills down to `{ type: 'now-playing' }`.

**Step 2: Add helper methods**

```javascript
formatPlaylistDuration(seconds) {
    const mins = Math.round(seconds / 60);
    if (mins < 60) return `${mins} min`;
    const hrs = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return `${hrs} hr ${remainMins} min`;
}

async createNewPlaylist(initialTracks = []) {
    const name = prompt('Playlist name:');
    if (!name || !name.trim()) return null;

    const playlist = {
        id: crypto.randomUUID(),
        name: name.trim(),
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        tracks: initialTracks.map(t => ({
            path: t.path,
            title: t.title || t.name,
            artist: t.artist || '',
            album: t.album || '',
            duration: t.duration || 0,
        })),
    };

    this.playlists.push(playlist);
    await window.electronAPI.playlistSave(playlist);

    if (this.musicSubView === 'playlists' && !this.musicDrillDown) {
        this.renderMusicSubContent();
    }

    return playlist;
}

async deletePlaylist(id) {
    if (!confirm('Delete this playlist?')) return;

    this.playlists = this.playlists.filter(p => p.id !== id);
    await window.electronAPI.playlistDelete(id);

    // Remove any pins pointing to this playlist
    this.pinnedItems = this.pinnedItems.filter(p => !(p.type === 'playlist' && p.meta.playlistId === id));
    await this.savePins();
    this.updatePinnedPanel();

    if (this.musicSubView === 'playlists') {
        if (this.musicDrillDown && this.musicDrillDown.id === id) {
            this.musicDrillDown = null;
        }
        this.renderMusicView();
    }
}
```

**Step 3: Add CSS for playlist list**

```css
.playlist-list {
    display: flex;
    flex-direction: column;
}

.playlist-row {
    display: flex;
    align-items: center;
    padding: 14px 8px;
    cursor: pointer;
    transition: background 0.15s;
    border-bottom: 1px solid rgba(255, 255, 255, 0.03);
}

.playlist-row:hover {
    background: rgba(255, 105, 0, 0.08);
}

.playlist-info {
    flex: 1;
    min-width: 0;
}

.playlist-name {
    font-size: 18px;
    font-weight: 400;
    color: var(--zune-text);
}

.playlist-meta {
    font-size: 13px;
    color: var(--zune-text-dim);
    margin-top: 2px;
}

.now-playing-row .playlist-name {
    color: rgba(255, 255, 255, 0.55);
    font-size: 22px;
    font-weight: 100;
    letter-spacing: 1px;
}

.playlist-divider {
    height: 1px;
    background: rgba(255, 255, 255, 0.08);
    margin: 8px 0;
}

.new-playlist-row {
    color: var(--zune-text-dim);
    font-size: 15px;
    font-weight: 400;
    letter-spacing: 0.5px;
}

.new-playlist-row:hover {
    color: var(--zune-text);
}
```

**Step 4: Verify**

Run `npm start`, go to Music, click PLAYLISTS. Now Playing appears at top. "+ new playlist" below divider. Create a playlist, see it appear.

**Step 5: Commit**

```
feat(playlists): playlist list view with now playing and create button
```

---

## Task 8: Playlist Detail View (Drill-Down)

**Files:**
- Modify: `src/assets/js/renderer.js` — playlist and now-playing drill-down rendering
- Modify: `src/assets/css/styles.css` — playlist detail styles

**Step 1: Handle playlist drill-down in `renderMusicView()`**

In the drill-down detection block (~line 3430), add cases for `playlist` and `now-playing`:

```javascript
} else if (this.musicDrillDown.type === 'playlist') {
    const playlist = this.playlists.find(p => p.id === this.musicDrillDown.id);
    title.textContent = playlist ? playlist.name : 'Playlist';
    breadcrumb.textContent = 'music';
} else if (this.musicDrillDown.type === 'now-playing') {
    title.textContent = 'now playing';
    breadcrumb.textContent = 'music';
}
```

**Step 2: Handle in `renderMusicDrillDown()`**

Add cases (~line 3528):

```javascript
} else if (this.musicDrillDown.type === 'playlist') {
    this.renderPlaylistDetail(fileDisplay, this.musicDrillDown.id);
} else if (this.musicDrillDown.type === 'now-playing') {
    this.renderNowPlayingDetail(fileDisplay);
}
```

**Step 3: Implement `renderPlaylistDetail(container, playlistId)`**

Build the detail view:
- Stats header ("N songs - MM min")
- Track list with album art, title, "Artist - Album" subtext
- Each row: click to play, right-click to remove, drag-to-reorder

**Step 4: Implement `createPlaylistTrackRow(track, index, playlist)`**

Each row contains:
- Drag handle (braille dots character)
- Album art thumbnail (40x40, cross-referenced from music library via `findAlbumArtForTrack()`)
- Track info (title + artist-album meta)
- Click handler: plays from that position using `playWithNowPlaying()`
- Right-click: "Remove from Playlist" (splices track, saves, re-renders)
- Drag events: dragstart sets index, dragover/drop handles reorder, saves playlist

**Step 5: Add `findAlbumArtForTrack()` helper**

Cross-references the music library to find album art:

```javascript
findAlbumArtForTrack(track) {
    if (!track.artist && !track.album) return null;
    const key = `${(track.album || '').toLowerCase()}||${(track.artist || '').toLowerCase()}`;
    const album = this.musicLibrary.albums.get(key);
    if (album && album.albumArt) return album.albumArt;
    for (const [, alb] of this.musicLibrary.albums) {
        if (alb.name.toLowerCase() === (track.album || '').toLowerCase()) {
            if (alb.albumArt) return alb.albumArt;
        }
    }
    return null;
}
```

**Step 6: Implement `renderNowPlayingDetail(container)`**

Nearly identical to playlist detail but operates on `this.nowPlaying`. Highlights the current track with `.now-playing-active` class (orange title). Remove action removes from `this.nowPlaying.tracks` and adjusts `currentIndex`. Reorder adjusts `currentIndex` to follow the currently playing track.

**Step 7: Add CSS for playlist detail**

```css
.playlist-detail {
    padding: 0 8px;
}

.playlist-stats {
    font-size: 14px;
    color: var(--zune-text-dim);
    padding: 8px 0 16px;
    letter-spacing: 0.5px;
}

.playlist-track-list {
    display: flex;
    flex-direction: column;
}

.playlist-track-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 4px;
    cursor: pointer;
    transition: background 0.15s;
    border-bottom: 1px solid rgba(255, 255, 255, 0.03);
}

.playlist-track-row:hover {
    background: rgba(255, 105, 0, 0.08);
}

.playlist-track-row.now-playing-active {
    background: rgba(255, 105, 0, 0.05);
}

.playlist-track-row.now-playing-active .playlist-track-title {
    color: var(--zune-orange);
}

.playlist-track-row.dragging {
    opacity: 0.4;
}

.playlist-track-row.drag-over {
    border-top: 2px solid var(--zune-orange);
}

.playlist-drag-handle {
    color: rgba(255, 255, 255, 0.15);
    font-size: 18px;
    cursor: grab;
    user-select: none;
    flex-shrink: 0;
    width: 20px;
    text-align: center;
}

.playlist-drag-handle:active {
    cursor: grabbing;
}

.playlist-track-thumb {
    width: 40px;
    height: 40px;
    border-radius: 3px;
    background: #1a1a1a;
    flex-shrink: 0;
    overflow: hidden;
}

.playlist-track-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.playlist-track-info {
    flex: 1;
    min-width: 0;
}

.playlist-track-title {
    font-size: 16px;
    font-weight: 400;
    color: var(--zune-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.playlist-track-meta {
    font-size: 12px;
    color: var(--zune-text-dim);
    margin-top: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.playlist-track-missing {
    opacity: 0.4;
}

.playlist-track-missing .playlist-track-title {
    text-decoration: line-through;
}
```

**Step 8: Verify**

Run `npm start`. Create a playlist with tracks. Drill in. Verify album art, drag-to-reorder, remove track. Check Now Playing detail with current track highlighting.

**Step 9: Commit**

```
feat(playlists): playlist and now-playing detail views with drag-to-reorder
```

---

## Task 9: Playlist & Now Playing Context Menus

**Files:**
- Modify: `src/assets/js/renderer.js` — add "Add to Playlist" and "Add to Now Playing" to music context menus

**Step 1: Implement shared music context menu builder**

```javascript
showMusicItemContextMenu(e, tracks, extraItems = []) {
    const items = [
        { label: 'Add to Now Playing', action: () => this.addToNowPlaying(tracks) },
        { separator: true },
        ...this.buildPlaylistSubmenuItems(tracks),
    ];
    if (extraItems.length > 0) {
        items.push({ separator: true });
        items.push(...extraItems);
    }
    this.showDynamicContextMenu(e, items);
}

buildPlaylistSubmenuItems(tracks) {
    const items = [];
    items.push({
        label: 'New Playlist...',
        action: () => this.createNewPlaylist(tracks),
    });

    if (this.playlists.length > 0) {
        items.push({ separator: true });
        this.playlists.sort((a, b) => a.name.localeCompare(b.name)).forEach(playlist => {
            items.push({
                label: `Add to "${playlist.name}"`,
                action: () => this.addTracksToPlaylist(playlist.id, tracks),
            });
        });
    }

    return items;
}

async addTracksToPlaylist(playlistId, tracks) {
    const playlist = this.playlists.find(p => p.id === playlistId);
    if (!playlist) return;

    const newTracks = tracks.map(t => ({
        path: t.path,
        title: t.title || t.name,
        artist: t.artist || '',
        album: t.album || '',
        duration: t.duration || 0,
    }));

    const existingPaths = new Set(playlist.tracks.map(t => t.path));
    const toAdd = newTracks.filter(t => !existingPaths.has(t.path));

    playlist.tracks.push(...toAdd);
    playlist.modifiedAt = new Date().toISOString();
    await window.electronAPI.playlistSave(playlist);
}
```

**Step 2: Wire up to album detail track rows**

In `renderAlbumDetail()` (~line 3925), add contextmenu handler to each track row:

```javascript
row.addEventListener('contextmenu', (e) => {
    const file = this.getTrackFile(track);
    this.showMusicItemContextMenu(e, [file]);
});
```

For the album header itself (right-click to add all tracks):

```javascript
albumHeader.addEventListener('contextmenu', (e) => {
    const files = album.tracks.map(t => this.getTrackFile(t));
    this.showMusicItemContextMenu(e, files, [
        { label: 'Pin to sidebar', action: () => this.pinMusicItem('album', { label: album.name, meta: { albumKey: album.key, category: 'music' } }) },
    ]);
});
```

**Step 3: Wire up to song rows in songs list**

In `renderMusicSongsView()` (~line 3637):

```javascript
row.addEventListener('contextmenu', (e) => {
    const file = this.getTrackFile(track);
    this.showMusicItemContextMenu(e, [file]);
});
```

**Step 4: Wire up to artist rows**

In `renderMusicArtistsView()` (~line 3699):

```javascript
row.addEventListener('contextmenu', (e) => {
    const files = [];
    for (const albumKey of artist.albums) {
        const album = this.musicLibrary.albums.get(albumKey);
        if (album) files.push(...album.tracks.map(t => this.getTrackFile(t)));
    }
    this.showMusicItemContextMenu(e, files, [
        { label: 'Pin to sidebar', action: () => this.pinMusicItem('artist', { label: artist.name, meta: { artistName: artist.name.toLowerCase(), category: 'music' } }) },
    ]);
});
```

**Step 5: Wire up to genre rows**

In `renderMusicGenresView()` (~line 3730):

```javascript
row.addEventListener('contextmenu', (e) => {
    const files = genre.tracks.map(t => this.getTrackFile(t));
    this.showMusicItemContextMenu(e, files, [
        { label: 'Pin to sidebar', action: () => this.pinMusicItem('genre', { label: genre.name, meta: { genreName: genre.name.toLowerCase(), category: 'music' } }) },
    ]);
});
```

**Step 6: Update `showContextMenu()` to include playlist items for music files**

If not already done in Task 3, ensure the refactored `showContextMenu()` calls `buildPlaylistSubmenuItems()` for music files.

**Step 7: Verify**

Run `npm start`. Right-click a song: see "Add to Now Playing", "New Playlist...", and existing playlist names. Right-click an album/artist: same plus "Pin to sidebar". Create a playlist via context menu. Add tracks to existing playlist. Verify tracks appear when drilling into the playlist.

**Step 8: Commit**

```
feat(playlists): context menus for add-to-playlist and add-to-now-playing
```

---

## Task 10: Polish & Edge Cases

**Files:**
- Modify: `src/assets/js/renderer.js` — genre drill-down, missing tracks, cleanup

**Step 1: Add genre drill-down support for pins**

The existing drill-down system may not have a `genre` type. Add support in `renderMusicView()` drill-down detection:

```javascript
} else if (this.musicDrillDown.type === 'genre') {
    const genre = this.musicLibrary.genres.get(this.musicDrillDown.name);
    title.textContent = genre ? genre.name : 'Genre';
    breadcrumb.textContent = 'music';
}
```

And in `renderMusicDrillDown()`:

```javascript
} else if (this.musicDrillDown.type === 'genre') {
    this.renderGenreDetail(fileDisplay);
}
```

Check if `renderGenreDetail` already exists. If not, implement it to show a song list for all tracks in the genre (same pattern as artist detail).

**Step 2: Handle missing tracks in playlists**

In `createPlaylistTrackRow()`, check if the track file exists in the music library:

```javascript
const trackExists = this.musicLibrary.tracks.has(track.path);
if (!trackExists) {
    row.classList.add('playlist-track-missing');
}
```

**Step 3: Verify end-to-end**

Full test pass:
- Pin a file, folder, album, artist, genre -> all appear in sidebar
- Click each pin -> navigates correctly
- Unpin -> removes from sidebar
- Create playlist from context menu -> appears in PLAYLISTS tab
- Drill into playlist -> tracks show with art, drag-to-reorder works
- Add to Now Playing -> tracks appended to queue
- Play a song -> Now Playing queue updated
- Drill into Now Playing -> current track highlighted in orange
- Close and reopen app -> pins, playlists, and Now Playing queue persist
- Missing tracks shown with strikethrough

**Step 4: Commit**

```
feat(pins-playlists): polish, edge cases, and genre drill-down
```

---

## Task 11: Update Roadmap & Documentation

**Files:**
- Modify: `docs/ROADMAP.md` — mark features as done

**Step 1: Update roadmap entries**

Mark as done:
- "Pins" under File Management
- "Playlists" under Music Experience Enhancements
- "Left Sidebar Expansion" under UI / UX

Add "Now Playing" under Music Experience Enhancements as done.

**Step 2: Commit**

```
docs: update roadmap for pins, playlists, and now playing
```
