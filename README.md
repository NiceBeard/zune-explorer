# Zune Explorer

A desktop app that brings the Zune HD interface to life as a file explorer and music manager. Browse your local files, play music, and sync with physical Zune devices over USB — all through a faithful recreation of the Zune HD's bold typography, panoramic scrolling, and dark aesthetic.

Built with Electron. Runs on macOS, Windows, and Linux.

## Features

### Zune HD Interface
- **Panoramic horizontal scrolling** between categories with momentum and snap
- **Giant hero headers** (340px, weight 100) that clip off the top edge — just like the Zune HD
- **Dark theme** with orange-to-magenta accent gradient
- **Music sub-categories** — albums, artists, songs, genres, and playlists with album art grids, letter dividers, and alpha jump overlay
- **Built-in music player** with album art display and unsupported format notifications
- **Playlists** — create, edit, and reorder playlists from anywhere in the music section. Individual JSON files per playlist with drag-to-reorder and play all
- **Now Playing** — persistent queue that survives app restarts. Click a song to replace the queue, "Add to Now Playing" to append. Accessible from the Playlists tab
- **Pins** — pin any navigable item (file, folder, album, artist, genre, playlist) to the left sidebar. Right-click to pin/unpin. Pinned albums and artists show album art
- **Deep folder scanning** — recurses through your entire music/videos/pictures directory tree, no matter how nested
- **Symlink support** — follows symlinks to external drives and network volumes
- Files automatically organized into **music**, **videos**, **pictures**, **documents**, and **applications**
- Browsable file system in the documents category with smart root directories
- **External drive discovery** — mounted volumes and drives appear in the documents root view
- **Left sidebar** with pinned section above recent files, both with muted white Zune HD-style headers
- Recently accessed files surfaced via platform-native APIs

### Metadata Enrichment
- **MusicBrainz lookup** — search for album metadata by artist and album name
- **Cover Art Archive** integration — fetch album art from the open cover art database
- **Preview before applying** — review matched results with thumbnails before committing
- **Persistent metadata cache** — enriched album art, year, and genre survive app restarts
- **Automatic cache restore** — cached metadata applied to the music library on startup

<img width="1283" height="722" alt="image" src="https://github.com/user-attachments/assets/d0cadec0-f2a5-4305-9aeb-886831145856" />
<img width="1283" height="722" alt="image" src="https://github.com/user-attachments/assets/01eb0624-7e22-4ab2-a455-03632a22a5dc" />
<img width="1283" height="722" alt="image" src="https://github.com/user-attachments/assets/902062f3-200f-45f3-be01-a048cea01798" />


### Zune USB Sync
Connect a physical Zune to manage your music library — no Zune desktop software or Windows required.
<img width="1283" height="722" alt="image" src="https://github.com/user-attachments/assets/fd9299f4-06c1-41cd-b7ee-086dd4f53c5a" />


- **Pure JavaScript MTP/MTPZ stack** — implements the Zune's encrypted USB protocol from scratch
- **Multi-category sync** — diff and transfer music, videos, and pictures between device and computer
- **Delete from device** — remove selected files from the Zune directly in the sync diff view
- **Pull destination picker** — choose where to save pulled tracks, with last-used folder memory
- **Sync management view** — expanded diff view with grouped selection by album/artist, select-all, and collapsible groups
- **Album art in sync view** — device-only tracks show cover art from your local library
- **Smart diff engine** — compares local and device libraries by filename and metadata (music) or filename (videos/pictures) to show what's missing from each side
- **ZMDB fast scan** — reads the Zune's internal media database for instant library enumeration with auto-detection of HD vs Classic format
- **Drag-and-drop transfer** with real-time progress streaming
- **Automatic format conversion** — WAV/FLAC/OGG/AIFF to MP3 320k on push; WMA to MP3 320k on pull
- **Extensionless file detection** — identifies audio files pulled without extensions and offers to fix them
- **ID3v2.3 retagging** — MP3s retagged for Zune compatibility (Zune ignores ID3v2.4)
- **Full metadata** — title, artist, album, genre, track number, duration
- **Album art** preserved in both directions
- **Artist & album hierarchy** — creates the MTP abstract objects the Zune requires to display metadata
- **Device content caching** — skips slow MTP enumeration on reconnect
- **Browse, delete, eject** — full device management from the sync panel
- **USB hotplug** — automatically detects when a Zune is plugged in or removed

### Supported Devices
- Zune HD (16GB, 32GB, 64GB)
- Zune 30, 4, 8, 16, 32, 80, 120

## Download

Grab the latest release from the [Releases page](https://github.com/NiceBeard/zune-explorer/releases).

| Platform | Architecture | File |
|----------|-------------|------|
| macOS | Apple Silicon (M1/M2/M3/M4) | `Zune Explorer-*-arm64.dmg` |
| macOS | Intel | `Zune Explorer-*.dmg` |
| Windows | x64 | `Zune Explorer Setup *.exe` |
| Linux | x64 | `Zune Explorer-*.AppImage` |

### macOS Gatekeeper Notice

The app is not yet code-signed. macOS will block it on first launch. To open it:

1. Open the DMG and drag Zune Explorer to Applications
2. **Right-click** (or Control-click) the app in Applications → **Open**
3. Click **Open** in the dialog that appears

You only need to do this once. Alternatively, run in Terminal:
```bash
xattr -cr /Applications/Zune\ Explorer.app
```

### Requirements
- A Zune device and USB cable (for sync features)
- MTPZ key data file at `~/.mtpz-data` (required for Zune authentication — see [MTPZ Keys](#mtpz-keys))
- USB 2.0 port recommended for Zune 30/classic models

### Linux: USB Permissions

By default, Linux requires root access for USB devices. To allow Zune Explorer to communicate with your Zune as a regular user, create a udev rule:

```bash
sudo tee /etc/udev/rules.d/69-zune.rules << 'EOF'
# Zune HD
SUBSYSTEM=="usb", ATTR{idVendor}=="045e", ATTR{idProduct}=="063e", MODE="0666"
# Zune (classic)
SUBSYSTEM=="usb", ATTR{idVendor}=="045e", ATTR{idProduct}=="0710", MODE="0666"
EOF
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Then unplug and replug your Zune.

### Windows: USB Driver

The app uses libusb to talk directly to the Zune over USB. Windows claims Zune devices with its own MTP driver by default, which blocks libusb access. A WinUSB driver is required.

**NSIS installer (recommended):** The installer automatically stages the WinUSB driver via `pnputil` during installation. Plug in your Zune after installation and it should be detected.

**In-app setup:** If the installer couldn't stage the driver (e.g. you're using the portable build), plug in your Zune and Zune Explorer will detect the conflict and show an **"install usb driver"** button in the sync panel. Click it, approve the UAC prompt, then unplug and replug your Zune.

**Manual fallback (Zadig):** If the automatic install doesn't work, use [Zadig](https://zadig.akeo.ie/) — select your Zune, choose the WinUSB driver, and click Replace Driver. After switching to WinUSB the Zune will no longer appear as a portable device in Windows Explorer, but Zune Explorer will manage it directly. To revert, open Device Manager, find the Zune, and uninstall its driver.

## Building from Source

```bash
npm install
npm start
```

Development mode with DevTools:
```bash
npm run dev
```

Build distributable:
```bash
npm run build
```

Produces a DMG on macOS (with a custom Zune-themed installer background), NSIS/portable on Windows, and AppImage on Linux. See [BUILD_INSTRUCTIONS.md](BUILD_INSTRUCTIONS.md) for details.

### MTPZ Keys

Zune devices require MTPZ authentication before they'll accept MTP commands. You need a key data file placed at `~/.mtpz-data`. This file contains the RSA certificate chain and encryption keys used in the MTPZ handshake. The app will connect to the Zune without it, but authentication will fail and the device won't allow file operations.

## Architecture

### MTP/MTPZ Stack

The entire Zune communication layer is pure JavaScript — no native MTP libraries, no libmtp, no Zune desktop software dependencies:

```
src/main/zune/
├── usb-transport.js    # USB communication via node-usb, dynamic endpoint discovery, hotplug
├── mtp-protocol.js     # MTP container encoding/decoding, all MTP operations
├── mtp-constants.js    # Operation codes, response codes, object formats, property codes
├── mtpz-auth.js        # MTPZ RSA/AES/CMAC authentication handshake
├── zune-manager.js     # High-level orchestrator: connect, sync, browse, delete, eject
├── zmdb-parser.js      # Zune Media Database binary parser (HD + Classic formats)
└── device-cache.js     # Per-device scan result caching

src/main/
├── musicbrainz.js      # MusicBrainz / Cover Art Archive API client
└── metadata-cache.js   # Persistent metadata cache (album art, year, genre)
```

### Push-to-Device Pipeline
1. USB device detection and interface claim
2. MTP session open → MTPZ 6-step authentication handshake
3. Format conversion (non-native formats → MP3 320k via ffmpeg)
4. ID3v2.3 retagging for Zune compatibility
5. File transfer via SendObjectInfo + SendObject
6. Per-track metadata via SetObjectPropValue
7. Artist object creation (format 0xB218)
8. Abstract Audio Album creation (format 0xBA03) with track references and ArtistId linking
9. Album art via RepresentativeSampleData

### Pull-from-Device Pipeline
1. MTP GetObject retrieves raw file bytes
2. WMA → MP3 320k conversion via ffmpeg
3. Device metadata embedded as ID3 tags
4. Album art from Zune's album objects embedded as cover art

### Platform Modules

Platform-specific code is isolated in `src/main/platform-darwin.js`, `src/main/platform-win32.js`, and `src/main/platform-linux.js` — recent files, application discovery, and icon extraction are handled natively per OS.

## Platforms

| Platform | Status |
|----------|--------|
| macOS    | Full support (Spotlight for recent files, sips for icons, custom DMG installer) |
| Windows  | Full support (Recent folder, Start Menu discovery, custom title bar) |
| Linux    | Full support (freedesktop recent files, .desktop app discovery, XDG icon themes, AppImage) |

## License

[MIT](LICENSE)
