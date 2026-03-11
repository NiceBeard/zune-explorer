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

- **Scroll container** with a tall spacer element representing full list height (`rowHeight × totalItems`)
- **Render window** of ~50-80 rows repositioned via `transform: translateY()` on scroll
- **Row recycling** — existing row DOM elements are reused and their content updated, not created/destroyed
- **Event delegation** — single `click`, `contextmenu`, and `dragstart` listener on the container; rows identified by `data-index` attribute

### Applies To

- Music songs list (`renderMusicSongsView`)
- Sync browse list (`_renderBrowseList`)
- Sync diff list — flat mode (`_renderDiffFlat`)
- Sync diff list — grouped mode (`_renderDiffGrouped`)

### Grouped Mode

For grouped lists (diff grouped by album/artist), precompute a flat position map of headers + rows. Each entry knows its type (header or track) and position. The virtualizer uses this map to determine what element to render at each offset.

### Alpha-Jump Integration

Scrolling to a letter sets `scrollTop` to `letterIndex × rowHeight`. The virtual scroller reacts to the scroll event and renders the correct rows. No special integration needed beyond the existing alpha-jump overlay triggering a scroll position change.

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

### Per-File Error Handling with Retry

- Each file wrapped in its own try-catch (replacing the current single try-catch around the entire loop)
- On failure: retry up to 2 more times with a brief pause between attempts
- After 3 total failures for one file: log the error, skip, continue with remaining files
- Transfer result tracks `{ succeeded: [], failed: [{ file, error }] }`

### Progress UI

- Sync panel shows progress bar with percentage and "X of Y" count
- Current file name displayed below the bar
- Real-time updates per file (not per batch)
- On completion: green summary if all succeeded, orange summary if some failed
- "View errors" link to see the list of failed files and their error messages

### Applies To

- **Push (sendFiles):** Batching wraps the loop in `zune-manager.js`
- **Pull (_pullFromDevice):** Batching wraps the loop in the renderer's pull logic with IPC calls per file

## Section 3: Album Art Deduplication

### Main Process (browseContents)

- Build an `albumArtMap` dictionary keyed by normalized album key (`artist|album` lowercased)
- Each track object gets an `albumArtKey` string reference instead of the full base64 data
- IPC payload structure: `{ tracks: [...], albumArtMap: { key: base64, ... } }`
- For 11,000 tracks across ~500 albums: art data drops from ~275MB to ~25MB

### Renderer Side

- Art lookup at render time: `albumArtMap[track.albumArtKey]`
- Virtual scroller rows resolve art from the map when populating visible rows
- Only ~50 rows have `<img>` elements with base64 src at any time

### Local Music Library

- Same deduplication applied to `musicLibrary.tracks`
- Art stored per album, referenced by key in each track
- Reduces baseline memory for users with large local libraries

## Section 4: Event Listener Cleanup

### IPC/Progress Listeners — AbortController Pattern

- `ZuneSyncPanel` creates an `AbortController` on panel open / device connect
- All IPC progress listeners (`onZuneBrowseProgress`, `onZuneTransferProgress`) registered with the controller's signal
- On device disconnect or panel close: `controller.abort()` removes all listeners at once
- New controller created on next session

### DOM List Interactions — Event Delegation

- Single `click`, `contextmenu`, `dragstart` listener on the virtual scroll container
- Row elements carry `data-index` attributes
- Delegation handler looks up the track from the data model by index
- No listener add/remove per row — rows are recycled by the virtual scroller

### Timer Cleanup

- `diffDeleteConfirmTimer` and `_diffFilterTimer` cleared on panel close / disconnect
- Tracked as instance properties, cleared in a `_cleanup()` method called on close/disconnect

### Temp File Cleanup

- Move cleanup into `finally` blocks for both push and pull (not just the success path)
- Track all temp file paths in an array
- `finally` block iterates and calls `fs.unlink` on each, regardless of transfer outcome

## Success Criteria

- App displays 11,000+ songs in the songs list without crashing or going black
- Scrolling through 11,000 songs is smooth (60fps)
- Transferring 1,000+ files completes without crashing
- Failed files are retried, skipped, and reported — not fatal
- Memory usage stays bounded during long transfers (no unbounded growth)
- No event listener accumulation across repeated sync operations
- IPC payload for 11,000-song device is under 30MB (down from 275MB+)
