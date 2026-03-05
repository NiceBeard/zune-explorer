# Zune Explorer

A desktop app that brings the Zune HD interface to life as a file explorer and music manager. Browse your local files, play music, and sync with physical Zune devices over USB — all through a faithful recreation of the Zune HD's bold typography, panoramic scrolling, and dark aesthetic.

Built with Electron. Runs on macOS and Windows.

## Features

### Zune HD Interface
- **Panoramic horizontal scrolling** between categories with momentum and snap
- **Giant hero headers** (340px, weight 100) that clip off the top edge — just like the Zune HD
- **Dark theme** with orange-to-magenta accent gradient
- **Music sub-categories** — albums, artists, songs, and genres with album art grids, letter dividers, and alpha jump overlay
- **Built-in music player** with album art display
- Files automatically organized into **music**, **videos**, **pictures**, **documents**, and **applications**
- Browsable file system in the documents category with smart root directories
- Recently accessed files surfaced via platform-native APIs

<img width="1283" height="722" alt="image" src="https://github.com/user-attachments/assets/d0cadec0-f2a5-4305-9aeb-886831145856" />
<img width="1283" height="722" alt="image" src="https://github.com/user-attachments/assets/01eb0624-7e22-4ab2-a455-03632a22a5dc" />
<img width="1283" height="722" alt="image" src="https://github.com/user-attachments/assets/902062f3-200f-45f3-be01-a048cea01798" />


### Zune USB Sync
Connect a physical Zune to manage your music library — no Zune desktop software or Windows required.
<img width="1283" height="722" alt="image" src="https://github.com/user-attachments/assets/fd9299f4-06c1-41cd-b7ee-086dd4f53c5a" />


- **Pure JavaScript MTP/MTPZ stack** — implements the Zune's encrypted USB protocol from scratch
- **Two-way sync** — push music to the Zune or pull tracks to your computer
- **Sync management view** — expanded diff view with grouped selection by album/artist, select-all, and collapsible groups
- **Smart diff engine** — compares local and device libraries by filename and metadata to show what's missing from each side
- **Drag-and-drop transfer** with real-time progress streaming
- **Automatic format conversion** — WAV/FLAC/OGG/AIFF to MP3 320k on push; WMA to MP3 320k on pull
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

Produces a DMG on macOS (with a custom Zune-themed installer background) and NSIS/portable on Windows. See [BUILD_INSTRUCTIONS.md](BUILD_INSTRUCTIONS.md) for details.

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
└── device-cache.js     # Per-device scan result caching
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

Platform-specific code is isolated in `src/main/platform-darwin.js` and `src/main/platform-win32.js` — recent files, application discovery, and icon extraction are handled natively per OS.

## Platforms

| Platform | Status |
|----------|--------|
| macOS    | Full support (Spotlight for recent files, sips for icons, custom DMG installer) |
| Windows  | Full support (Recent folder, Start Menu discovery, custom title bar) |

## License

[MIT](LICENSE)
