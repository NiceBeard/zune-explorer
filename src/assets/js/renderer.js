class ZuneExplorer {
    constructor() {
        this.currentView = 'menu'; // menu, content, recent
        this.currentCategory = null;
        this.currentMenuIndex = 0;
        this.currentViewMode = 'grid'; // grid, list
        this.categories = ['music', 'videos', 'pictures', 'documents', 'applications'];
        this.categorizedFiles = {
            music: [],
            videos: [],
            pictures: [],
            documents: [],
            applications: []
        };
        this.recentFiles = [];
        this.fileExtensions = {
            music: ['.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg', '.wma'],
            videos: ['.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v'],
            pictures: ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.bmp', '.webp', '.ico'],
            documents: ['.pdf', '.txt', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.rtf'],
            applications: ['.app', '.exe', '.dmg', '.pkg', '.deb', '.msi']
        };
        this.selectedFile = null;
        this.currentPath = null;        // current directory being browsed
        this.pathHistory = [];           // stack of previous paths for back navigation
        this.browsingMode = false;       // true when browsing directories (vs root view)
        this.homePath = null;            // cached home directory path
        this.smartRoots = [];            // populated in init()
        this.audioPlayer = null;
        this.nowPlayingOpen = false;
        this.init();
    }

    async init() {
        this.platform = await window.electronAPI.getPlatform();
        if (this.platform === 'win32') {
            document.body.classList.add('platform-win32');
        }
        this.homePath = await window.electronAPI.getHomeDirectory();
        if (this.platform === 'win32') {
            this.smartRoots = [
                { name: 'Desktop',   path: `${this.homePath}\\Desktop` },
                { name: 'Documents', path: `${this.homePath}\\Documents` },
                { name: 'Downloads', path: `${this.homePath}\\Downloads` },
                { name: 'Music',     path: `${this.homePath}\\Music` },
                { name: 'Videos',    path: `${this.homePath}\\Videos` },
                { name: 'Pictures',  path: `${this.homePath}\\Pictures` },
                { name: 'Home',      path: this.homePath },
            ];
        } else {
            this.smartRoots = [
                { name: 'Desktop',   path: `${this.homePath}/Desktop` },
                { name: 'Documents', path: `${this.homePath}/Documents` },
                { name: 'Downloads', path: `${this.homePath}/Downloads` },
                { name: 'Music',     path: `${this.homePath}/Music` },
                { name: 'Movies',    path: `${this.homePath}/Movies` },
                { name: 'Pictures',  path: `${this.homePath}/Pictures` },
                { name: 'Home',      path: this.homePath },
            ];
        }
        await this.scanFileSystem();
        this.updateFileCounts();
        await this.loadRecentFiles();
        this.updateRecentFiles();
        this.setupEventListeners();
        this.setupKeyboardNavigation();
        this.focusMenu();
        this.setupPlayer();
    }

    setupEventListeners() {
        // Menu items
        document.querySelectorAll('.menu-item').forEach((item, index) => {
            item.addEventListener('click', () => this.selectCategory(index));
        });

        // Back button
        document.getElementById('back-button').addEventListener('click', () => this.navigateBack());

        // Breadcrumb click navigates up one level
        document.getElementById('breadcrumb').addEventListener('click', () => {
            if (this.browsingMode && this.currentPath) {
                this.navigateBack();
            }
        });

        // View toggle buttons
        document.getElementById('grid-view-btn').addEventListener('click', () => this.setViewMode('grid'));
        document.getElementById('list-view-btn').addEventListener('click', () => this.setViewMode('list'));

        // Context menu
        document.addEventListener('contextmenu', (e) => e.preventDefault());
        document.addEventListener('click', () => this.hideContextMenu());

        // Context menu actions
        document.querySelectorAll('.context-menu-item').forEach(item => {
            item.addEventListener('click', (e) => this.handleContextMenuAction(e));
        });

        // Mouse wheel for vertical scrolling in menu
        const menuContainer = document.querySelector('.menu-container');
        menuContainer.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (this.currentView === 'menu') {
                if (e.deltaY > 0) {
                    this.navigateMenuDown();
                } else {
                    this.navigateMenuUp();
                }
            }
        });

        // Recent sidebar click to rotate to front
        document.getElementById('recent-sidebar').addEventListener('click', (e) => {
            if (this.currentView === 'menu' && !e.target.closest('.recent-preview-item')) {
                this.showRecent();
            }
        });

        // Title bar controls (Windows)
        const minimizeBtn = document.getElementById('minimize-btn');
        const maximizeBtn = document.getElementById('maximize-btn');
        const closeBtn = document.getElementById('close-btn');
        if (minimizeBtn) {
            minimizeBtn.addEventListener('click', () => window.electronAPI.windowMinimize());
        }
        if (maximizeBtn) {
            maximizeBtn.addEventListener('click', () => window.electronAPI.windowMaximize());
        }
        if (closeBtn) {
            closeBtn.addEventListener('click', () => window.electronAPI.windowClose());
        }
    }

    setupKeyboardNavigation() {
        document.addEventListener('keydown', (e) => {
            // Escape closes Now Playing panel from any view
            if (e.key === 'Escape' && this.nowPlayingOpen) {
                e.preventDefault();
                this.closeNowPlaying();
                return;
            }

            switch(this.currentView) {
                case 'menu':
                    this.handleMenuKeyboard(e);
                    break;
                case 'content':
                    this.handleContentKeyboard(e);
                    break;
                case 'recent':
                    this.handleRecentKeyboard(e);
                    break;
            }
        });
    }

    setupPlayer() {
        this.audioPlayer = new AudioPlayer();

        // Bottom bar click opens Now Playing
        const bottomBar = document.getElementById('player-bottom-bar');
        bottomBar.addEventListener('click', (e) => {
            if (e.target.closest('.player-bar-controls') || e.target.closest('.player-bar-progress-track')) return;
            this.openNowPlaying();
        });

        // Bottom bar controls
        document.getElementById('player-bar-prev').addEventListener('click', (e) => {
            e.stopPropagation();
            this.audioPlayer.previous();
        });
        document.getElementById('player-bar-play').addEventListener('click', (e) => {
            e.stopPropagation();
            this.audioPlayer.togglePlayPause();
        });
        document.getElementById('player-bar-next').addEventListener('click', (e) => {
            e.stopPropagation();
            this.audioPlayer.next();
        });

        // Bottom bar progress seek
        document.getElementById('player-bar-progress-track').addEventListener('click', (e) => {
            e.stopPropagation();
            const track = e.currentTarget;
            const rect = track.getBoundingClientRect();
            const percent = ((e.clientX - rect.left) / rect.width) * 100;
            this.audioPlayer.seek(percent);
        });

        // Now Playing controls
        document.getElementById('np-back-btn').addEventListener('click', () => this.closeNowPlaying());
        document.getElementById('np-prev').addEventListener('click', () => this.audioPlayer.previous());
        document.getElementById('np-play').addEventListener('click', () => this.audioPlayer.togglePlayPause());
        document.getElementById('np-next').addEventListener('click', () => this.audioPlayer.next());
        document.getElementById('np-shuffle').addEventListener('click', () => this.audioPlayer.toggleShuffle());
        document.getElementById('np-repeat').addEventListener('click', () => this.audioPlayer.toggleRepeat());

        // Now Playing progress seek
        document.getElementById('np-progress-track').addEventListener('click', (e) => {
            const track = e.currentTarget;
            const rect = track.getBoundingClientRect();
            const percent = ((e.clientX - rect.left) / rect.width) * 100;
            this.audioPlayer.seek(percent);
        });

        // Player events
        this.audioPlayer.on('trackchange', (data) => this.onTrackChange(data));
        this.audioPlayer.on('play', () => this.onPlayStateChange(true));
        this.audioPlayer.on('pause', () => this.onPlayStateChange(false));
        this.audioPlayer.on('timeupdate', (data) => this.onTimeUpdate(data));
        this.audioPlayer.on('shufflechange', (active) => {
            document.getElementById('np-shuffle').classList.toggle('active', active);
        });
        this.audioPlayer.on('repeatchange', (mode) => {
            const btn = document.getElementById('np-repeat');
            btn.classList.toggle('active', mode !== 'none');
            btn.title = mode === 'one' ? 'Repeat One' : mode === 'all' ? 'Repeat All' : 'Repeat';
        });
        this.audioPlayer.on('queueend', () => this.onPlayStateChange(false));
    }

    handleMenuKeyboard(e) {
        switch(e.key) {
            case 'ArrowDown':
                e.preventDefault();
                this.navigateMenuDown();
                break;
            case 'ArrowUp':
                e.preventDefault();
                this.navigateMenuUp();
                break;
            case 'Enter':
            case ' ':
                e.preventDefault();
                this.selectCategory(this.currentMenuIndex);
                break;
            case 'ArrowLeft':
                e.preventDefault();
                this.showRecent();
                break;
        }
    }

    handleContentKeyboard(e) {
        switch(e.key) {
            case 'Escape':
            case 'Backspace':
                e.preventDefault();
                this.navigateBack();
                break;
            case 'ArrowRight':
                e.preventDefault();
                this.navigateBack();
                break;
        }
    }

    handleRecentKeyboard(e) {
        switch(e.key) {
            case 'ArrowRight':
                e.preventDefault();
                this.showMenu();
                break;
        }
    }

    navigateMenuDown() {
        this.currentMenuIndex = Math.min(this.currentMenuIndex + 1, this.categories.length - 1);
        this.updateMenuSelection();
    }

    navigateMenuUp() {
        this.currentMenuIndex = Math.max(this.currentMenuIndex - 1, 0);
        this.updateMenuSelection();
    }

    updateMenuSelection() {
        // Remove visual selection - keep clean Zune HD look
        // Only track currentMenuIndex for keyboard navigation
    }

    selectCategory(index) {
        this.currentCategory = this.categories[index];
        this.currentMenuIndex = index;
        this.browsingMode = false;
        this.currentPath = null;
        this.pathHistory = [];
        this.showContent();

        if (this.currentCategory === 'documents') {
            this.renderRootView();
        } else {
            this.renderCategoryContent();
        }
    }

    showContent() {
        const container = document.getElementById('panoramic-container');
        container.classList.remove('show-recent');
        container.classList.add('show-content');
        this.currentView = 'content';

        this.updateHeader();
    }

    updateHeader() {
        const title = document.getElementById('content-title');
        const breadcrumb = document.getElementById('breadcrumb');

        if (!this.browsingMode || !this.currentPath) {
            title.textContent = this.currentCategory;
            breadcrumb.textContent = '';
        } else {
            const folderName = this.currentPath === this.homePath
                ? 'Home'
                : this.currentPath.split(/[/\\]/).pop();
            title.textContent = folderName;

            const lastSep = Math.max(this.currentPath.lastIndexOf('/'), this.currentPath.lastIndexOf('\\'));
            const parentPath = this.currentPath.substring(0, lastSep);
            const displayPath = parentPath.replace(this.homePath, '~');
            breadcrumb.textContent = displayPath || '~';
        }
    }

    renderRootView() {
        const fileDisplay = document.getElementById('file-display');
        fileDisplay.textContent = '';

        if (this.currentViewMode === 'list') {
            fileDisplay.className = 'file-display list-view';
            this.smartRoots.forEach(root => {
                const item = this.createFolderElement({
                    name: root.name,
                    path: root.path,
                    isDirectory: true
                });
                fileDisplay.appendChild(item);
            });
            return;
        }

        fileDisplay.className = 'file-display root-grid';

        this.smartRoots.forEach(root => {
            const tile = document.createElement('div');
            tile.className = 'root-tile';

            const icon = document.createElement('div');
            icon.className = 'root-tile-icon';
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

    async navigateToFolder(folderPath) {
        if (this.currentPath !== null) {
            this.pathHistory.push(this.currentPath);
        } else {
            this.pathHistory.push(null);
        }

        this.currentPath = folderPath;
        this.browsingMode = true;
        this.updateHeader();
        await this.renderDirectoryContents();
    }

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

        const folders = result.files.filter(f => f.isDirectory && !f.name.startsWith('.'));
        const files = result.files.filter(f =>
            !f.isDirectory &&
            !f.name.startsWith('.') &&
            extensions.includes(f.extension)
        );

        const visibleFolders = await this.filterFoldersWithContent(folders, extensions);

        fileDisplay.textContent = '';

        if (visibleFolders.length === 0 && files.length === 0) {
            const emptyMsg = document.createElement('div');
            emptyMsg.className = 'empty-state';
            emptyMsg.textContent = `no ${this.currentCategory} here`;
            fileDisplay.appendChild(emptyMsg);
            return;
        }

        visibleFolders.sort((a, b) => a.name.localeCompare(b.name));
        visibleFolders.forEach(folder => {
            fileDisplay.appendChild(this.createFolderElement(folder));
        });

        if (visibleFolders.length > 0 && files.length > 0) {
            const sep = document.createElement('div');
            sep.className = 'folder-file-separator';
            fileDisplay.appendChild(sep);
        }

        files.sort((a, b) => a.name.localeCompare(b.name));
        files.forEach(file => {
            fileDisplay.appendChild(this.createFileElement(file));
        });
    }

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

    createFolderElement(folder) {
        const div = document.createElement('div');
        div.className = 'folder-item';
        div.dataset.path = folder.path;

        const icon = document.createElement('div');
        icon.className = 'folder-icon';
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

    showMenu() {
        const container = document.getElementById('panoramic-container');
        container.classList.remove('show-recent', 'show-content');
        this.currentView = 'menu';
        this.focusMenu();
    }

    showRecent() {
        const container = document.getElementById('panoramic-container');
        container.classList.add('show-recent');
        container.classList.remove('show-content');
        this.currentView = 'recent';
    }

    navigateBack() {
        // Non-documents categories go straight to menu
        if (this.currentCategory !== 'documents') {
            this.currentPath = null;
            this.pathHistory = [];
            this.browsingMode = false;
            this.showMenu();
            return;
        }

        // Documents at root view → go to menu
        if (!this.browsingMode) {
            this.currentPath = null;
            this.pathHistory = [];
            this.showMenu();
            return;
        }

        // Documents browsing → navigate back through history
        if (this.pathHistory.length > 0) {
            const previousPath = this.pathHistory.pop();
            if (previousPath === null) {
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
            this.currentPath = null;
            this.browsingMode = false;
            this.updateHeader();
            this.renderRootView();
        }
    }

    focusMenu() {
        // Keep keyboard navigation tracking but no visual focus
    }

    async scanFileSystem() {
        try {
            Object.keys(this.categorizedFiles).forEach(key => {
                this.categorizedFiles[key] = [];
            });

            await this.scanApplications();
            await this.scanMediaFiles();

        } catch (error) {
            console.error('Error scanning file system:', error);
        }
    }

    async scanMediaFiles() {
        const sep = this.platform === 'win32' ? '\\' : '/';
        const categoryDirs = {
            music: [`${this.homePath}${sep}Music`],
            videos: [this.platform === 'win32' ? `${this.homePath}${sep}Videos` : `${this.homePath}${sep}Movies`],
            pictures: [`${this.homePath}${sep}Pictures`],
        };

        for (const [category, dirs] of Object.entries(categoryDirs)) {
            for (const dir of dirs) {
                await this.scanDirectoryRecursive(dir, category, 3);
            }
        }

        const commonDirs = [
            `${this.homePath}${sep}Desktop`,
            `${this.homePath}${sep}Downloads`,
        ];
        for (const dir of commonDirs) {
            await this.scanDirectoryForMedia(dir);
        }
    }

    async scanDirectoryRecursive(dirPath, category, maxDepth) {
        if (maxDepth <= 0) return;
        try {
            const result = await window.electronAPI.getDirectoryContents(dirPath);
            if (!result.success) return;

            const extensions = this.fileExtensions[category];
            for (const file of result.files) {
                if (file.name.startsWith('.')) continue;
                if (file.isDirectory) {
                    await this.scanDirectoryRecursive(file.path, category, maxDepth - 1);
                } else if (extensions.includes(file.extension)) {
                    if (!this.categorizedFiles[category].some(f => f.path === file.path)) {
                        this.categorizedFiles[category].push(file);
                    }
                }
            }
        } catch (error) {
            console.error(`Error scanning ${dirPath}:`, error);
        }
    }

    async scanDirectoryForMedia(dirPath) {
        try {
            const result = await window.electronAPI.getDirectoryContents(dirPath);
            if (!result.success) return;

            for (const file of result.files) {
                if (file.isDirectory || file.name.startsWith('.')) continue;
                for (const [category, extensions] of Object.entries(this.fileExtensions)) {
                    if (category === 'documents' || category === 'applications') continue;
                    if (extensions.includes(file.extension)) {
                        if (!this.categorizedFiles[category].some(f => f.path === file.path)) {
                            this.categorizedFiles[category].push(file);
                        }
                        break;
                    }
                }
            }
        } catch (error) {
            console.error(`Error scanning ${dirPath}:`, error);
        }
    }

    async scanApplications() {
        try {
            const result = await window.electronAPI.scanApplications();
            if (result.success) {
                this.categorizedFiles.applications = result.applications;
            }
        } catch (error) {
            console.error('Error scanning applications:', error);
        }
    }

    async loadRecentFiles() {
        try {
            const result = await window.electronAPI.getRecentFiles();
            if (result.success && result.files) {
                // Clear existing recent files
                this.recentFiles = [];
                
                // Add system recent files
                result.files.forEach(file => {
                    // Check if it's a file type we track
                    const ext = file.extension.toLowerCase();
                    let category = null;
                    
                    for (const [cat, extensions] of Object.entries(this.fileExtensions)) {
                        if (extensions.includes(ext)) {
                            category = cat;
                            break;
                        }
                    }
                    
                    // Add to recent files with proper metadata
                    if (category || file.isApplication) {
                        this.recentFiles.push({
                            ...file,
                            category: category || 'applications',
                            lastAccessed: file.lastAccessed || file.modified
                        });
                    }
                });
                
                // Sort by last accessed date
                this.recentFiles.sort((a, b) => {
                    const aTime = new Date(a.lastAccessed || a.modified);
                    const bTime = new Date(b.lastAccessed || b.modified);
                    return bTime - aTime;
                });
                
                // Keep only the most recent 50 files
                this.recentFiles = this.recentFiles.slice(0, 50);
            }
        } catch (error) {
            console.error('Error loading recent files:', error);
        }
    }

    addToRecentFiles(file) {
        // Remove existing entry if present
        this.recentFiles = this.recentFiles.filter(f => f.path !== file.path);
        
        // Add timestamp when file was accessed
        const fileWithTimestamp = {
            ...file,
            lastAccessed: new Date().toISOString()
        };
        
        // Add to beginning (most recent first)
        this.recentFiles.unshift(fileWithTimestamp);
        
        // Keep only last 20
        if (this.recentFiles.length > 20) {
            this.recentFiles = this.recentFiles.slice(0, 20);
        }
    }

    updateFileCounts() {
        this.categories.forEach(category => {
            const countElement = document.getElementById(`${category}-count`);
            if (countElement) {
                if (category === 'documents') {
                    countElement.textContent = '';
                } else {
                    countElement.textContent = this.categorizedFiles[category].length;
                }
            }
        });
    }

    updateRecentFiles() {
        // Update both the recent panel and the preview in menu
        this.updateRecentPanel();
        this.updateRecentPreview();
    }

    updateRecentPanel() {
        const recentContainer = document.getElementById('recent-files');
        
        if (this.recentFiles.length === 0) {
            return; // Keep empty state
        }
        
        recentContainer.innerHTML = '';
        
        // Sort by access time (most recently accessed first)
        const sortedRecent = [...this.recentFiles].sort((a, b) => {
            const aTime = a.lastAccessed || a.modified;
            const bTime = b.lastAccessed || b.modified;
            return new Date(bTime) - new Date(aTime);
        }).slice(0, 10); // Show only 10 most recent
        
        sortedRecent.forEach(file => {
            const recentElement = this.createRecentFileElement(file);
            recentContainer.appendChild(recentElement);
        });
    }

    updateRecentPreview() {
        const recentPreview = document.getElementById('recent-preview');
        
        if (this.recentFiles.length === 0) {
            recentPreview.innerHTML = '<div class="recent-empty">no recent files</div>';
            return;
        }
        
        recentPreview.innerHTML = '';
        
        // Sort by access time (most recently accessed first) and take max 20
        const sortedRecent = [...this.recentFiles].sort((a, b) => {
            const aTime = a.lastAccessed || a.modified;
            const bTime = b.lastAccessed || b.modified;
            return new Date(bTime) - new Date(aTime);
        }).slice(0, 20);
        
        sortedRecent.forEach(file => {
            const previewElement = this.createRecentPreviewElement(file);
            recentPreview.appendChild(previewElement);
        });
    }

    async loadAppIcon(file, iconContainer) {
        try {
            const result = await window.electronAPI.getAppIcon(file.path);
            
            if (result.success && result.iconDataUrl) {
                const img = document.createElement('img');
                img.src = result.iconDataUrl;
                img.style.width = '100%';
                img.style.height = '100%';
                img.style.objectFit = 'contain';
                img.style.borderRadius = '6px';
                
                img.onerror = () => {
                    // Fallback to generic icon if app icon fails to load
                    img.style.display = 'none';
                    iconContainer.innerHTML = this.getFileIcon(file);
                };
                
                iconContainer.appendChild(img);
            } else {
                // No app icon found, use generic icon
                iconContainer.innerHTML = this.getFileIcon(file);
            }
        } catch (error) {
            // Error getting app icon, use generic icon
            console.error(`Error loading app icon for ${file.name}:`, error);
            iconContainer.innerHTML = this.getFileIcon(file);
        }
    }

    createRecentPreviewElement(file) {
        const div = document.createElement('div');
        div.className = 'recent-preview-item';
        div.dataset.path = file.path;
        
        const category = this.getFileCategory(file);
        
        // Check if it's an image file for preview
        if (category === 'pictures') {
            const img = document.createElement('img');
            img.src = `file://${file.path}`;
            img.onerror = () => {
                // Fallback to icon if image fails to load
                img.style.display = 'none';
                const iconDiv = document.createElement('div');
                iconDiv.className = 'recent-preview-icon';
                iconDiv.innerHTML = this.getFileIcon(file);
                div.appendChild(iconDiv);
            };
            div.appendChild(img);
        } else if (category === 'applications' && file.isApplication) {
            // Try to load app icon for applications in recent
            const iconDiv = document.createElement('div');
            iconDiv.className = 'recent-preview-icon';
            this.loadAppIcon(file, iconDiv);
            div.appendChild(iconDiv);
        } else {
            // Use icon for non-image files
            const iconDiv = document.createElement('div');
            iconDiv.className = 'recent-preview-icon';
            iconDiv.innerHTML = this.getFileIcon(file);
            div.appendChild(iconDiv);
        }
        
        // Add file name overlay
        const nameDiv = document.createElement('div');
        nameDiv.className = 'recent-item-name';
        nameDiv.textContent = file.name;
        div.appendChild(nameDiv);
        
        // Event listeners
        div.addEventListener('click', () => this.handleFileClick(null, file));
        div.addEventListener('contextmenu', (e) => this.showContextMenu(e, file));
        
        return div;
    }

    createRecentFileElement(file) {
        const div = document.createElement('div');
        div.className = 'recent-file';
        div.dataset.path = file.path;
        
        const fileName = document.createElement('div');
        fileName.className = 'file-name';
        fileName.textContent = file.name;
        
        const fileType = document.createElement('div');
        fileType.className = 'file-details';
        fileType.textContent = this.getFileCategory(file);
        
        div.appendChild(fileName);
        div.appendChild(fileType);
        
        div.addEventListener('click', () => this.handleFileClick(null, file));
        div.addEventListener('contextmenu', (e) => this.showContextMenu(e, file));
        
        return div;
    }

    getFileCategory(file) {
        if (file.isApplication || file.extension === '.app') {
            return 'applications';
        }
        
        const ext = file.extension.toLowerCase();
        for (const [category, extensions] of Object.entries(this.fileExtensions)) {
            if (extensions.includes(ext)) {
                return category;
            }
        }
        return 'other';
    }

    setViewMode(mode) {
        this.currentViewMode = mode;

        document.querySelectorAll('.view-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        document.getElementById(`${mode}-view-btn`).classList.add('active');

        if (this.currentView === 'content') {
            if (this.currentCategory === 'documents' && !this.browsingMode) {
                this.renderRootView();
            } else if (this.browsingMode) {
                this.renderDirectoryContents();
            } else {
                this.renderCategoryContent();
            }
        }
    }

    renderCategoryContent() {
        const fileDisplay = document.getElementById('file-display');
        const files = this.categorizedFiles[this.currentCategory];
        
        fileDisplay.innerHTML = '';
        fileDisplay.className = `file-display ${this.currentViewMode}-view`;
        
        if (files.length === 0) {
            fileDisplay.innerHTML = '<div class="empty-state">No files found in this category</div>';
            return;
        }
        
        // Sort files by name
        files.sort((a, b) => a.name.localeCompare(b.name));
        
        files.forEach(file => {
            const fileElement = this.createFileElement(file);
            fileDisplay.appendChild(fileElement);
        });
    }

    createFileElement(file) {
        const div = document.createElement('div');
        div.className = `file-item ${this.currentViewMode}`;
        div.tabIndex = 0;
        div.dataset.path = file.path;
        
        // Create file icon/preview
        const fileIcon = document.createElement('div');
        fileIcon.className = 'file-icon';
        
        const category = this.getFileCategory(file);
        
        // Use image preview for picture files, fallback to icon
        if (category === 'pictures') {
            const img = document.createElement('img');
            img.src = `file://${file.path}`;
            img.style.width = '100%';
            img.style.height = '100%';
            img.style.objectFit = 'cover';
            img.style.borderRadius = '6px';
            
            img.onerror = () => {
                // Fallback to icon if image fails to load
                img.style.display = 'none';
                fileIcon.innerHTML = this.getFileIcon(file);
            };
            
            fileIcon.appendChild(img);
        } else if (category === 'applications' && file.isApplication) {
            // Try to get app icon for applications
            this.loadAppIcon(file, fileIcon);
        } else {
            // Use icon for non-image files
            fileIcon.innerHTML = this.getFileIcon(file);
        }
        
        const fileInfo = document.createElement('div');
        fileInfo.className = 'file-info';
        
        const fileName = document.createElement('div');
        fileName.className = 'file-name';
        fileName.textContent = file.name;
        
        const fileDetails = document.createElement('div');
        fileDetails.className = 'file-details';
        
        const fileSize = document.createElement('span');
        fileSize.textContent = this.formatFileSize(file.size);
        
        const fileDate = document.createElement('span');
        fileDate.textContent = this.formatDate(file.modified);
        
        fileDetails.appendChild(fileSize);
        fileDetails.appendChild(fileDate);
        
        fileInfo.appendChild(fileName);
        fileInfo.appendChild(fileDetails);
        
        div.appendChild(fileIcon);
        div.appendChild(fileInfo);
        
        // Event listeners
        div.addEventListener('click', (e) => this.handleFileClick(e, file));
        div.addEventListener('contextmenu', (e) => this.showContextMenu(e, file));
        
        return div;
    }

    getFileIcon(file) {
        // For actual applications, try to show a generic app icon
        if (file.isApplication || file.extension === '.app') {
            return `<svg viewBox="0 0 64 64" fill="none">
                <rect x="8" y="8" width="48" height="48" rx="12" fill="#00cc66" opacity="0.2"/>
                <rect x="8" y="8" width="48" height="48" rx="12" stroke="#00cc66" stroke-width="2"/>
                <circle cx="24" cy="24" r="2" fill="#00cc66"/>
                <circle cx="32" cy="24" r="2" fill="#00cc66"/>
                <circle cx="40" cy="24" r="2" fill="#00cc66"/>
                <circle cx="24" cy="32" r="2" fill="#00cc66"/>
                <circle cx="32" cy="32" r="2" fill="#00cc66"/>
                <circle cx="40" cy="32" r="2" fill="#00cc66"/>
                <circle cx="24" cy="40" r="2" fill="#00cc66"/>
                <circle cx="32" cy="40" r="2" fill="#00cc66"/>
                <circle cx="40" cy="40" r="2" fill="#00cc66"/>
            </svg>`;
        }
        
        const category = this.getFileCategory(file);
        const colors = {
            music: '#ff6900',
            videos: '#ff0066', 
            pictures: '#9966ff',
            documents: '#0099ff',
            applications: '#00cc66'
        };
        
        const color = colors[category] || '#666666';
        
        const icons = {
            music: `<svg viewBox="0 0 64 64" fill="none">
                <circle cx="32" cy="32" r="28" fill="${color}" opacity="0.2"/>
                <path d="M24 20v24l16-8-16-8z" fill="${color}"/>
                <circle cx="32" cy="32" r="28" stroke="${color}" stroke-width="2"/>
            </svg>`,
            videos: `<svg viewBox="0 0 64 64" fill="none">
                <rect x="8" y="16" width="48" height="32" rx="4" fill="${color}" opacity="0.2"/>
                <path d="M28 24v16l12-8-12-8z" fill="${color}"/>
                <rect x="8" y="16" width="48" height="32" rx="4" stroke="${color}" stroke-width="2"/>
            </svg>`,
            pictures: `<svg viewBox="0 0 64 64" fill="none">
                <rect x="8" y="12" width="48" height="40" rx="4" fill="${color}" opacity="0.2"/>
                <circle cx="24" cy="28" r="4" fill="${color}"/>
                <path d="M16 44l8-8 4 4 12-12 8 8v8H16v-8z" fill="${color}"/>
                <rect x="8" y="12" width="48" height="40" rx="4" stroke="${color}" stroke-width="2"/>
            </svg>`,
            documents: `<svg viewBox="0 0 64 64" fill="none">
                <path d="M16 8h24l8 8v40H16V8z" fill="${color}" opacity="0.2"/>
                <path d="M40 8v8h8" stroke="${color}" stroke-width="2" fill="none"/>
                <path d="M16 8h24l8 8v40H16V8z" stroke="${color}" stroke-width="2" fill="none"/>
                <path d="M24 28h16M24 36h16M24 44h12" stroke="${color}" stroke-width="1.5"/>
            </svg>`,
            applications: `<svg viewBox="0 0 64 64" fill="none">
                <rect x="12" y="12" width="40" height="40" rx="8" fill="${color}" opacity="0.2"/>
                <circle cx="28" cy="28" r="3" fill="${color}"/>
                <circle cx="36" cy="28" r="3" fill="${color}"/>
                <circle cx="28" cy="36" r="3" fill="${color}"/>
                <circle cx="36" cy="36" r="3" fill="${color}"/>
                <rect x="12" y="12" width="40" height="40" rx="8" stroke="${color}" stroke-width="2"/>
            </svg>`
        };
        
        return icons[category] || icons.documents;
    }

    formatFileSize(bytes) {
        if (!bytes || bytes <= 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    formatDate(date) {
        const d = new Date(date);
        const now = new Date();
        const diffTime = Math.abs(now - d);
        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

        if (diffDays === 0) return 'Today';
        if (diffDays === 1) return 'Yesterday';
        if (diffDays < 7) return `${diffDays} days ago`;
        
        return d.toLocaleDateString('en-US', { 
            month: 'short', 
            day: 'numeric',
            year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
        });
    }

    onTrackChange(data) {
        const { metadata } = data;

        // Show bottom bar
        document.getElementById('player-bottom-bar').classList.add('visible');
        document.body.classList.add('player-active');

        // Update bottom bar
        document.getElementById('player-bar-title').textContent = metadata.title;
        document.getElementById('player-bar-artist').textContent = metadata.artist;

        // Update Now Playing
        document.getElementById('np-artist').textContent = metadata.artist.toUpperCase();
        document.getElementById('np-album').textContent = metadata.album;
        document.getElementById('np-title').textContent = metadata.title;

        // Album art
        const barImg = document.getElementById('player-bar-art-img');
        const barPlaceholder = document.querySelector('.player-bar-art-placeholder');
        const npImg = document.getElementById('np-art-img');
        const npPlaceholder = document.querySelector('.np-art-placeholder');

        if (metadata.albumArt) {
            barImg.src = metadata.albumArt;
            barImg.style.display = 'block';
            if (barPlaceholder) barPlaceholder.style.display = 'none';

            npImg.src = metadata.albumArt;
            npImg.style.display = 'block';
            if (npPlaceholder) npPlaceholder.style.display = 'none';
        } else {
            barImg.style.display = 'none';
            if (barPlaceholder) barPlaceholder.style.display = 'block';

            npImg.style.display = 'none';
            if (npPlaceholder) npPlaceholder.style.display = 'block';
        }

        // Update queue display
        this.updateQueueDisplay();
    }

    onPlayStateChange(playing) {
        const playPath = playing ? 'M6 4h4v16H6zm8 0h4v16h-4z' : 'M8 5v14l11-7z';

        // Update SVG paths via setAttribute (DOM-safe)
        document.getElementById('player-bar-play-path').setAttribute('d', playPath);
        document.getElementById('np-play-path').setAttribute('d', playPath);

        // Equalizer animation
        const eq = document.getElementById('player-equalizer');
        eq.classList.toggle('paused', !playing);
    }

    onTimeUpdate(data) {
        const { currentTime, duration } = data;
        const percent = duration ? (currentTime / duration) * 100 : 0;
        const remaining = duration - currentTime;

        // Bottom bar
        document.getElementById('player-bar-progress-fill').style.width = percent + '%';
        document.getElementById('player-bar-elapsed').textContent = this.audioPlayer.formatTime(currentTime);
        document.getElementById('player-bar-remaining').textContent = '-' + this.audioPlayer.formatTime(remaining);

        // Now Playing
        document.getElementById('np-progress-fill').style.width = percent + '%';
        document.getElementById('np-elapsed').textContent = this.audioPlayer.formatTime(currentTime);
        document.getElementById('np-remaining').textContent = '-' + this.audioPlayer.formatTime(remaining);
    }

    updateQueueDisplay() {
        const queueList = document.getElementById('np-queue-list');
        const queue = this.audioPlayer.queue;
        const currentIndex = this.audioPlayer.currentIndex;

        // Clear existing queue items
        while (queueList.firstChild) {
            queueList.removeChild(queueList.firstChild);
        }

        // Show upcoming tracks (current + next 20)
        const startIdx = currentIndex;
        const endIdx = Math.min(queue.length, currentIndex + 21);

        for (let i = startIdx; i < endIdx; i++) {
            const track = queue[i];
            const item = document.createElement('div');
            item.className = 'np-queue-item' + (i === currentIndex ? ' active' : '');

            const num = document.createElement('span');
            num.className = 'np-queue-item-num';
            num.textContent = (i + 1).toString();
            item.appendChild(num);

            const title = document.createElement('span');
            title.className = 'np-queue-item-title';
            const fileName = track.name || track.path.split(/[/\\]/).pop();
            const dotIdx = fileName.lastIndexOf('.');
            title.textContent = dotIdx > 0 ? fileName.substring(0, dotIdx) : fileName;
            item.appendChild(title);

            item.addEventListener('click', () => {
                this.audioPlayer.currentIndex = i;
                this.audioPlayer.loadAndPlay(queue[i]);
            });

            queueList.appendChild(item);
        }
    }

    openNowPlaying() {
        document.getElementById('now-playing-panel').classList.add('open');
        this.nowPlayingOpen = true;
    }

    closeNowPlaying() {
        document.getElementById('now-playing-panel').classList.remove('open');
        this.nowPlayingOpen = false;
    }

    handleFileClick(e, file) {
        // Check if this is a music file
        if (this.fileExtensions.music.includes(file.extension)) {
            // Build queue from all music files in current view
            const queue = this.currentCategory === 'music'
                ? this.categorizedFiles.music
                : this.categorizedFiles[this.currentCategory].filter(f =>
                    this.fileExtensions.music.includes(f.extension)
                  );
            this.audioPlayer.play(file, queue.length > 0 ? queue : [file]);
        } else {
            // Open non-music files externally
            window.electronAPI.openFile(file.path);
        }

        this.selectedFile = file;
        this.addToRecentFiles(file);
        this.updateRecentFiles();
    }

    showContextMenu(e, file) {
        e.preventDefault();
        e.stopPropagation();
        
        this.selectedFile = file;
        const contextMenu = document.getElementById('context-menu');
        
        // Position the context menu
        const x = e.clientX;
        const y = e.clientY;
        
        contextMenu.style.left = `${x}px`;
        contextMenu.style.top = `${y}px`;
        contextMenu.style.display = 'block';
        
        // Adjust position if menu goes off screen
        const rect = contextMenu.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            contextMenu.style.left = `${x - rect.width}px`;
        }
        if (rect.bottom > window.innerHeight) {
            contextMenu.style.top = `${y - rect.height}px`;
        }
    }

    hideContextMenu() {
        document.getElementById('context-menu').style.display = 'none';
    }

    async handleContextMenuAction(e) {
        const action = e.target.dataset.action;
        
        if (!this.selectedFile) return;
        
        switch (action) {
            case 'open':
                await window.electronAPI.openFile(this.selectedFile.path);
                // Add to recent files when opened via context menu
                this.addToRecentFiles(this.selectedFile);
                this.updateRecentFiles();
                break;
            
            case 'show-in-folder':
                await window.electronAPI.showItemInFolder(this.selectedFile.path);
                break;
            
            case 'delete':
                const result = await window.electronAPI.deleteFile(this.selectedFile.path);
                if (result.success) {
                    if (this.currentCategory === 'documents' && this.browsingMode) {
                        await this.renderDirectoryContents();
                    } else if (this.currentCategory !== 'documents') {
                        await this.scanFileSystem();
                        this.updateFileCounts();
                        this.renderCategoryContent();
                    }
                    this.updateRecentFiles();
                }
                break;
        }
        
        this.hideContextMenu();
    }
}

// Initialize the Zune Explorer when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new ZuneExplorer();
});