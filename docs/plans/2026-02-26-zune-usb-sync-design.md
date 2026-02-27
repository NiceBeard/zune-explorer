# Zune USB Sync — Design Document

**Date:** 2026-02-26
**Status:** Approved

## Overview

Add the ability to connect a physical Microsoft Zune device to the Zune Explorer app over USB, authenticate via the proprietary MTPZ protocol, and push media files (music, videos, photos) from the computer to the device. Pure JavaScript implementation — no native C library dependencies beyond node-usb.

## Goals

- One-way push: transfer files from Mac to Zune
- Zune HD first (VID `045E`, PID `063E`), Zune 30/32GB later
- Slide-out overlay panel UI, no disruption to existing navigation
- Real-time progress feedback during transfers
- Hotplug detection (plug in / unplug awareness)

## Non-Goals (for now)

- Pulling files off the Zune
- Two-way sync or library management
- Playlist creation on device
- DRM / Zune Marketplace integration
- Zune 30/32GB support (deferred to follow-up)

## Architecture

### Module Structure

```
src/main/
├── main.js                    # New IPC handlers for Zune operations
├── zune/
│   ├── zune-manager.js        # Top-level orchestrator: detect, connect, transfer
│   ├── usb-transport.js       # Raw USB bulk read/write via node-usb
│   ├── mtp-protocol.js        # MTP container encoding/decoding, operations
│   ├── mtpz-auth.js           # MTPZ 4-step crypto handshake
│   ├── mtpz-keys.js           # Extracted certificates & RSA keys from libmtp-zune
│   └── mtp-constants.js       # Operation codes, response codes, format codes
```

Each layer only depends on the one below it:

```
zune-manager  →  mtp-protocol  →  usb-transport
                     ↑
                 mtpz-auth
                     ↑
                 mtpz-keys
```

### Layer 1: USB Transport (`usb-transport.js`)

Raw USB communication via the `node-usb` npm package.

**Device identification:**
- Vendor ID: `0x045E` (Microsoft)
- Product ID: `0x063E` (Zune HD)

**Connection flow:**
1. Enumerate USB devices, filter by VID/PID
2. Open device, get configuration, claim the MTP interface
3. Find bulk IN and bulk OUT endpoints (512-byte max packet size)
4. All MTP communication uses bulk transfers only

**Hotplug detection:**
- `usb.on('attach')` / `usb.on('detach')` events from node-usb
- Emit events up to zune-manager on connect/disconnect

**API:**
```javascript
open(vendorId, productId)    // → device handle
close()                       // → cleanup
bulkWrite(data: Buffer)       // → Promise<void>
bulkRead(length: number)      // → Promise<Buffer>
onAttach(callback)            // hotplug: device plugged in
onDetach(callback)            // hotplug: device removed
```

### Layer 2: MTP Protocol (`mtp-protocol.js`)

Implements the MTP container format and specific operations needed for one-way push.

**Container format (every MTP message):**
```
Bytes 0-3:   Container Length (uint32 LE)
Bytes 4-5:   Container Type (uint16 LE) — 1=Command, 2=Data, 3=Response, 4=Event
Bytes 6-7:   Operation Code (uint16 LE)
Bytes 8-11:  Transaction ID (uint32 LE)
Bytes 12+:   Payload
```

**Operations needed:**

| Operation       | Code     | Purpose                                    |
|-----------------|----------|--------------------------------------------|
| GetDeviceInfo   | `0x1001` | Device capabilities and extensions         |
| OpenSession     | `0x1002` | Start MTP session                          |
| CloseSession    | `0x1003` | End session                                |
| GetStorageIDs   | `0x1004` | List storage volumes                       |
| GetStorageInfo  | `0x1005` | Capacity, free space                       |
| GetNumObjects   | `0x1006` | Count files on device                      |
| GetObjectHandles| `0x1007` | List files on device                       |
| GetObjectInfo   | `0x1008` | File metadata                              |
| SendObjectInfo  | `0x100C` | Announce incoming file (name, size, format) |
| SendObject      | `0x100D` | Transfer file bytes                        |

**Supported file format codes:**
- Audio: MP3 (`0x3009`), WMA (`0xB901`), AAC (`0xB903`)
- Video: WMV (`0xB981`), MP4 (`0xB982`)
- Image: JPEG (`0x3801`)

**Transfer flow for pushing a file:**
1. `SendObjectInfo` — declare file metadata (name, size, format, destination folder)
2. Zune responds with assigned storage ID and parent object handle
3. `SendObject` — stream file bytes in USB bulk packets
4. Zune responds with success/failure code

### Layer 3: MTPZ Authentication (`mtpz-auth.js`)

The proprietary Microsoft authentication layer. Runs after `OpenSession`, before any other MTP operations. Without it, the Zune refuses all commands.

**4-step handshake:**

```
Step 1: INIT (local)
  ├─ Load keys from mtpz-keys.js
  ├─ Expand AES-128 key with custom InvMixColumns variant
  ├─ Decrypt two AES blocks → CA cert + leaf cert + RSA private key
  └─ Ready to authenticate

Step 2: APPLICATION CERTIFICATE (app → Zune)
  ├─ Build message: marker (02 01) + 2 certificates + 16 random bytes
  ├─ SHA-1 hash the message
  ├─ RSA-sign the hash with private key (1024-bit, exponent 65537)
  ├─ Append 128-byte signature
  └─ Send via vendor-specific MTP operation

Step 3: DEVICE RESPONSE (Zune → app)
  ├─ Receive encrypted blob
  ├─ First 128 bytes = RSA-encrypted AES session key
  ├─ Decrypt session key with our RSA private key
  ├─ Decrypt remainder → device certs + echoed random bytes + signature + SHA-256 hash
  ├─ Verify device RSA signature against device certificate
  └─ Extract SHA-256 hash for Step 4

Step 4: CONFIRMATION (app → Zune)
  ├─ Derive 16-byte confirmation from SHA-256 hash
  ├─ Apply CBC-MAC transformation + encryption
  ├─ Send message: marker (02 03) + 16 bytes
  └─ Zune responds: authenticated or rejected
```

**Crypto primitives (all Node.js `crypto`):**
- `crypto.createCipheriv` / `createDecipheriv` — AES-128-ECB for cert decryption
- `crypto.privateDecrypt` / `crypto.sign` — RSA-1024 operations
- `crypto.createHash` — SHA-1 and SHA-256
- `crypto.randomBytes` — 16-byte nonce generation

**Custom AES note:** The key expansion applies InvMixColumns (Galois field multiplication with constants `0x0E`, `0x09`, `0x0D`, `0x0B`) to round keys. This is ~30 lines of math, documented in the libmtp-zune C source.

**Key source:** Certificates and RSA parameters extracted from the libmtp-zune project's `.mtpz-data` file. These are constant across all Zune devices ever manufactured.

### Layer 4: Zune Manager (`zune-manager.js`)

Top-level orchestrator. This is what `main.js` interfaces with.

**Connection lifecycle:**
```
USB attach event
  → Identify Zune by VID/PID
  → Open USB transport
  → MTP OpenSession
  → MTPZ authenticate
  → GetDeviceInfo (name, model, serial)
  → GetStorageInfo (capacity, free space)
  → Emit 'zune-connected' to renderer

USB detach event
  → Abort in-progress transfer
  → Clean up session
  → Emit 'zune-disconnected' to renderer
```

**Transfer queue:**
- Receives array of file paths from renderer
- Validates paths, reads file metadata, determines MTP format code
- Transfers files sequentially (MTP is single-threaded)
- Emits progress per file: `{ file, bytesTransferred, totalBytes, fileIndex, totalFiles }`
- Supports cancellation mid-transfer

### IPC Integration

New channels added to `main.js` and `preload.js`:

| Channel                | Direction        | Purpose                          |
|------------------------|------------------|----------------------------------|
| `zune-status`          | main → renderer  | Connection state changes         |
| `zune-device-info`     | renderer → main  | Get device name, storage, capacity |
| `zune-send-files`      | renderer → main  | Queue files for transfer         |
| `zune-transfer-progress` | main → renderer | Per-file and overall progress    |
| `zune-cancel-transfer` | renderer → main  | Abort current transfer           |

## UI: Sync Panel

A slide-out overlay panel on the right side of the viewport. Does not add a new section or disrupt existing panoramic navigation.

### Panel States

**No device:** Panel hidden, no UI elements shown.

**Connecting:** Toast slides in from right edge. Large "zune hd" text with "connecting..." subtitle and orange pulse animation.

**Connected, idle:**
- Toggle button appears (bottom-right or top-right area)
- Panel slides open/closed on click
- Shows: device name (large type), storage bar (orange-to-magenta gradient), free space text, drop zone for files, quick-sync category buttons

**Transfer in progress:**
- Current file name and per-file progress bar
- Overall transfer progress bar
- File count ("sending 3 of 47")
- Cancel button

**Transfer complete:** "47 files synced" message, fades back to idle state.

### Interaction Methods

1. **Drag and drop** — drag files from music/videos/pictures views onto the panel drop zone
2. **Context menu** — right-click file → "Send to Zune" option
3. **Quick sync buttons** — "sync music" / "sync videos" / "sync pictures" sends all scanned files of that category (with duplicate detection by filename)

### Styling

- Same dark theme: black background, white/gray text, orange accents
- Panel width: ~300px
- Slide animation: `cubic-bezier(0.25, 0.46, 0.45, 0.94)`, 400ms
- Storage bar: orange-to-magenta gradient (`#ff6900` → `#ff0066`)
- Drop zone: dashed border, lights up orange on dragover

## Dependencies

**New production dependency:**
- `usb` (node-usb) — USB device access from Node.js/Electron

**No other new dependencies.** All crypto via Node.js built-in `crypto` module.

## Device Reference

### Zune HD
- Vendor ID: `0x045E`, Product ID: `0x063E`
- USB 2.0, Class 255 (vendor-specific)
- Endpoints: bulk IN/OUT, 512-byte max packet
- Storage: Fixed RAM, ~32GB, generic hierarchical filesystem
- Vendor extensions: `microsoft.com/MTPZ: 1.0`
- Accepted formats: MP3, WMA, AAC, WMV, MP4, JPEG
- 86 supported MTP operations, 39 device properties

### Zune 32GB (deferred)
- Vendor ID: `0x045E`, Product ID: `0x0710`
- Similar MTPZ requirements, different firmware quirks

## References

- [libmtp-zune](https://github.com/kbhomes/libmtp-zune) — MTPZ implementation in C, key source
- [MTPZ protocol docs](https://github.com/kbhomes/libmtp-zune/blob/master/mtpz.md) — handshake details
- [Zune HD MTP device log](https://github.com/yifanlu/libMTP/blob/master/logs/mtp-detect-microsoft-zune-hd.txt) — full capability dump
- [ZuneSyncLinux](https://github.com/Klar/ZuneSyncLinux) — working Linux sync guide
- [node-usb](https://github.com/node-usb/node-usb) — USB library for Node.js
- [MTP spec](https://www.usb.org/sites/default/files/MTPv1_1.zip) — USB Implementer's Forum
- [PTP over USB spec](https://people.ece.cornell.edu/land/courses/ece4760/FinalProjects/f2012/jmv87/site/img/pima15740-2000.pdf) — container format reference
