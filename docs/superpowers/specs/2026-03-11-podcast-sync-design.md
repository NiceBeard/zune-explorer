# Podcast Sync Design — Full 2-Way Zune Sync

**Date:** 2026-03-11
**Status:** Draft
**Scope:** Add podcast episodes to the existing Zune 2-way sync infrastructure

## Context

Zune Explorer v1.4.0 added podcast support (subscribe, download, playback). The Zune HD natively supports podcasts via MTP format code `0xBA0B` (AbstractMediacast). The ZMDB parser already defines podcast schemas (`PodcastShow: 0x0f`, `PodcastEpisode: 0x10`) but doesn't parse them. This spec adds full 2-way podcast sync: push downloaded episodes to the device, pull podcast episodes from the device, and bidirectional playback position sync.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Sync scope | Full 2-way (push, pull, position sync) | Existing music sync infrastructure supports all three; podcasts follow the same MTP patterns |
| UI integration | New "podcasts" tab in existing diff view | Consistent with music/videos/pictures tabs; reuses diff infrastructure |
| Position sync strategy | Furthest progress wins | Handles the common case (listen on device, come home) without losing progress |
| Episode selection | Manual (same as music) | Consistent UX; no new settings UI needed |

## 1. MTP Constants & Protocol Layer

### New Constants (`mtp-constants.js`)

**Object Format:**
- `AbstractMediacast: 0xBA0B` — podcast series container (confirmed supported by Zune HD mtp-detect log)

**Object Properties:**
- `URLSource: 0xDD60` — feed URL (series) or episode download URL (episode)
- `TimeBookmark: 0xDD62` — playback position in milliseconds
- `ObjectBookmark: 0xDD63` — handle of last-played episode (on series container)
- `MediaGUID: 0xDD72` — unique identifier (subscription ID or episode GUID)
- `ReleaseDate: 0xDC99` — publish date (already may exist; add if missing)

### Protocol Methods (`mtp-protocol.js`)

TimeBookmark is in milliseconds. Most podcast episodes are under 4 hours (~14.4M ms), well within uint32 range (4.29B). Use `getObjectPropUint32()` / `setObjectPropUint32()` (already exist) as the primary approach. Only add uint64 variants if overflow is encountered during testing.

## 2. ZMDB Parser — Podcast Parsing

The parser (`zmdb-parser.js`) already defines schemas at lines 28-29:
- `PodcastShow: 0x0f` (entry size 8 bytes)
- `PodcastEpisode: 0x10` (entry size 32 bytes)

Descriptor 19 maps to `Schema.PodcastEpisode` for HD devices (line 78). The `_resolveString()` method already handles podcast show titles at offset 8 (lines 426-429).

### Changes

**PodcastEpisode:** Add `case Schema.PodcastEpisode:` to the parse switch:
- Read episode title, duration, show reference (parent show atomId)
- Store in `result.podcastEpisodes[]` with `{ atomId, title, showAtomId, duration }`
- The exact byte offsets for episode fields need probing on a real device (similar to how music offsets were discovered)

**PodcastShow:** There is no descriptor index mapped to `Schema.PodcastShow` in `HD_DESCRIPTOR_MAP`. Podcast show records are likely reachable only via reference resolution from episode records (similar to how albums are resolved via `_resolveAlbum()` from track references). Add a `_resolvePodcastShow(atomId)` method that reads the show name from the string table at offset 8 (already handled by `_resolveString()`). No `case Schema.PodcastShow:` in the parse switch — shows are resolved on demand from episode show references.

Expose `result.podcastEpisodes[]` (with resolved show names) from `parse()` return value.

### Probing Strategy

Since we don't have confirmed byte offsets for podcast episode entries:
1. First sync a known podcast to the device via push (Section 3)
2. Read back the ZMDB and dump the raw podcast episode bytes
3. Identify title offset, duration offset, show reference offset by matching known values
4. Update parser with confirmed offsets

The push flow does NOT depend on ZMDB parsing — it uses MTP object creation directly. So push works first, ZMDB parsing is refined after.

## 3. Push Flow (PC -> Zune)

### Entry Point

Same as music: user selects episodes in the diff view's "local-only" tab, clicks push button. `_pushToDevice()` checks `this.diffCategory` — if `'podcasts'`, delegates to a new `sendPodcastEpisodes()` method in `zune-manager.js` (instead of the music-oriented `sendFiles()`).

### Podcast Folder

Create or find a top-level "Podcasts" folder (Association object, format `0x3001`) on the device storage. Cache the handle for the session.

### Series Container (AbstractMediacast)

For each subscription with selected episodes:

1. **Check if series already exists on device** — scan existing AbstractMediacast objects, match by name (case-insensitive) or MediaGUID
2. **If not found, create:**
   - `sendObjectInfo()` with format `0xBA0B`, parent = podcast folder handle
   - Filename: `{podcastTitle}.pod`
   - Set properties via `setObjectPropString()`:
     - `ObjectName (0xDC44)` = podcast title
     - `Artist (0xDC46)` = author
     - `Genre (0xDC8C)` = "Podcast"
     - `URLSource (0xDD60)` = feed URL
     - `MediaGUID (0xDD72)` = subscription ID
3. **If found, reuse existing handle**

### Episode Transfer

For each selected episode:

1. **Format check:** Most podcasts are MP3 (no conversion needed). If non-native format (OGG, FLAC, etc.), convert via existing ffmpeg pipeline to MP3 320k.
2. **Send file:**
   - `sendObjectInfo()` with appropriate format code (MP3: `0x3009`, WMA: `0xB901`, AAC: `0xB903`, MP4: `0xB982`)
   - **Parent handle:** Try `parent = series container handle` first (episodes parented to their AbstractMediacast). If the device rejects this, fall back to `parent = podcast folder handle` and rely solely on `setObjectReferences()` for the association. Both approaches must be tested on a real device — the music flow uses `parent = 0` (root/auto-placed) with `setObjectReferences()` for album linking, so the fallback is well-proven.
   - `sendObject()` — stream file data with progress callbacks
3. **Set episode metadata:**
   - `ObjectName (0xDC44)` = episode title
   - `Artist (0xDC46)` = podcast author
   - `Genre (0xDC8C)` = "Podcast"
   - `Duration (0xDC89)` = duration in milliseconds
   - `ReleaseDate (0xDC99)` = publish date
   - `URLSource (0xDD60)` = episode enclosure URL
   - `MediaGUID (0xDD72)` = episode GUID
   - `TimeBookmark (0xDD62)` = local playback position in milliseconds
4. **Error handling:** Same retry logic as music (3 attempts, 500ms delay, orphan cleanup on failure)

### Link Episodes to Series

After all episodes for a series are transferred:
- Read existing references on the AbstractMediacast via `getObjectReferences()`
- Append new episode handles
- `setObjectReferences()` with the combined list

### Cache Update

- Add pushed episodes to the device browse cache under `podcasts` category
- Save cache to disk (update hardcoded category lists — see Section 8)
- Recompute diff

## 4. Pull Flow (Zune -> PC)

### Entry Point

User selects episodes from the diff view's "device-only" tab, clicks pull button. `_pullFromDevice()` checks `this.diffCategory` — if `'podcasts'`, routes to podcast-specific pull logic.

### Discovery

Podcast episodes on the device are discovered during browse via:
- **ZMDB fast-path:** Parse `PodcastEpisode` entries, resolve show names via `_resolvePodcastShow()` (once offsets are confirmed)
- **MTP fallback:** Enumerate objects with format `0xBA0B` (series containers), then resolve their references to get episode handles. Read metadata from each episode object.

### Download

1. Resolve handle (ZMDB atomId -> MTP handle if needed, via existing handle resolution cache)
2. `getObject(handle)` — download binary file data
3. Save to podcast download directory (from `podcast-preferences.json`)
4. Filename: `{PodcastTitle} - {EpisodeTitle}.{ext}` (sanitized)
5. Format conversion if needed (WMA -> MP3 via existing pipeline)

### Integration with Podcast System

After pulling:
1. **Find matching subscription** by series name or feed URL (from URLSource property)
2. **If found:** Add episode to that subscription's episode list with `downloaded: true`, `localPath` set, `playbackPosition` from device TimeBookmark (converted from ms to seconds)
3. **If not found:** Create a stub subscription:
   - `title` = series name from device
   - `feedUrl` = URLSource if available, otherwise null
   - `category` = "audio" (or "video" based on file format)
   - No feed refresh capability until user provides/confirms a feed URL
   - Episodes added with downloaded state
4. Trigger podcast UI refresh via IPC event

## 5. Playback Position Sync

### When It Runs

During diff computation for the podcasts tab, after matching episodes between local and device. Position writes to device are awaited before push/pull operations are allowed (to prevent race conditions if the user clicks push/pull quickly after the diff view opens).

### Unit Convention

- **Device:** TimeBookmark is in **milliseconds** (MTP convention)
- **Local:** `episode.playbackPosition` is in **seconds** (set by AudioPlayer's `currentTime` property, persisted via `podcastSavePlaybackPosition()` in podcast-renderer.js)
- **Conversion:** `localMs = Math.round(episode.playbackPosition * 1000)`, `localSec = deviceMs / 1000`

### Algorithm

For each matched episode pair (local episode + device episode):

```
devicePositionMs = getObjectPropUint32(deviceHandle, TimeBookmark)
localPositionMs  = Math.round(localEpisode.playbackPosition * 1000)

if devicePositionMs > localPositionMs:
    // Device is further ahead — update local
    localEpisode.playbackPosition = devicePositionMs / 1000
    save episode record via IPC
    emit position-updated event

else if localPositionMs > devicePositionMs:
    // Local is further ahead — update device
    setObjectPropUint32(deviceHandle, TimeBookmark, localPositionMs)
```

### Played Status

- If either position >= 95% of episode duration, mark as played on both sides
- "Played" on device: position set to duration (or 0 with a "completed" convention — needs probing)
- "Played" locally: `episode.played = true`, decrement subscription's `newEpisodeCount`

### Batching

Position reads are batched during diff computation (already iterating all matched episodes). Position writes to device are collected during diff computation and flushed as a batch before the diff view becomes interactive.

## 6. Diff Computation

### New Method: `_computePodcastDiff()`

Added to `ZuneSyncPanel` in `renderer.js`, following the pattern of `_computeMusicDiff()`.

### Dispatcher Integration

`_computeDiff()` currently branches on `this.diffCategory === 'music'` vs other categories. Add a third branch: `if (this.diffCategory === 'podcasts') { this._computePodcastDiff(); }`.

### Local Data Source

Downloaded episodes are fetched via IPC from the main process (PodcastManager holds all subscription/episode data, which is more reliable than renderer-side state that may be stale):

```javascript
// New IPC handler: podcast-get-all-downloaded
// Returns all episodes with downloaded === true across all subscriptions
const downloaded = await window.electronAPI.podcastGetAllDownloaded();
// Returns [{ subscriptionId, subscriptionTitle, episodeId, title, localPath, duration, publishDate, playbackPosition }]
```

This requires a new `podcastGetAllDownloaded()` method in `PodcastManager` and corresponding IPC handler in `main.js` + preload bridge.

### Device Source

```javascript
browseData.podcasts[]
// Each: { handle, title, seriesName, duration, releaseDate, timeBookmark, guid }
```

### Matching Logic

1. **GUID match:** Episode GUID (MediaGUID property) === episode.id — primary match
2. **Title+Series match:** Episode title + series name (case-insensitive, trimmed) — fallback

### Result

`{ matched[], localOnly[], deviceOnly[] }` — same structure as music diff.

### Grouping

Group by series name (analogous to album grouping in music diff).

### Position Sync Integration

During matched-pair iteration in `_computePodcastDiff()`:
- Read TimeBookmark from device for each matched episode
- Apply "furthest wins" logic (Section 5)
- Annotate matched entries with sync direction indicator if position was updated

## 7. UI Integration

### Diff View Tab

Add "podcasts" tab to the existing tab bar in the sync panel diff view. Requires adding a new tab button in `src/renderer/index.html` (alongside the music/videos/pictures tabs):
```html
<button class="zune-diff-category-tab" data-category="podcasts">PODCASTS</button>
```

Tab only appears if:
- Local has downloaded podcast episodes, OR
- Device has podcast content (from browse data)

### Diff List Items

Each episode row displays:
- Episode title (primary text)
- Series name (secondary text, like artist in music diff)
- Duration (formatted)
- Publish date (formatted)
- Playback progress indicator (if in-progress)

### Group Headers

- Series name + episode count in group (like album headers in music diff)
- Series artwork if available (from local subscription or device)

### Push/Pull/Delete

Identical button behavior to music tab. Selection state tracked in existing `diffSelectedPaths` (or `diffSelectedHandles` for device items).

`_deleteFromDevice()` must also handle the `'podcasts'` category — remove deleted handles from `browseData.podcasts` (currently only iterates `['music', 'videos', 'pictures']`).

## 8. Device Browse Integration

### Browse Data Structure

Add `podcasts` category to `browseData`:
```javascript
browseData.podcasts = [
  {
    handle: Number,        // MTP handle or ZMDB atomId
    title: String,         // episode title
    seriesName: String,    // parent show name
    seriesHandle: Number,  // AbstractMediacast handle
    duration: Number,      // milliseconds
    releaseDate: String,   // ISO date
    timeBookmark: Number,  // playback position ms
    guid: String,          // MediaGUID
    size: Number,          // file size bytes
    format: Number,        // MTP format code
    filename: String
  }
]
```

### MTP Enumeration Path

During device browse (MTP fallback, not ZMDB):
1. Collect AbstractMediacast objects (format `0xBA0B`) in a `podcastSeriesHandles[]` array (alongside existing `albumObjHandles` and `artistObjHandles` collection)
2. In a subsequent pass: for each series, `getObjectReferences()` to get episode handles
3. For each episode: read metadata properties (name, duration, release date, time bookmark, GUID)
4. Read series name from the AbstractMediacast's ObjectName property
5. Build `browseData.podcasts[]`

### ZMDB Fast Path

Once podcast entry offsets are confirmed:
- Parse episodes from ZMDB, resolve show names via `_resolvePodcastShow()`
- Build `browseData.podcasts[]` from parsed data
- Handle resolution follows existing pattern (probe atomIds, fallback to filename->handle map)

### Initializing `podcasts` in Browse Results

Both `_tryZMDB()` and the MTP fallback path initialize result with `{ music: [], videos: [], pictures: [] }`. Add `podcasts: []` to both initialization points.

### Device Cache & Hardcoded Category Lists

Podcast data included in device cache save/load. Multiple places in `renderer.js` iterate hardcoded `['music', 'videos', 'pictures']` arrays for cache save, cache load, count display, and delete cleanup. All of these must be updated to include `'podcasts'`:

- Cache save loop (line ~1125)
- Cache count serialization (lines ~1828-1835)
- Delete cleanup loop (line ~2006)
- Storage bar calculation
- Any other category iteration points

### Video Podcasts

Video podcast episodes (MP4, M4V, WMV) use the same `AbstractMediacast` container as audio episodes — the container is format-agnostic. Video episodes appear in the `podcasts` diff tab (not the `videos` tab) since they belong to a podcast series. Format codes for video episodes follow existing video format mapping.

## 9. File Scope

### Modified Files
- `src/main/zune/mtp-constants.js` — new format code + property codes
- `src/main/zune/mtp-protocol.js` — only if uint64 needed (unlikely for v1)
- `src/main/zune/zmdb-parser.js` — podcast episode parsing, `_resolvePodcastShow()`
- `src/main/zune/zune-manager.js` — `sendPodcastEpisodes()`, podcast browse enumeration, position sync
- `src/main/main.js` — new IPC handlers (`podcast-get-all-downloaded`, podcast sync operations)
- `src/main/preload.js` — expose new IPC channels
- `src/main/podcast-manager.js` — `getAllDownloaded()` method
- `src/assets/js/renderer.js` — `_computePodcastDiff()`, podcasts tab in diff view, push/pull/delete dispatch, hardcoded category list updates
- `src/renderer/index.html` — podcasts tab button in diff view
- `src/assets/css/styles.css` — podcast tab styling (minimal, follows existing tab pattern)

### No New Files

All changes are additions to existing files, following established patterns.

## 10. Risks & Unknowns

| Risk | Mitigation |
|------|------------|
| ZMDB podcast entry byte offsets are unconfirmed | Push flow works without ZMDB; probe offsets by syncing known content and reading back |
| Episode parent handle uncertainty (series vs folder) | Try series container as parent first; fall back to folder + references-only (proven pattern from music) |
| AbstractMediacast creation may require specific property ordering | Follow the pattern that works for AbstractAudioAlbum; test incrementally |
| Video podcasts may need different handling than audio | Same AbstractMediacast container; use existing video format codes; test separately |
| Stub subscriptions (from pull without feed URL) have limited functionality | Clearly label as "imported from device" in UI; user can add feed URL later |
| TimeBookmark uint32 overflow for very long episodes (>49 days) | Effectively impossible for podcasts; add uint64 only if needed |
