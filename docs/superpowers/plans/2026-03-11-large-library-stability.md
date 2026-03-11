# Large Library Stability Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Zune Explorer handle 11,000+ song libraries without crashing — in both the UI (virtual scrolling) and transfers (batching/retry).

**Architecture:** A new `VirtualScroller` class handles all large lists. Transfer loops get batching with per-file error handling. Album art is deduplicated by album key. IPC listener leaks are fixed with named references and remove wrappers.

**Tech Stack:** Vanilla JS (no dependencies), Electron IPC, existing CSS

**Spec:** `docs/superpowers/specs/2026-03-11-large-library-stability-design.md`

**Note:** No test framework is configured. Each task includes manual verification steps.

---

## File Structure

### New Files
- `src/assets/js/virtual-scroller.js` — Reusable `VirtualScroller` class

### Modified Files
- `src/assets/js/renderer.js` — Songs list, browse list, diff list, alpha-jump, pull loop, listener cleanup
- `src/main/zune/zune-manager.js` — sendFiles batching/retry, browseContents art dedup
- `src/main/main.js` — Pull file batching awareness, IPC handler for cache format
- `src/main/preload.js` — Add `off*` listener removal wrappers
- `src/assets/css/styles.css` — Virtual scroller container styles, progress bar styles
- `src/renderer/index.html` — Add script tag for virtual-scroller.js

---

## Chunk 1: Virtual Scroller Core + Songs List

### Task 1: Create the VirtualScroller class

**Files:**
- Create: `src/assets/js/virtual-scroller.js`

The VirtualScroller is a reusable class that renders only visible rows in a scrollable container. It supports variable row heights via a position map, row recycling, and event delegation.

- [ ] **Step 1: Create `src/assets/js/virtual-scroller.js`**

```javascript
/**
 * VirtualScroller — renders only visible rows from a large dataset.
 *
 * Usage:
 *   const vs = new VirtualScroller({
 *     container,            // the scrollable DOM element
 *     rowTypes: { track: { height: 48 }, letter: { height: 64 } },
 *     renderRow(el, index, entry),   // populate a row element
 *     overscan: 20,         // extra rows above/below viewport
 *   });
 *   vs.setData(entries);   // [{ type: 'track', data: {...} }, ...]
 *   vs.scrollToOffset(500);
 *   vs.destroy();
 */
class VirtualScroller {
    constructor({ container, rowTypes, renderRow, overscan = 20 }) {
        this.container = container;
        this.rowTypes = rowTypes;
        this.renderRow = renderRow;
        this.overscan = overscan;

        this.entries = [];
        this.positionMap = [];  // [{ offset, height, type }]
        this.totalHeight = 0;

        // DOM structure: container > spacer > viewport
        this.spacer = document.createElement('div');
        this.spacer.className = 'vs-spacer';
        this.spacer.style.position = 'relative';

        this.viewport = document.createElement('div');
        this.viewport.className = 'vs-viewport';
        this.viewport.style.position = 'absolute';
        this.viewport.style.left = '0';
        this.viewport.style.right = '0';

        this.spacer.appendChild(this.viewport);
        this.container.appendChild(this.spacer);

        // Row pool keyed by type
        this.rowPool = {};
        for (const type of Object.keys(rowTypes)) {
            this.rowPool[type] = [];
        }
        this.activeRows = []; // currently rendered { el, index, type }

        // Rendering state
        this.firstVisible = -1;
        this.lastVisible = -1;
        this._rafId = null;

        // Measure actual row heights from DOM on first render
        this._measuredHeights = {};
        this._measured = false;

        // Bind scroll handler
        this._onScroll = () => {
            if (this._rafId) return;
            this._rafId = requestAnimationFrame(() => {
                this._rafId = null;
                this._render();
            });
        };
        this.container.addEventListener('scroll', this._onScroll, { passive: true });
    }

    /**
     * Measure actual row heights by temporarily rendering one of each type.
     */
    _measureHeights() {
        if (this._measured) return;
        for (const [type, config] of Object.entries(this.rowTypes)) {
            if (config.measure === false) {
                this._measuredHeights[type] = config.height;
                continue;
            }
            // Create a temporary element off-screen to measure
            const el = document.createElement('div');
            el.className = config.className || '';
            el.style.visibility = 'hidden';
            el.style.position = 'absolute';
            el.style.top = '-9999px';
            // Add minimal content so CSS applies
            el.textContent = 'M';
            this.container.appendChild(el);
            const rect = el.getBoundingClientRect();
            this._measuredHeights[type] = rect.height || config.height;
            this.container.removeChild(el);
        }
        this._measured = true;
    }

    /**
     * Set/replace the data source. Rebuilds position map and re-renders.
     * @param {Array} entries - [{ type: string, data: any }, ...]
     * @param {Object} opts - { preserveScroll: boolean }
     */
    setData(entries, opts = {}) {
        const savedScroll = opts.preserveScroll ? this.container.scrollTop : 0;

        this.entries = entries;
        this._measureHeights();
        this._buildPositionMap();
        this.spacer.style.height = this.totalHeight + 'px';

        // Recycle all active rows back to pool
        for (const active of this.activeRows) {
            active.el.style.display = 'none';
            this.rowPool[active.type].push(active.el);
        }
        this.activeRows = [];
        this.firstVisible = -1;
        this.lastVisible = -1;

        if (opts.preserveScroll) {
            this.container.scrollTop = Math.min(savedScroll, Math.max(0, this.totalHeight - this.container.clientHeight));
        }

        this._render();
    }

    _buildPositionMap() {
        this.positionMap = [];
        let offset = 0;
        for (const entry of this.entries) {
            const height = this._measuredHeights[entry.type] || 48;
            this.positionMap.push({ offset, height, type: entry.type });
            offset += height;
        }
        this.totalHeight = offset;
    }

    /**
     * Build a letter-to-offset map for alpha-jump integration.
     * Call after setData. Looks for entries with type 'letter'.
     * @returns {Object} { 'a': 0, 'b': 1240, ... }
     */
    buildLetterPositionMap() {
        const map = {};
        for (let i = 0; i < this.entries.length; i++) {
            const entry = this.entries[i];
            if (entry.type === 'letter' && entry.letter) {
                map[entry.letter] = this.positionMap[i].offset;
            }
        }
        return map;
    }

    /**
     * Scroll to a specific pixel offset (for alpha-jump).
     */
    scrollToOffset(offset) {
        this.container.scrollTop = Math.max(0, Math.min(offset, this.totalHeight - this.container.clientHeight));
    }

    /**
     * Scroll to a specific item index.
     */
    scrollToIndex(index) {
        if (index >= 0 && index < this.positionMap.length) {
            this.scrollToOffset(this.positionMap[index].offset);
        }
    }

    /**
     * Core render — compute visible range and update DOM.
     */
    _render() {
        const scrollTop = this.container.scrollTop;
        const viewportHeight = this.container.clientHeight;
        if (viewportHeight === 0 || this.entries.length === 0) return;

        // Binary search for first visible index
        let first = this._findIndexAtOffset(scrollTop);
        let last = first;

        // Walk forward to find last visible
        let bottomEdge = scrollTop + viewportHeight;
        while (last < this.positionMap.length - 1) {
            const pos = this.positionMap[last + 1];
            if (pos.offset >= bottomEdge) break;
            last++;
        }

        // Apply overscan
        first = Math.max(0, first - this.overscan);
        last = Math.min(this.entries.length - 1, last + this.overscan);

        if (first === this.firstVisible && last === this.lastVisible) return;

        // Recycle rows that are now out of range
        const newActive = [];
        for (const active of this.activeRows) {
            if (active.index < first || active.index > last) {
                active.el.style.display = 'none';
                this.rowPool[active.type].push(active.el);
            } else {
                newActive.push(active);
            }
        }

        // Build set of currently active indices
        const activeIndices = new Set(newActive.map(a => a.index));

        // Render new rows
        for (let i = first; i <= last; i++) {
            if (activeIndices.has(i)) continue;

            const entry = this.entries[i];
            const pos = this.positionMap[i];
            const type = entry.type;

            // Get or create a row element
            let el;
            if (this.rowPool[type].length > 0) {
                el = this.rowPool[type].pop();
            } else {
                el = document.createElement('div');
                el.className = (this.rowTypes[type].className || '') + ' vs-row';
                this.viewport.appendChild(el);
            }

            el.style.display = '';
            el.style.position = 'absolute';
            el.style.top = pos.offset + 'px';
            el.style.height = pos.height + 'px';
            el.style.left = '0';
            el.style.right = '0';
            el.dataset.index = String(i);

            // Let the caller populate content
            this.renderRow(el, i, entry);

            newActive.push({ el, index: i, type });
        }

        this.activeRows = newActive;
        this.firstVisible = first;
        this.lastVisible = last;
    }

    /**
     * Binary search for the index at a given scroll offset.
     */
    _findIndexAtOffset(offset) {
        let low = 0;
        let high = this.positionMap.length - 1;
        while (low < high) {
            const mid = (low + high) >>> 1;
            const pos = this.positionMap[mid];
            if (pos.offset + pos.height <= offset) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        return low;
    }

    /**
     * Get the data entry at a given index. Used by event delegation handlers.
     */
    getEntryAtIndex(index) {
        return this.entries[index] || null;
    }

    /**
     * Force a full re-render (e.g., after selection state changes).
     */
    refresh() {
        for (const active of this.activeRows) {
            const entry = this.entries[active.index];
            if (entry) {
                this.renderRow(active.el, active.index, entry);
            }
        }
    }

    /**
     * Clean up all DOM and listeners.
     */
    destroy() {
        this.container.removeEventListener('scroll', this._onScroll);
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
        for (const active of this.activeRows) {
            active.el.remove();
        }
        for (const pool of Object.values(this.rowPool)) {
            for (const el of pool) {
                el.remove();
            }
        }
        this.spacer.remove();
        this.activeRows = [];
        this.entries = [];
    }
}
```

- [ ] **Step 2: Add script tag to index.html**

In `src/renderer/index.html`, add before the renderer.js script tag:
```html
<script src="../assets/js/virtual-scroller.js"></script>
```

- [ ] **Step 3: Add CSS for virtual scroller**

In `src/assets/css/styles.css`, add at the end:
```css
/* Virtual Scroller */
.vs-spacer {
    width: 100%;
}
.vs-row {
    box-sizing: border-box;
    overflow: hidden;
}
```

- [ ] **Step 4: Commit**

```bash
git add src/assets/js/virtual-scroller.js src/renderer/index.html src/assets/css/styles.css
git commit -m "feat: add VirtualScroller class for large list rendering"
```

---

### Task 2: Virtualize the music songs list

**Files:**
- Modify: `src/assets/js/renderer.js:3977-4037` (`renderMusicSongsView`)
- Modify: `src/assets/js/renderer.js:4949-4986` (`openAlphaJump`)

Replace the synchronous DOM creation loop with a VirtualScroller instance. The songs list currently creates ~8 DOM elements per song with 4 event listeners each. After this change, only ~60 rows exist at a time with event delegation.

- [ ] **Step 1: Add VirtualScroller instance properties to ZuneExplorer**

In `src/assets/js/renderer.js`, in the `ZuneExplorer` constructor (around line 1854-1909), add after the existing property declarations:

```javascript
this.songsScroller = null;        // VirtualScroller for songs list
this.songsLetterMap = null;       // letter -> scroll offset for alpha-jump
```

- [ ] **Step 2: Replace `renderMusicSongsView` (lines 3977-4037)**

Replace the entire method. The `renderRow` callback uses `clearElement` + DOM methods (no innerHTML) to populate each row. Event delegation on the container replaces per-row listeners.

```javascript
renderMusicSongsView(container) {
    this.clearElement(container);
    const songs = this.musicLibrary.sortedSongs;

    if (songs.length === 0 && this.musicLibrary.scanState !== 'scanning') {
        this.appendEmptyState(container, 'no songs found');
        return;
    }

    const grouped = this.buildLetterGroupedList(songs, s => s.title);
    const entries = grouped.map(entry => {
        if (entry.type === 'letter') {
            return { type: 'letter', letter: entry.letter, data: null };
        }
        return { type: 'track', data: entry.data };
    });

    const list = document.createElement('div');
    list.className = 'music-songs-list';
    container.appendChild(list);

    if (this.songsScroller) {
        this.songsScroller.destroy();
    }

    const self = this;
    this.songsScroller = new VirtualScroller({
        container: list,
        rowTypes: {
            letter: { height: 64, className: 'music-letter-row' },
            track: { height: 48, className: 'music-song-row' },
        },
        renderRow(el, index, entry) {
            // Clear previous content safely
            while (el.firstChild) el.removeChild(el.firstChild);

            if (entry.type === 'letter') {
                el.textContent = entry.letter;
                el.dataset.letter = entry.letter;
                el.draggable = false;
            } else {
                const track = entry.data;
                el.draggable = true;
                el.dataset.trackPath = track.path;
                const info = document.createElement('div');
                info.className = 'music-song-info';
                const titleEl = document.createElement('div');
                titleEl.className = 'music-song-title';
                titleEl.textContent = track.title;
                const meta = document.createElement('div');
                meta.className = 'music-song-meta';
                meta.textContent = (track.artist + ' \u2014 ' + track.album).toUpperCase();
                info.appendChild(titleEl);
                info.appendChild(meta);
                const dur = document.createElement('div');
                dur.className = 'music-song-duration';
                dur.textContent = self.formatDuration(track.duration);
                el.appendChild(info);
                el.appendChild(dur);
            }
        },
        overscan: 20,
    });

    // Event delegation on the scroll container
    list.addEventListener('click', (e) => {
        const row = e.target.closest('.vs-row');
        if (!row) return;
        const idx = parseInt(row.dataset.index, 10);
        const entry = this.songsScroller.getEntryAtIndex(idx);
        if (!entry) return;
        if (entry.type === 'letter') {
            this.openAlphaJump();
        } else {
            const track = entry.data;
            const file = this.getTrackFile(track);
            const allFiles = this.musicLibrary.sortedSongs.map(t => this.getTrackFile(t));
            this.playWithNowPlaying(file, allFiles);
        }
    });

    list.addEventListener('contextmenu', (e) => {
        const row = e.target.closest('.vs-row');
        if (!row) return;
        const idx = parseInt(row.dataset.index, 10);
        const entry = this.songsScroller.getEntryAtIndex(idx);
        if (!entry || entry.type === 'letter') return;
        const file = this.getTrackFile(entry.data);
        this.showMusicItemContextMenu(e, [file]);
    });

    list.addEventListener('dragstart', (e) => {
        const row = e.target.closest('.vs-row[draggable="true"]');
        if (!row) return;
        const idx = parseInt(row.dataset.index, 10);
        const entry = this.songsScroller.getEntryAtIndex(idx);
        if (!entry || entry.type !== 'track') return;
        e.dataTransfer.setData('application/x-zune-paths', JSON.stringify([entry.data.path]));
        e.dataTransfer.effectAllowed = 'copy';
        row.classList.add('dragging');
    });

    list.addEventListener('dragend', (e) => {
        const row = e.target.closest('.vs-row');
        if (row) row.classList.remove('dragging');
    });

    this.songsScroller.setData(entries);
    this.songsLetterMap = this.songsScroller.buildLetterPositionMap();
}
```

- [ ] **Step 3: Update `openAlphaJump` (lines 4949-4986) for virtual scrolling**

Replace the letter availability check (lines 4955-4961):
```javascript
const availableLetters = new Set();
if (this.songsLetterMap) {
    for (const letter of Object.keys(this.songsLetterMap)) {
        availableLetters.add(letter);
    }
} else {
    const letterEls = document.querySelectorAll('[data-letter]');
    letterEls.forEach(el => {
        if (!el.closest('.alpha-jump-overlay')) {
            availableLetters.add(el.dataset.letter);
        }
    });
}
```

Replace the click handler (lines 4969-4974):
```javascript
btn.addEventListener('click', () => {
    this.closeAlphaJump();
    if (this.songsScroller && this.songsLetterMap && this.songsLetterMap[letter] !== undefined) {
        this.songsScroller.scrollToOffset(this.songsLetterMap[letter]);
    } else {
        const target = document.querySelector('[data-letter="' + letter + '"]:not(.alpha-jump-letter)');
        if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }
});
```

- [ ] **Step 4: Add CSS for virtualized song rows**

In `src/assets/css/styles.css`, update `.music-songs-list` to support virtual scrolling:

```css
.music-songs-list {
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    flex: 1;
    position: relative;
}
```

Add VS-specific row styles:

```css
.music-song-row.vs-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 8px;
    cursor: pointer;
}

.music-letter-row.vs-row {
    font-size: 32px;
    font-weight: 200;
    color: var(--zune-text-dim);
    padding: 16px 4px 8px;
    cursor: pointer;
}
```

- [ ] **Step 5: Verify manually**

1. Run `npm start`
2. Navigate to Music > Songs with a large library
3. Verify smooth scrolling, alpha-jump works, click/right-click/drag work
4. Open DevTools > Performance > check DOM node count stays under 200 regardless of library size

- [ ] **Step 6: Commit**

```bash
git add src/assets/js/renderer.js src/assets/css/styles.css
git commit -m "feat: virtualize music songs list for 11,000+ song support"
```

---

## Chunk 2: Virtual Scrolling for Sync Panel

### Task 3: Virtualize the browse list

**Files:**
- Modify: `src/assets/js/renderer.js:834-942` (`_renderBrowseList`)

Replace the browse list's synchronous loop with a VirtualScroller. This list shows device contents with checkboxes, album art, and metadata.

- [ ] **Step 1: Add scroller instance to ZuneSyncPanel**

In the `ZuneSyncPanel` constructor (around line 1-30), add:

```javascript
this.browseScroller = null;  // VirtualScroller for browse list
```

- [ ] **Step 2: Replace `_renderBrowseList` (lines 834-942)**

```javascript
_renderBrowseList() {
    const listEl = document.getElementById('zune-browse-list');
    const actionsEl = document.getElementById('zune-browse-actions');

    if (!this.browseData) {
        if (this.browseScroller) { this.browseScroller.destroy(); this.browseScroller = null; }
        listEl.textContent = '';
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'zune-browse-empty';
        emptyDiv.textContent = 'no data';
        listEl.appendChild(emptyDiv);
        actionsEl.style.display = 'none';
        return;
    }

    const items = this.browseData[this.browseTab] || [];

    if (items.length === 0) {
        if (this.browseScroller) { this.browseScroller.destroy(); this.browseScroller = null; }
        listEl.textContent = '';
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'zune-browse-empty';
        emptyDiv.textContent = 'no ' + this.browseTab + ' on device';
        listEl.appendChild(emptyDiv);
        actionsEl.style.display = 'none';
        return;
    }

    const entries = items.map(item => ({ type: 'browseItem', data: item }));
    const panel = this;

    if (!this.browseScroller) {
        listEl.textContent = '';

        this.browseScroller = new VirtualScroller({
            container: listEl,
            rowTypes: {
                browseItem: { height: 52, className: 'zune-browse-item' },
            },
            renderRow(el, index, entry) {
                const item = entry.data;
                while (el.firstChild) el.removeChild(el.firstChild);
                el.dataset.handle = String(item.handle);

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = 'zune-browse-check';
                checkbox.checked = panel.selectedHandles.has(item.handle);

                const art = panel._getBrowseArt ? panel._getBrowseArt(item) : item.albumArt;
                if (art) {
                    const artImg = document.createElement('img');
                    artImg.className = 'zune-browse-art';
                    artImg.src = art;
                    artImg.alt = '';
                    el.appendChild(artImg);
                }

                const infoDiv = document.createElement('div');
                infoDiv.className = 'zune-browse-info';
                const displayTitle = item.title || item.filename;
                const titleSpan = document.createElement('span');
                titleSpan.className = 'zune-browse-filename';
                titleSpan.title = item.filename;
                titleSpan.textContent = displayTitle;
                infoDiv.appendChild(titleSpan);

                if (item.artist || item.album) {
                    const metaSpan = document.createElement('span');
                    metaSpan.className = 'zune-browse-meta';
                    const parts = [];
                    if (item.artist) parts.push(item.artist);
                    if (item.album) parts.push(item.album);
                    metaSpan.textContent = parts.join(' \u2014 ');
                    infoDiv.appendChild(metaSpan);
                }

                const rightDiv = document.createElement('div');
                rightDiv.className = 'zune-browse-right';
                if (item.duration) {
                    const durSpan = document.createElement('span');
                    durSpan.className = 'zune-browse-duration';
                    const secs = Math.floor(item.duration / 1000);
                    const mins = Math.floor(secs / 60);
                    const remSecs = secs % 60;
                    durSpan.textContent = mins + ':' + String(remSecs).padStart(2, '0');
                    rightDiv.appendChild(durSpan);
                }
                const sizeSpan = document.createElement('span');
                sizeSpan.className = 'zune-browse-size';
                sizeSpan.textContent = panel._formatSize(item.size);
                rightDiv.appendChild(sizeSpan);

                el.appendChild(checkbox);
                el.appendChild(infoDiv);
                el.appendChild(rightDiv);
            },
            overscan: 15,
        });

        // Event delegation for checkbox changes
        listEl.addEventListener('change', (e) => {
            if (!e.target.classList.contains('zune-browse-check')) return;
            const row = e.target.closest('.vs-row');
            if (!row) return;
            const idx = parseInt(row.dataset.index, 10);
            const entry = panel.browseScroller.getEntryAtIndex(idx);
            if (!entry) return;
            const handle = entry.data.handle;
            if (e.target.checked) {
                panel.selectedHandles.add(handle);
            } else {
                panel.selectedHandles.delete(handle);
            }
            panel._updateDeleteButton();
        });
    }

    this.browseScroller.setData(entries, { preserveScroll: true });
    this._updateDeleteButton();
}
```

- [ ] **Step 3: Destroy browseScroller on panel close / disconnect / tab switch**

In `_updateUI` where disconnect is handled, and in tab switch handlers, add:
```javascript
if (this.browseScroller) { this.browseScroller.destroy(); this.browseScroller = null; }
```

- [ ] **Step 4: Verify manually**

1. Connect a Zune device (or use cached data)
2. Open sync panel, browse device contents
3. Verify checkboxes, scroll, and select/deselect work correctly
4. Switch tabs (music/videos/pictures) and verify list updates

- [ ] **Step 5: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat: virtualize sync browse list for large device libraries"
```

---

### Task 4: Virtualize the diff list (flat and grouped)

**Files:**
- Modify: `src/assets/js/renderer.js:1261-1475` (`_renderDiffFlat`, `_renderDiffGrouped`, `_createDiffRow`)

This is the most complex virtualization because grouped mode has variable-height rows (group headers vs track rows) and checkboxes with selection state that must survive recycling.

- [ ] **Step 1: Add scroller instance to ZuneSyncPanel**

In the constructor, add:
```javascript
this.diffScroller = null;  // VirtualScroller for diff list
```

- [ ] **Step 2: Create a helper to build flat entries from grouped data**

Add a new method to ZuneSyncPanel that converts the grouped structure into a flat entry array suitable for the virtualizer:

```javascript
_buildDiffEntries(items, groupBy) {
    if (groupBy === 'all') {
        return items.map(item => ({ type: 'diffTrack', data: item }));
    }

    const groups = new Map();
    for (const item of items) {
        let key, name, artist, albumArt;
        if (this.diffTab === 'matched') {
            const loc = item.local || {};
            const dev = item.device || {};
            if (groupBy === 'album') {
                name = loc.album || dev.album || 'Unknown Album';
                artist = loc.artist || dev.artist || '';
                albumArt = loc.albumArt || dev.albumArt || null;
                key = name.toLowerCase();
            } else {
                name = loc.artist || dev.artist || 'Unknown Artist';
                albumArt = loc.albumArt || dev.albumArt || null;
                key = name.toLowerCase();
                artist = '';
            }
        } else {
            if (groupBy === 'album') {
                name = item.album || 'Unknown Album';
                artist = item.artist || '';
                albumArt = item.albumArt || null;
                key = name.toLowerCase();
            } else {
                name = item.artist || 'Unknown Artist';
                albumArt = item.albumArt || null;
                key = name.toLowerCase();
                artist = '';
            }
        }
        if (!groups.has(key)) {
            groups.set(key, { name, artist, albumArt, tracks: [], key });
        }
        const g = groups.get(key);
        g.tracks.push(item);
        if (!g.albumArt && albumArt) g.albumArt = albumArt;
    }

    const sortedKeys = [...groups.keys()].sort();
    const entries = [];
    for (const key of sortedKeys) {
        const group = groups.get(key);
        entries.push({ type: 'diffHeader', data: group });
        if (!this.collapsedGroups.has(key)) {
            for (const track of group.tracks) {
                entries.push({ type: 'diffTrack', data: track });
            }
        }
    }
    return entries;
}
```

- [ ] **Step 3: Replace `_renderDiffFlat` and `_renderDiffGrouped` with a unified virtualized renderer**

Replace both methods and update the call site. Add a new method `_renderDiffListVirtual`:

```javascript
_renderDiffListVirtual(listEl, items, showCheckboxes, groupBy) {
    const entries = this._buildDiffEntries(items, groupBy);
    const panel = this;

    if (!this.diffScroller) {
        listEl.textContent = '';

        this.diffScroller = new VirtualScroller({
            container: listEl,
            rowTypes: {
                diffHeader: { height: 56, className: 'zune-diff-group-header' },
                diffTrack: { height: 44, className: 'zune-diff-item' },
            },
            renderRow(el, index, entry) {
                while (el.firstChild) el.removeChild(el.firstChild);

                if (entry.type === 'diffHeader') {
                    const group = entry.data;
                    const isCollapsed = panel.collapsedGroups.has(group.key);

                    const arrow = document.createElement('span');
                    arrow.className = 'zune-diff-group-arrow' + (isCollapsed ? ' collapsed' : '');
                    arrow.textContent = '\u25BE';
                    el.appendChild(arrow);

                    if (group.albumArt) {
                        const artImg = document.createElement('img');
                        artImg.className = 'zune-diff-group-art';
                        artImg.src = group.albumArt;
                        artImg.alt = '';
                        el.appendChild(artImg);
                    }

                    const info = document.createElement('div');
                    info.className = 'zune-diff-group-info';
                    const nameEl = document.createElement('div');
                    nameEl.className = 'zune-diff-group-name';
                    nameEl.textContent = group.name;
                    info.appendChild(nameEl);
                    const metaEl = document.createElement('div');
                    metaEl.className = 'zune-diff-group-meta';
                    const metaParts = [];
                    if (group.artist) metaParts.push(group.artist);
                    metaParts.push(group.tracks.length + ' track' + (group.tracks.length !== 1 ? 's' : ''));
                    metaEl.textContent = metaParts.join(' \u2014 ');
                    info.appendChild(metaEl);
                    el.appendChild(info);

                    if (showCheckboxes) {
                        const groupCheck = document.createElement('input');
                        groupCheck.type = 'checkbox';
                        groupCheck.className = 'zune-diff-group-check';
                        panel._updateGroupCheckState(groupCheck, group.tracks);
                        el.appendChild(groupCheck);
                    }
                    el.dataset.groupKey = group.key;

                } else {
                    const item = entry.data;

                    if (showCheckboxes) {
                        const checkbox = document.createElement('input');
                        checkbox.type = 'checkbox';
                        checkbox.className = 'zune-diff-check';
                        if (panel.diffTab === 'local-only') {
                            checkbox.checked = panel.diffSelectedPaths.has(item.path);
                        } else if (panel.diffTab === 'device-only') {
                            checkbox.checked = panel.diffSelectedHandles.has(item.handle);
                        }
                        el.appendChild(checkbox);
                    }

                    const art = panel.diffTab === 'matched'
                        ? ((item.local && item.local.albumArt) || (item.device && item.device.albumArt))
                        : (item.albumArt || null);
                    if (art) {
                        const artImg = document.createElement('img');
                        artImg.className = 'zune-diff-art';
                        artImg.src = art;
                        artImg.alt = '';
                        el.appendChild(artImg);
                    }

                    const infoDiv = document.createElement('div');
                    infoDiv.className = 'zune-diff-info';
                    const titleSpan = document.createElement('span');
                    titleSpan.className = 'zune-diff-title';
                    if (panel.diffTab === 'matched') {
                        titleSpan.textContent = (item.local && item.local.title) || (item.local && item.local.name) || (item.device && item.device.title) || (item.device && item.device.filename) || '?';
                    } else {
                        titleSpan.textContent = item.title || item.name || item.filename || '?';
                    }
                    infoDiv.appendChild(titleSpan);

                    const metaSpan = document.createElement('span');
                    metaSpan.className = 'zune-diff-meta';
                    if (panel.diffCategory === 'music') {
                        if (panel.diffTab === 'matched') {
                            const parts = [];
                            if (item.local && item.local.artist) parts.push(item.local.artist);
                            if (item.local && item.local.album) parts.push(item.local.album);
                            metaSpan.textContent = parts.join(' \u2014 ');
                        } else {
                            const parts = [];
                            if (item.artist) parts.push(item.artist);
                            if (item.album) parts.push(item.album);
                            metaSpan.textContent = parts.join(' \u2014 ');
                        }
                    } else {
                        const size = item.size || (item.device && item.device.size) || (item.local && item.local.size) || 0;
                        if (size > 0) {
                            metaSpan.textContent = panel._formatSize(size);
                        } else {
                            metaSpan.textContent = item.filename || (item.device && item.device.filename) || '';
                        }
                    }
                    if (metaSpan.textContent) infoDiv.appendChild(metaSpan);
                    el.appendChild(infoDiv);
                }
            },
            overscan: 15,
        });

        // Event delegation: checkbox changes
        listEl.addEventListener('change', (e) => {
            const checkbox = e.target;
            if (checkbox.classList.contains('zune-diff-check')) {
                const row = checkbox.closest('.vs-row');
                if (!row) return;
                const idx = parseInt(row.dataset.index, 10);
                const entry = panel.diffScroller.getEntryAtIndex(idx);
                if (!entry || entry.type !== 'diffTrack') return;
                if (panel.diffTab === 'local-only') {
                    if (checkbox.checked) panel.diffSelectedPaths.add(entry.data.path);
                    else panel.diffSelectedPaths.delete(entry.data.path);
                } else if (panel.diffTab === 'device-only') {
                    if (checkbox.checked) panel.diffSelectedHandles.add(entry.data.handle);
                    else panel.diffSelectedHandles.delete(entry.data.handle);
                }
                panel._updateDiffActionButton();
                panel.diffScroller.refresh();
                const allItems = panel.diffTab === 'local-only' ? (panel.diffResult && panel.diffResult.localOnly || []) : (panel.diffResult && panel.diffResult.deviceOnly || []);
                panel._updateSelectAllState(allItems);
            } else if (checkbox.classList.contains('zune-diff-group-check')) {
                const row = checkbox.closest('.vs-row');
                if (!row) return;
                const idx = parseInt(row.dataset.index, 10);
                const entry = panel.diffScroller.getEntryAtIndex(idx);
                if (!entry || entry.type !== 'diffHeader') return;
                panel._toggleGroupSelection(entry.data.tracks, checkbox.checked);
                panel.diffScroller.refresh();
                panel._updateDiffActionButton();
            }
        });

        // Event delegation: header click to collapse/expand
        listEl.addEventListener('click', (e) => {
            if (e.target.closest('input')) return;
            const row = e.target.closest('.zune-diff-group-header.vs-row');
            if (!row) return;
            const idx = parseInt(row.dataset.index, 10);
            const entry = panel.diffScroller.getEntryAtIndex(idx);
            if (!entry || entry.type !== 'diffHeader') return;
            const key = entry.data.key;
            if (panel.collapsedGroups.has(key)) {
                panel.collapsedGroups.delete(key);
            } else {
                panel.collapsedGroups.add(key);
            }
            panel._renderDiffList();
        });
    }

    this.diffScroller.setData(entries, { preserveScroll: true });
}
```

- [ ] **Step 4: Update the `_renderDiffList` call site**

Find where `_renderDiffFlat` / `_renderDiffGrouped` are called and replace with:
```javascript
this._renderDiffListVirtual(listEl, filtered, showCheckboxes, this.diffGroupBy);
```

Keep the old methods as dead code for now.

- [ ] **Step 5: Destroy diffScroller on tab/group/filter changes**

When `diffTab`, `diffGroupBy`, or `diffCategory` changes, destroy the scroller so a fresh one is created. In the handlers for these changes (in `_bindEvents`), add before `_renderDiffList()`:
```javascript
if (this.diffScroller) { this.diffScroller.destroy(); this.diffScroller = null; }
```

- [ ] **Step 6: Verify manually**

1. Connect device, go to diff view
2. Switch between flat/grouped modes
3. Verify checkbox select/deselect works (individual + group headers)
4. Verify collapse/expand of groups
5. Verify filter works
6. Verify select-all checkbox
7. Check DOM count stays low in DevTools

- [ ] **Step 7: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat: virtualize sync diff list with grouped mode support"
```

---

## Chunk 3: Album Art Deduplication

### Task 5: Deduplicate album art in browseContents

**Files:**
- Modify: `src/main/zune/zune-manager.js:761+` (`browseContents`)
- Modify: `src/assets/js/renderer.js` (browseData consumers)
- Modify: `src/main/main.js:429-445` (cache load/save)

- [ ] **Step 1: Modify `browseContents` in zune-manager.js to build albumArtMap**

After the existing code builds the `result.music`, `result.videos`, `result.pictures` arrays, add a deduplication pass before returning:

```javascript
// Deduplicate album art: extract into albumArtMap keyed by artist|album
const albumArtMap = {};
for (const category of ['music', 'videos', 'pictures']) {
    const items = result[category] || [];
    for (const item of items) {
        if (item.albumArt) {
            const artKey = (item.artist || '').toLowerCase() + '|' + (item.album || '').toLowerCase();
            if (!albumArtMap[artKey]) {
                albumArtMap[artKey] = item.albumArt;
            }
            item.albumArtKey = artKey;
            delete item.albumArt;
        }
    }
}
result.albumArtMap = albumArtMap;
```

- [ ] **Step 2: Update renderer to store and use albumArtMap from browseData**

In `ZuneSyncPanel`, where `browseData` is set from the IPC result (in `_startFirstTimeScan` around line 655), store the art map:

```javascript
this.browseAlbumArtMap = result.albumArtMap || {};
```

Add a helper method to ZuneSyncPanel:
```javascript
_getBrowseArt(item) {
    if (item.albumArt) return item.albumArt;  // backwards compat with old cache
    if (item.albumArtKey && this.browseAlbumArtMap) {
        return this.browseAlbumArtMap[item.albumArtKey] || null;
    }
    return null;
}
```

- [ ] **Step 3: Update all browseData art references in renderer**

Replace `item.albumArt` with `this._getBrowseArt(item)` (or `panel._getBrowseArt(item)` in renderRow callbacks) in:
- `_renderBrowseList` (Task 3's virtualized version): where it checks `item.albumArt`
- `_renderDiffListVirtual` (Task 4): where it reads `item.albumArt` for diff track rows
- `_buildDiffEntries`: where group albumArt is gathered
- `_enrichDeviceArt`: where device art is cross-referenced
- `_pullFromDevice`: where metadata.albumArt is read for pull

- [ ] **Step 4: Update cache format**

In `_startFirstTimeScan`, where `zuneCacheSave` is called, ensure the `albumArtMap` is included in the saved data (it should already be part of the result object).

In the cache load path (where `zuneCacheLoad` result is used), add:
```javascript
if (cached.albumArtMap) {
    this.browseAlbumArtMap = cached.albumArtMap;
} else {
    // Old cache format: re-scan device to get deduped format
    this.browseAlbumArtMap = {};
}
```

- [ ] **Step 5: Verify manually**

1. Clear device cache (delete cache file or use fresh device key)
2. Connect device and browse — verify album art displays correctly
3. Disconnect and reconnect — verify cached data loads with art
4. Check IPC payload size in DevTools (should be dramatically smaller)

- [ ] **Step 6: Commit**

```bash
git add src/main/zune/zune-manager.js src/assets/js/renderer.js src/main/main.js
git commit -m "feat: deduplicate album art in device browse data, reducing IPC payload"
```

---

### Task 6: Deduplicate album art in local music library

**Files:**
- Modify: `src/assets/js/renderer.js` (musicLibrary structure, all art consumers)

- [ ] **Step 1: Add albumArtMap to musicLibrary**

In the ZuneExplorer constructor where `musicLibrary` is initialized (around line 1892-1904), add:
```javascript
this.musicLibrary.albumArtMap = {};  // key: 'artist|album' -> base64 art
```

- [ ] **Step 2: Add `getAlbumArt(track)` helper to ZuneExplorer**

```javascript
getAlbumArt(track) {
    if (track.albumArt) return track.albumArt;  // direct art (backwards compat)
    if (track.albumArtKey) {
        return this.musicLibrary.albumArtMap[track.albumArtKey] || null;
    }
    return null;
}
```

- [ ] **Step 3: Extract art during scan progress handling**

In the `onMusicScanProgress` callback (line 3721-3760), when tracks arrive in `data.batch`, extract art into the map before storing the track:

```javascript
for (const result of data.batch) {
    if (result.albumArt) {
        const artKey = (result.artist || '').toLowerCase() + '|' + (result.album || '').toLowerCase();
        if (!lib.albumArtMap[artKey]) {
            lib.albumArtMap[artKey] = result.albumArt;
        }
        result.albumArtKey = artKey;
        delete result.albumArt;
    }
    lib.tracks.set(result.path, result);
}
```

- [ ] **Step 4: Update all consumers of `track.albumArt`**

Replace `track.albumArt` / `album.albumArt` with `this.getAlbumArt(track)` in:

1. `renderMusicAlbumsView` — album tile background image
2. `renderMusicArtistsView` — artist row art
3. `_enrichDeviceArt` — cross-reference local art for device tracks
4. `createPinnedElement` — pin tile art
5. `_enrichTrackData` / `_enrichPlaylistTracks` — playlist enrichment
6. `showMusicItemContextMenu` — if it reads art
7. Now-playing display — current track art
8. `applyCachedMetadata` — where MusicBrainz cached art is applied to tracks

For each consumer, the change pattern is:
```javascript
// Before:
const art = track.albumArt;
// After:
const art = this.getAlbumArt(track);
```

- [ ] **Step 5: Verify manually**

1. Run `npm start`, navigate to Music > Albums — verify album art displays
2. Navigate to Artists — verify art displays
3. Check pinned items — verify art
4. Play a song — verify now-playing art
5. Check memory in DevTools — should be notably lower for large libraries

- [ ] **Step 6: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat: deduplicate album art in local music library"
```

---

## Chunk 4: Transfer Stability

### Task 7: Add batching and per-file retry to push (sendFiles)

**Files:**
- Modify: `src/main/zune/zune-manager.js:254-431` (`sendFiles`)

- [ ] **Step 1: Restructure sendFiles with per-file try-catch and retry**

Replace the inner loop (lines 275-398) and outer try-catch (lines 274-430) with the batched version. Key changes:
1. Each file gets its own try-catch with up to 3 attempts
2. Files processed in batches of 8 with yields between batches
3. On sendObject failure, attempt to clean up orphaned handle before retry
4. albumMap accumulation unchanged — stays in scope across all batches
5. Transfer result includes succeeded/failed lists

Replace the `try` block (lines 274-430):

```javascript
try {
    const BATCH_SIZE = 8;
    const MAX_RETRIES = 3;
    const succeeded = [];
    const failed = [];

    for (let batchStart = 0; batchStart < filePaths.length; batchStart += BATCH_SIZE) {
        if (this.cancelRequested) {
            this.emit('transfer-progress', { state: 'cancelled', completedFiles, totalFiles });
            break;
        }

        const batchEnd = Math.min(batchStart + BATCH_SIZE, filePaths.length);

        for (let fi = batchStart; fi < batchEnd; fi++) {
            if (this.cancelRequested) break;
            const filePath = filePaths[fi];
            let lastError = null;
            let fileSuccess = false;

            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    const ext = path.extname(filePath).toLowerCase();
                    let sendPath = filePath;
                    let needsConvert = CONVERTIBLE_AUDIO.has(ext);

                    const metadata = await this._readMetadata(filePath);

                    if (this.metadataCache && metadata.artist && metadata.album) {
                        const cached = await this.metadataCache.get(metadata.artist, metadata.album);
                        if (cached) {
                            if (cached.genre && !metadata.genre) metadata.genre = cached.genre;
                            if (cached.year && !metadata.year) metadata.year = String(cached.year);
                            if (cached.albumArt && !metadata.albumArt) {
                                const base64Match = cached.albumArt.match(/^data:([^;]+);base64,(.+)$/);
                                if (base64Match) {
                                    metadata.albumArt = {
                                        data: Buffer.from(base64Match[2], 'base64'),
                                        format: base64Match[1],
                                    };
                                }
                            }
                        }
                    }

                    if (needsConvert) {
                        this.emit('transfer-progress', {
                            state: 'converting', fileName: path.basename(filePath),
                            fileIndex: completedFiles, totalFiles,
                        });
                        sendPath = await this._convertForZune(filePath);
                        tempFiles.push(sendPath);
                    } else if (ext === '.mp3') {
                        try {
                            sendPath = await this._retagToId3v23(filePath);
                            tempFiles.push(sendPath);
                        } catch (err) {
                            console.log('ZuneManager: retag failed, sending original: ' + err.message);
                        }
                    }

                    const sendExt = path.extname(sendPath).toLowerCase();
                    const objectFormat = ExtensionToFormat[sendExt] || ObjectFormat.Undefined;
                    const sendName = path.basename(filePath, ext) + (needsConvert ? '.mp3' : path.extname(filePath));
                    const fileData = await fs.readFile(sendPath);
                    const totalBytes = fileData.length;

                    this.emit('transfer-progress', {
                        state: 'sending', fileName: sendName,
                        fileIndex: completedFiles, totalFiles,
                        bytesTransferred: 0, totalBytes,
                    });

                    const { objectHandle } = await this.mtp.sendObjectInfo(this.storageId, 0, {
                        objectFormat, compressedSize: totalBytes, filename: sendName,
                    });

                    try {
                        await this.mtp.sendObject(fileData, (sent, total) => {
                            this.emit('transfer-progress', {
                                state: 'sending', fileName: sendName,
                                fileIndex: completedFiles, totalFiles,
                                bytesTransferred: sent, totalBytes: total,
                            });
                        });
                    } catch (sendErr) {
                        // Data-phase failure: clean up orphaned handle
                        if (objectHandle) {
                            try { await this.mtp.deleteObject(objectHandle); } catch (_) {}
                        }
                        throw sendErr;
                    }

                    if (objectHandle) {
                        await this._setObjectMetadata(objectHandle, metadata);
                        const isAudio = ZUNE_NATIVE_AUDIO.has(ext) || CONVERTIBLE_AUDIO.has(ext);
                        if (isAudio && metadata.album) {
                            const artist = metadata.artist || 'Unknown Artist';
                            const key = artist + '|||' + metadata.album;
                            if (!albumMap.has(key)) {
                                albumMap.set(key, {
                                    artist, albumArtist: metadata.albumArtist || artist,
                                    album: metadata.album, genre: metadata.genre || null,
                                    albumArt: metadata.albumArt || null, trackHandles: [],
                                });
                            }
                            const entry = albumMap.get(key);
                            entry.trackHandles.push(objectHandle);
                            if (!entry.albumArt && metadata.albumArt) entry.albumArt = metadata.albumArt;
                        }
                    }

                    fileSuccess = true;
                    succeeded.push(filePath);
                    break; // success, no more retries

                } catch (err) {
                    lastError = err;
                    console.log('ZuneManager: file ' + path.basename(filePath) + ' attempt ' + attempt + '/' + MAX_RETRIES + ' failed: ' + err.message);
                    if (attempt < MAX_RETRIES) {
                        await new Promise(r => setTimeout(r, 500));
                    }
                }
            }

            if (!fileSuccess) {
                console.log('ZuneManager: file ' + path.basename(filePath) + ' failed after ' + MAX_RETRIES + ' attempts');
                failed.push({ file: filePath, error: lastError ? lastError.message : 'Unknown error' });
            }

            completedFiles++;
        }

        // Yield between batches to let GC run
        await new Promise(r => setTimeout(r, 0));
    }

    if (albumMap.size > 0 && this.connected && !this.cancelRequested) {
        await this._createAlbumObjects(albumMap);
    }

    if (this.connected) {
        this.storageInfo = await this.mtp.getStorageInfo(this.storageId);
    }

    if (!this.cancelRequested) {
        this.emit('transfer-progress', {
            state: 'complete',
            completedFiles, totalFiles,
            succeeded: succeeded.length,
            failed,
            storage: this.storageInfo,
        });
    }
} catch (err) {
    // Catastrophic failure (device disconnect, etc.)
    this.emit('transfer-progress', {
        state: 'error',
        error: err.message,
        completedFiles, totalFiles,
    });
}
```

- [ ] **Step 2: Update progress UI in renderer to show transfer summary**

In `ZuneSyncPanel._updateProgress`, handle the updated `complete` state with `failed` array:

```javascript
if (progress.state === 'complete') {
    if (progress.failed && progress.failed.length > 0) {
        statusEl.textContent = 'transferred ' + progress.succeeded + ' of ' + progress.totalFiles + ' \u2014 ' + progress.failed.length + ' failed';
        statusEl.style.color = 'var(--zune-orange)';
        this._lastTransferFailed = progress.failed;
    } else {
        statusEl.textContent = progress.completedFiles + ' files transferred';
        this._lastTransferFailed = null;
    }
}
```

- [ ] **Step 3: Verify manually**

1. Push a batch of files to the device
2. Verify progress updates per-file ("Transferring X of Y")
3. Intentionally include an unsupported file format to test skip behavior
4. Verify transfer completes and shows summary

- [ ] **Step 4: Commit**

```bash
git add src/main/zune/zune-manager.js src/assets/js/renderer.js
git commit -m "feat: batched push transfers with per-file retry and error summary"
```

---

### Task 8: Add batching and retry to pull (_pullFromDevice)

**Files:**
- Modify: `src/assets/js/renderer.js:1697-1766` (`_pullFromDevice`)

- [ ] **Step 1: Replace `_pullFromDevice` with batched version**

```javascript
async _pullFromDevice() {
    if (this.diffSelectedHandles.size === 0) return;

    const destResult = await window.electronAPI.pickPullDestination();
    if (!destResult.success) return;

    const handles = Array.from(this.diffSelectedHandles);
    this.diffSelectedHandles.clear();
    const destDir = destResult.path;

    const pullBtn = document.getElementById('zune-pull-btn');
    pullBtn.disabled = true;

    const BATCH_SIZE = 8;
    const MAX_RETRIES = 3;
    let pulled = 0;
    let failedCount = 0;
    const pulledFiles = [];
    const failedFiles = [];
    const category = this.diffCategory;
    const deviceItems = (this.browseData && this.browseData[category]) || [];

    for (let batchStart = 0; batchStart < handles.length; batchStart += BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE, handles.length);

        for (let hi = batchStart; hi < batchEnd; hi++) {
            const handle = handles[hi];
            const deviceItem = deviceItems.find(i => i.handle === handle);
            if (!deviceItem) continue;

            const filename = deviceItem.filename || ('file_' + handle);
            const metadata = category === 'music' ? {
                title: deviceItem.title || null,
                artist: deviceItem.artist || null,
                album: deviceItem.album || null,
                genre: deviceItem.genre || null,
                trackNumber: deviceItem.trackNumber || null,
                albumArt: this._getBrowseArt ? this._getBrowseArt(deviceItem) : (deviceItem.albumArt || null),
            } : {};

            let fileSuccess = false;
            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                    const result = await window.electronAPI.zunePullFile(handle, filename, destDir, metadata);
                    if (result.success) {
                        pulled++;
                        pulledFiles.push({ path: result.path, size: result.size || 0 });
                        fileSuccess = true;
                        break;
                    } else {
                        throw new Error(result.error || 'Pull failed');
                    }
                } catch (err) {
                    console.log('Pull ' + filename + ' attempt ' + attempt + '/' + MAX_RETRIES + ' failed: ' + err.message);
                    if (attempt < MAX_RETRIES) {
                        await new Promise(r => setTimeout(r, 500));
                    }
                }
            }

            if (!fileSuccess) {
                failedCount++;
                failedFiles.push(filename);
            }

            pullBtn.textContent = 'copying ' + (pulled + failedCount) + ' of ' + handles.length + '...';
        }

        // Yield between batches
        await new Promise(r => setTimeout(r, 0));
    }

    if (failedCount > 0) {
        pullBtn.textContent = pulled + ' copied, ' + failedCount + ' failed';
        if (typeof showToast === 'function') {
            showToast(failedCount + ' file(s) failed to copy: ' + failedFiles.slice(0, 3).join(', ') + (failedCount > 3 ? '...' : ''));
        }
    } else {
        pullBtn.textContent = pulled + ' files copied';
    }
    pullBtn.disabled = false;

    if (pulledFiles.length > 0) {
        for (const pf of pulledFiles) {
            const ext = pf.path.split('.').pop().toLowerCase();
            this.explorer.categorizedFiles[category].push({
                path: pf.path,
                name: pf.path.split(/[/\\]/).pop(),
                extension: '.' + ext,
                size: pf.size,
                modified: new Date(),
                isDirectory: false,
            });
        }
        if (category === 'music') {
            const paths = pulledFiles.map(pf => pf.path);
            await window.electronAPI.batchScanAudioMetadata(paths, { includeArt: true });
        }
    }

    this._computeDiff();
    this._renderDiffSummary();
    this._renderDiffList();
}
```

- [ ] **Step 2: Verify manually**

1. Select multiple files on device, pull to local
2. Verify progress updates ("copying X of Y")
3. Verify summary shown at end
4. Verify pulled files appear in local library

- [ ] **Step 3: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat: batched pull transfers with per-file retry"
```

---

## Chunk 5: Event Listener Cleanup

### Task 9: Add `off*` wrappers to preload bridge

**Files:**
- Modify: `src/main/preload.js`

- [ ] **Step 1: Rewrite `on*` to return handler refs, add `off*` wrappers**

Replace the four `on*` entries (lines 17, 46-48) with versions that return handler references, and add corresponding `off*` entries:

```javascript
onMusicScanProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('music-scan-progress', handler);
    return handler;
},
offMusicScanProgress: (handler) => ipcRenderer.removeListener('music-scan-progress', handler),

// ... (in the Zune sync section)
onZuneStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('zune-status', handler);
    return handler;
},
offZuneStatus: (handler) => ipcRenderer.removeListener('zune-status', handler),

onZuneTransferProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on('zune-transfer-progress', handler);
    return handler;
},
offZuneTransferProgress: (handler) => ipcRenderer.removeListener('zune-transfer-progress', handler),

onZuneBrowseProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('zune-browse-progress', handler);
    return handler;
},
offZuneBrowseProgress: (handler) => ipcRenderer.removeListener('zune-browse-progress', handler),
```

- [ ] **Step 2: Commit**

```bash
git add src/main/preload.js
git commit -m "feat: add IPC listener removal wrappers to preload bridge"
```

---

### Task 10: Use named references and cleanup in renderer

**Files:**
- Modify: `src/assets/js/renderer.js` (ZuneSyncPanel._listenForZune, ZuneExplorer.scanMusicLibrary)

- [ ] **Step 1: Store handler references in ZuneSyncPanel._listenForZune (lines 279-297)**

```javascript
_listenForZune() {
    this._zuneStatusHandler = window.electronAPI.onZuneStatus((status) => {
        this.state = status.state;
        this.lastStatus = status;
        this._updateUI(status);
    });
    this._transferProgressHandler = window.electronAPI.onZuneTransferProgress((progress) => {
        this._updateProgress(progress);
    });

    window.electronAPI.zuneGetStatus().then((status) => {
        if (status) {
            this.state = status.state;
            this.lastStatus = status;
            this._updateUI(status);
        }
    });
}
```

- [ ] **Step 2: Store handler reference for browse progress**

In `_startFirstTimeScan` or `_openBrowse` (around line 602), where `onZuneBrowseProgress` is registered:

```javascript
if (this._browseProgressHandler) {
    window.electronAPI.offZuneBrowseProgress(this._browseProgressHandler);
}
this._browseProgressHandler = window.electronAPI.onZuneBrowseProgress((data) => {
    // ... existing handler body ...
});
```

- [ ] **Step 3: Add `_cleanup()` method to ZuneSyncPanel**

```javascript
_cleanup() {
    if (this._zuneStatusHandler) {
        window.electronAPI.offZuneStatus(this._zuneStatusHandler);
        this._zuneStatusHandler = null;
    }
    if (this._transferProgressHandler) {
        window.electronAPI.offZuneTransferProgress(this._transferProgressHandler);
        this._transferProgressHandler = null;
    }
    if (this._browseProgressHandler) {
        window.electronAPI.offZuneBrowseProgress(this._browseProgressHandler);
        this._browseProgressHandler = null;
    }
    if (this.deleteConfirmTimer) { clearTimeout(this.deleteConfirmTimer); this.deleteConfirmTimer = null; }
    if (this.diffDeleteConfirmTimer) { clearTimeout(this.diffDeleteConfirmTimer); this.diffDeleteConfirmTimer = null; }
    if (this._diffFilterTimer) { clearTimeout(this._diffFilterTimer); this._diffFilterTimer = null; }
    if (this.browseScroller) { this.browseScroller.destroy(); this.browseScroller = null; }
    if (this.diffScroller) { this.diffScroller.destroy(); this.diffScroller = null; }
}
```

Call `_cleanup()` on device disconnect (in `_updateUI` when state becomes `'disconnected'`) and on panel close.

- [ ] **Step 4: Fix music scan listener leak in ZuneExplorer**

In `scanMusicLibrary` (line 3721), store the handler and remove previous:

```javascript
if (this._musicScanHandler) {
    window.electronAPI.offMusicScanProgress(this._musicScanHandler);
}
this._musicScanHandler = window.electronAPI.onMusicScanProgress((data) => {
    // ... existing handler body (lines 3722-3759) ...
});
```

- [ ] **Step 5: Verify manually**

1. Connect/disconnect device several times
2. Open/close sync panel multiple times
3. Run music scan multiple times
4. In DevTools console, check listener counts stay constant

- [ ] **Step 6: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "fix: clean up IPC listeners and timers to prevent memory leaks"
```

---

### Task 11: Ensure temp file cleanup on all error paths

**Files:**
- Modify: `src/main/main.js:621-715` (`zune-pull-file` handler)

- [ ] **Step 1: Wrap pull handler in proper finally block**

Review the `zune-pull-file` handler in main.js. Ensure all temp file creation points are tracked in a `tempFiles` array and cleaned in a `finally` block:

```javascript
ipcMain.handle('zune-pull-file', async (event, handle, filename, destDir, metadata) => {
    const tempFiles = [];
    try {
        // ... existing logic ...
        // When creating temp files, push to tempFiles array:
        // tempFiles.push(tempPath);
        // ...
        return { success: true, path: finalPath, size };
    } catch (err) {
        return { success: false, error: err.message };
    } finally {
        for (const tmp of tempFiles) {
            try { await fs.unlink(tmp); } catch (_) {}
        }
    }
});
```

Review the handler carefully and identify all points where temp files are created (ffmpeg conversion output, writeFile intermediaries). Ensure each is pushed to `tempFiles`.

- [ ] **Step 2: Commit**

```bash
git add src/main/main.js
git commit -m "fix: ensure temp file cleanup on all pull error paths"
```

---

## Implementation Order

Tasks are ordered by dependency:
1. **Task 1** (VirtualScroller class) — foundation, no dependencies
2. **Task 2** (Songs list) — depends on Task 1
3. **Task 3** (Browse list) — depends on Task 1
4. **Task 4** (Diff list) — depends on Task 1
5. **Task 5** (Browse art dedup) — independent of virtual scrolling, but Tasks 3-4 reference art helper
6. **Task 6** (Local art dedup) — depends on art helper pattern from Task 5
7. **Task 7** (Push batching) — independent
8. **Task 8** (Pull batching) — independent, uses art helper from Task 5 if available
9. **Task 9** (Preload off* wrappers) — independent, must come before Task 10
10. **Task 10** (Renderer listener cleanup) — depends on Task 9
11. **Task 11** (Temp file cleanup) — independent

**Parallelizable groups (for subagent-driven development):**
- Lane A: Tasks 1 -> 2 -> 3 -> 4
- Lane B: Tasks 5 -> 6
- Lane C: Tasks 7 -> 8
- Lane D: Tasks 9 -> 10 -> 11
