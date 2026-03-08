# Sync Diff: Multi-Category Support & Delete Button — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expand the sync diff view to support music, videos, and pictures with Zune HD category tabs, and add a "delete from device" button.

**Architecture:** Add a `diffCategory` state variable that scopes the entire diff view. Category tabs sit above the diff summary using Zune HD sub-tab styling. `_computeDiff()` becomes category-aware — music uses metadata matching, videos/pictures use filename matching. The delete button reuses the existing `zuneDeleteObjects` IPC. No backend changes needed.

**Tech Stack:** Electron renderer (vanilla JS/CSS/HTML)

---

### Task 1: Add Category Tabs to HTML

**Files:**
- Modify: `src/renderer/index.html:298-328`

**Step 1: Add category tab bar above diff summary**

Insert a new `zune-diff-category-tabs` div as the first child of `#zune-diff-view`, before the diff summary:

```html
<div class="zune-diff-category-tabs" id="zune-diff-category-tabs">
    <button class="zune-diff-category-tab active" data-category="music">MUSIC</button>
    <button class="zune-diff-category-tab" data-category="videos">VIDEOS</button>
    <button class="zune-diff-category-tab" data-category="pictures">PHOTOS</button>
</div>
```

**Step 2: Add delete button to diff actions**

In the `.zune-diff-actions` div (line 324-327), add the delete button after the pull button:

```html
<button class="zune-sync-btn zune-diff-delete-btn" id="zune-diff-delete-btn">delete from device</button>
```

**Step 3: Commit**

```bash
git add src/renderer/index.html
git commit -m "feat(sync): add category tabs and delete button HTML to diff view"
```

---

### Task 2: Style Category Tabs and Delete Button

**Files:**
- Modify: `src/assets/css/styles.css`

**Step 1: Add category tab styles**

Add after the existing `.zune-diff-stat-pull` block (line 1964), before `.zune-diff-tabs`:

```css
.zune-diff-category-tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    margin-bottom: 12px;
    flex-shrink: 0;
}

.zune-diff-category-tab {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: rgba(255, 255, 255, 0.25);
    font-size: 14px;
    font-weight: 600;
    font-family: inherit;
    letter-spacing: 3px;
    padding: 12px 24px;
    cursor: pointer;
    transition: color 0.2s, border-color 0.2s;
    text-transform: uppercase;
}

.zune-diff-category-tab:hover {
    color: rgba(255, 255, 255, 0.5);
}

.zune-diff-category-tab.active {
    color: var(--zune-text);
    border-bottom-color: var(--zune-orange);
}
```

This mirrors the `.music-sub-tab` pattern (styles.css:2427-2449).

**Step 2: Add diff delete button styles**

Add after the `.zune-pull-btn:hover:not(:disabled)` block (line 2116):

```css
.zune-diff-delete-btn {
    color: #ff3333 !important;
}

.zune-diff-delete-btn:hover:not(:disabled) {
    color: #ff5555 !important;
}

.zune-diff-delete-btn.confirm {
    color: #ff3333 !important;
    background: rgba(255, 51, 51, 0.1);
}
```

**Step 3: Commit**

```bash
git add src/assets/css/styles.css
git commit -m "feat(sync): style category tabs and delete button for diff view"
```

---

### Task 3: Wire Category Tabs and Add diffCategory State

**Files:**
- Modify: `src/assets/js/renderer.js:1-30` (constructor)
- Modify: `src/assets/js/renderer.js:148-235` (event listeners)

**Step 1: Add diffCategory state to constructor**

In the constructor (after line 17, the `this.diffGroupBy = 'all'` line), add:

```javascript
this.diffCategory = 'music';              // 'music' | 'videos' | 'pictures'
```

Also add a confirm timer for the diff delete:

```javascript
this.diffDeleteConfirmTimer = null;
```

**Step 2: Add category tab click handler**

After the existing diff tab handlers (after line 171), add:

```javascript
// Diff category tabs
document.querySelectorAll('.zune-diff-category-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        this.diffCategory = tab.dataset.category;
        document.querySelectorAll('.zune-diff-category-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.diffTab = 'local-only';
        document.querySelectorAll('.zune-diff-tab').forEach(t => t.classList.remove('active'));
        document.querySelector('.zune-diff-tab[data-diff="local-only"]').classList.add('active');
        this.diffSelectedPaths.clear();
        this.diffSelectedHandles.clear();
        this.diffGroupBy = 'all';
        document.querySelectorAll('.zune-diff-group-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('.zune-diff-group-btn[data-group="all"]').classList.add('active');
        this.collapsedGroups.clear();
        this.diffFilterQuery = '';
        document.getElementById('zune-diff-filter-input').value = '';
        document.getElementById('zune-diff-filter-clear').style.display = 'none';
        this._computeDiff();
        this._renderDiffSummary();
        this._renderDiffList();
    });
});
```

**Step 3: Add delete button click handler**

After the pull button handler (after line 230), add:

```javascript
// Delete from device (diff view)
document.getElementById('zune-diff-delete-btn').addEventListener('click', () => {
    this._deleteFromDevice();
});
```

**Step 4: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat(sync): wire category tabs and delete button handlers"
```

---

### Task 4: Make _computeDiff() Category-Aware

**Files:**
- Modify: `src/assets/js/renderer.js:987-1073` (`_computeDiff` method)

**Step 1: Replace _computeDiff() with category-aware version**

Replace the entire `_computeDiff()` method (lines 987-1073) with:

```javascript
_computeDiff() {
    if (this.diffCategory === 'music') {
        this._computeMusicDiff();
    } else {
        this._computeMediaDiff(this.diffCategory);
    }
}

_computeMusicDiff() {
    const localTracks = this.explorer.musicLibrary.tracks; // Map: path -> trackInfo
    const deviceTracks = (this.browseData && this.browseData.music) || [];

    const matched = [];
    const localOnly = [];
    const deviceOnly = [];

    // Build lookup maps
    const localByFilename = new Map();
    for (const [filePath, track] of localTracks) {
        const basename = filePath.split(/[/\\]/).pop().toLowerCase();
        localByFilename.set(basename, { ...track, path: filePath });
    }

    const deviceByFilename = new Map();
    for (const item of deviceTracks) {
        const fn = (item.filename || '').toLowerCase();
        deviceByFilename.set(fn, item);
    }

    // Pass 1: Filename match
    const matchedLocalPaths = new Set();
    const matchedDeviceFilenames = new Set();

    for (const [fn, localTrack] of localByFilename) {
        if (deviceByFilename.has(fn)) {
            matched.push({ local: localTrack, device: deviceByFilename.get(fn) });
            matchedLocalPaths.add(localTrack.path);
            matchedDeviceFilenames.add(fn);
        }
    }

    // Pass 2: Title+Artist match (unmatched only)
    const unmatchedLocal = [];
    for (const [filePath, track] of localTracks) {
        if (!matchedLocalPaths.has(filePath)) {
            unmatchedLocal.push({ ...track, path: filePath });
        }
    }

    const unmatchedDevice = [];
    for (const item of deviceTracks) {
        const fn = (item.filename || '').toLowerCase();
        if (!matchedDeviceFilenames.has(fn)) {
            unmatchedDevice.push(item);
        }
    }

    const localByMeta = new Map();
    for (const track of unmatchedLocal) {
        const key = `${(track.title || '').toLowerCase()}|||${(track.artist || '').toLowerCase()}`;
        if (key !== '|||') localByMeta.set(key, track);
    }

    const deviceByMeta = new Map();
    for (const item of unmatchedDevice) {
        const key = `${(item.title || '').toLowerCase()}|||${(item.artist || '').toLowerCase()}`;
        if (key !== '|||') deviceByMeta.set(key, item);
    }

    const metaMatchedLocalPaths = new Set();
    const metaMatchedDeviceHandles = new Set();

    for (const [key, localTrack] of localByMeta) {
        if (deviceByMeta.has(key)) {
            matched.push({ local: localTrack, device: deviceByMeta.get(key) });
            metaMatchedLocalPaths.add(localTrack.path);
            metaMatchedDeviceHandles.add(deviceByMeta.get(key).handle);
        }
    }

    // Collect remaining unmatched
    for (const track of unmatchedLocal) {
        if (!metaMatchedLocalPaths.has(track.path)) {
            localOnly.push(track);
        }
    }

    for (const item of unmatchedDevice) {
        if (!metaMatchedDeviceHandles.has(item.handle)) {
            deviceOnly.push(item);
        }
    }

    this.diffResult = { matched, localOnly, deviceOnly };
}

_computeMediaDiff(category) {
    // Map category to the local categorizedFiles key
    const localFiles = this.explorer.categorizedFiles[category] || [];
    const deviceFiles = (this.browseData && this.browseData[category]) || [];

    const matched = [];
    const localOnly = [];
    const deviceOnly = [];

    // Filename-only matching for videos/pictures
    const localByFilename = new Map();
    for (const file of localFiles) {
        const basename = (file.name || file.path.split(/[/\\]/).pop()).toLowerCase();
        localByFilename.set(basename, file);
    }

    const matchedDeviceFilenames = new Set();

    for (const item of deviceFiles) {
        const fn = (item.filename || '').toLowerCase();
        if (localByFilename.has(fn)) {
            matched.push({ local: localByFilename.get(fn), device: item });
            matchedDeviceFilenames.add(fn);
            localByFilename.delete(fn);
        }
    }

    // Remaining local files are local-only
    for (const [, file] of localByFilename) {
        localOnly.push(file);
    }

    // Remaining device files are device-only
    for (const item of deviceFiles) {
        const fn = (item.filename || '').toLowerCase();
        if (!matchedDeviceFilenames.has(fn)) {
            deviceOnly.push(item);
        }
    }

    this.diffResult = { matched, localOnly, deviceOnly };
}
```

**Step 2: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat(sync): category-aware diff computation for music, videos, pictures"
```

---

### Task 5: Update _renderDiffList() for Multi-Category

**Files:**
- Modify: `src/assets/js/renderer.js:1086-1162` (`_renderDiffList`)
- Modify: `src/assets/js/renderer.js:1290-1369` (`_createDiffRow`)
- Modify: `src/assets/js/renderer.js:1504-1519` (`_updateDiffActionButton`)

**Step 1: Update _renderDiffList() to show/hide group bar and delete button**

In `_renderDiffList()`, after the line that gets `pullBtn` (line 1090), add:

```javascript
const deleteBtn = document.getElementById('zune-diff-delete-btn');
```

In the `device-only` branch (lines 1113-1118), show the delete button alongside pull:

```javascript
} else if (this.diffTab === 'device-only') {
    items = this.diffResult.deviceOnly;
    showCheckboxes = true;
    pushBtn.style.display = 'none';
    pullBtn.style.display = 'block';
    deleteBtn.style.display = 'block';
    actionsEl.style.display = items.length > 0 ? 'flex' : 'none';
}
```

In the `local-only` branch, hide the delete button:

```javascript
if (this.diffTab === 'local-only') {
    items = this.diffResult.localOnly;
    showCheckboxes = true;
    pushBtn.style.display = 'block';
    pullBtn.style.display = 'none';
    deleteBtn.style.display = 'none';
    actionsEl.style.display = items.length > 0 ? 'flex' : 'none';
}
```

In the `matched` branch, also hide:

```javascript
} else {
    items = this.diffResult.matched;
    showCheckboxes = false;
    deleteBtn.style.display = 'none';
    actionsEl.style.display = 'none';
}
```

For the group bar visibility, change line 1133 to hide for non-music categories:

```javascript
groupBar.style.display = (showCheckboxes && this.diffCategory === 'music') ? 'flex' : 'none';
```

Update the empty-state messages to be category-aware. Replace the hardcoded "music" references (lines 1141-1146):

```javascript
if (this.diffFilterQuery) {
    emptyDiv.textContent = 'no matches';
} else if (this.diffTab === 'local-only') {
    emptyDiv.textContent = `all local ${this.diffCategory} on the device`;
} else if (this.diffTab === 'device-only') {
    emptyDiv.textContent = `all device ${this.diffCategory} on the computer`;
} else {
    emptyDiv.textContent = 'no matched files';
}
```

For the groupBy logic, force 'all' for non-music:

```javascript
const groupBy = (showCheckboxes && this.diffCategory === 'music') ? (this.diffGroupBy || 'all') : 'all';
```

**Step 2: Update _createDiffRow() for videos/pictures**

In `_createDiffRow()`, update the info section (lines 1340-1365) to handle non-music items. Replace the title and meta logic:

```javascript
const titleSpan = document.createElement('span');
titleSpan.className = 'zune-diff-title';
if (this.diffTab === 'matched') {
    titleSpan.textContent = item.local?.title || item.local?.name || item.device?.title || item.device?.filename || '?';
} else {
    titleSpan.textContent = item.title || item.name || item.filename || '?';
}
infoDiv.appendChild(titleSpan);

const metaSpan = document.createElement('span');
metaSpan.className = 'zune-diff-meta';
if (this.diffCategory === 'music') {
    if (this.diffTab === 'matched') {
        const parts = [];
        if (item.local?.artist) parts.push(item.local.artist);
        if (item.local?.album) parts.push(item.local.album);
        metaSpan.textContent = parts.join(' \u2014 ');
    } else {
        const parts = [];
        if (item.artist) parts.push(item.artist);
        if (item.album) parts.push(item.album);
        metaSpan.textContent = parts.join(' \u2014 ');
    }
} else {
    // Videos/pictures: show filename and size
    const size = item.size || item.device?.size || item.local?.size || 0;
    if (size > 0) {
        metaSpan.textContent = this._formatSize(size);
    } else {
        const name = item.filename || item.device?.filename || '';
        metaSpan.textContent = name;
    }
}
if (metaSpan.textContent) infoDiv.appendChild(metaSpan);
```

**Step 3: Update _updateDiffActionButton() to include delete button**

Replace `_updateDiffActionButton()` (lines 1504-1519):

```javascript
_updateDiffActionButton() {
    const pushBtn = document.getElementById('zune-push-btn');
    const pullBtn = document.getElementById('zune-pull-btn');
    const deleteBtn = document.getElementById('zune-diff-delete-btn');
    const noun = this.diffCategory === 'music' ? 'tracks' : 'files';

    if (this.diffTab === 'local-only') {
        pushBtn.textContent = this.diffSelectedPaths.size > 0
            ? `sync ${this.diffSelectedPaths.size} to device`
            : `select ${noun} to sync`;
        pushBtn.disabled = this.diffSelectedPaths.size === 0;
    } else if (this.diffTab === 'device-only') {
        pullBtn.textContent = this.diffSelectedHandles.size > 0
            ? `copy ${this.diffSelectedHandles.size} to computer`
            : `select ${noun} to copy`;
        pullBtn.disabled = this.diffSelectedHandles.size === 0;
        deleteBtn.textContent = this.diffSelectedHandles.size > 0
            ? `delete ${this.diffSelectedHandles.size} from device`
            : `select ${noun} to delete`;
        deleteBtn.disabled = this.diffSelectedHandles.size === 0;
        // Reset confirm state when selection changes
        deleteBtn.classList.remove('confirm');
        if (this.diffDeleteConfirmTimer) {
            clearTimeout(this.diffDeleteConfirmTimer);
            this.diffDeleteConfirmTimer = null;
        }
    }
}
```

**Step 4: Update _updateSelectAllState() label for non-music**

In `_updateSelectAllState()` (lines 1480-1502), update the label text:

```javascript
const noun = this.diffCategory === 'music' ? 'track' : 'file';
const count = items.length;
if (allSelected) {
    label.textContent = `deselect all (${count} ${noun}${count !== 1 ? 's' : ''})`;
} else {
    label.textContent = `select all (${count} ${noun}${count !== 1 ? 's' : ''})`;
}
```

Also update the empty state (line 1487):

```javascript
const noun = this.diffCategory === 'music' ? 'tracks' : 'files';
label.textContent = `select all (0 ${noun})`;
```

**Step 5: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat(sync): update diff rendering for multi-category and delete button"
```

---

### Task 6: Update _openDiffView() and _renderDiffSummary()

**Files:**
- Modify: `src/assets/js/renderer.js:660-698` (`_openDiffView`)
- Modify: `src/assets/js/renderer.js:1075-1084` (`_renderDiffSummary`)

**Step 1: Reset category tabs in _openDiffView()**

In `_openDiffView()`, after the group-by reset (line 675), add:

```javascript
// Reset category tab state
this.diffCategory = 'music';
document.querySelectorAll('.zune-diff-category-tab').forEach(t => t.classList.remove('active'));
document.querySelector('.zune-diff-category-tab[data-category="music"]').classList.add('active');
```

**Step 2: Update _renderDiffSummary() to be category-aware**

Replace `_renderDiffSummary()` (lines 1075-1084):

```javascript
_renderDiffSummary() {
    if (!this.diffResult) return;

    const noun = this.diffCategory === 'music' ? '' : ' files';
    document.getElementById('zune-diff-matched').textContent =
        this.diffResult.matched.length + ' matched' + noun;
    document.getElementById('zune-diff-local-only').textContent =
        this.diffResult.localOnly.length + ' to sync';
    document.getElementById('zune-diff-device-only').textContent =
        this.diffResult.deviceOnly.length + ' on device only';
}
```

**Step 3: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat(sync): update diff view init and summary for multi-category"
```

---

### Task 7: Implement _deleteFromDevice()

**Files:**
- Modify: `src/assets/js/renderer.js` (add after `_pullFromDevice`, before `_formatSize`)

**Step 1: Add the _deleteFromDevice() method**

Insert before `_formatSize()` (before line 1638):

```javascript
// ---- Delete from device (diff view) ----
async _deleteFromDevice() {
    const deleteBtn = document.getElementById('zune-diff-delete-btn');
    const count = this.diffSelectedHandles.size;

    if (count === 0) return;

    // Confirm-on-second-click pattern
    if (!deleteBtn.classList.contains('confirm')) {
        deleteBtn.classList.add('confirm');
        deleteBtn.textContent = `confirm: delete ${count} file${count !== 1 ? 's' : ''}?`;

        if (this.diffDeleteConfirmTimer) clearTimeout(this.diffDeleteConfirmTimer);
        this.diffDeleteConfirmTimer = setTimeout(() => {
            deleteBtn.classList.remove('confirm');
            this._updateDiffActionButton();
            this.diffDeleteConfirmTimer = null;
        }, 3000);
        return;
    }

    // Confirmed — execute delete
    if (this.diffDeleteConfirmTimer) {
        clearTimeout(this.diffDeleteConfirmTimer);
        this.diffDeleteConfirmTimer = null;
    }

    const handles = Array.from(this.diffSelectedHandles);
    this.diffSelectedHandles.clear();

    deleteBtn.textContent = 'deleting...';
    deleteBtn.classList.remove('confirm');
    deleteBtn.disabled = true;

    const result = await window.electronAPI.zuneDeleteObjects(handles);

    if (result.success && result.storage) {
        this._updateStorage(result.storage);
    }

    // Remove deleted items from browseData
    if (result.success && this.browseData) {
        const deletedSet = new Set(handles);
        if (result.errors) {
            for (const err of result.errors) {
                deletedSet.delete(err.handle);
            }
        }
        for (const cat of ['music', 'videos', 'pictures']) {
            this.browseData[cat] = this.browseData[cat].filter(
                item => !deletedSet.has(item.handle)
            );
        }
    }

    // Update cache
    if (this.deviceKey && this.browseData) {
        await window.electronAPI.zuneCacheSave(this.deviceKey, {
            model: this.cachedData?.model || this.lastStatus?.model || 'Zune',
            scanDurationMs: this.cachedData?.scanDurationMs || 0,
            counts: {
                music: this.browseData.music?.length || 0,
                videos: this.browseData.videos?.length || 0,
                pictures: this.browseData.pictures?.length || 0,
            },
            contents: this.browseData,
        });
    }

    // Recompute and re-render
    this._computeDiff();
    this._computeStorageBreakdown();
    this._renderDiffSummary();
    this._renderDiffList();
}
```

**Step 2: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat(sync): implement _deleteFromDevice with two-click confirmation"
```

---

### Task 8: Update _pullFromDevice() for Multi-Category

**Files:**
- Modify: `src/assets/js/renderer.js:1569-1636` (`_pullFromDevice`)

**Step 1: Make _pullFromDevice() category-aware**

Replace the method to handle music vs videos/pictures:

```javascript
async _pullFromDevice() {
    if (this.diffSelectedHandles.size === 0) return;

    const handles = Array.from(this.diffSelectedHandles);
    this.diffSelectedHandles.clear();

    // Ask user where to save
    const destResult = await window.electronAPI.pickPullDestination();
    if (!destResult.success) return;
    const destDir = destResult.path;

    const pullBtn = document.getElementById('zune-pull-btn');
    pullBtn.textContent = `copying 0 of ${handles.length}...`;
    pullBtn.disabled = true;

    let pulled = 0;
    const pulledFiles = [];
    const category = this.diffCategory;
    const deviceItems = (this.browseData && this.browseData[category]) || [];

    for (const handle of handles) {
        const deviceItem = deviceItems.find(i => i.handle === handle);
        if (!deviceItem) continue;

        const filename = deviceItem.filename || `file_${handle}`;
        const metadata = category === 'music' ? {
            title: deviceItem.title || null,
            artist: deviceItem.artist || null,
            album: deviceItem.album || null,
            genre: deviceItem.genre || null,
            trackNumber: deviceItem.trackNumber || null,
            albumArt: deviceItem.albumArt || null,
        } : {};
        const result = await window.electronAPI.zunePullFile(handle, filename, destDir, metadata);

        if (result.success) {
            pulled++;
            pulledFiles.push(result.path);
            pullBtn.textContent = `copying ${pulled} of ${handles.length}...`;
        }
    }

    pullBtn.textContent = `${pulled} files copied`;
    pullBtn.disabled = false;

    // Add pulled files to local categorized files
    if (pulledFiles.length > 0) {
        for (const fp of pulledFiles) {
            const ext = fp.split('.').pop().toLowerCase();
            this.explorer.categorizedFiles[category].push({
                path: fp,
                name: fp.split(/[/\\]/).pop(),
                extension: '.' + ext,
                size: 0,
                modified: new Date(),
                isDirectory: false,
            });
        }
        // Trigger metadata scan only for music
        if (category === 'music') {
            await window.electronAPI.batchScanAudioMetadata(pulledFiles, { includeArt: true });
        }
    }

    // Re-compute diff
    this._computeDiff();
    this._renderDiffSummary();
    this._renderDiffList();
}
```

**Step 2: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat(sync): update pull to support videos and pictures categories"
```

---

### Task 9: Update _matchesFilter() and _enrichDeviceArt() for Multi-Category

**Files:**
- Modify: `src/assets/js/renderer.js:1371-1386` (`_matchesFilter`)
- Modify: `src/assets/js/renderer.js:700-717` (`_enrichDeviceArt`)

**Step 1: Update _matchesFilter() for videos/pictures**

The existing filter checks `title`, `artist`, `album` — for videos/pictures we also need to check `filename` and `name`. The current code already falls through to check `item.filename`, so it should work. But update the matched branch to also check `name`:

In the non-matched branch (lines 1383-1385), update to:

```javascript
return (item.title || item.name || item.filename || '').toLowerCase().includes(q)
    || (item.artist || '').toLowerCase().includes(q)
    || (item.album || '').toLowerCase().includes(q);
```

**Step 2: Update _enrichDeviceArt() to only run for music**

At the top of `_enrichDeviceArt()`, add a guard:

```javascript
_enrichDeviceArt() {
    if (!this.diffResult) return;
    if (this.diffCategory !== 'music') return;
```

**Step 3: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat(sync): update filter and art enrichment for multi-category"
```

---

### Task 10: Final Integration Test and Commit

**Step 1: Run the app**

```bash
npm run dev
```

**Step 2: Manual test checklist**

- [ ] Category tabs appear above diff summary with MUSIC / VIDEOS / PHOTOS
- [ ] MUSIC tab active by default, styled with orange underline and bright text
- [ ] Switching to VIDEOS tab shows video diff (filename matching)
- [ ] Switching to PHOTOS tab shows photo diff (filename matching)
- [ ] Group bar hidden for VIDEOS and PHOTOS tabs
- [ ] "missing from computer" tab shows pull AND delete buttons for device-only items
- [ ] Delete button: first click shows "confirm: delete N files?", reverts after 3s
- [ ] Delete button: second click within 3s executes deletion
- [ ] Pull works for videos and pictures (straight file copy)
- [ ] Summary counts update per category
- [ ] Filter works for all categories
- [ ] Select-all label says "tracks" for music, "files" for videos/photos
- [ ] Switching categories resets selections, filter, diff tab, and group-by

**Step 3: Commit all remaining changes**

```bash
git add -A
git commit -m "feat(sync): multi-category diff view with delete button

Add MUSIC / VIDEOS / PHOTOS category tabs to the sync diff view using
Zune HD sub-tab styling. Each category computes its own diff — music uses
metadata matching, videos/pictures use filename matching. Add delete-from-device
button with two-click confirmation on the device-only tab."
```
