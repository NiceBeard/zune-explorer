# Podcast Support — Design Spec

## Overview

Add podcast subscription, streaming, and download support to Zune Explorer as a new top-level category. Users subscribe to podcasts via RSS feeds (discovered through search, manual URL entry, or OPML import), browse and play episodes (streaming or downloaded), and manage their library through a Zune HD-inspired interface.

## Category Placement

Podcasts sits between pictures and documents in the main navigation:

`music → videos → pictures → podcasts → documents → applications`

### Integration Checklist

Adding the new category requires updates to:
- `this.categories` array in renderer.js — insert `'podcasts'` at index 3
- Add `podcasts: []` to `this.categorizedFiles` initialization (even though podcasts don't use file scanning, this prevents `undefined` when code accesses `categorizedFiles[currentCategory]`)
- New `<button class="menu-item">` in `index.html` between pictures and documents, including `<span class="menu-count" id="podcasts-count">0</span>` (shows total subscription count)
- `selectCategory()` — add `else if (this.currentCategory === 'podcasts')` branch delegating to PodcastPanel. Must appear before the final `else` block (between existing category checks and the fallback `renderCategoryContent()`)
- Verify any code using hardcoded category indices is updated (documents shifts from 3→4, applications from 4→5)
- `<script>` tag in index.html for `podcast-renderer.js`

## Navigation & UI

### Top Level — Subscription List

- **Hero header**: "podcasts" in giant 340px text, matching other categories
- **Sub-tabs**: AUDIO / VIDEO (matching Zune HD), with "refresh all" link right-aligned
- **Layout**: 1-per-row list. Each row contains:
  - **Left**: Podcast artwork thumbnail (72px square), with orange badge overlay showing new episode count (if any)
  - **Center**: Podcast title (14px, bold, white), author (11px, dim), episode count (10px, dimmer)
  - **Right**: Latest 3 episodes in light text, separated by a subtle vertical divider. Each shows a playback state dot (solid orange = new, hollow orange = in progress, none = played), episode title, and publish date
- Clicking a row drills down to the episode list
- **Context menu on subscription**: refresh, unsubscribe, pin to sidebar
- **VIDEO sub-tab in v1**: Video podcasts are listed and subscribable. Playback uses AudioPlayer (audio track only) — HTML5 `<audio>` can extract audio from many video container formats. Full video playback is a future enhancement.

### Episode Drill-Down

- **Back button**: Zune HD angular SVG (existing pattern)
- **Header**: Podcast name (22px, bold), author, episode count, per-podcast refresh link
- **Episode list** (VirtualScroller for scale): Each row contains:
  - **Status dot**: Solid orange = new/unplayed, hollow orange with border = in progress, empty = played
  - **Title**: 14px, white for unplayed, dimmed for played
  - **Metadata**: Publish date, duration. If in progress: "Xh Ym left" + orange progress bar below
  - **Actions** (right-aligned, borderless text + icon, no button outlines):
    - Not downloaded: `▶ stream` and `↓ download` in dim text
    - Downloaded: `✓ downloaded` in orange (for unplayed/in-progress) or dim (for played)
- Clicking an episode title plays it in the now playing bar (same AudioPlayer integration as music)
- **Context menu on episode**: stream, download, delete download, mark played/unplayed, add to now playing

### Add/Subscribe Flow

An "add" button in the sub-tab bar (right-aligned, near "refresh all") opens a Zune-styled modal with three sections:

1. **Search** (default): Text input querying iTunes Search API. Results show podcast art, title, author, description preview. "Subscribe" button on each result.
2. **RSS URL**: Text input field for pasting a feed URL directly. Validates the feed and subscribes on submit. Shows error toast if feed is invalid or unreachable.
3. **Import OPML**: File picker button for `.opml` files. Two-step flow: first picks the file (`podcast-pick-opml-file`), then starts the import (`podcast-import-opml`) which emits `podcast-import-progress` events so the modal can show incremental progress (e.g., "Importing 47 of 120 feeds...").

### Playback Integration

Episodes play through the existing AudioPlayer class and now playing bar, with modifications to support remote URLs:

- **AudioPlayer changes**: Modify `loadAndPlay(file)` to detect podcast episodes and branch accordingly:
  - Podcast episodes are identified by an `isPodcast: true` property on the queue entry
  - When `isPodcast` is true: skip `getAudioMetadata()` IPC call (metadata already inline), set `audio.src` to `localPath` (if downloaded) or `enclosureUrl` (if streaming) — no `file://` prefix needed for remote URLs
  - Emit `trackchange` with podcast-specific metadata: episode title as track title, podcast name as artist, podcast artwork path
  - Queue identity matching: use `episode.id` instead of `file.path` for podcast entries. Both `play(file, queue)` and `loadAndPlay(file)` must check `id` before `path`: `this.queue.findIndex(f => (f.id && f.id === file.id) || f.path === file.path)`
- **Mixed queues**: Podcast episodes and music tracks can coexist in the Now Playing queue. `next()` and `previous()` call `loadAndPlay()` which handles both types via the `isPodcast` branch.
- **Podcast queue entry shape**: `{ isPodcast: true, id, title, podcastName, artworkPath, duration, enclosureUrl, localPath, subscriptionId, playbackPosition }`
- **Now playing bar**: Displays podcast episode info naturally — episode title, podcast name, artwork. No UI changes needed beyond what `trackchange` already provides.
- **Playback position**: Saved per-episode on `pause` and `timeupdate`. PodcastPanel's `timeupdate` listener implements its own 15-second throttle (timestamp check) — AudioPlayer's emission frequency is unchanged so the existing progress bar UI is unaffected. Each position save via IPC also updates the main process's "last known" podcast playback state, so on `before-quit` the main process already has a recent position and can persist it without needing to query the renderer.
- **Episode ended**: When a podcast episode reaches the `ended` event, PodcastPanel marks it as played via `podcast-mark-played` IPC and resets `playbackPosition` to 0. AudioPlayer's existing `next()` behavior advances to the next queue item.
- **Episode object for playback** includes `subscriptionId` so position saves can locate the correct episode file.
- Podcast episodes can be added to Now Playing queue via context menu.

## Security Configuration

Streaming episodes from remote HTTPS URLs requires:

- **CSP `media-src`**: The existing CSP in `index.html` has `media-src 'self' file:;` — this must be changed to `media-src 'self' file: https:;` to allow `<audio>` to load remote enclosure URLs for streaming.
- **Electron `webSecurity`**: The existing `webSecurity: true` setting should work — Chromium allows `<audio>` to load HTTPS resources from a `file://` origin. If issues arise, the alternative is to proxy audio streams through the main process via a local HTTP server, but this is unlikely to be needed.
- **Artwork images**: All podcast artwork (subscription art and search result art) is fetched by the main process (Node `https`), not loaded directly in `<img>` tags from remote URLs. This avoids CSP/CORS issues entirely. Search results from iTunes API include artwork URLs — the main process fetches these and returns base64 data inline with search results (transient, not persisted). Subscription artwork is saved to disk.

## Architecture

### Main Process — `src/main/podcast-manager.js`

Handles all network I/O, disk I/O, and data persistence. Exposed to renderer via IPC handlers registered in `main.js`.

**Responsibilities:**
- **RSS feed parsing**: Fetch and parse RSS/Atom feeds using `fast-xml-parser` (lightweight, no native deps). Extract: title, author, description, artwork URL, episode list with enclosure URLs, durations, publish dates.
- **Podcast search**: Query iTunes Search API (`https://itunes.apple.com/search?media=podcast&term=...`). Returns podcast metadata including feed URLs. Search result artwork uses the 100px variant (`artworkUrl100`) for thumbnails to keep IPC payloads small; full-size artwork is fetched only on subscribe.
- **OPML parsing**: Parse OPML XML to extract feed URLs and titles.
- **Download manager**: Queue-based download system with configurable concurrency (default 2 simultaneous). Emits progress events via `webContents.send()`. Downloads saved to user-chosen directory.
- **Feed refresh**: Fetch a single feed or all feeds. Compare with stored episodes by stable ID (see Episode Identity below), flag new ones.
- **Persistence**: Read/write JSON files in userData (see Data Model below).
- **Download directory picker**: Electron dialog for first-time directory selection, persisted to preferences.
- **Artwork caching**: Fetch podcast artwork on subscribe/refresh, save as file to `userData/podcasts/artwork/<subscriptionId>.jpg`, return local path to renderer.

**IPC Handlers:**
- `podcast-search(query)` → search results array
- `podcast-subscribe(feedUrl)` → subscription object
- `podcast-unsubscribe(subscriptionId)` → success
- `podcast-pick-opml-file()` → opens file picker, returns file path (or null if cancelled)
- `podcast-import-opml(filePath)` → starts import, emits `podcast-import-progress` events, returns total imported count when complete
- `podcast-refresh(subscriptionId?)` → refreshed subscription(s) with new episode flags
- `podcast-get-subscriptions()` → all subscriptions (lightweight, no episodes)
- `podcast-get-episodes(subscriptionId)` → episodes for one subscription
- `podcast-download-episode(subscriptionId, episodeId)` → starts download, emits progress
- `podcast-cancel-download(episodeId)` → cancels in-progress download, deletes `.partial` temp file immediately
- `podcast-delete-download(subscriptionId, episodeId)` → removes local file
- `podcast-save-playback-position(subscriptionId, episodeId, position)` → persists position
- `podcast-mark-played(subscriptionId, episodeId, played)` → toggles played state
- `podcast-get-preferences()` → preferences object
- `podcast-pick-download-directory()` → opens dialog, persists choice

**IPC Events (main → renderer):**
- `podcast-download-progress` → `{ episodeId, percent, bytesDownloaded, bytesTotal }`
- `podcast-download-complete` → `{ episodeId, localPath }`
- `podcast-download-error` → `{ episodeId, error }`
- `podcast-refresh-complete` → `{ subscriptionId, newEpisodeCount }`
- `podcast-import-progress` → `{ current, total, title }`

### Renderer — `src/assets/js/podcast-renderer.js`

**PodcastPanel class** — instantiated by ZuneExplorer, manages all podcast UI rendering and interaction.

**Responsibilities:**
- Render subscription list (1-per-row with episode preview)
- Render episode drill-down with VirtualScroller
- Manage sub-tab state (AUDIO / VIDEO)
- Handle add/subscribe flow (search, manual RSS, OPML)
- Integrate with AudioPlayer for playback
- Manage drill-down navigation (subscription → episodes, back button)
- Trigger feed refresh on category navigate and on manual request
- Show download progress inline on episode rows

**Integration with ZuneExplorer:**
- `renderer.js` creates `PodcastPanel` instance alongside existing classes
- `selectCategory()` delegates to `PodcastPanel.render()` when podcast category is selected
- `PodcastPanel` uses existing patterns: hero header CSS, sub-tab styling, back button SVG, context menu builder, toast notifications, Zune-styled modals

### Preload Bridge — `src/main/preload.js`

New `electronAPI` methods mirroring the IPC handlers above. Same pattern as existing Zune sync and music metadata APIs.

**Invoke methods** (one per IPC handler):
- `podcastSearch(query)`, `podcastSubscribe(feedUrl)`, `podcastUnsubscribe(id)`, etc.

**Event listener pairs** (matching existing `onZuneTransferProgress`/`offZuneTransferProgress` pattern):
- `onPodcastDownloadProgress(callback)` / `offPodcastDownloadProgress()`
- `onPodcastDownloadComplete(callback)` / `offPodcastDownloadComplete()`
- `onPodcastDownloadError(callback)` / `offPodcastDownloadError()`
- `onPodcastRefreshComplete(callback)` / `offPodcastRefreshComplete()`
- `onPodcastImportProgress(callback)` / `offPodcastImportProgress()`

## Data Model

### Episode Identity

RSS feeds identify episodes via `<guid>` elements, which may be URLs, arbitrary strings, or absent entirely. The episode ID strategy:

1. Use the RSS `<guid>` value as the canonical `id` when present
2. Fall back to `enclosureUrl` as the ID when `<guid>` is missing
3. Generate a UUID only as a last resort (no guid, no enclosure URL)

This ensures stable episode identity across feed refreshes. The refresh comparison matches stored episodes against incoming feed entries by this stable ID.

### `userData/podcasts/subscriptions.json`

```json
[
  {
    "id": "uuid",
    "feedUrl": "https://example.com/feed.xml",
    "title": "Hardcore History",
    "author": "Dan Carlin",
    "description": "...",
    "artworkUrl": "https://example.com/artwork.jpg",
    "artworkPath": "artwork/abc123.jpg",
    "category": "audio",
    "episodeCount": 89,
    "newEpisodeCount": 3,
    "lastRefreshed": "2026-03-11T10:00:00Z",
    "subscribedAt": "2026-01-15T08:30:00Z",
    "error": null
  }
]
```

Note: `artworkPath` is relative to `userData/podcasts/`. Artwork is fetched by the main process and saved as a file — not inline base64 — to keep `subscriptions.json` lightweight at scale.

The `error` field stores the last fetch error message (if any), or `null` when healthy. Used to show error state in the UI.

### `userData/podcasts/episodes/<subscriptionId>.json`

```json
[
  {
    "id": "guid-or-enclosure-url-or-uuid",
    "title": "Addendum EP24 — The Romanov Aftermath",
    "description": "...",
    "publishDate": "2026-03-08T00:00:00Z",
    "duration": 13320,
    "enclosureUrl": "https://example.com/episode.mp3",
    "enclosureType": "audio/mpeg",
    "enclosureSize": 159840000,
    "played": false,
    "playbackPosition": 0,
    "downloaded": false,
    "localPath": null
  }
]
```

Episode files are loaded lazily — only when the user drills into a specific subscription.

### `userData/podcasts/artwork/`

Cached podcast artwork images, one per subscription. Named by subscription ID (e.g., `abc123.jpg`). Referenced from `subscriptions.json` via `artworkPath`. Fallback to a generic podcast placeholder icon if artwork is unavailable.

### `userData/podcasts/preferences.json`

```json
{
  "downloadDirectory": "/Users/name/Podcasts"
}
```

Currently contains only `downloadDirectory`; extensible for future preferences (auto-download, concurrency, etc.). First download triggers a directory picker dialog if `downloadDirectory` is not set. Choice is persisted here (same pattern as pull-destination picker).

### Download Directory Structure

```
<downloadDirectory>/
  Hardcore History/
    Addendum EP24 — The Romanov Aftermath.mp3
    Show 71 — Blitz (Human Resources) VI.mp3
  99% Invisible/
    Episode 571 — The Accidental Room.mp3
```

Filenames sanitized to remove filesystem-unsafe characters. If two episodes have the same sanitized title within a podcast, append the publish date (e.g., `Part 1 (2026-03-08).mp3`) to avoid collisions. In-progress downloads write to a `.partial` temp file (e.g., `episode.mp3.partial`) and are renamed to the final filename on completion.

## Error Handling

### Feed Errors
- **Unreachable feed URL**: Show toast ("Couldn't reach feed — check the URL"), set `error` field on subscription. Subscription tile shows a subtle error indicator. Next successful refresh clears the error.
- **Malformed XML**: Show toast ("Feed isn't valid RSS — check the URL"). Reject subscription if on first subscribe; preserve existing data if on refresh.
- **Feeds requiring authentication**: Not supported in v1. Show toast ("This feed requires authentication") if the server returns 401/403.

### Download Errors
- **Network failure mid-download**: Emit `podcast-download-error` event. Episode row shows error state. User can retry via context menu or stream/download buttons.
- **Disk full**: Catch write errors, emit error event with "Not enough disk space" message, clean up partial file.
- **Cancel download**: Immediately aborts the HTTP request and deletes the `.partial` temp file. Episode row reverts to stream/download buttons.
- **Partial files on app quit**: In-progress downloads are abandoned on quit. On next launch, podcast-manager scans for `.partial` temp files in the download directory and deletes them.

### Streaming Errors
- **Unreachable enclosure URL**: Delegate to existing AudioPlayer `playbackerror` flow — emits event, shows toast ("Couldn't play episode — check your connection").
- **Unsupported format**: Same `playbackerror` flow. Toast with format-specific message.

### Download Directory Errors
- **Directory moved/deleted**: On category navigate, verify `downloadDirectory` exists. If missing, show toast ("Download folder not found") and clear `downloaded`/`localPath` for episodes whose files are no longer present. Next download will re-prompt for a directory.

### Artwork Errors
- **Fetch failure**: Use generic podcast placeholder icon. Retry on next feed refresh.
- **CORS issues**: Artwork is always fetched by the main process (Node `https`), not the renderer, so CORS does not apply.

## Scale Considerations

- **Subscription list**: Loaded eagerly on category navigate — lightweight even at 500+ subscriptions (just metadata, no episodes, no inline artwork)
- **Episode lists**: Loaded lazily per-subscription on drill-down. VirtualScroller renders only visible rows — handles thousands of episodes per podcast
- **Feed refresh**: Batched with 5 concurrent requests (higher than download concurrency since feed fetches are small/fast) to avoid hammering servers. Progress indication for "refresh all" across many subscriptions
- **OPML import**: Subscriptions added incrementally with progress bar. Feeds fetched in batches (e.g., 5 at a time) to populate episode data
- **Download queue**: Concurrent limit (default 2) prevents bandwidth saturation. Queue persists across navigation (downloads continue while browsing other categories). Queue is not persisted across app restarts — in-progress downloads are abandoned and partial files cleaned up on next launch.
- **Artwork caching**: Stored as individual files on disk, referenced by path. Keeps subscriptions.json small regardless of subscription count.

## Feed Refresh Behavior

- **On category navigate**: Auto-refresh all subscriptions when user navigates to the podcasts category (if last refresh was more than 15 minutes ago, to avoid redundant fetches on quick navigation)
- **Manual refresh**: Per-podcast refresh link in drill-down header. "Refresh all" link in sub-tab bar.
- **On app launch**: Not in v1 scope. Feeds refresh when the user navigates to podcasts. Deferred to future enhancement (would require background polling or startup hook).

## Dependencies

- `fast-xml-parser` — RSS/Atom/OPML parsing. Lightweight, pure JS, no native deps.
- No other new dependencies. iTunes Search API is a simple HTTPS GET (use Node's built-in `https` or Electron's `net`). Downloads use Node streams.

## Future Enhancements (Out of Scope)

- **Zune device sync**: Push downloaded podcast episodes to Zune via MTP. Requires testing podcast audio file transfer and metadata mapping. Flagged for future work.
- **Auto-download**: Option to automatically download new episodes on refresh. Requires settings UI.
- **Episode limits**: Per-subscription setting to keep only N most recent episodes downloaded. Requires settings UI.
- **Full video podcast playback**: Video player integration for video podcast episodes. v1 plays audio track only via AudioPlayer.
- **PodcastIndex API**: Alternative/supplementary search backend to iTunes.
- **Auto-refresh on launch**: Background refresh on app startup or periodic polling.
- **Resumable downloads**: Resume partially-downloaded episodes after app restart.
