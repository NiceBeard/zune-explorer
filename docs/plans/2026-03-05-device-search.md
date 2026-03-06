# Device Search Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a real-time filter input to the diff view that filters songs by title, artist, or album within the current tab and grouping mode.

**Architecture:** A single `diffFilterQuery` string on `ZuneSyncPanel` drives client-side filtering. The `_renderDiffList` method filters items before passing them to `_renderDiffFlat`/`_renderDiffGrouped`. No IPC or backend changes needed.

**Tech Stack:** Vanilla JS, CSS — no new dependencies.

**Note:** This project has no automated test framework. Each task includes manual verification steps instead.

---

### Task 1: Add filter input HTML

**Files:**
- Modify: `src/renderer/index.html:303-311`

**Step 1: Add the filter input element between the group-by bar and select-all**

Insert this HTML after the `zune-diff-group-bar` div (line 307) and before the `zune-diff-select-all` label (line 308):

```html
<div class="zune-diff-filter" id="zune-diff-filter">
    <input type="text" class="zune-diff-filter-input" id="zune-diff-filter-input" placeholder="Filter...">
    <button class="zune-diff-filter-clear" id="zune-diff-filter-clear" title="Clear filter">&times;</button>
</div>
```

**Step 2: Verify HTML structure**

Run `npm start` and connect a Zune (or use cached data). Confirm the filter input appears between the group-by buttons and the select-all row. It will be unstyled at this point.

**Step 3: Commit**

```bash
git add src/renderer/index.html
git commit -m "feat(device-search): add filter input HTML to diff view"
```

---

### Task 2: Style the filter input

**Files:**
- Modify: `src/assets/css/styles.css` (after the `.zune-diff-group-bar` block, around line 2148)

**Step 1: Add CSS for the filter bar**

Insert these styles after the `.zune-diff-group-btn.active` rule:

```css
/* Diff filter input */
.zune-diff-filter {
    display: flex;
    align-items: center;
    margin-bottom: 6px;
    position: relative;
    flex-shrink: 0;
}

.zune-diff-filter-input {
    width: 100%;
    padding: 8px 32px 8px 12px;
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 4px;
    color: #fff;
    font-size: 13px;
    font-family: inherit;
    outline: none;
    transition: border-color 0.15s;
}

.zune-diff-filter-input::placeholder {
    color: #666;
}

.zune-diff-filter-input:focus {
    border-color: var(--zune-orange);
}

.zune-diff-filter-clear {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    color: #666;
    font-size: 18px;
    cursor: pointer;
    padding: 4px 8px;
    line-height: 1;
    display: none;
}

.zune-diff-filter-clear:hover {
    color: #fff;
}
```

**Step 2: Verify styling**

Run `npm start`. The filter input should appear as a dark input with gray border that turns orange on focus. The clear button is hidden (no text entered yet).

**Step 3: Commit**

```bash
git add src/assets/css/styles.css
git commit -m "feat(device-search): style filter input for Zune dark theme"
```

---

### Task 3: Add filter state and event binding

**Files:**
- Modify: `src/assets/js/renderer.js`

**Step 1: Add state property to constructor (after line 20, `this.diffActive = false;`)**

```javascript
this.diffFilterQuery = '';          // current filter text
this._diffFilterTimer = null;       // debounce timer
```

**Step 2: Add event listeners in `_bindEvents` (after the select-all listener, around line 165)**

```javascript
// Diff filter input
const filterInput = document.getElementById('zune-diff-filter-input');
const filterClear = document.getElementById('zune-diff-filter-clear');

filterInput.addEventListener('input', () => {
    clearTimeout(this._diffFilterTimer);
    this._diffFilterTimer = setTimeout(() => {
        this.diffFilterQuery = filterInput.value.trim().toLowerCase();
        filterClear.style.display = this.diffFilterQuery ? 'block' : 'none';
        this._renderDiffList();
    }, 150);
});

filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        filterInput.value = '';
        this.diffFilterQuery = '';
        filterClear.style.display = 'none';
        this._renderDiffList();
    }
});

filterClear.addEventListener('click', () => {
    filterInput.value = '';
    this.diffFilterQuery = '';
    filterClear.style.display = 'none';
    filterInput.focus();
    this._renderDiffList();
});
```

**Step 3: Clear filter when switching tabs (in the diff tab click handler, around line 145)**

Add `this.diffFilterQuery = '';` and reset the input value when the user switches diff tabs. Inside the existing diff tab click handler, after `this.diffSelectedHandles.clear();` add:

```javascript
this.diffFilterQuery = '';
document.getElementById('zune-diff-filter-input').value = '';
document.getElementById('zune-diff-filter-clear').style.display = 'none';
```

**Step 4: Verify event binding**

Run `npm start`. Type in the filter input — nothing filters yet (that's Task 4), but:
- The clear button (×) should appear when text is present
- Escape should clear the input
- Clicking × should clear the input
- Switching tabs should clear the input

**Step 5: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat(device-search): add filter state and input event binding"
```

---

### Task 4: Implement filter logic in _renderDiffList

**Files:**
- Modify: `src/assets/js/renderer.js`

**Step 1: Add a `_matchesFilter` helper method (after `_createDiffRow`, around line 1272)**

```javascript
_matchesFilter(item) {
    if (!this.diffFilterQuery) return true;
    const q = this.diffFilterQuery;

    if (this.diffTab === 'matched') {
        const loc = item.local || {};
        const dev = item.device || {};
        return (loc.title || dev.title || dev.filename || '').toLowerCase().includes(q)
            || (loc.artist || dev.artist || '').toLowerCase().includes(q)
            || (loc.album || dev.album || '').toLowerCase().includes(q);
    }

    return (item.title || item.filename || '').toLowerCase().includes(q)
        || (item.artist || '').toLowerCase().includes(q)
        || (item.album || '').toLowerCase().includes(q);
}
```

**Step 2: Filter items in `_renderDiffList` (modify around line 1031-1055)**

After the `items` variable is assigned (around line 1031), add filtering:

```javascript
// Apply filter
const filteredItems = this.diffFilterQuery
    ? items.filter(item => this._matchesFilter(item))
    : items;
```

Then replace all subsequent references to `items` with `filteredItems` in the rest of `_renderDiffList`:
- Line with `items.length === 0` check → `filteredItems.length === 0`
- The empty message for filtered results should say `'no matches'` when `this.diffFilterQuery` is set, otherwise the original messages
- `_renderDiffFlat(listEl, items, ...)` → `_renderDiffFlat(listEl, filteredItems, ...)`
- `_renderDiffGrouped(listEl, items, ...)` → `_renderDiffGrouped(listEl, filteredItems, ...)`
- `_updateSelectAllState(items)` → `_updateSelectAllState(filteredItems)`

**Step 3: Show/hide the filter bar alongside group bar**

In `_renderDiffList`, where `groupBar.style.display` is set (around line 1037), add the same for the filter:

```javascript
document.getElementById('zune-diff-filter').style.display = showCheckboxes ? 'flex' : 'none';
```

This shows the filter on local-only and device-only tabs, and hides it on the matched tab (which has no checkboxes). Actually, filtering is useful on the matched tab too. Change this to:

```javascript
document.getElementById('zune-diff-filter').style.display = 'flex';
```

So the filter is always visible in the diff view.

**Step 4: Verify filtering works**

Run `npm start`:
- Type an artist name → only tracks by that artist appear
- Type an album name → only tracks from that album appear
- Type a song title → only that song appears
- With "by album" grouping: albums with no matching tracks disappear entirely
- With "by artist" grouping: same behavior for artists
- Clear the filter → full list returns
- Empty results show "no matches"

**Step 5: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat(device-search): filter diff list by title/artist/album"
```

---

### Task 5: Make select-all and group checkboxes filter-aware

**Files:**
- Modify: `src/assets/js/renderer.js`

**Step 1: Update `_handleSelectAll` to only select/deselect filtered items**

Replace the `_handleSelectAll` method. Instead of operating on `this.diffResult.localOnly` / `this.diffResult.deviceOnly` directly, filter them first:

```javascript
_handleSelectAll(checked) {
    let items;
    if (this.diffTab === 'local-only') {
        items = (this.diffResult?.localOnly || []).filter(i => this._matchesFilter(i));
        for (const item of items) {
            if (checked) this.diffSelectedPaths.add(item.path);
            else this.diffSelectedPaths.delete(item.path);
        }
    } else if (this.diffTab === 'device-only') {
        items = (this.diffResult?.deviceOnly || []).filter(i => this._matchesFilter(i));
        for (const item of items) {
            if (checked) this.diffSelectedHandles.add(item.handle);
            else this.diffSelectedHandles.delete(item.handle);
        }
    } else {
        return;
    }
    this._renderDiffList();
}
```

**Step 2: Update `_toggleGroupSelection` to only toggle filtered tracks**

In `_renderDiffGrouped`, the group checkbox's change handler calls `this._toggleGroupSelection(group.tracks, ...)`. Since `group.tracks` already only contains filtered tracks (because we passed `filteredItems` into `_renderDiffGrouped`), this already works correctly — no change needed.

**Step 3: Verify select-all with filter**

Run `npm start`:
- Filter to show a subset of tracks
- Click select-all → only the visible filtered tracks get selected
- Clear the filter → previously hidden tracks remain unselected
- The action button count reflects only selected items (not filtered count)

**Step 4: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat(device-search): make select-all filter-aware"
```

---

### Task 6: Handle group name matching

**Files:**
- Modify: `src/assets/js/renderer.js`

**Step 1: Update `_renderDiffGrouped` to keep all tracks when the group name matches**

In `_renderDiffGrouped`, after groups are built from the (already filtered) items, we need to also include groups whose name matches the query — even if individual track fields didn't match. This means we need the original unfiltered items too.

Change the approach: instead of pre-filtering items before passing to `_renderDiffGrouped`, do the filtering inside the grouped renderer. Pass both the full items and the query.

Actually, a simpler approach: in `_renderDiffList`, when grouping is active and a filter is set, build groups from ALL items first, then filter:
- If the group name matches the query, keep all tracks in that group
- Otherwise, keep only tracks that individually match

Modify `_renderDiffGrouped` to accept the filter query and handle this:

After building groups from all items (the `for (const item of items)` loop), add a filtering pass before rendering:

```javascript
// Filter groups by query
if (this.diffFilterQuery) {
    const q = this.diffFilterQuery;
    for (const [key, group] of groups) {
        const nameMatches = group.name.toLowerCase().includes(q);
        if (!nameMatches) {
            // Filter to only matching tracks
            group.tracks = group.tracks.filter(t => this._matchesFilter(t));
            if (group.tracks.length === 0) {
                groups.delete(key);
            }
        }
        // If name matches, keep all tracks
    }
}
```

This requires passing unfiltered items to `_renderDiffGrouped` when a filter is active. Update `_renderDiffList` so that `_renderDiffGrouped` always receives the full item list:

```javascript
if (groupBy === 'all') {
    this._renderDiffFlat(listEl, filteredItems, showCheckboxes);
} else {
    this._renderDiffGrouped(listEl, items, showCheckboxes, groupBy);
}
```

And update `_updateSelectAllState` to count correctly — pass `filteredItems` which should now account for group-name matches too. Compute `filteredItems` after grouping would be complex, so instead just recompute: items that match individually OR whose group name matches.

Simpler: add a `_getFilteredItems` method that encapsulates the full filtering logic including group-name matching:

```javascript
_getFilteredItems(items, groupBy) {
    if (!this.diffFilterQuery) return items;
    const q = this.diffFilterQuery;

    if (groupBy === 'all') {
        return items.filter(item => this._matchesFilter(item));
    }

    // For grouped modes, keep all tracks in a group if the group name matches
    const groups = new Map();
    for (const item of items) {
        let groupName;
        if (this.diffTab === 'matched') {
            const loc = item.local || {};
            const dev = item.device || {};
            groupName = groupBy === 'album'
                ? (loc.album || dev.album || 'Unknown Album')
                : (loc.artist || dev.artist || 'Unknown Artist');
        } else {
            groupName = groupBy === 'album'
                ? (item.album || 'Unknown Album')
                : (item.artist || 'Unknown Artist');
        }
        const key = groupName.toLowerCase();
        if (!groups.has(key)) groups.set(key, { name: groupName, tracks: [] });
        groups.get(key).tracks.push(item);
    }

    const result = [];
    for (const [key, group] of groups) {
        if (group.name.toLowerCase().includes(q)) {
            result.push(...group.tracks);
        } else {
            result.push(...group.tracks.filter(t => this._matchesFilter(t)));
        }
    }
    return result;
}
```

Then in `_renderDiffList`, replace the simple filter with:

```javascript
const groupBy = showCheckboxes ? (this.diffGroupBy || 'all') : 'all';
const filteredItems = this._getFilteredItems(items, groupBy);
```

And pass `filteredItems` everywhere (including to `_renderDiffGrouped`).

In `_renderDiffGrouped`, the groups will be built from `filteredItems`, which already includes the group-name-matched tracks. No additional filtering needed in that method.

**Step 2: Verify group name matching**

Run `npm start`:
- Switch to "by artist" grouping
- Type an artist name → that artist's group appears with ALL its tracks
- Type a song title → only the groups containing that song appear, with only the matching track visible
- Switch to "by album" → same behavior for album names

**Step 3: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat(device-search): show all tracks when group name matches filter"
```

---

### Summary of Changes

| File | Change |
|------|--------|
| `src/renderer/index.html` | Add filter input + clear button between group bar and select-all |
| `src/assets/css/styles.css` | Dark-themed filter input with orange focus ring |
| `src/assets/js/renderer.js` | `diffFilterQuery` state, debounced input handling, `_matchesFilter()`, `_getFilteredItems()`, filter-aware rendering and selection |
