# Zune Explorer

A file explorer and Zune device manager inspired by the Zune HD interface, built with Electron. Features a panoramic horizontal scrolling UI with files organized into categories and a pure JavaScript MTP/MTPZ stack for syncing music to physical Zune devices over USB.

<img width="1276" height="715" alt="image" src="https://github.com/user-attachments/assets/48113e85-121e-4ff3-b28a-99679dde9df9" />

## Features

### File Explorer
- **Horizontal panoramic navigation** between file categories
- **Dark theme** with Zune HD-inspired orange accent colors
- Files automatically organized into **music**, **videos**, **pictures**, **documents**, and **applications**
- **Documents** category provides a browsable file system with smart root directories
- Recently accessed files surfaced via platform-native APIs
- Native app icon extraction
- Frameless window with custom title bar on Windows
- Built-in music player with album art

### Zune USB Sync
- **Pure JavaScript MTP/MTPZ implementation** — no native drivers or Zune software required
- **MTPZ authentication** with RSA/AES/CMAC handshake for Zune's encrypted protocol
- **Drag-and-drop file transfer** with real-time progress tracking
- **Automatic format conversion** — WAV, FLAC, OGG, AIFF converted to MP3 320k via ffmpeg
- **ID3v2.3 retagging** — MP3s automatically retagged for Zune compatibility (Zune can't read ID3v2.4)
- **Full metadata support** — title, artist, album, genre, track number, duration
- **Artist & album objects** — creates MTP Artist (0xB218) and AbstractAudioAlbum (0xBA03) objects with ArtistId linking, which the Zune requires to display metadata in its UI
- **Album art** — extracts embedded cover art from audio files and sets it on the album object via RepresentativeSampleData
- **Browse device contents** — view music, videos, and pictures on the Zune organized by category
- **Delete files** from the device with confirm-on-second-click safety
- **Eject** to cleanly disconnect without quitting the app
- **USB hotplug detection** — automatically detects when a Zune is plugged in or removed

### Supported Zune Devices
- Zune HD (all storage sizes)
- Zune 4/8/16/30/32/80/120

## Supported Platforms

- **macOS** — uses Spotlight (`mdfind`, `mdls`) for recent files, `sips` for icon conversion
- **Windows** — uses Windows Recent folder for recent files, Start Menu for application discovery

## Requirements

- Node.js 18+
- A Zune device and USB cable (for sync features)
- MTPZ key data file (for Zune authentication)

## Getting Started

```bash
# Install dependencies
npm install

# Run the app
npm start

# Run in development mode (with DevTools)
npm run dev
```

## Building

```bash
# Build distributable
npm run build
```

See [BUILD_INSTRUCTIONS.md](BUILD_INSTRUCTIONS.md) for detailed build and installation steps.

## Architecture

### MTP/MTPZ Stack

The Zune sync feature is built from scratch in pure JavaScript:

```
src/main/zune/
├── usb-transport.js    # Raw USB communication via node-usb, hotplug detection
├── mtp-protocol.js     # MTP container encoding/decoding, all MTP operations
├── mtp-constants.js    # Operation codes, response codes, object formats, properties
├── mtpz-auth.js        # MTPZ RSA/AES/CMAC authentication handshake
└── zune-manager.js     # High-level orchestrator: sync, browse, delete, eject
```

The sync pipeline:
1. USB device detection and claim
2. MTP session open
3. MTPZ 6-step authentication handshake
4. Format conversion (non-native formats → MP3 via ffmpeg)
5. ID3v2.3 retagging (Zune ignores ID3v2.4)
6. File transfer via SendObjectInfo/SendObject
7. Per-track metadata via SetObjectPropValue
8. Artist object creation (format 0xB218) with Name property
9. Abstract Audio Album creation (format 0xBA03) with track references
10. ArtistId (0xDAB9) linking on albums and tracks
11. Album art via RepresentativeSampleData (0xDC86)

## License

[MIT](LICENSE)
