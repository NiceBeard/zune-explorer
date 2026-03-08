# Pins & Playlists Design

## Overview

Two features that enhance the Zune Explorer experience:

1. **Pins** — Pin any navigable item (file, folder, album, artist, genre, playlist) to the left sidebar above the recent files section.
2. **Playlists & Now Playing** — Create and manage playlists under the Music tab, with a persistent Now Playing queue.

## Feature 1: Pins

### Data Model

Storage: `pins.json` in app's userData directory.

Schema — array of pin objects:
```json
[
  {
    "id": "uuid",
    "type": "file|folder|album|artist|genre|playlist",
    "label": "Display Name",
    "path": "/path/to/file",
    "meta": { "category": "music", "albumKey": "...", "artistName": "..." },
    "createdAt": "ISO timestamp"
  }
]
```

- `type` + `meta` determine navigation behavior on click
- `path` is the primary identifier for files/folders; `meta` fields identify music library entities

### Left Sidebar Layout

New layout (replaces current single-section):
```
[ pinned (header, muted white) ]
[ 2-col grid of pinned items ]
[ recent (header, muted white) ]
[ 2-col grid of recent files ]
```

- "pinned" and "recent" headers use muted white text (not orange gradient) — matches Zune HD style
- If no pins exist, the pinned section is hidden entirely
- Pinned items use the same tile size as recent items with type-appropriate icons/thumbnails
- No hard max on pins; section scrolls with the rest of the sidebar

### Interactions

- **Pin:** Right-click any navigable item → "Pin to sidebar"
- **Unpin:** Right-click a pinned item in sidebar → "Unpin"
- **Click:** Navigates to the item (opens file, drills into album, browses folder, etc.)
- **Drag:** Pinned items remain draggable to sync panel (for files)

### Context Menu Integration

Existing `showContextMenu()` gets "Pin to sidebar" for all navigable items. Items already pinned show "Unpin from sidebar" instead.

## Feature 2: Playlists

### Data Model

Storage: `~/.zune-explorer/playlists/` directory, one JSON file per playlist.

Filename: slugified playlist name (e.g. `my-chill-mix.json`).

Schema:
```json
{
  "id": "uuid",
  "name": "My Chill Mix",
  "createdAt": "ISO timestamp",
  "modifiedAt": "ISO timestamp",
  "tracks": [
    { "path": "/path/to/song.mp3", "title": "Song", "artist": "Artist", "album": "Album", "duration": 245 }
  ]
}
```

- Track entries store metadata for rendering without re-scanning; `path` is source of truth for playback
- Missing files shown grayed out / strikethrough

### Tab Integration

- Add `'playlists'` to existing music sub-tabs: `['albums', 'artists', 'songs', 'genres', 'playlists']`
- New `case 'playlists'` in `renderMusicSubContent()` switch
- New `renderMusicPlaylistsView(container)` method

### Playlist List View (root)

- Each row: **Playlist name** (white), subtext **"12 songs · 45 min"** (gray)
- Click drills into playlist detail
- Right-click → "Delete Playlist" with confirmation
- "New playlist" option at the top

### Playlist Detail View (drilled in)

- Header stats: "12 songs · 45 min"
- Track list: album art thumbnail, title, subtext "Artist - Album"
- Drag-to-reorder with drag handles; reorder saves to JSON file
- Right-click track → "Remove from Playlist"
- Back button returns to playlist list (existing drill-down pattern)
- Hero header shows playlist name

### Creating Playlists

- Right-click any song/album/artist → "Add to Playlist >" submenu with existing playlists + "New Playlist..."
- "New Playlist..." prompts for name (input dialog), creates file, adds tracks

## Feature 3: Now Playing

### Data Model

- In-memory: `this.nowPlaying = { tracks: [], currentIndex: 0 }`
- Persistence: `now-playing.json` in app userData, saved on every change
- On launch: loaded from file but no auto-play; available as queue if user hits play

Schema:
```json
{
  "tracks": [
    { "path": "...", "title": "...", "artist": "...", "album": "...", "duration": 245 }
  ],
  "currentIndex": 3
}
```

### Playback Integration

- **Click a song:** Replaces Now Playing with that song (or current list context — clicking song 5 in an album loads the album starting at track 5)
- **Click an album/artist:** Replaces Now Playing with all tracks, starts at track 1
- **"Add to Now Playing" (right-click):** Appends tracks to end of queue without interrupting playback
- `playTrack()` updated to work off `nowPlaying`; advancing pulls from queue

### Now Playing in the Playlists Tab

- Appears as special entry at top of Playlists list, visually distinct with muted white styling
- Separated from user playlists by subtle divider
- Drilling in shows same track list UI as regular playlists (drag-to-reorder, album art, track info)
- Currently playing track highlighted with orange accent
- Right-click track → "Remove from Now Playing"

### Context Menu Additions

All song/album/artist items get:
- **"Add to Now Playing"** — appends to queue
- **"Add to Playlist >"** — submenu with existing playlists + "New Playlist..."
