# Large Library Stability — Design Spec

**Date:** 2026-03-11
**Problem:** App crashes when displaying 11,000+ songs and when transferring thousands of files to/from Zune devices.

## Root Causes

1. **Renderer crash at ~5,000 songs** — all songs rendered as DOM elements synchronously (88,000-110,000 DOM nodes for 11,000 songs), 4+ event listeners per row, no virtual scrolling
2. **Transfer crashes** — tight sequential loop with no yielding, entire files buffered in RAM with no cleanup between files, one failure kills the whole transfer
3. **IPC payload bloat** — browseContents sends base64 album art per track (275MB+ for 11,000 songs with art)
4. **Event listener leaks** — progress listeners registered on every scan but never removed, DOM listeners accumulate on panel open/close cycles

## Section 1: Virtual Scrolling Engine

A lightweight virtual scroller built into the app with no external dependencies.

### Architecture

- **Scroll container** with a tall spacer element whose height is computed from a position map (not a simple `rowHeight × count`, since letter-header rows and track rows may differ in height)
- **Position map** — a precomputed array mapping each logical index to `{ type, offset, height }`. Built once when the data changes. Used for both total height calculation and scroll-to-index lookups.
- **Render window** of ~50-80 rows repositioned via `transform: translateY()` on scroll
- **Row recycling** — existing row DOM elements are reused and their content updated, not created/destroyed
- **Event delegation** — single `click`, `contextmenu`, and `dragstart` listener on the container; rows identified by `data-index` attribute

### Applies To

- Music songs list (`renderMusicSongsView`)
- Sync browse list (`_renderBrowseList`)
- Sync diff list — flat mode (`_renderDiffFlat`)
- Sync diff list — grouped mode (`_renderDiffGrouped`)

### Variable Row Heights

The songs list interleaves letter-header rows (`.music-letter-row`) and track rows (`.music-song-row`) which have different CSS heights. The grouped diff view has album/artist group headers and track rows. The position map handles this by storing the height of each entry, so total spacer height and scroll-to-index calculations are accurate for mixed row types.

Row heights are measured from the DOM on first render (via `getBoundingClientRect` on a prototype element rendered off-screen), not hardcoded in JS. This keeps the position map in sync with CSS even if row heights change.

### Grouped Mode

For grouped lists (diff grouped by album/artist), precompute a flat position map of headers + rows. Each entry knows its type (header or track), position, and height. The virtualizer uses this map to determine what element to render at each offset.

### Checkbox State in Diff Lists

Diff list rows carry per-item checkbox state tied to `diffSelectedPaths` and `diffSelectedHandles` sets. When a row is recycled:
- The checkbox's `checked` property is set from the selection set lookup (`diffSelectedPaths.has(item.path)`)
- Event delegation handles checkbox `change` events — the handler reads `data-index` to identify which item was toggled, then updates the selection set
- Group header checkboxes use the same delegation pattern and call `_updateGroupCheckState` based on the group's items in the selection set
- No closure-based listeners on checkboxes — all state is derived from the selection sets at render time

### Alpha-Jump Integration

The current alpha-jump uses `scrollIntoView()` on `[data-letter]` DOM elements, which won't work under virtualization since off-screen letter rows don't exist in the DOM.

**Fix:** Build a `letterPositionMap` (`{ A: 0, B: 247, C: 512, ... }`) during position map construction. Alpha-jump calls `virtualScroller.scrollToOffset(letterPositionMap[letter])` which sets `scrollTop` directly. The virtualizer reacts to the scroll event and renders the correct rows. The `openAlphaJump()` method is updated to use this map instead of `querySelector`/`scrollIntoView`.

### Scroll Position Preservation

When the virtualizer's data source changes (tab switch, filter change, progressive scan update):
- Save current `scrollTop` before replacing data
- Rebuild position map from new data
- Restore `scrollTop` (clamped to new max) after rebuild
- The virtualizer's scroll handler re-renders visible rows automatically

For tab switches that change the list entirely (e.g., albums → songs), reset `scrollTop` to 0.

### DOM Budget

- ~50-80 row elements exist at any time regardless of list size
- ~50-80 event delegation lookups (via `data-index`) instead of 44,000+ individual listeners
- Supports 11,000+ items with the same memory footprint as 50

## Section 2: Transfer Stability

### Batched Processing

- Files processed in batches of 5-10
- Between batches: release references to previous file buffers, yield to event loop via `await new Promise(r => setTimeout(r, 0))`
- Allows V8 garbage collection to reclaim memory between batches
- Prevents renderer freeze by not blocking the event loop for extended periods

### Album Map Accumulation (Push)

The `sendFiles` loop builds an `albumMap` across all files, then calls `_createAlbumObjects(albumMap)` after all files complete. The `albumMap` is lightweight (just metadata strings, not file buffers) and must persist across all batches. Batching only affects the file read/convert/send portion of each iteration — the albumMap accumulation and the final `_createAlbumObjects` call remain unchanged. File buffer references are what get released between batches; the albumMap stays in scope for the full run.

### Per-File Error Handling with Retry

- Each file wrapped in its own try-catch (replacing the current single try-catch around the entire loop)
- On failure: retry up to 2 more times with a brief pause (500ms) between attempts
- After 3 total failures for one file: log the error, skip, continue with remaining files
- Transfer result tracks `{ succeeded: [], failed: [{ file, error }] }`

### MTP Session Recovery on Retry

MTP failures (especially during `sendObject`) can leave the device session in an undefined state. Before retrying a failed file:
- If the failure occurred during `sendObject` (data phase), issue a `cancelTransaction` or `resetDevice` command to clear the device's pending state. If the initial `sendObjectInfo` returned a handle before the data-phase failure, attempt `deleteObject(orphanHandle)` to clean up the partially-received object before retrying. Track the handle from the `sendObjectInfo` response for this purpose.
- If the failure occurred during `sendObjectInfo` (setup phase), no recovery needed — the device hasn't started expecting data
- If retry also fails after recovery, the session may be corrupted beyond repair — skip the file and continue. The next file's `sendObjectInfo` will either succeed (session recovered) or fail fast (indicating the session needs a full reconnect)
- Log the failure type (info-phase vs data-phase) in the error report for debugging

### Progress UI

- Sync panel shows progress bar with percentage and "X of Y" count
- Current file name displayed below the bar
- Real-time updates per file (not per batch)
- On completion: green summary if all succeeded, orange summary if some failed
- "View errors" link to see the list of failed files and their error messages

### Applies To

- **Push (sendFiles):** Batching wraps the file read/convert/send loop in `zune-manager.js`. The albumMap accumulation and `_createAlbumObjects` call are outside the batched section.
- **Pull (_pullFromDevice):** Batching wraps the renderer-side loop. Note: each `zunePullFile` IPC call still reads the full file into a Buffer in the main process (`zuneManager.getFile`). Batching the renderer loop yields the renderer event loop and prevents the renderer from queueing thousands of concurrent IPC calls, but peak per-file memory on the main process is unchanged. True streaming from MTP to disk is a future optimization if needed.

## Section 3: Album Art Deduplication

### Main Process (browseContents)

- Build an `albumArtMap` dictionary keyed by normalized album key (`artist|album` lowercased)
- Each track object gets an `albumArtKey` string reference instead of the full base64 data
- IPC payload structure: `{ tracks: [...], albumArtMap: { key: base64, ... } }`
- For 11,000 tracks across ~500 albums: art data drops from ~275MB to ~25MB

### Device Cache Format

The device cache (`zuneCacheSave`) stores the browseContents result to disk. The cache format must be updated to store the deduplicated structure (`{ tracks, albumArtMap }`). For backwards compatibility:
- On cache load, check for the presence of `albumArtMap` in the cached data
- If missing (old format): the cache is from a pre-dedup version. Treat it as a cache miss and re-scan the device. Old cache files are small enough that re-scanning is acceptable.
- New cache writes always use the deduplicated format

### Renderer Side

- Store `albumArtMap` as a separate property on the sync panel (e.g., `this.albumArtMap`)
- Art lookup at render time: `this.albumArtMap[track.albumArtKey]`
- Virtual scroller rows resolve art from the map when populating visible rows
- Only ~50 rows have `<img>` elements with base64 src at any time

### Local Music Library

Same deduplication applied to `musicLibrary.tracks`:
- Art stored per album in `musicLibrary.albumArtMap`, keyed by `artist|album` lowercased
- Each track gets `albumArtKey` instead of `albumArt`
- During `music-scan-progress` handling, extract art from incoming track results and store in the map; set `albumArtKey` on the track

**Consumers that read `track.albumArt` and must be updated:**
- `renderMusicAlbumsView` — album tile background image
- `renderMusicArtistsView` — artist row inline art
- `renderMusicSongsView` — (songs don't show art, but may reference it)
- `_enrichDeviceArt` — cross-references local art for device tracks
- `createPinnedElement` — pin tile art
- `_renderDiffGrouped` / `_createDiffRow` — diff list album art
- `showMusicItemContextMenu` — metadata lookup context
- `playWithNowPlaying` / now-playing display — current track art
- `_enrichTrackData` / `_enrichPlaylistTracks` — playlist track enrichment

All consumers updated to use a helper: `getAlbumArt(track)` that returns `albumArtMap[track.albumArtKey]` or a fallback placeholder. Single point of change if the lookup strategy changes later.

## Section 4: Event Listener Cleanup

### IPC/Progress Listeners — Named References with Remove

`ipcRenderer.on` does not support AbortController signals. Instead:

- Store named callback references for each IPC listener on the `ZuneSyncPanel` instance (e.g., `this._browseProgressHandler`, `this._transferProgressHandler`, `this._zuneStatusHandler`)
- Add `removeListener` wrappers to the preload bridge: `offZuneBrowseProgress(fn)`, `offZuneTransferProgress(fn)`, `offZuneStatus(fn)`, `offMusicScanProgress(fn)` — each calls `ipcRenderer.removeListener(channel, fn)`
- On panel open / device connect: create new handler functions, store references, register via `on` wrappers
- On panel close / device disconnect: call `off` wrappers with stored references, null out the references
- `_cleanup()` method handles all removals in one place

**Also applies to `onMusicScanProgress`** — currently leaks a new anonymous listener on every `startMusicScan()` call. Add the same named-reference + remove pattern to the music scan listener in `ZuneExplorer`.

### DOM List Interactions — Event Delegation

- Single `click`, `contextmenu`, `dragstart` listener on the virtual scroll container
- Row elements carry `data-index` attributes
- Delegation handler looks up the track from the data model by index
- No listener add/remove per row — rows are recycled by the virtual scroller

### Timer Cleanup

- `diffDeleteConfirmTimer`, `_diffFilterTimer`, and `deleteConfirmTimer` cleared on panel close / disconnect
- Tracked as instance properties, cleared in a `_cleanup()` method called on close/disconnect

### Temp File Cleanup

- Move cleanup into `finally` blocks for both push and pull (not just the success path)
- Track all temp file paths in an array
- `finally` block iterates and calls `fs.unlink` on each, regardless of transfer outcome

## Success Criteria

- App displays 11,000+ songs in the songs list without crashing or going black
- Scrolling through 11,000 songs is smooth (60fps)
- Alpha-jump works correctly with virtualized lists
- Transferring 1,000+ files completes without crashing
- Failed files are retried, skipped, and reported — not fatal
- Memory usage stays bounded during long transfers (no unbounded growth)
- No event listener accumulation across repeated sync operations
- IPC payload for 11,000-song device is under 30MB (down from 275MB+)
- Old device cache files handled gracefully (re-scan, not crash)
- Checkbox state in diff lists is correct after row recycling
