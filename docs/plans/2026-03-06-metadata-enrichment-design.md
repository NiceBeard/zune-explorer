# Metadata Enrichment — Design

## Overview
Manual metadata lookup via MusicBrainz + Cover Art Archive. User right-clicks an album or artist to fetch missing/corrected metadata. Results are cached locally and used for display and Zune device sync without modifying original files.

## Data Source
- **MusicBrainz API** — album/artist/track metadata (title corrections, genre, year, track numbers)
- **Cover Art Archive** — album cover art (linked from MusicBrainz releases)
- No API key required. Rate limit: 1 request/second (throttled accordingly).
- User-Agent header required per MusicBrainz policy: `ZuneExplorer/1.1.0 (https://github.com/NiceBeard/zune-explorer)`

## Lookup Flow
1. User right-clicks an album → "Look up metadata"
2. App queries MusicBrainz: search by album name + artist
3. If multiple matches, show a picker (top 3-5 results with release year/label to disambiguate)
4. User confirms the match
5. Fetch full release metadata (track listing, genre, year) + cover art from Cover Art Archive
6. Cache the results and refresh the UI

Artist lookup works similarly — search by artist name, fetch artist metadata, apply to all their albums where applicable.

## Metadata Cache
- Stored as a JSON file per library (e.g., `~/.zune-explorer/metadata-cache.json`)
- Keyed by a normalized `artist|album` string
- Stores: album art URL/base64, genre, year, corrected track names, MusicBrainz release ID
- The music library rendering merges cached metadata over embedded tags (cache wins where present)
- Cache persists across app restarts

## UI Integration
- **Right-click context menu** on album tiles, artist rows, and album detail views: "Look up metadata"
- **Lookup progress indicator** — subtle spinner or status text while fetching
- **Match picker dialog** — when MusicBrainz returns multiple results, show a simple list with release name, artist, year, and label so the user can pick the right one
- **Visual indicator** on albums/artists that have been enriched (optional, subtle)

## Zune Sync Integration
- When syncing to device, the sync code checks the metadata cache first
- If cached metadata exists for a track's album, use it for MTP properties (artist, album, genre, year, track number) and album art (RepresentativeSampleData)
- Falls back to embedded file tags as before

## Optional Write-Back (Future)
- Not in initial scope, but the architecture supports adding a "Save to file" action later that writes cached metadata back into ID3/Vorbis tags

## Out of Scope
- No automatic/background lookups
- No artist images (just album covers — MusicBrainz doesn't have great artist photos)
- No lyrics
- No file modification
