# Windows Support Design

**Goal:** Make Zune Explorer run on Windows with full feature parity, keeping the immersive dark aesthetic.

## Platform Abstraction

All macOS-specific code lives in `main.js`. We extract platform-dependent logic into two modules:

- `src/main/platform-darwin.js` — macOS implementations (existing code, moved)
- `src/main/platform-win32.js` — Windows implementations (new)

`main.js` picks the right one at startup via `process.platform` and calls the same interface. The renderer and CSS are unchanged except for the custom title bar.

**Platform module interface:**
- `getAllowedPrefixes()` — returns allowed path prefixes for security validation
- `getRecentFiles(homePath)` — returns recent files array
- `getAppIcon(appPath)` — returns icon as data URL
- `getApplicationDirectories(homePath)` — returns paths to scan for apps

## Windows-Specific Implementations

**Allowed paths:** User's home directory, `C:\Program Files`, `C:\Program Files (x86)`, and the Start Menu folders.

**Recent files:** Read `.lnk` files from `%APPDATA%\Microsoft\Windows\Recent`, resolve targets with Electron's `shell.readShortcutLink()`, stat each file, sort by modification time.

**App icons:** Use Electron's `app.getFileIcon(exePath)` which returns embedded `.exe` icons natively on Windows.

**App scanning:** Read Start Menu shortcuts from `C:\ProgramData\Microsoft\Windows\Start Menu\Programs` and `%APPDATA%\Microsoft\Windows\Start Menu\Programs`. Resolve `.lnk` targets, filter for `.exe` files.

## Custom Title Bar (Windows only)

A small HTML bar at the top of `index.html`, hidden on macOS via CSS. Three buttons: minimize, maximize, close. Styled dark to match theme. Wired to IPC calls invoking `mainWindow.minimize()`, etc. Uses `-webkit-app-region: drag` for window dragging.

## BrowserWindow Config

Platform-conditional in `createWindow()`:
- macOS: `titleBarStyle: 'hidden'`, `vibrancy: 'dark'`, `frame: false`
- Windows: `frame: false`, skip `vibrancy`

## Renderer Changes

Minimal:
- Custom title bar HTML (hidden on macOS via CSS)
- Detect platform via new `get-platform` IPC call
- Adjust application extensions from `.app` to `.exe`/`.lnk` on Windows
