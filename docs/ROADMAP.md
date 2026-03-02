# Zune Explorer Roadmap

Future ideas and feature wishlist. Not prioritized — just captured for when inspiration strikes.

## Zune Sync

### ~~Browse Zune Contents~~ (Done)
List files on the connected Zune by category (music, videos, pictures) with metadata. Includes tab navigation and scrollable file list with checkboxes.

### ~~Delete Files from Zune~~ (Done)
Select files and delete via MTP DeleteObject with confirm-on-second-click safety. Handles stale handles (InvalidObjectHandle) gracefully.

### ~~Eject Button~~ (Done)
Cleanly disconnect via CloseSession + USB close. The Zune exits its syncing screen without quitting the app.

### ~~Album Metadata~~ (Done)
Solved by creating Artist objects (format 0xB218) and Abstract Audio Album objects (format 0xBA03) with ArtistId (0xDAB9) linking and SetObjectReferences (0x9811). The Zune ignores per-track Artist/AlbumName string properties — it requires these abstract MTP objects to display metadata.

### ~~Album Art~~ (Done)
Extracts embedded cover art from audio files and sets it on the album object via RepresentativeSampleData (0xDC86).

### Fix Drag-and-Drop to Sync Panel
Dragging files from the file explorer onto the "drop files here" zone doesn't work. May be an Electron drag event or CSS issue.

### Zune 32GB Testing
Verify the full sync flow on the brown Zune 32GB (PID 0x0710). May have different MTP behavior or endpoint configuration.

### Two-Way Sync
Pull files from the Zune to the computer via MTP GetObject. Could enable backup/restore workflows.

## Music Experience Enhancements

### Sub-Category Navigation (Zune HD Style)
When entering a category like Music, show the title flowing off the top in giant font with horizontal scrollable sub-categories below (ALBUMS, ARTISTS, SONGS, PLAYLISTS). Album art grid with alphabetical letter dividers — exactly like the Zune HD browsing experience.

Reference: `docs/music-zune.png`

### Playlists
Create, edit, and save playlists as JSON files. Add a "playlists" sub-category under Music. Drag-to-reorder, save/load, delete.

### Spotify / Streaming Integration
Connect to Spotify (or other services) via OAuth and browse your library through the Zune UI. Use the Web Playback SDK to play tracks directly in the app. Full Zune HD experience with your actual streaming library.

## File Management

### Cloud Storage Integration
Browse Google Drive, OneDrive, and other cloud storage via their REST APIs. Show them as additional roots alongside local directories. Music files from cloud storage could stream or cache locally for playback.

### External Storage Detection
Detect mounted volumes (USB drives, external disks) and expose them as browsable roots. Surface media files from external storage into the appropriate categories.

### Pins
Pin frequently used files or folders to the left sidebar alongside recent files. Persist pins in local storage across sessions.

## UI / UX

### Left Sidebar Expansion
Currently the left sidebar only shows recent files. Could expand to include pins, playlists, and quick-access items.

### Zune HD as a Design System
The dream: Zune HD's design language applied as a full desktop OS experience. Bold typography as navigation, panoramic horizontal scrolling, dark theme with accent colors, touch-friendly targets. Every screen follows the giant-header-with-sub-categories pattern.
