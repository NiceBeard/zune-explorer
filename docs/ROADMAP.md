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

### ~~Fix Drag-and-Drop to Sync Panel~~ (Done)
Drag-and-drop file transfer to the sync panel working.

### ~~Zune 30 Testing~~ (Done)
Verified full sync flow on the Zune 30 (PID 0x0710). Required dynamic USB endpoint discovery (different MTP interface layout than Zune HD) and USB 2.0 port (USB 3.0 doesn't enumerate the device). Scan progress streaming added for all phases.

### ~~Two-Way Sync~~ (Done)
Pull files from the Zune to the computer via MTP GetObject. WMA files automatically converted to MP3 320k via ffmpeg. Device metadata (title, artist, album, genre, track number) embedded as ID3 tags. Album art from Zune's AbstractAudioAlbum objects embedded as cover art. Full-screen sync management view with grouped selection by album/artist, select-all, collapsible groups, and smart diff engine comparing local and device libraries.

## Music Experience Enhancements

### ~~Sub-Category Navigation (Zune HD Style)~~ (Done)
Music view with giant hero header, horizontal sub-tabs (ALBUMS, ARTISTS, SONGS, GENRES), album art grid with letter dividers, alpha jump overlay, and drill-down views for albums and artists. Batch metadata scanning with progressive loading. Playback integration from any sub-view.

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

### ~~USB Hotplug Detection~~ (Done)
Fixed hotplug by wrapping libusb device directly via WebUSBDevice.createInstance() instead of WebUSB requestDevice(), which can't see devices connected after app start. Retry with escalating delays for device initialization.

### ~~Sync Panel Redesign~~ (Done)
Zune HD-style sync panel: segmented storage bar (music/videos/pictures/other), borderless text navigation, subtle drop zone, back arrow overlapping header, inline rescan link, eject icon with hover tooltip, panel edge bar toggle, play icon on music category in explore menu.

### Zune HD as a Design System (In Progress)
The dream: Zune HD's design language applied as a full desktop OS experience. Bold typography as navigation, panoramic horizontal scrolling, dark theme with accent colors, touch-friendly targets.

**Completed:**
- Giant hero header pattern on all categories (340px, weight 100, muted white, clips off top edge)
- Hero headers persist through folder browsing (dynamic folder name as hero text)
- Zune HD angular back button SVG (square linecaps, miter joins)
- Visual hierarchy: bright active tabs, dim inactive tabs, orange accents
- Music sub-category tabs with Zune HD styling
- Sync panel with Zune text-as-navigation, segmented storage, panel edge bar
- Play icon on music menu item (matching Zune HD home screen)

**Remaining:**
- Now Playing screen in Zune HD style (full-screen album art, minimal controls)
- Animations and transitions between views (slide, fade, momentum)
- Touch/gesture support for horizontal panoramic scrolling
- Accent color theming (user-selectable color beyond orange)

## Distribution

### ~~Custom DMG Installer~~ (Done)
Zune-themed DMG background (black, orange-to-magenta gradient, orange folder icon, drag arrow). Built with appdmg to work around electron-builder's DS_Store corruption bug on macOS.
