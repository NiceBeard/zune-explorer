# External Volumes & Drive Access Design

## Problem

1. Users can't browse paths outside their home directory on Windows (e.g. `C:\music`) because `getAllowedPrefixes()` doesn't include drive roots.
2. External drives (USB, SD cards) and cloud-synced folders (Google Drive, OneDrive, iCloud) aren't discoverable in the file explorer.

## Solution

Add external volume discovery to both platforms and display them as tiles in the documents root view alongside existing smart roots.

## Drive Discovery

**New function `getExternalVolumes()`** added to both platform modules:

- **macOS:** Read `/Volumes/`, filter out the boot volume. Each remaining entry is an external/cloud volume.
- **Windows:** Iterate drive letters A-Z, check which exist. Include all detected drives (including `C:\` since users need paths like `C:\music`).

Returns `[{ name, path, kind: 'volume' }]`.

**New IPC handler** `get-external-volumes` exposed via preload.

**Security:** Update `getAllowedPrefixes()`:
- macOS: add `/Volumes`
- Windows: add each detected drive letter root

## Renderer Integration

- After loading smart roots on init, call `getExternalVolumes()` and store as `this.externalVolumes`
- Documents root view renders external volumes as a second grid below the smart roots grid
- No divider label — color difference is sufficient
- External volume tiles use **blue folder icons** (`#4a9eff`) instead of orange to visually distinguish from smart roots
- Same tile layout/size, clicking navigates into the volume
- If no external volumes detected, second grid doesn't render

## Files Changed

| File | Change |
|------|--------|
| `src/main/platform-darwin.js` | Add `getExternalVolumes()`, update `getAllowedPrefixes()` |
| `src/main/platform-win32.js` | Add `getExternalVolumes()`, update `getAllowedPrefixes()` |
| `src/main/main.js` | Add `get-external-volumes` IPC handler |
| `src/main/preload.js` | Expose `getExternalVolumes` |
| `src/assets/js/renderer.js` | Load volumes on init, render volume tiles in documents root |
| `src/assets/css/styles.css` | Blue folder icon variant for volume tiles |
