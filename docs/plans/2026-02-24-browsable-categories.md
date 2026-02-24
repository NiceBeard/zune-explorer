# Browsable Category File System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform each file category from a flat file dump into a browsable directory view with Zune HD aesthetics.

**Architecture:** Each non-application category becomes a directory browser filtered by file type. Selecting a category shows smart root folders (Desktop, Documents, Downloads, etc.) as tiles. Clicking a tile navigates into that directory, showing subfolders + filtered files. Folders with no matching files (one-level check) are hidden. Applications keeps its current flat-list behavior.

**Tech Stack:** Electron IPC (existing `get-directory-contents`), vanilla JS, CSS

**Security note:** All SVG icon content used in this plan is hardcoded static markup (no user data interpolated). The existing codebase pattern uses innerHTML for these static SVGs. File names and paths are always set via textContent or DOM properties, never innerHTML.

---

### Task 1: Add browsing state to ZuneExplorer class

**Files:**
- Modify: `src/assets/js/renderer.js:1-25` (constructor)

**Step 1: Add new state properties to the constructor**

Add these properties after `this.selectedFile = null;` (line 23):

```javascript
this.currentPath = null;        // current directory being browsed
this.pathHistory = [];           // stack of previous paths for back navigation
this.browsingMode = false;       // true when browsing directories (vs root view)
this.homePath = null;            // cached home directory path
this.smartRoots = [];            // populated in init()
```

**Step 2: Cache homePath in init() and build smartRoots**

Replace the current `init()` method (lines 27-35) with:

```javascript
async init() {
    this.homePath = await window.electronAPI.getHomeDirectory();
    this.smartRoots = [
        { name: 'Desktop',   path: `${this.homePath}/Desktop` },
        { name: 'Documents', path: `${this.homePath}/Documents` },
        { name: 'Downloads', path: `${this.homePath}/Downloads` },
        { name: 'Music',     path: `${this.homePath}/Music` },
        { name: 'Movies',    path: `${this.homePath}/Movies` },
        { name: 'Pictures',  path: `${this.homePath}/Pictures` },
        { name: 'Home',      path: this.homePath },
    ];
    await this.scanFileSystem();
    this.updateFileCounts();
    await this.loadRecentFiles();
    this.updateRecentFiles();
    this.setupEventListeners();
    this.setupKeyboardNavigation();
    this.focusMenu();
}
```

**Step 3: Verify app still loads**

Run: `npm start`
Expected: App launches, menu shows, counts display. No behavioral change yet.

**Step 4: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat: add browsing state and smart roots to ZuneExplorer"
```

---

### Task 2: Add breadcrumb HTML to content panel

**Files:**
- Modify: `src/renderer/index.html:62-85` (content-header area)

**Step 1: Add breadcrumb element between back-button and content-title**

Replace the content-header div (lines 63-84) with:

```html
<div class="content-header">
    <button class="back-button" id="back-button">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M15 18L9 12L15 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
    </button>
    <div class="title-group">
        <div class="breadcrumb" id="breadcrumb"></div>
        <h1 class="content-title" id="content-title"></h1>
    </div>
    <div class="view-toggle">
        <button class="view-btn active" id="grid-view-btn" data-view="grid">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <rect x="2" y="2" width="6" height="6" stroke="currentColor" stroke-width="1.5"/>
                <rect x="12" y="2" width="6" height="6" stroke="currentColor" stroke-width="1.5"/>
                <rect x="2" y="12" width="6" height="6" stroke="currentColor" stroke-width="1.5"/>
                <rect x="12" y="12" width="6" height="6" stroke="currentColor" stroke-width="1.5"/>
            </svg>
        </button>
        <button class="view-btn" id="list-view-btn" data-view="list">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M3 6H17M3 10H17M3 14H17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
        </button>
    </div>
</div>
```

**Step 2: Commit**

```bash
git add src/renderer/index.html
git commit -m "feat: add breadcrumb element to content panel header"
```

---

### Task 3: Add CSS for breadcrumbs, folder tiles, and root directory grid

**Files:**
- Modify: `src/assets/css/styles.css` (append new styles)

**Step 1: Add breadcrumb styles**

Append to end of `styles.css`:

```css
/* Breadcrumb / stacked header */
.title-group {
    flex: 1;
    min-width: 0;
}

.breadcrumb {
    font-size: 14px;
    color: var(--zune-text-dim);
    font-weight: 300;
    margin-bottom: 4px;
    cursor: pointer;
    transition: color 0.2s ease;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.breadcrumb:hover {
    color: var(--zune-orange);
}

.breadcrumb:empty {
    display: none;
}
```

**Step 2: Add smart root folder tile styles**

Append to end of `styles.css`:

```css
/* Smart root directory tiles */
.root-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 20px;
}

.root-tile {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 8px;
    padding: 30px 24px;
    cursor: pointer;
    transition: all 0.3s ease;
    display: flex;
    align-items: center;
    gap: 16px;
}

.root-tile:hover {
    background: rgba(255, 105, 0, 0.1);
    border-color: rgba(255, 105, 0, 0.3);
    transform: translateY(-3px);
}

.root-tile-icon {
    width: 48px;
    height: 48px;
    flex-shrink: 0;
}

.root-tile-icon svg {
    width: 100%;
    height: 100%;
}

.root-tile-info {
    flex: 1;
    min-width: 0;
}

.root-tile-name {
    font-size: 22px;
    font-weight: 300;
    color: var(--zune-text);
    letter-spacing: -0.5px;
}

.root-tile-detail {
    font-size: 13px;
    color: var(--zune-text-dim);
    margin-top: 4px;
}
```

**Step 3: Add browsable folder item styles (within directory listings)**

Append to end of `styles.css`:

```css
/* Folder items in directory listings */
.folder-item {
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.04);
    border-radius: 8px;
    padding: 16px 20px;
    cursor: pointer;
    transition: all 0.3s ease;
    display: flex;
    align-items: center;
    gap: 14px;
}

.folder-item:hover {
    background: rgba(255, 105, 0, 0.08);
    border-color: rgba(255, 105, 0, 0.25);
    padding-left: 26px;
}

.folder-icon {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
}

.folder-icon svg {
    width: 100%;
    height: 100%;
}

.folder-info {
    flex: 1;
    min-width: 0;
}

.folder-name {
    font-size: 17px;
    font-weight: 400;
    color: var(--zune-text);
}

.folder-detail {
    font-size: 13px;
    color: var(--zune-text-dim);
    margin-top: 2px;
}

.folder-arrow {
    color: var(--zune-text-dim);
    transition: all 0.3s ease;
}

.folder-item:hover .folder-arrow {
    color: var(--zune-orange);
    transform: translateX(4px);
}

/* Separator between folders and files */
.folder-file-separator {
    height: 1px;
    background: rgba(255, 255, 255, 0.05);
    margin: 16px 0;
}
```

**Step 4: Commit**

```bash
git add src/assets/css/styles.css
git commit -m "feat: add CSS for breadcrumbs, root tiles, and folder items"
```

---

### Task 4: Implement root directory view rendering

**Files:**
- Modify: `src/assets/js/renderer.js` (add new methods, modify `selectCategory` and `showContent`)

**Step 1: Modify `selectCategory()` to show root view for non-application categories**

Replace `selectCategory()` (line 156-161) with:

```javascript
selectCategory(index) {
    this.currentCategory = this.categories[index];
    this.currentMenuIndex = index;

    if (this.currentCategory === 'applications') {
        // Applications keeps flat list behavior
        this.browsingMode = false;
        this.currentPath = null;
        this.pathHistory = [];
        this.showContent();
        this.renderCategoryContent();
    } else {
        // All other categories show browsable root view
        this.browsingMode = false;
        this.currentPath = null;
        this.pathHistory = [];
        this.showContent();
        this.renderRootView();
    }
}
```

**Step 2: Modify `showContent()` to update breadcrumb**

Replace `showContent()` (lines 163-172) with:

```javascript
showContent() {
    const container = document.getElementById('panoramic-container');
    container.classList.remove('show-recent');
    container.classList.add('show-content');
    this.currentView = 'content';

    this.updateHeader();
}
```

**Step 3: Add `updateHeader()` method**

Add after `showContent()`:

```javascript
updateHeader() {
    const title = document.getElementById('content-title');
    const breadcrumb = document.getElementById('breadcrumb');

    if (!this.browsingMode || !this.currentPath) {
        // Root view: show category name, no breadcrumb
        title.textContent = this.currentCategory;
        breadcrumb.textContent = '';
    } else {
        // Browsing: big title is current folder name, breadcrumb is parent path
        const folderName = this.currentPath === this.homePath
            ? 'Home'
            : this.currentPath.split('/').pop();
        title.textContent = folderName;

        // Build parent path display (shorten home to ~)
        const parentPath = this.currentPath.substring(0, this.currentPath.lastIndexOf('/'));
        const displayPath = parentPath.replace(this.homePath, '~');
        breadcrumb.textContent = displayPath || '~';
    }
}
```

**Step 4: Add `renderRootView()` method**

Add after `updateHeader()`. This method creates folder tile elements using DOM methods. The folder SVG is static hardcoded markup (no user data):

```javascript
renderRootView() {
    const fileDisplay = document.getElementById('file-display');
    fileDisplay.innerHTML = '';
    fileDisplay.className = 'file-display root-grid';

    this.smartRoots.forEach(root => {
        const tile = document.createElement('div');
        tile.className = 'root-tile';

        const icon = document.createElement('div');
        icon.className = 'root-tile-icon';
        // Static SVG icon - no user data interpolated
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 48 48');
        svg.setAttribute('fill', 'none');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M6 12C6 9.79 7.79 8 10 8H18L22 12H38C40.21 12 42 13.79 42 16V36C42 38.21 40.21 40 38 40H10C7.79 40 6 38.21 6 36V12Z');
        path.setAttribute('fill', 'rgba(255, 105, 0, 0.2)');
        path.setAttribute('stroke', '#ff6900');
        path.setAttribute('stroke-width', '2');
        svg.appendChild(path);
        icon.appendChild(svg);

        const info = document.createElement('div');
        info.className = 'root-tile-info';

        const name = document.createElement('div');
        name.className = 'root-tile-name';
        name.textContent = root.name;

        const detail = document.createElement('div');
        detail.className = 'root-tile-detail';
        detail.textContent = root.path.replace(this.homePath, '~');

        info.appendChild(name);
        info.appendChild(detail);
        tile.appendChild(icon);
        tile.appendChild(info);

        tile.addEventListener('click', () => this.navigateToFolder(root.path));
        fileDisplay.appendChild(tile);
    });
}
```

**Step 5: Verify root view renders**

Run: `npm start`
Expected: Clicking "music", "videos", "pictures", or "documents" shows a grid of folder tiles (Desktop, Documents, Downloads, etc.). "applications" still shows the flat list.

**Step 6: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat: implement smart root directory view for browsable categories"
```

---

### Task 5: Implement folder navigation and filtered directory rendering

**Files:**
- Modify: `src/assets/js/renderer.js` (add `navigateToFolder`, `renderDirectoryContents`, helper methods)

**Step 1: Add `navigateToFolder()` method**

Add after `renderRootView()`:

```javascript
async navigateToFolder(folderPath) {
    // Push current state to history
    if (this.currentPath !== null) {
        this.pathHistory.push(this.currentPath);
    } else {
        // Pushing null means "root view" is in history
        this.pathHistory.push(null);
    }

    this.currentPath = folderPath;
    this.browsingMode = true;
    this.updateHeader();
    await this.renderDirectoryContents();
}
```

**Step 2: Add `renderDirectoryContents()` method**

Add after `navigateToFolder()`:

```javascript
async renderDirectoryContents() {
    const fileDisplay = document.getElementById('file-display');
    fileDisplay.textContent = '';
    const loadingMsg = document.createElement('div');
    loadingMsg.className = 'empty-state';
    loadingMsg.textContent = 'loading...';
    fileDisplay.appendChild(loadingMsg);
    fileDisplay.className = `file-display ${this.currentViewMode}-view`;

    const result = await window.electronAPI.getDirectoryContents(this.currentPath);
    if (!result.success) {
        fileDisplay.textContent = '';
        const errMsg = document.createElement('div');
        errMsg.className = 'empty-state';
        errMsg.textContent = 'could not read this folder';
        fileDisplay.appendChild(errMsg);
        return;
    }

    const extensions = this.fileExtensions[this.currentCategory] || [];

    // Separate folders and matching files
    const folders = result.files.filter(f => f.isDirectory && !f.name.startsWith('.'));
    const files = result.files.filter(f =>
        !f.isDirectory &&
        !f.name.startsWith('.') &&
        extensions.includes(f.extension)
    );

    // Filter folders: only show folders that contain matching files (one-level check)
    const visibleFolders = await this.filterFoldersWithContent(folders, extensions);

    fileDisplay.textContent = '';

    if (visibleFolders.length === 0 && files.length === 0) {
        const emptyMsg = document.createElement('div');
        emptyMsg.className = 'empty-state';
        emptyMsg.textContent = `no ${this.currentCategory} here`;
        fileDisplay.appendChild(emptyMsg);
        return;
    }

    // Render folders first, sorted alphabetically
    visibleFolders.sort((a, b) => a.name.localeCompare(b.name));
    visibleFolders.forEach(folder => {
        fileDisplay.appendChild(this.createFolderElement(folder));
    });

    // Separator if both folders and files exist
    if (visibleFolders.length > 0 && files.length > 0) {
        const sep = document.createElement('div');
        sep.className = 'folder-file-separator';
        fileDisplay.appendChild(sep);
    }

    // Render files, sorted alphabetically
    files.sort((a, b) => a.name.localeCompare(b.name));
    files.forEach(file => {
        fileDisplay.appendChild(this.createFileElement(file));
    });
}
```

**Step 3: Add `filterFoldersWithContent()` method**

Add after `renderDirectoryContents()`:

```javascript
async filterFoldersWithContent(folders, extensions) {
    const checks = folders.map(async (folder) => {
        try {
            const result = await window.electronAPI.getDirectoryContents(folder.path);
            if (!result.success) return null;
            const hasMatch = result.files.some(f =>
                extensions.includes(f.extension) ||
                (f.isDirectory && !f.name.startsWith('.'))
            );
            return hasMatch ? folder : null;
        } catch {
            return null;
        }
    });

    const results = await Promise.all(checks);
    return results.filter(f => f !== null);
}
```

**Step 4: Add `createFolderElement()` method**

Add after `filterFoldersWithContent()`. Uses DOM methods for all user-visible text:

```javascript
createFolderElement(folder) {
    const div = document.createElement('div');
    div.className = 'folder-item';
    div.dataset.path = folder.path;

    const icon = document.createElement('div');
    icon.className = 'folder-icon';
    // Static SVG folder icon
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 48 48');
    svg.setAttribute('fill', 'none');
    const iconPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    iconPath.setAttribute('d', 'M6 12C6 9.79 7.79 8 10 8H18L22 12H38C40.21 12 42 13.79 42 16V36C42 38.21 40.21 40 38 40H10C7.79 40 6 38.21 6 36V12Z');
    iconPath.setAttribute('fill', 'rgba(255, 105, 0, 0.15)');
    iconPath.setAttribute('stroke', '#ff6900');
    iconPath.setAttribute('stroke-width', '1.5');
    svg.appendChild(iconPath);
    icon.appendChild(svg);

    const info = document.createElement('div');
    info.className = 'folder-info';

    const name = document.createElement('div');
    name.className = 'folder-name';
    name.textContent = folder.name;

    info.appendChild(name);

    const arrow = document.createElement('div');
    arrow.className = 'folder-arrow';
    const arrowSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrowSvg.setAttribute('width', '20');
    arrowSvg.setAttribute('height', '20');
    arrowSvg.setAttribute('viewBox', '0 0 24 24');
    arrowSvg.setAttribute('fill', 'none');
    const arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    arrowPath.setAttribute('d', 'M9 6L15 12L9 18');
    arrowPath.setAttribute('stroke', 'currentColor');
    arrowPath.setAttribute('stroke-width', '2');
    arrowPath.setAttribute('stroke-linecap', 'round');
    arrowPath.setAttribute('stroke-linejoin', 'round');
    arrowSvg.appendChild(arrowPath);
    arrow.appendChild(arrowSvg);

    div.appendChild(icon);
    div.appendChild(info);
    div.appendChild(arrow);

    div.addEventListener('click', () => this.navigateToFolder(folder.path));
    div.addEventListener('contextmenu', (e) => this.showContextMenu(e, folder));

    return div;
}
```

**Step 5: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat: implement folder navigation with filtered directory contents"
```

---

### Task 6: Fix back button navigation for directory browsing

**Files:**
- Modify: `src/assets/js/renderer.js` (replace `navigateBack`, add breadcrumb click handler)

**Step 1: Replace `navigateBack()` method**

Replace the existing `navigateBack()` with:

```javascript
navigateBack() {
    if (this.currentCategory === 'applications' || !this.browsingMode) {
        // At root view or applications: go back to menu
        this.currentPath = null;
        this.pathHistory = [];
        this.browsingMode = false;
        this.showMenu();
        return;
    }

    // Pop path history
    if (this.pathHistory.length > 0) {
        const previousPath = this.pathHistory.pop();
        if (previousPath === null) {
            // Back to root view
            this.currentPath = null;
            this.browsingMode = false;
            this.updateHeader();
            this.renderRootView();
        } else {
            this.currentPath = previousPath;
            this.updateHeader();
            this.renderDirectoryContents();
        }
    } else {
        // No history, go to root view
        this.currentPath = null;
        this.browsingMode = false;
        this.updateHeader();
        this.renderRootView();
    }
}
```

**Step 2: Add breadcrumb click handler in `setupEventListeners()`**

Add inside `setupEventListeners()`, after the back button listener:

```javascript
// Breadcrumb click navigates up one level
document.getElementById('breadcrumb').addEventListener('click', () => {
    if (this.browsingMode && this.currentPath) {
        this.navigateBack();
    }
});
```

**Step 3: Verify full navigation flow**

Run: `npm start`
Expected:
1. Click "documents" -> see root folder tiles
2. Click "Documents" tile -> see folders and .pdf/.txt files in ~/Documents
3. Click a subfolder -> drill in, breadcrumb shows parent path
4. Click back -> go up one level
5. Click back at root view -> return to main menu
6. Click "applications" -> still shows flat list with app icons

**Step 4: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat: implement back navigation with path history for directory browsing"
```

---

### Task 7: Update view mode toggle to work with directory browsing

**Files:**
- Modify: `src/assets/js/renderer.js` (update `setViewMode`)

**Step 1: Update `setViewMode()` to re-render directory contents when browsing**

Replace `setViewMode()` with:

```javascript
setViewMode(mode) {
    this.currentViewMode = mode;

    // Update button states
    document.querySelectorAll('.view-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.getElementById(`${mode}-view-btn`).classList.add('active');

    // Re-render content if we're in content view
    if (this.currentView === 'content') {
        if (this.currentCategory === 'applications') {
            this.renderCategoryContent();
        } else if (this.browsingMode) {
            this.renderDirectoryContents();
        }
        // Root view doesn't change with view mode (always grid tiles)
    }
}
```

**Step 2: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat: update view toggle to work with directory browsing"
```

---

### Task 8: Remove old flat-scan code for non-application categories

**Files:**
- Modify: `src/assets/js/renderer.js` (clean up `scanFileSystem`, remove `scanDirectory`, remove `categorizeFile`, update `updateFileCounts`)

**Step 1: Simplify `scanFileSystem()` to only scan applications**

Replace `scanFileSystem()` with:

```javascript
async scanFileSystem() {
    try {
        // Clear previous data
        Object.keys(this.categorizedFiles).forEach(key => {
            this.categorizedFiles[key] = [];
        });

        // Only scan applications (other categories are now browsable)
        await this.scanApplications();

    } catch (error) {
        console.error('Error scanning file system:', error);
    }
}
```

**Step 2: Remove `scanDirectory()` and `categorizeFile()` methods entirely**

Delete the `scanDirectory()` method and `categorizeFile()` method. They are no longer used.

**Step 3: Update `updateFileCounts()` to only show count for applications**

Replace `updateFileCounts()` with:

```javascript
updateFileCounts() {
    // Applications shows count, browsable categories show nothing
    this.categories.forEach(category => {
        const countElement = document.getElementById(`${category}-count`);
        if (countElement) {
            if (category === 'applications') {
                countElement.textContent = this.categorizedFiles[category].length;
            } else {
                countElement.textContent = '';
            }
        }
    });
}
```

**Step 4: Verify everything still works**

Run: `npm start`
Expected: App loads faster (no longer scanning 4 directories on startup). Menu shows counts only for applications. All category browsing works.

**Step 5: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "refactor: remove flat-scan code, categories now use directory browsing"
```

---

### Task 9: Handle delete refresh in browsing mode

**Files:**
- Modify: `src/assets/js/renderer.js` (update `handleContextMenuAction` delete case)

**Step 1: Update delete handler to refresh directory view**

Replace the `delete` case in `handleContextMenuAction()` with:

```javascript
case 'delete':
    const result = await window.electronAPI.deleteFile(this.selectedFile.path);
    if (result.success) {
        if (this.currentCategory === 'applications') {
            await this.scanFileSystem();
            this.updateFileCounts();
            this.renderCategoryContent();
        } else if (this.browsingMode) {
            await this.renderDirectoryContents();
        }
        this.updateRecentFiles();
    }
    break;
```

**Step 2: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "fix: refresh directory view after file deletion in browsing mode"
```

---

### Task 10: Final verification and cleanup commit

**Step 1: Full test walkthrough**

Run: `npm start`

Test checklist:
- Click "music" -> root folder tiles appear
- Click "Documents" tile -> navigate in, see filtered files
- Breadcrumb shows parent path (e.g. `~`)
- Click breadcrumb -> go back one level
- Click back button -> navigate up directories, eventually back to menu
- Empty folders hidden (folders with no matching files don't show)
- "applications" -> flat list with icons, unchanged
- Grid/list toggle works in both root view and directory view
- Context menu (open, show in finder, delete) works
- Recent files panel still works
- Keyboard navigation (arrows, enter, escape) works
- App loads quickly (no long startup scan)

**Step 2: Commit any final fixes and push**

```bash
git add -A
git commit -m "feat: browsable category file system complete"
git push
```
