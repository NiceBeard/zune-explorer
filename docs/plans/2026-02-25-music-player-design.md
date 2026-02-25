# Music Player Design (Phase 1 of Media Suite)

**Goal:** Built-in music player with a persistent bottom bar mini-player and a full-screen Now Playing panel inspired by the Zune HD.

## Bottom Bar (persistent mini-player)

Fixed to the bottom of the screen. Appears when music starts playing, persists across all navigation. Contains:
- Small album art thumbnail (left)
- Track name and artist (center)
- Progress bar with elapsed/remaining time
- Transport controls: previous, play/pause, next (right)
- Animated equalizer bars (right, near controls) — CSS-only, 3-4 bouncing vertical bars when playing, frozen when paused
- Clickable — opens Now Playing panel

## Now Playing Panel

Full-screen overlay that slides up from the bottom bar. Styled after the Zune HD:
- **Large circular back button** top-left — iconic Zune circle-arrow, closes panel back to bottom bar
- **Artist name** in large bold uppercase
- **Album name** below in lighter weight
- **Large album art** centered
- **Progress bar** with elapsed time (left) and remaining time (right), seekable
- **Track queue** below the art — upcoming songs, scrollable
- Transport controls: shuffle, previous, play/pause, next, repeat

## Audio Engine

An `AudioPlayer` class in the renderer wrapping HTML5 `<audio>`:
- `play(file, queue)` — starts playback, sets queue (all music files from current view)
- `pause()`, `resume()`, `next()`, `previous()`
- `seek(percent)` — scrub progress bar
- Emits events for UI updates (timeupdate, ended, etc.)
- On track end, automatically plays next in queue
- Shuffle and repeat modes

## Metadata Extraction

New IPC handler `get-audio-metadata` in main process using `music-metadata` npm package:
- Extracts artist, album, title, duration, embedded album art
- Returns art as data URL (base64 PNG/JPEG)
- Fallback: filename as title, "Unknown Artist"/"Unknown Album", no art

## Queue Behavior

Clicking a music file plays it and queues all other music files visible in the current view. Matches Zune HD behavior — tap a track and it plays through the rest.

## Integration

- Music files start playback instead of `shell.openPath`
- Bottom bar sits above existing UI; content area gets bottom padding when visible
- Circular back button only on Now Playing panel
- CSP needs `media-src 'self' file:` for `<audio>` to play local files

## Animated Equalizer Bars

CSS-only animation: 3-4 thin vertical bars at different heights/animation speeds. Playing = bouncing, paused = frozen. Placed in the bottom bar near transport controls.
