# Pull Destination Picker Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show a native folder picker when pulling songs from the Zune, remembering the last-used folder between sessions.

**Architecture:** New IPC handler `pick-pull-destination` opens Electron's native directory picker dialog, defaulting to the last-used path persisted in a JSON file. Renderer calls this before starting the pull.

**Tech Stack:** Electron `dialog.showOpenDialog`, Node.js `fs`, JSON file persistence.

---

### Task 1: Add pull destination picker IPC handler

**Files:**
- Modify: `src/main/main.js`
- Modify: `src/main/preload.js`

**Step 1: Add the IPC handler in main.js**

Add near the other Zune IPC handlers (around the `zune-pull-file` handler). This handler reads the last-used path from a JSON file, opens a native folder picker, saves the chosen path, and returns it.

```javascript
ipcMain.handle('pick-pull-destination', async () => {
  const settingsPath = path.join(app.getPath('userData'), 'pull-destination.json');
  let defaultPath;
  try {
    const data = await fs.readFile(settingsPath, 'utf-8');
    defaultPath = JSON.parse(data).path;
  } catch {
    defaultPath = app.getPath('music');
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose destination folder',
    defaultPath,
    properties: ['openDirectory', 'createDirectory'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, cancelled: true };
  }

  const chosen = result.filePaths[0];

  // Remember for next time
  try {
    await fs.writeFile(settingsPath, JSON.stringify({ path: chosen }));
  } catch {
    // Non-critical — just won't remember next time
  }

  return { success: true, path: chosen };
});
```

**Step 2: Expose in preload.js**

Add to the `electronAPI` object, near the other Zune methods:

```javascript
pickPullDestination: () => ipcRenderer.invoke('pick-pull-destination'),
```

**Step 3: Commit**

```bash
git add src/main/main.js src/main/preload.js
git commit -m "feat(zune): add pull destination picker IPC with last-path persistence"
```

---

### Task 2: Use the picker in `_pullFromDevice()`

**Files:**
- Modify: `src/assets/js/renderer.js`

**Step 1: Replace the hardcoded destination in `_pullFromDevice()`**

In the `ZuneSyncPanel` class, find `_pullFromDevice()` (around line 1549). Replace the hardcoded `musicDir` logic with a call to the picker. The current code:

```javascript
    // Determine destination directory (user's Music folder)
    const homePath = this.explorer.homePath;
    const musicDir = this.explorer.platform === 'win32'
        ? `${homePath}\\Music`
        : `${homePath}/Music`;
```

Replace with:

```javascript
    // Ask user where to save
    const destResult = await window.electronAPI.pickPullDestination();
    if (!destResult.success) return;
    const musicDir = destResult.path;
```

**Step 2: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat(zune): prompt for save location when pulling from device"
```

---

### Summary of Changes

| File | Change |
|------|--------|
| `src/main/main.js` | Add `pick-pull-destination` IPC handler with JSON persistence |
| `src/main/preload.js` | Expose `pickPullDestination` |
| `src/assets/js/renderer.js` | Call picker in `_pullFromDevice()` instead of hardcoding `~/Music` |
