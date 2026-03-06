# Pull Destination Picker Design

## Problem

When pulling songs from the Zune to the computer, files always go to `~/Music`. Users want to choose the destination, especially for saving to external drives.

## Solution

Show an OS-native folder picker dialog when the user clicks "copy to computer". Remember the last-used folder between sessions.

## Flow

1. User selects tracks and clicks "copy to computer"
2. Native folder picker dialog opens, defaulting to last-used path (or `~/Music` on first use)
3. User picks a folder → pull proceeds to that location
4. If user cancels the dialog → pull is aborted
5. Chosen path is persisted to `pull-destination.json` in userData

## Implementation

**Main process:** New IPC handler `pick-pull-destination` opens `dialog.showOpenDialog` with `openDirectory` property. Reads/writes `pull-destination.json` in userData to remember the last pick.

**Renderer:** `_pullFromDevice()` calls the picker before starting the pull. Uses returned path as `destDir`. Aborts if user cancels.

**No UI changes** beyond the native OS dialog.

## Files Changed

| File | Change |
|------|--------|
| `src/main/main.js` | Add `pick-pull-destination` IPC handler with last-path persistence |
| `src/main/preload.js` | Expose `pickPullDestination` |
| `src/assets/js/renderer.js` | Call picker in `_pullFromDevice()` before pulling |
