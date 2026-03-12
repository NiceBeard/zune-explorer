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
- `DestinationURL: 0xDD61` — website link
- `TimeBookmark: 0xDD62` — playback position in milliseconds
- `ObjectBookmark: 0xDD63` — handle of last-played episode (on series container)
- `MediaGUID: 0xDD72` — unique identifier (subscription ID or episode GUID)
- `ReleaseDate: 0xDC99` — publish date (already may exist; add if missing)

### Protocol Methods (`mtp-protocol.js`)

Add if not already present:
- `getObjectPropUint64(handle, propCode)` — needed for TimeBookmark (ms value can exceed uint32)
- `setObjectPropUint64(handle, propCode, value)` — write TimeBookmark back to device

## 2. ZMDB Parser — Podcast Parsing

The parser (`zmdb-parser.js`) already defines schemas at lines 28-29:
- `PodcastShow: 0x0f` (entry size 8 bytes)
- `PodcastEpisode: 0x10` (entry size 32 bytes)

Descriptor 19 maps to `Schema.PodcastEpisode` for HD devices (line 78). The `_resolveString()` method already handles podcast show titles at offset 8 (lines 426-429).

### Changes

Add `case Schema.PodcastShow:` to the parse switch:
- Read show name via string table
- Store in `result.podcastShows[]` with `{ atomId, name }`

Add `case Schema.PodcastEpisode:` to the parse switch:
- Read episode title, duration, show reference (parent show atomId)
- Store in `result.podcastEpisodes[]` with `{ atomId, title, showAtomId, duration }`
- The exact byte offsets for episode fields need probing on a real device (similar to how music offsets were discovered)

Expose both arrays from `parse()` return value.

### Probing Strategy

Since we don't have confirmed byte offsets for podcast episode entries:
1. First sync a known podcast to the device via push (Section 3)
2. Read back the ZMDB and dump the raw podcast episode bytes
3. Identify title offset, duration offset, show reference offset by matching known values
4. Update parser with confirmed offsets

The push flow does NOT depend on ZMDB parsing — it uses MTP object creation directly. So push works first, ZMDB parsing is refined after.

## 3. Push Flow (PC -> Zune)

### Entry Point

Same as music: user selects episodes in the diff view's "local-only" tab, clicks push button. `_pushToDevice()` delegates to a new `sendPodcastEpisodes()` method in `zune-manager.js`.

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
   - `sendObjectInfo()` with appropriate format code (MP3: `0x3009`, WMA: `0xB901`, AAC: `0xB903`, MP4: `0xB982`), parent = podcast folder handle
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

- Add pushed episodes to the device browse cache under a new `podcasts` category
- Save cache to disk
- Recompute diff

## 4. Pull Flow (Zune -> PC)

### Entry Point

User selects episodes from the diff view's "device-only" tab, clicks pull button.

### Discovery

Podcast episodes on the device are discovered during browse via:
- **ZMDB fast-path:** Parse `PodcastShow` and `PodcastEpisode` entries (once offsets are confirmed)
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
2. **If found:** Add episode to that subscription's episode list with `downloaded: true`, `localPath` set, `playbackPosition` from device TimeBookmark
3. **If not found:** Create a stub subscription:
   - `title` = series name from device
   - `feedUrl` = URLSource if available, otherwise null
   - `category` = "audio" (or "video" based on file format)
   - No feed refresh capability until user provides/confirms a feed URL
   - Episodes added with downloaded state
4. Trigger podcast UI refresh

## 5. Playback Position Sync

### When It Runs

During diff computation for the podcasts tab, after matching episodes between local and device.

### Algorithm

For each matched episode pair (local episode + device episode):

```
devicePositionMs = getObjectPropUint64(deviceHandle, TimeBookmark)
localPositionMs  = localEpisode.playbackPosition * 1000  // stored in seconds locally

if devicePositionMs > localPositionMs:
    // Device is further ahead — update local
    localEpisode.playbackPosition = devicePositionMs / 1000
    save episode record
    emit position-updated event

else if localPositionMs > devicePositionMs:
    // Local is further ahead — queue update to device
    setObjectPropUint64(deviceHandle, TimeBookmark, localPositionMs)
```

### Played Status

- If either position >= 95% of episode duration, mark as played on both sides
- "Played" on device: position set to duration (or 0 with a "completed" convention — needs probing)
- "Played" locally: `episode.played = true`, decrement subscription's `newEpisodeCount`

### Batching

Position reads are batched during diff computation (already iterating all matched episodes). Position writes to device are batched after diff is displayed, before user initiates any push/pull.

## 6. Diff Computation

### New Method: `_computePodcastDiff()`

Added to `ZuneSyncPanel` in `renderer.js`, following the pattern of `_computeMusicDiff()`.

**Local source:** All downloaded episodes across all subscriptions:
```javascript
podcastRenderer.getAllDownloadedEpisodes()
// Returns [{ subscriptionId, subscriptionTitle, episodeId, title, localPath, duration, publishDate, playbackPosition }]
```

**Device source:** Podcast episodes from ZMDB parse or MTP enumeration:
```javascript
browseData.podcasts[]
// Each: { handle, title, seriesName, duration, releaseDate, timeBookmark, guid }
```

**Matching logic:**
1. **GUID match:** Episode GUID (MediaGUID property) === episode.id — primary match
2. **Title+Series match:** Episode title + series name (case-insensitive, trimmed) — fallback

**Result:** `{ matched[], localOnly[], deviceOnly[] }` — same structure as music diff.

**Grouping:** Group by series name (analogous to album grouping in music diff).

### Position Sync Integration

During matched-pair iteration in `_computePodcastDiff()`:
- Read TimeBookmark from device for each matched episode
- Apply "furthest wins" logic (Section 5)
- Annotate matched entries with sync direction indicator if position was updated

## 7. UI Integration

### Diff View Tab

Add "podcasts" tab to the existing tab bar in the sync panel diff view. Tab only appears if:
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
1. Collect AbstractMediacast objects (format `0xBA0B`) alongside existing artist/album collection
2. For each series: `getObjectReferences()` to get episode handles
3. For each episode: read metadata properties (name, duration, release date, time bookmark, GUID)
4. Build `browseData.podcasts[]`

### ZMDB Fast Path

Once podcast entry offsets are confirmed:
- Parse shows and episodes from ZMDB
- Map show atomIds to show names
- Build `browseData.podcasts[]` from parsed data
- Handle resolution follows existing pattern (probe atomIds, fallback to filename->handle map)

### Device Cache

Podcast data included in device cache save/load (same `deviceCache` mechanism), keyed under `podcasts` alongside existing `music`, `video`, `picture` categories.

## 9. File Scope

### Modified Files
- `src/main/zune/mtp-constants.js` — new format code + property codes
- `src/main/zune/mtp-protocol.js` — uint64 prop getter/setter (if not present)
- `src/main/zune/zmdb-parser.js` — podcast show/episode parsing
- `src/main/zune/zune-manager.js` — `sendPodcastEpisodes()`, podcast browse enumeration, position sync
- `src/main/main.js` — new IPC handlers for podcast sync operations
- `src/main/preload.js` — expose new IPC channels
- `src/assets/js/renderer.js` — `_computePodcastDiff()`, podcasts tab in diff view, push/pull integration
- `src/assets/js/podcast-renderer.js` — `getAllDownloadedEpisodes()` helper, position update handler
- `src/assets/css/styles.css` — podcast tab styling (minimal, follows existing tab pattern)

### No New Files

All changes are additions to existing files, following established patterns.

## 10. Risks & Unknowns

| Risk | Mitigation |
|------|------------|
| ZMDB podcast entry byte offsets are unconfirmed | Push flow works without ZMDB; probe offsets by syncing known content and reading back |
| Zune may not accept `setObjectPropUint64` for TimeBookmark | Fall back to `setObjectPropUint32` if uint64 fails; test on real device |
| AbstractMediacast creation may require specific property ordering | Follow the pattern that works for AbstractAudioAlbum; test incrementally |
| Video podcasts may need different handling than audio | Use existing video format codes (MP4/WMV); test separately |
| Stub subscriptions (from pull without feed URL) have limited functionality | Clearly label as "imported from device" in UI; user can add feed URL later |
