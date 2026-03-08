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

### ~~Multi-Category Sync Diff~~ (Done)
Sync diff view now supports music, videos, and pictures via Zune HD-style category tabs (MUSIC / VIDEOS / PHOTOS). Music uses metadata+filename matching; videos/pictures use filename matching. Delete-from-device button with two-click confirmation on the device-only tab. ZMDB handle resolution extended to videos and pictures.

### ~~ZMDB Fast Path~~ (Done)
Parses the Zune's internal binary media database (ZMDB) in a single vendor bulk transfer — 7561 tracks in 0.5 seconds vs 10+ minutes for MTP enumeration. Based on reverse-engineering work by [@magicisinthehole](https://github.com/magicisinthehole/XuneSyncLibrary). Supports both Classic (ZMed v2) and HD (ZMed v5) field layouts. ZMDB atom IDs work directly as MTP handles for GetObject, with a lazy resolver fallback. Pulled files saved as "Artist - Title.mp3" instead of cryptic device filenames.

## Music Experience Enhancements

### ~~Sub-Category Navigation (Zune HD Style)~~ (Done)
Music view with giant hero header, horizontal sub-tabs (ALBUMS, ARTISTS, SONGS, GENRES), album art grid with letter dividers, alpha jump overlay, and drill-down views for albums and artists. Batch metadata scanning with progressive loading. Playback integration from any sub-view.

### ~~Playlists~~ (Done)
Create, edit, and save playlists as individual JSON files. PLAYLISTS sub-tab under Music with drill-down detail view, drag-to-reorder, and context menu integration. "Add to Playlist" and "New Playlist..." available from any song, album, artist, or genre context menu.

### ~~Now Playing~~ (Done)
Persistent Now Playing queue. Clicking a song/album/artist replaces the queue; "Add to Now Playing" appends without interrupting playback. Queue persists across app restarts (no auto-play on launch). Accessible as a special entry at the top of the Playlists tab with current-track highlighting.

### Spotify / Streaming Integration
Connect to Spotify (or other services) via OAuth and browse your library through the Zune UI. Use the Web Playback SDK to play tracks directly in the app. Full Zune HD experience with your actual streaming library.

## File Management

### Cloud Storage Integration
Browse Google Drive, OneDrive, and other cloud storage via their REST APIs. Show them as additional roots alongside local directories. Music files from cloud storage could stream or cache locally for playback.

### ~~External Storage Detection~~ (Done)
Detect mounted volumes (USB drives, external disks) and expose them as browsable roots. Surface media files from external storage into the appropriate categories.

### ~~Deep Folder Scanning & Symlink Support~~ (Done)
Media scanning now recurses to unlimited depth (was capped at 3 levels). Symlinks are followed correctly — a symlink to an external volume is treated as a directory and traversed.

### ~~Pins~~ (Done)
Pin any navigable item (file, folder, album, artist, genre, playlist) to the left sidebar above recent files. Pins persist in JSON across sessions. Right-click "Pin to sidebar" / "Unpin" on any item. Clicking a pin navigates directly to the item.

## UI / UX

### ~~Left Sidebar Expansion~~ (Done)
Left sidebar now has a "pinned" section above "recent", both with muted white Zune HD-style headers. Pinned items support all navigable types. Sidebar scrolls naturally with both sections.

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
