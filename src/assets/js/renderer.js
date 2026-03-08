class ZuneSyncPanel {
    constructor(explorer) {
        this.explorer = explorer;
        this.open = false;
        this.state = 'disconnected';
        this.browseActive = false;
        this.browseTab = 'music';
        this.browseData = null;
        this.selectedHandles = new Set();
        this.deleteConfirmTimer = null;
        this.diffDeleteConfirmTimer = null;

        // Cache + diff state
        this.deviceKey = null;
        this.cachedData = null;
        this.diffResult = null;
        this.diffTab = 'local-only';
        this.diffGroupBy = 'all';            // 'all' | 'album' | 'artist'
        this.diffCategory = 'music';              // 'music' | 'videos' | 'pictures'
        this.collapsedGroups = new Set();     // keys of collapsed group headers
        this.diffSelectedPaths = new Set();   // local-only selected paths
        this.diffSelectedHandles = new Set(); // device-only selected handles
        this.diffActive = false;
        this.diffFilterQuery = '';          // current filter text
        this._diffFilterTimer = null;       // debounce timer
        this.scanStartTime = null;
        this.lastStatus = null;
        this.deviceModel = null;
        this.storageBreakdown = null;

        this.panel = document.getElementById('zune-sync-panel');
        this.toggleBtn = document.getElementById('zune-toggle-btn');
        this.dropZone = document.getElementById('zune-drop-zone');

        this._bindEvents();
        this._listenForZune();
    }

    _bindEvents() {
        this.toggleBtn.addEventListener('click', () => this.toggle());

        // Drop zone drag handling with counter to prevent child-element flicker
        let dragCounter = 0;
        this.dropZone.addEventListener('dragenter', (e) => {
            e.preventDefault();
            dragCounter++;
            this.dropZone.classList.add('dragover');
        });
        this.dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        });
        this.dropZone.addEventListener('dragleave', () => {
            dragCounter--;
            if (dragCounter === 0) this.dropZone.classList.remove('dragover');
        });
        this.dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dragCounter = 0;
            this.dropZone.classList.remove('dragover');
            const paths = [];

            // Internal drag (from app file explorer)
            const zuneData = e.dataTransfer.getData('application/x-zune-paths');
            if (zuneData) {
                try { paths.push(...JSON.parse(zuneData)); } catch (err) { /* ignore */ }
            }

            // External drag (from OS file manager)
            if (paths.length === 0 && e.dataTransfer.files.length > 0) {
                for (const f of e.dataTransfer.files) {
                    const p = window.electronAPI.getPathForFile(f);
                    if (p) paths.push(p);
                }
            }

            if (paths.length > 0) this._sendFiles(paths);
        });

        // Auto-open sync panel when dragging over the toggle button
        this.toggleBtn.addEventListener('dragenter', (e) => {
            e.preventDefault();
            if (!this.open && this.state === 'connected') this.show();
        });
        this.toggleBtn.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        });

        document.getElementById('zune-sync-music').addEventListener('click', () => {
            const paths = this.explorer.categorizedFiles.music.map(f => f.path);
            if (paths.length > 0) this._sendFiles(paths);
        });
        document.getElementById('zune-sync-videos').addEventListener('click', () => {
            const paths = this.explorer.categorizedFiles.videos.map(f => f.path);
            if (paths.length > 0) this._sendFiles(paths);
        });
        document.getElementById('zune-sync-pictures').addEventListener('click', () => {
            const paths = this.explorer.categorizedFiles.pictures.map(f => f.path);
            if (paths.length > 0) this._sendFiles(paths);
        });

        document.getElementById('zune-cancel-btn').addEventListener('click', () => {
            window.electronAPI.zuneCancelTransfer();
        });

        // Browse device
        document.getElementById('zune-browse-btn').addEventListener('click', () => {
            this._openBrowse();
        });

        // Eject
        document.getElementById('zune-eject-btn').addEventListener('click', () => {
            window.electronAPI.zuneEject();
        });

        // Install WinUSB driver (Windows only)
        const installDriverBtn = document.getElementById('zune-install-driver-btn');
        if (installDriverBtn) {
            installDriverBtn.addEventListener('click', async () => {
                const hint = document.getElementById('zune-driver-hint');
                installDriverBtn.disabled = true;
                if (hint) hint.textContent = 'installing... a UAC prompt may appear';
                const result = await window.electronAPI.zuneInstallDriver();
                installDriverBtn.disabled = false;
                if (result.success) {
                    if (hint) hint.textContent = 'driver installed — connecting...';
                } else {
                    if (hint) hint.textContent = 'install failed: ' + (result.error || 'unknown error');
                }
            });
        }


        // Browse back button
        document.getElementById('zune-browse-back').addEventListener('click', () => {
            this._closeBrowse();
        });

        // Browse tabs
        document.querySelectorAll('.zune-browse-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                this.browseTab = tab.dataset.tab;
                document.querySelectorAll('.zune-browse-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                this._renderBrowseList();
            });
        });

        // Delete button
        document.getElementById('zune-delete-btn').addEventListener('click', () => {
            this._handleDelete();
        });

        // WMDRMPD probe (diagnostic)
        document.getElementById('zune-probe-wmdrmpd-btn').addEventListener('click', () => {
            window.electronAPI.zuneProbeWmdrmpd();
        });

        // Diff tabs
        document.querySelectorAll('.zune-diff-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                this.diffTab = tab.dataset.diff;
                document.querySelectorAll('.zune-diff-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                this.diffSelectedPaths.clear();
                this.diffSelectedHandles.clear();
                this.diffFilterQuery = '';
                document.getElementById('zune-diff-filter-input').value = '';
                document.getElementById('zune-diff-filter-clear').style.display = 'none';
                this._renderDiffList();
            });
        });

        // Diff category tabs
        document.querySelectorAll('.zune-diff-category-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                this.diffCategory = tab.dataset.category;
                document.querySelectorAll('.zune-diff-category-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                this.diffTab = 'local-only';
                document.querySelectorAll('.zune-diff-tab').forEach(t => t.classList.remove('active'));
                document.querySelector('.zune-diff-tab[data-diff="local-only"]').classList.add('active');
                this.diffSelectedPaths.clear();
                this.diffSelectedHandles.clear();
                this.diffGroupBy = 'all';
                document.querySelectorAll('.zune-diff-group-btn').forEach(b => b.classList.remove('active'));
                document.querySelector('.zune-diff-group-btn[data-group="all"]').classList.add('active');
                this.collapsedGroups.clear();
                this.diffFilterQuery = '';
                document.getElementById('zune-diff-filter-input').value = '';
                document.getElementById('zune-diff-filter-clear').style.display = 'none';
                if (this.diffDeleteConfirmTimer) {
                    clearTimeout(this.diffDeleteConfirmTimer);
                    this.diffDeleteConfirmTimer = null;
                }
                document.getElementById('zune-diff-delete-btn').classList.remove('confirm');
                this._computeDiff();
                this._renderDiffSummary();
                this._renderDiffList();
            });
        });

        // Group-by buttons
        document.querySelectorAll('.zune-diff-group-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.diffGroupBy = btn.dataset.group;
                document.querySelectorAll('.zune-diff-group-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.collapsedGroups.clear();
                this._renderDiffList();
            });
        });

        // Select-all checkbox
        document.getElementById('zune-diff-select-all-check').addEventListener('change', (e) => {
            this._handleSelectAll(e.target.checked);
        });

        // Diff filter input
        const filterInput = document.getElementById('zune-diff-filter-input');
        const filterClear = document.getElementById('zune-diff-filter-clear');

        filterInput.addEventListener('input', () => {
            clearTimeout(this._diffFilterTimer);
            this._diffFilterTimer = setTimeout(() => {
                this.diffFilterQuery = filterInput.value.trim().toLowerCase();
                filterClear.style.display = this.diffFilterQuery ? 'block' : 'none';
                this._renderDiffList();
            }, 150);
        });

        filterInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (this.diffFilterQuery) {
                    e.stopPropagation();
                }
                filterInput.value = '';
                this.diffFilterQuery = '';
                filterClear.style.display = 'none';
                this._renderDiffList();
            }
        });

        filterClear.addEventListener('click', () => {
            filterInput.value = '';
            this.diffFilterQuery = '';
            filterClear.style.display = 'none';
            filterInput.focus();
            this._renderDiffList();
        });

        // Push (sync to device)
        document.getElementById('zune-push-btn').addEventListener('click', () => {
            this._pushToDevice();
        });

        // Pull (copy to computer)
        document.getElementById('zune-pull-btn').addEventListener('click', () => {
            this._pullFromDevice();
        });

        // Delete from device (diff view)
        document.getElementById('zune-diff-delete-btn').addEventListener('click', () => {
            this._deleteFromDevice();
        });

        // Rescan device
        document.getElementById('zune-rescan-btn').addEventListener('click', () => {
            this._rescanDevice();
        });

        // Diff back button
        document.getElementById('zune-diff-back').addEventListener('click', () => {
            this._closeDiff();
        });
    }

    _listenForZune() {
        window.electronAPI.onZuneStatus((status) => {
            this.state = status.state;
            this.lastStatus = status;
            this._updateUI(status);
        });
        window.electronAPI.onZuneTransferProgress((progress) => {
            this._updateProgress(progress);
        });

        // Request current status in case the device connected before renderer loaded
        window.electronAPI.zuneGetStatus().then((status) => {
            if (status) {
                this.state = status.state;
                this.lastStatus = status;
                this._updateUI(status);
            }
        });
    }

    toggle() {
        if (this.open) {
            // Closing — exit diff/browse if active
            if (this.diffActive) this._closeDiff();
            if (this.browseActive) this._closeBrowse();
        }
        this.open = !this.open;
        this.panel.classList.toggle('open', this.open);
    }

    show() {
        this.open = true;
        this.panel.classList.add('open');
    }

    _updateUI(status) {
        const title = document.getElementById('zune-sync-title');
        const subtitle = document.getElementById('zune-sync-subtitle');
        const storageEl = document.getElementById('zune-sync-storage');
        const idleEl = document.getElementById('zune-sync-idle');
        const progressEl = document.getElementById('zune-sync-progress');
        const completeEl = document.getElementById('zune-sync-complete');

        const ejectBtn = document.getElementById('zune-eject-btn');
        const silhouette = document.getElementById('zune-device-silhouette');

        storageEl.style.display = 'none';
        idleEl.style.display = 'none';
        progressEl.style.display = 'none';
        completeEl.style.display = 'none';
        ejectBtn.style.display = 'none';
        silhouette.style.display = 'none';
        const driverNeededEl = document.getElementById('zune-driver-needed');
        if (driverNeededEl) driverNeededEl.style.display = 'none';

        // Close browse/diff views on any state change that isn't 'connected'
        const browseEl = document.getElementById('zune-browse-view');
        const diffEl = document.getElementById('zune-diff-view');

        switch (status.state) {
            case 'connecting':
                this.toggleBtn.style.display = 'flex';
                title.textContent = (status.model || 'zune').toLowerCase();
                subtitle.textContent = 'connecting...';
                if (this.browseActive) this._closeBrowse();
                if (this.diffActive) this._closeDiff();
                this.show();
                break;

            case 'connected':
                this.toggleBtn.style.display = 'flex';
                this.deviceModel = status.model || 'zune';
                title.textContent = this.deviceModel.toLowerCase();
                subtitle.textContent = 'connected';
                this._setDeviceSilhouette(this.deviceModel);
                // Derive device key
                if (status.productId && status.storage) {
                    const pidHex = status.productId.toString(16).toUpperCase().padStart(4, '0');
                    this.deviceKey = `${pidHex}-${status.storage.maxCapacity}`;
                }
                ejectBtn.style.display = 'block';
                silhouette.style.display = 'block';
                if (status.storage) {
                    this._updateStorage(status.storage);
                    storageEl.style.display = 'block';
                }
                if (!this.browseActive && !this.diffActive) {
                    idleEl.style.display = 'block';
                } else if (this.diffActive) {
                    diffEl.style.display = 'flex';
                } else if (this.browseActive) {
                    browseEl.style.display = 'flex';
                }
                this.show();
                break;

            case 'disconnected':
                if (this.browseActive) this._closeBrowse();
                if (this.diffActive) this._closeDiff();
                this.deviceKey = null;
                this.deviceModel = null;
                this.storageBreakdown = null;
                this.toggleBtn.style.display = 'none';
                this.open = false;
                this.panel.classList.remove('open');
                break;

            case 'driver-needed':
                if (this.browseActive) this._closeBrowse();
                if (this.diffActive) this._closeDiff();
                this.toggleBtn.style.display = 'flex';
                title.textContent = 'zune';
                subtitle.textContent = 'driver required';
                if (driverNeededEl) driverNeededEl.style.display = 'flex';
                this.show();
                break;

            case 'error':
                if (this.browseActive) this._closeBrowse();
                if (this.diffActive) this._closeDiff();
                subtitle.textContent = 'error: ' + (status.error || 'unknown');
                break;
        }
    }

    _updateStorage(storage) {
        const text = document.getElementById('zune-storage-text');
        const legend = document.getElementById('zune-storage-legend');
        const musicSeg = document.getElementById('zune-storage-music');
        const videosSeg = document.getElementById('zune-storage-videos');
        const picturesSeg = document.getElementById('zune-storage-pictures');
        const otherSeg = document.getElementById('zune-storage-other');

        const freeGB = (storage.freeSpace / (1024 * 1024 * 1024)).toFixed(1);
        text.textContent = freeGB + ' GB free';

        const totalUsed = storage.maxCapacity - storage.freeSpace;

        if (this.storageBreakdown) {
            // Segmented bar with per-category breakdown
            const bd = this.storageBreakdown;
            const pct = (bytes) => ((bytes / storage.maxCapacity) * 100).toFixed(2) + '%';
            musicSeg.style.width = pct(bd.music);
            videosSeg.style.width = pct(bd.videos);
            picturesSeg.style.width = pct(bd.pictures);
            otherSeg.style.width = pct(bd.other);
            legend.style.display = 'flex';
        } else {
            // Simple total-used bar (all as "other" until we have breakdown)
            const usedPct = ((totalUsed / storage.maxCapacity) * 100).toFixed(1) + '%';
            musicSeg.style.width = '0%';
            videosSeg.style.width = '0%';
            picturesSeg.style.width = '0%';
            otherSeg.style.width = usedPct;
            legend.style.display = 'none';
        }
    }

    _setDeviceSilhouette(model) {
        const el = document.getElementById('zune-device-silhouette');
        if (!el) return;
        const isHD = model && model.toLowerCase().includes('hd');
        // Build SVG using DOM methods (no innerHTML with untrusted data — model is not used in SVG)
        el.textContent = '';
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', isHD ? '0 0 60 120' : '0 0 70 120');
        svg.setAttribute('fill', 'white');
        if (isHD) {
            // Zune HD — slim, tall, rounded, touch pad circle at bottom
            const body = document.createElementNS(ns, 'rect');
            Object.entries({x:'5',y:'2',width:'50',height:'116',rx:'8',fill:'white'}).forEach(([k,v])=>body.setAttribute(k,v));
            const screen = document.createElementNS(ns, 'rect');
            Object.entries({x:'12',y:'10',width:'36',height:'55',rx:'2',fill:'black',opacity:'0.2'}).forEach(([k,v])=>screen.setAttribute(k,v));
            const pad = document.createElementNS(ns, 'circle');
            Object.entries({cx:'30',cy:'90',r:'14',fill:'black',opacity:'0.3'}).forEach(([k,v])=>pad.setAttribute(k,v));
            svg.append(body, screen, pad);
        } else {
            // Classic Zune — wider body, squircle click pad
            const body = document.createElementNS(ns, 'rect');
            Object.entries({x:'3',y:'2',width:'64',height:'116',rx:'10',fill:'white'}).forEach(([k,v])=>body.setAttribute(k,v));
            const screen = document.createElementNS(ns, 'rect');
            Object.entries({x:'12',y:'10',width:'46',height:'45',rx:'3',fill:'black',opacity:'0.2'}).forEach(([k,v])=>screen.setAttribute(k,v));
            const pad = document.createElementNS(ns, 'rect');
            Object.entries({x:'17',y:'68',width:'36',height:'36',rx:'10',fill:'black',opacity:'0.3'}).forEach(([k,v])=>pad.setAttribute(k,v));
            svg.append(body, screen, pad);
        }
        el.appendChild(svg);
    }

    _computeStorageBreakdown() {
        if (!this.browseData || !this.lastStatus?.storage) return;
        const sumSize = (items) => (items || []).reduce((acc, item) => acc + (item.size || 0), 0);
        const musicBytes = sumSize(this.browseData.music);
        const videosBytes = sumSize(this.browseData.videos);
        const picturesBytes = sumSize(this.browseData.pictures);
        const totalUsed = this.lastStatus.storage.maxCapacity - this.lastStatus.storage.freeSpace;
        const knownBytes = musicBytes + videosBytes + picturesBytes;
        const otherBytes = Math.max(0, totalUsed - knownBytes);
        this.storageBreakdown = { music: musicBytes, videos: videosBytes, pictures: picturesBytes, other: otherBytes };
        this._updateStorage(this.lastStatus.storage);
    }

    _updateProgress(progress) {
        const countEl = document.getElementById('zune-progress-count');
        const fileEl = document.getElementById('zune-progress-file');
        const fillEl = document.getElementById('zune-progress-fill');
        const overallEl = document.getElementById('zune-progress-overall');
        const bytesEl = document.getElementById('zune-progress-bytes');
        const idleEl = document.getElementById('zune-sync-idle');
        const progressEl = document.getElementById('zune-sync-progress');
        const completeEl = document.getElementById('zune-sync-complete');

        // Close browse view during transfers
        if (this.browseActive && (progress.state === 'converting' || progress.state === 'sending')) {
            this._closeBrowse();
        }

        switch (progress.state) {
            case 'converting':
                idleEl.style.display = 'none';
                progressEl.style.display = 'block';
                completeEl.style.display = 'none';
                document.getElementById('zune-sync-title').textContent = 'syncing...';
                document.getElementById('zune-sync-subtitle').textContent = `${progress.fileIndex + 1} of ${progress.totalFiles}`;

                countEl.textContent = `converting ${progress.fileIndex + 1} of ${progress.totalFiles}`;
                fileEl.textContent = progress.fileName;
                fillEl.style.width = '0%';
                bytesEl.textContent = 'converting to mp3...';
                break;

            case 'sending':
                idleEl.style.display = 'none';
                progressEl.style.display = 'block';
                completeEl.style.display = 'none';
                document.getElementById('zune-sync-title').textContent = 'syncing...';
                document.getElementById('zune-sync-subtitle').textContent = `${progress.fileIndex + 1} of ${progress.totalFiles}`;

                countEl.textContent = `sending ${progress.fileIndex + 1} of ${progress.totalFiles}`;
                fileEl.textContent = progress.fileName;

                const filePercent = progress.totalBytes > 0
                    ? (progress.bytesTransferred / progress.totalBytes) * 100 : 0;
                fillEl.style.width = filePercent.toFixed(1) + '%';

                const overallPercent = ((progress.fileIndex + filePercent / 100) / progress.totalFiles) * 100;
                overallEl.style.width = overallPercent.toFixed(1) + '%';

                const sentMB = (progress.bytesTransferred / (1024 * 1024)).toFixed(1);
                const totalMB = (progress.totalBytes / (1024 * 1024)).toFixed(1);
                bytesEl.textContent = `${sentMB} / ${totalMB} MB`;
                break;

            case 'complete':
                progressEl.style.display = 'none';
                completeEl.style.display = 'block';
                document.getElementById('zune-sync-title').textContent = (this.deviceModel || 'zune').toLowerCase();
                document.getElementById('zune-sync-subtitle').textContent = 'connected';
                document.getElementById('zune-complete-text').textContent =
                    `${progress.completedFiles} files synced`;
                if (progress.storage) this._updateStorage(progress.storage);
                setTimeout(() => {
                    completeEl.style.display = 'none';
                    idleEl.style.display = 'block';
                }, 3000);
                break;

            case 'cancelled':
                progressEl.style.display = 'none';
                idleEl.style.display = 'block';
                document.getElementById('zune-sync-title').textContent = (this.deviceModel || 'zune').toLowerCase();
                document.getElementById('zune-sync-subtitle').textContent = 'connected';
                break;

            case 'error':
                progressEl.style.display = 'none';
                idleEl.style.display = 'block';
                document.getElementById('zune-sync-title').textContent = (this.deviceModel || 'zune').toLowerCase();
                document.getElementById('zune-sync-subtitle').textContent =
                    'transfer error: ' + (progress.error || 'unknown');
                break;
        }
    }

    async _sendFiles(filePaths) {
        await window.electronAPI.zuneSendFiles(filePaths);
    }

    async _openBrowse() {
        // Cache-first: try to load from cache before scanning
        if (this.deviceKey) {
            const cached = await window.electronAPI.zuneCacheLoad(this.deviceKey);
            if (cached.success && cached.data) {
                this.cachedData = cached.data;
                this.browseData = cached.data.contents;
                this._computeStorageBreakdown();
                this._openDiffView();
                return;
            }
        }

        // No cache — do a first-time scan with progress UI
        this._startFirstTimeScan();
    }

    async _startFirstTimeScan() {
        this.scanStartTime = Date.now();
        document.getElementById('zune-sync-idle').style.display = 'none';
        document.getElementById('zune-scan-progress').style.display = 'block';

        const labelEl = document.querySelector('.zune-scan-label');
        const fillEl = document.getElementById('zune-scan-fill');
        const statsEl = document.getElementById('zune-scan-stats');
        const errorEl = document.getElementById('zune-scan-error');
        fillEl.style.width = '0%';
        labelEl.textContent = 'scanning device...';
        statsEl.textContent = '0 files found';
        errorEl.style.display = 'none';

        let scanFileCount = 0; // total files found during folder scan

        // Listen for progressive updates during scan
        window.electronAPI.onZuneBrowseProgress((data) => {
            if (data.phase === 'scanning') {
                const found = (data.contents.music?.length || 0) +
                              (data.contents.videos?.length || 0) +
                              (data.contents.pictures?.length || 0);
                scanFileCount = found;
                const elapsed = ((Date.now() - this.scanStartTime) / 1000).toFixed(0);
                statsEl.textContent = `${found} files found · ${elapsed}s`;
                // Use per-handle progress if available (large single-folder devices)
                let pct;
                if (data.handleProgress && data.handleTotal) {
                    pct = Math.min(90, Math.round((data.handleProgress / data.handleTotal) * 90));
                } else {
                    pct = Math.min(90, (data.foldersScanned || 0) * 5);
                }
                fillEl.style.width = pct + '%';
            } else if (data.phase === 'enumerated') {
                const found = (data.contents.music?.length || 0) +
                              (data.contents.videos?.length || 0) +
                              (data.contents.pictures?.length || 0);
                scanFileCount = found;
                // Reset for phase 2: syncing metadata
                fillEl.style.width = '0%';
                labelEl.textContent = 'syncing files...';
                statsEl.textContent = `0 / ${scanFileCount}`;
            } else if (data.phase === 'resolving-albums') {
                const resolved = data.resolved || 0;
                const total = data.resolveTotal || 1;
                const pct = Math.round((resolved / total) * 100);
                fillEl.style.width = pct + '%';
                labelEl.textContent = 'resolving albums...';
                statsEl.textContent = `${resolved} / ${total}`;
            } else if (data.phase === 'albums-resolved') {
                // Album hierarchy resolved, enrichment starting
                const total = data.enrichTotal || scanFileCount;
                fillEl.style.width = '0%';
                labelEl.textContent = 'syncing files...';
                statsEl.textContent = `0 / ${total}`;
            } else if (data.phase === 'enriching') {
                const enriched = data.enriched || 0;
                const total = data.enrichTotal || scanFileCount;
                const pct = total > 0 ? Math.round((enriched / total) * 100) : 0;
                fillEl.style.width = pct + '%';
                statsEl.textContent = `${enriched} / ${total}`;
            } else if (data.phase === 'resolving-handles') {
                const resolved = data.resolved || 0;
                const total = data.total || 1;
                const pct = Math.round((resolved / total) * 100);
                fillEl.style.width = pct + '%';
                labelEl.textContent = 'syncing file handles...';
                statsEl.textContent = `${resolved} / ${total}`;
            }
            // Keep browse data updated for progressive rendering
            this.browseData = data.contents;
        });

        const result = await window.electronAPI.zuneBrowseContents();

        document.getElementById('zune-scan-progress').style.display = 'none';

        if (result.success) {
            this.browseData = result.contents;

            // Save to cache
            if (this.deviceKey) {
                const model = this.lastStatus?.model || 'Zune';
                const scanDurationMs = Date.now() - this.scanStartTime;
                await window.electronAPI.zuneCacheSave(this.deviceKey, {
                    model,
                    scanDurationMs,
                    counts: {
                        music: result.contents.music?.length || 0,
                        videos: result.contents.videos?.length || 0,
                        pictures: result.contents.pictures?.length || 0,
                    },
                    contents: result.contents,
                });
                const cached = await window.electronAPI.zuneCacheLoad(this.deviceKey);
                if (cached.success && cached.data) {
                    this.cachedData = cached.data;
                }
            }

            this._computeStorageBreakdown();
            this._openDiffView();
        } else {
            // Show error
            const errorEl = document.getElementById('zune-scan-error');
            errorEl.textContent = 'error: ' + (result.error || 'unknown');
            errorEl.style.display = 'block';
            document.getElementById('zune-scan-progress').style.display = 'block';
        }
    }

    _openDiffView() {
        this.diffActive = true;
        this.browseActive = false;
        this.diffTab = 'local-only';
        this.diffGroupBy = 'all';
        this.collapsedGroups = new Set();
        this.diffSelectedPaths.clear();
        this.diffSelectedHandles.clear();

        // Reset diff tab state
        document.querySelectorAll('.zune-diff-tab').forEach(t => t.classList.remove('active'));
        document.querySelector('.zune-diff-tab[data-diff="local-only"]').classList.add('active');

        // Reset group-by state
        document.querySelectorAll('.zune-diff-group-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('.zune-diff-group-btn[data-group="all"]').classList.add('active');

        // Reset category tab state
        this.diffCategory = 'music';
        document.querySelectorAll('.zune-diff-category-tab').forEach(t => t.classList.remove('active'));
        document.querySelector('.zune-diff-category-tab[data-category="music"]').classList.add('active');

        document.getElementById('zune-sync-idle').style.display = 'none';
        document.getElementById('zune-scan-progress').style.display = 'none';
        document.getElementById('zune-browse-view').style.display = 'none';
        document.getElementById('zune-diff-view').style.display = 'flex';
        document.getElementById('zune-diff-back').style.display = 'flex';
        document.getElementById('zune-eject-btn').style.display = 'none';
        this.panel.classList.add('has-back');
        this.panel.classList.add('expanded');

        // Push panoramic layout
        this.explorer.showSync();

        // Ensure local music library is scanned for accurate diff
        if (this.explorer.musicLibrary.scanState === 'idle') {
            this.explorer.scanMusicLibrary();
        }

        this._computeDiff();
        this._enrichDeviceArt();
        this._renderDiffSummary();
        this._renderDiffList();
    }

    _enrichDeviceArt() {
        if (!this.diffResult) return;
        if (this.diffCategory !== 'music') return;
        const albums = this.explorer.musicLibrary.albums;
        // Build a lookup by normalized album name for fuzzy matching
        const artByAlbum = new Map();
        for (const [, album] of albums) {
            if (album.albumArt) {
                artByAlbum.set(album.name.toLowerCase().trim(), album.albumArt);
            }
        }
        for (const item of this.diffResult.deviceOnly) {
            if (item.albumArt) continue;
            const albumName = (item.album || '').toLowerCase().trim();
            if (albumName && artByAlbum.has(albumName)) {
                item.albumArt = artByAlbum.get(albumName);
            }
        }
    }

    _closeDiff() {
        this.diffActive = false;
        this.diffResult = null;
        this.diffSelectedPaths.clear();
        this.diffSelectedHandles.clear();

        document.getElementById('zune-diff-view').style.display = 'none';
        document.getElementById('zune-diff-back').style.display = 'none';
        document.getElementById('zune-eject-btn').style.display = 'block';
        this.panel.classList.remove('has-back');
        this.panel.classList.remove('expanded');

        // Restore panoramic layout
        this.explorer.hideSync();

        if (this.state === 'connected') {
            document.getElementById('zune-sync-idle').style.display = 'block';
        }
    }

    async _rescanDevice() {
        // Invalidate cache and re-scan
        if (this.deviceKey) {
            await window.electronAPI.zuneCacheInvalidate(this.deviceKey);
        }
        this.cachedData = null;
        this.browseData = null;
        this.diffActive = false;
        document.getElementById('zune-diff-view').style.display = 'none';
        this._startFirstTimeScan();
    }

    // Legacy browse for non-diff usage (kept for browse-back compatibility)
    async _openLegacyBrowse() {
        this.browseActive = true;
        this.selectedHandles.clear();
        this.browseTab = 'music';

        // Reset tab state
        document.querySelectorAll('.zune-browse-tab').forEach(t => t.classList.remove('active'));
        document.querySelector('.zune-browse-tab[data-tab="music"]').classList.add('active');

        document.getElementById('zune-sync-idle').style.display = 'none';
        document.getElementById('zune-browse-view').style.display = 'flex';
        document.getElementById('zune-browse-actions').style.display = 'none';

        const listEl = document.getElementById('zune-browse-list');
        listEl.textContent = '';
        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'zune-browse-loading';
        loadingDiv.textContent = 'loading...';
        listEl.appendChild(loadingDiv);

        if (this.browseData) {
            this._renderBrowseList();
        }
    }

    _closeBrowse() {
        this.browseActive = false;
        // Don't clear browseData — it may be used by diff view
        this.selectedHandles.clear();
        if (this.deleteConfirmTimer) {
            clearTimeout(this.deleteConfirmTimer);
            this.deleteConfirmTimer = null;
        }

        document.getElementById('zune-browse-view').style.display = 'none';
        if (this.state === 'connected' && !this.diffActive) {
            document.getElementById('zune-sync-idle').style.display = 'block';
        }
    }

    _renderBrowseList() {
        const listEl = document.getElementById('zune-browse-list');
        const actionsEl = document.getElementById('zune-browse-actions');

        // Preserve scroll position across progressive re-renders
        const savedScroll = listEl.scrollTop;

        listEl.textContent = '';

        if (!this.browseData) {
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'zune-browse-empty';
            emptyDiv.textContent = 'no data';
            listEl.appendChild(emptyDiv);
            actionsEl.style.display = 'none';
            return;
        }

        const items = this.browseData[this.browseTab] || [];

        if (items.length === 0) {
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'zune-browse-empty';
            emptyDiv.textContent = 'no ' + this.browseTab + ' on device';
            listEl.appendChild(emptyDiv);
            actionsEl.style.display = 'none';
            return;
        }

        for (const item of items) {
            const label = document.createElement('label');
            label.className = 'zune-browse-item';
            label.dataset.handle = String(item.handle);

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'zune-browse-check';
            checkbox.dataset.handle = String(item.handle);
            checkbox.checked = this.selectedHandles.has(item.handle);

            // Album art thumbnail (if available)
            if (item.albumArt) {
                const artImg = document.createElement('img');
                artImg.className = 'zune-browse-art';
                artImg.src = item.albumArt;
                artImg.alt = '';
                label.appendChild(artImg);
            }

            const infoDiv = document.createElement('div');
            infoDiv.className = 'zune-browse-info';

            // Show title/artist/album if available, otherwise filename
            const displayTitle = item.title || item.filename;
            const titleSpan = document.createElement('span');
            titleSpan.className = 'zune-browse-filename';
            titleSpan.title = item.filename;
            titleSpan.textContent = displayTitle;
            infoDiv.appendChild(titleSpan);

            if (item.artist || item.album) {
                const metaSpan = document.createElement('span');
                metaSpan.className = 'zune-browse-meta';
                const parts = [];
                if (item.artist) parts.push(item.artist);
                if (item.album) parts.push(item.album);
                metaSpan.textContent = parts.join(' \u2014 ');
                infoDiv.appendChild(metaSpan);
            }

            const rightDiv = document.createElement('div');
            rightDiv.className = 'zune-browse-right';

            if (item.duration) {
                const durSpan = document.createElement('span');
                durSpan.className = 'zune-browse-duration';
                const secs = Math.floor(item.duration / 1000);
                const mins = Math.floor(secs / 60);
                const remSecs = secs % 60;
                durSpan.textContent = `${mins}:${String(remSecs).padStart(2, '0')}`;
                rightDiv.appendChild(durSpan);
            }

            const sizeSpan = document.createElement('span');
            sizeSpan.className = 'zune-browse-size';
            sizeSpan.textContent = this._formatSize(item.size);
            rightDiv.appendChild(sizeSpan);

            label.appendChild(checkbox);
            label.appendChild(infoDiv);
            label.appendChild(rightDiv);
            listEl.appendChild(label);

            checkbox.addEventListener('change', () => {
                const handle = item.handle;
                if (checkbox.checked) {
                    this.selectedHandles.add(handle);
                } else {
                    this.selectedHandles.delete(handle);
                }
                this._updateDeleteButton();
            });
        }

        this._updateDeleteButton();

        // Restore scroll position after progressive re-render
        listEl.scrollTop = savedScroll;
    }

    _updateDeleteButton() {
        const actionsEl = document.getElementById('zune-browse-actions');
        const deleteBtn = document.getElementById('zune-delete-btn');
        const count = this.selectedHandles.size;

        if (count > 0) {
            actionsEl.style.display = 'block';
            deleteBtn.textContent = 'delete ' + count + ' file' + (count !== 1 ? 's' : '');
            deleteBtn.classList.remove('confirm');
        } else {
            actionsEl.style.display = 'none';
        }
    }

    async _handleDelete() {
        const deleteBtn = document.getElementById('zune-delete-btn');
        const count = this.selectedHandles.size;

        if (count === 0) return;

        // Confirm-on-second-click pattern
        if (!deleteBtn.classList.contains('confirm')) {
            deleteBtn.classList.add('confirm');
            deleteBtn.textContent = 'confirm: delete ' + count + ' file' + (count !== 1 ? 's' : '') + '?';

            if (this.deleteConfirmTimer) clearTimeout(this.deleteConfirmTimer);
            this.deleteConfirmTimer = setTimeout(() => {
                deleteBtn.classList.remove('confirm');
                deleteBtn.textContent = 'delete ' + count + ' file' + (count !== 1 ? 's' : '');
                this.deleteConfirmTimer = null;
            }, 3000);
            return;
        }

        // Confirmed — execute delete
        if (this.deleteConfirmTimer) {
            clearTimeout(this.deleteConfirmTimer);
            this.deleteConfirmTimer = null;
        }

        const handles = Array.from(this.selectedHandles);
        deleteBtn.textContent = 'deleting...';
        deleteBtn.classList.remove('confirm');

        const result = await window.electronAPI.zuneDeleteObjects(handles);

        if (result.success && result.storage) {
            this._updateStorage(result.storage);
        }

        // Remove deleted items from local data
        if (result.success && this.browseData) {
            const deletedSet = new Set(handles);
            // If some failed, keep those in the set
            if (result.errors) {
                for (const err of result.errors) {
                    deletedSet.delete(err.handle);
                }
            }
            for (const cat of ['music', 'videos', 'pictures']) {
                this.browseData[cat] = this.browseData[cat].filter(
                    item => !deletedSet.has(item.handle)
                );
            }
        }

        this.selectedHandles.clear();
        this._renderBrowseList();

        // Update cache after deletion
        if (this.deviceKey && this.browseData) {
            await window.electronAPI.zuneCacheSave(this.deviceKey, {
                model: this.cachedData?.model || this.lastStatus?.model || 'Zune',
                scanDurationMs: this.cachedData?.scanDurationMs || 0,
                counts: {
                    music: this.browseData.music?.length || 0,
                    videos: this.browseData.videos?.length || 0,
                    pictures: this.browseData.pictures?.length || 0,
                },
                contents: this.browseData,
            });
        }
    }

    // ---- Diff Engine ----
    _computeDiff() {
        if (this.diffCategory === 'music') {
            this._computeMusicDiff();
        } else {
            this._computeMediaDiff(this.diffCategory);
        }
    }

    _computeMusicDiff() {
        const localTracks = this.explorer.musicLibrary.tracks; // Map: path -> trackInfo
        const deviceTracks = (this.browseData && this.browseData.music) || [];

        const matched = [];
        const localOnly = [];
        const deviceOnly = [];

        // Build lookup maps
        const localByFilename = new Map();
        for (const [filePath, track] of localTracks) {
            const basename = filePath.split(/[/\\]/).pop().toLowerCase();
            localByFilename.set(basename, { ...track, path: filePath });
        }

        const deviceByFilename = new Map();
        for (const item of deviceTracks) {
            const fn = (item.filename || '').toLowerCase();
            deviceByFilename.set(fn, item);
        }

        // Pass 1: Filename match
        const matchedLocalPaths = new Set();
        const matchedDeviceFilenames = new Set();

        for (const [fn, localTrack] of localByFilename) {
            if (deviceByFilename.has(fn)) {
                matched.push({ local: localTrack, device: deviceByFilename.get(fn) });
                matchedLocalPaths.add(localTrack.path);
                matchedDeviceFilenames.add(fn);
            }
        }

        // Pass 2: Title+Artist match (unmatched only)
        const unmatchedLocal = [];
        for (const [filePath, track] of localTracks) {
            if (!matchedLocalPaths.has(filePath)) {
                unmatchedLocal.push({ ...track, path: filePath });
            }
        }

        const unmatchedDevice = [];
        for (const item of deviceTracks) {
            const fn = (item.filename || '').toLowerCase();
            if (!matchedDeviceFilenames.has(fn)) {
                unmatchedDevice.push(item);
            }
        }

        const localByMeta = new Map();
        for (const track of unmatchedLocal) {
            const key = `${(track.title || '').toLowerCase()}|||${(track.artist || '').toLowerCase()}`;
            if (key !== '|||') localByMeta.set(key, track);
        }

        const deviceByMeta = new Map();
        for (const item of unmatchedDevice) {
            const key = `${(item.title || '').toLowerCase()}|||${(item.artist || '').toLowerCase()}`;
            if (key !== '|||') deviceByMeta.set(key, item);
        }

        const metaMatchedLocalPaths = new Set();
        const metaMatchedDeviceHandles = new Set();

        for (const [key, localTrack] of localByMeta) {
            if (deviceByMeta.has(key)) {
                matched.push({ local: localTrack, device: deviceByMeta.get(key) });
                metaMatchedLocalPaths.add(localTrack.path);
                metaMatchedDeviceHandles.add(deviceByMeta.get(key).handle);
            }
        }

        // Collect remaining unmatched
        for (const track of unmatchedLocal) {
            if (!metaMatchedLocalPaths.has(track.path)) {
                localOnly.push(track);
            }
        }

        for (const item of unmatchedDevice) {
            if (!metaMatchedDeviceHandles.has(item.handle)) {
                deviceOnly.push(item);
            }
        }

        this.diffResult = { matched, localOnly, deviceOnly };
    }

    _computeMediaDiff(category) {
        const localFiles = this.explorer.categorizedFiles[category] || [];
        const deviceFiles = (this.browseData && this.browseData[category]) || [];

        const matched = [];
        const localOnly = [];
        const deviceOnly = [];

        // Filename-only matching for videos/pictures
        const localByFilename = new Map();
        for (const file of localFiles) {
            const basename = (file.name || file.path.split(/[/\\]/).pop()).toLowerCase();
            localByFilename.set(basename, file);
        }

        const matchedLocalFilenames = new Set();
        const matchedDeviceFilenames = new Set();

        for (const item of deviceFiles) {
            const fn = (item.filename || '').toLowerCase();
            if (localByFilename.has(fn) && !matchedLocalFilenames.has(fn)) {
                matched.push({ local: localByFilename.get(fn), device: item });
                matchedLocalFilenames.add(fn);
                matchedDeviceFilenames.add(fn);
            }
        }

        for (const [fn, file] of localByFilename) {
            if (!matchedLocalFilenames.has(fn)) {
                localOnly.push(file);
            }
        }

        for (const item of deviceFiles) {
            const fn = (item.filename || '').toLowerCase();
            if (!matchedDeviceFilenames.has(fn)) {
                deviceOnly.push(item);
            }
        }

        this.diffResult = { matched, localOnly, deviceOnly };
    }

    _renderDiffSummary() {
        if (!this.diffResult) return;

        document.getElementById('zune-diff-matched').textContent =
            this.diffResult.matched.length + ' matched';
        document.getElementById('zune-diff-local-only').textContent =
            this.diffResult.localOnly.length + ' to sync';
        document.getElementById('zune-diff-device-only').textContent =
            this.diffResult.deviceOnly.length + ' on device only';
    }

    _renderDiffList() {
        const listEl = document.getElementById('zune-diff-list');
        const actionsEl = document.getElementById('zune-diff-actions');
        const pushBtn = document.getElementById('zune-push-btn');
        const pullBtn = document.getElementById('zune-pull-btn');
        const deleteBtn = document.getElementById('zune-diff-delete-btn');

        listEl.textContent = '';

        if (!this.diffResult) {
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'zune-diff-empty';
            emptyDiv.textContent = 'no diff data';
            listEl.appendChild(emptyDiv);
            actionsEl.style.display = 'none';
            this._updateSelectAllState([]);
            return;
        }

        let items;
        let showCheckboxes = false;

        if (this.diffTab === 'local-only') {
            items = this.diffResult.localOnly;
            showCheckboxes = true;
            pushBtn.style.display = 'block';
            pullBtn.style.display = 'none';
            deleteBtn.style.display = 'none';
            actionsEl.style.display = items.length > 0 ? 'flex' : 'none';
        } else if (this.diffTab === 'device-only') {
            items = this.diffResult.deviceOnly;
            showCheckboxes = true;
            pushBtn.style.display = 'none';
            pullBtn.style.display = 'block';
            deleteBtn.style.display = 'block';
            actionsEl.style.display = items.length > 0 ? 'flex' : 'none';
        } else {
            items = this.diffResult.matched;
            showCheckboxes = false;
            deleteBtn.style.display = 'none';
            actionsEl.style.display = 'none';
        }

        // Apply filter
        const groupBy = (showCheckboxes && this.diffCategory === 'music') ? (this.diffGroupBy || 'all') : 'all';
        const filteredItems = this._getFilteredItems(items, groupBy);

        // Show/hide select-all and group bar based on checkbox mode
        const selectAllEl = document.getElementById('zune-diff-select-all');
        const groupBar = document.getElementById('zune-diff-group-bar');
        selectAllEl.style.display = showCheckboxes ? 'flex' : 'none';
        groupBar.style.display = (showCheckboxes && this.diffCategory === 'music') ? 'flex' : 'none';
        document.getElementById('zune-diff-filter').style.display = 'flex';

        if (filteredItems.length === 0) {
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'zune-diff-empty';
            if (this.diffFilterQuery) {
                emptyDiv.textContent = 'no matches';
            } else if (this.diffTab === 'local-only') {
                emptyDiv.textContent = `all local ${this.diffCategory} on the device`;
            } else if (this.diffTab === 'device-only') {
                emptyDiv.textContent = `all device ${this.diffCategory} on the computer`;
            } else {
                emptyDiv.textContent = 'no matched files';
            }
            listEl.appendChild(emptyDiv);
            this._updateSelectAllState(filteredItems);
            this._updateDiffActionButton();
            return;
        }

        if (groupBy === 'all') {
            this._renderDiffFlat(listEl, filteredItems, showCheckboxes);
        } else {
            this._renderDiffGrouped(listEl, filteredItems, showCheckboxes, groupBy);
        }

        this._updateSelectAllState(filteredItems);
        this._updateDiffActionButton();
    }

    _renderDiffFlat(listEl, items, showCheckboxes) {
        for (const item of items) {
            listEl.appendChild(this._createDiffRow(item, showCheckboxes));
        }
    }

    _renderDiffGrouped(listEl, items, showCheckboxes, groupBy) {
        const groups = new Map();

        for (const item of items) {
            let key, name, artist, albumArt;

            if (this.diffTab === 'matched') {
                const loc = item.local || {};
                const dev = item.device || {};
                if (groupBy === 'album') {
                    name = loc.album || dev.album || 'Unknown Album';
                    artist = loc.artist || dev.artist || '';
                    albumArt = loc.albumArt || dev.albumArt || null;
                    key = name.toLowerCase();
                } else {
                    name = loc.artist || dev.artist || 'Unknown Artist';
                    albumArt = loc.albumArt || dev.albumArt || null;
                    key = name.toLowerCase();
                    artist = '';
                }
            } else {
                if (groupBy === 'album') {
                    name = item.album || 'Unknown Album';
                    artist = item.artist || '';
                    albumArt = item.albumArt || null;
                    key = name.toLowerCase();
                } else {
                    name = item.artist || 'Unknown Artist';
                    albumArt = item.albumArt || null;
                    key = name.toLowerCase();
                    artist = '';
                }
            }

            if (!groups.has(key)) {
                groups.set(key, { name, artist, albumArt, tracks: [] });
            }
            const g = groups.get(key);
            g.tracks.push(item);
            // Use first available art
            if (!g.albumArt && albumArt) g.albumArt = albumArt;
        }

        // Sort groups alphabetically
        const sortedKeys = [...groups.keys()].sort();

        for (const key of sortedKeys) {
            const group = groups.get(key);
            const isCollapsed = this.collapsedGroups.has(key);

            // Group header
            const header = document.createElement('div');
            header.className = 'zune-diff-group-header';

            const arrow = document.createElement('span');
            arrow.className = 'zune-diff-group-arrow' + (isCollapsed ? ' collapsed' : '');
            arrow.textContent = '\u25BE';
            header.appendChild(arrow);

            if (group.albumArt) {
                const artImg = document.createElement('img');
                artImg.className = 'zune-diff-group-art';
                artImg.src = group.albumArt;
                artImg.alt = '';
                header.appendChild(artImg);
            }

            const info = document.createElement('div');
            info.className = 'zune-diff-group-info';
            const nameEl = document.createElement('div');
            nameEl.className = 'zune-diff-group-name';
            nameEl.textContent = group.name;
            info.appendChild(nameEl);
            const metaEl = document.createElement('div');
            metaEl.className = 'zune-diff-group-meta';
            const metaParts = [];
            if (group.artist) metaParts.push(group.artist);
            metaParts.push(`${group.tracks.length} track${group.tracks.length !== 1 ? 's' : ''}`);
            metaEl.textContent = metaParts.join(' \u2014 ');
            info.appendChild(metaEl);
            header.appendChild(info);

            if (showCheckboxes) {
                const groupCheck = document.createElement('input');
                groupCheck.type = 'checkbox';
                groupCheck.className = 'zune-diff-group-check';
                this._updateGroupCheckState(groupCheck, group.tracks);

                groupCheck.addEventListener('change', (e) => {
                    e.stopPropagation();
                    this._toggleGroupSelection(group.tracks, groupCheck.checked);
                    this._renderDiffList();
                });
                groupCheck.addEventListener('click', (e) => e.stopPropagation());
                header.appendChild(groupCheck);
            }

            header.addEventListener('click', () => {
                if (this.collapsedGroups.has(key)) {
                    this.collapsedGroups.delete(key);
                } else {
                    this.collapsedGroups.add(key);
                }
                this._renderDiffList();
            });

            listEl.appendChild(header);

            // Group tracks container
            const tracksDiv = document.createElement('div');
            tracksDiv.className = 'zune-diff-group-tracks' + (isCollapsed ? ' collapsed' : '');

            for (const item of group.tracks) {
                tracksDiv.appendChild(this._createDiffRow(item, showCheckboxes));
            }

            listEl.appendChild(tracksDiv);
        }
    }

    _createDiffRow(item, showCheckboxes) {
        const row = document.createElement('div');
        row.className = 'zune-diff-item';

        if (showCheckboxes) {
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'zune-diff-check';

            if (this.diffTab === 'local-only') {
                const trackPath = item.path;
                checkbox.checked = this.diffSelectedPaths.has(trackPath);
                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) {
                        this.diffSelectedPaths.add(trackPath);
                    } else {
                        this.diffSelectedPaths.delete(trackPath);
                    }
                    this._updateDiffActionButton();
                    this._updateSelectAllState(this.diffResult?.localOnly || []);
                });
            } else if (this.diffTab === 'device-only') {
                const handle = item.handle;
                checkbox.checked = this.diffSelectedHandles.has(handle);
                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) {
                        this.diffSelectedHandles.add(handle);
                    } else {
                        this.diffSelectedHandles.delete(handle);
                    }
                    this._updateDiffActionButton();
                    this._updateSelectAllState(this.diffResult?.deviceOnly || []);
                });
            }

            row.appendChild(checkbox);
        }

        // Album art
        const art = this.diffTab === 'matched'
            ? (item.local?.albumArt || item.device?.albumArt)
            : (item.albumArt || null);
        if (art) {
            const artImg = document.createElement('img');
            artImg.className = 'zune-diff-art';
            artImg.src = art;
            artImg.alt = '';
            row.appendChild(artImg);
        }

        const infoDiv = document.createElement('div');
        infoDiv.className = 'zune-diff-info';

        const titleSpan = document.createElement('span');
        titleSpan.className = 'zune-diff-title';
        if (this.diffTab === 'matched') {
            titleSpan.textContent = item.local?.title || item.local?.name || item.device?.title || item.device?.filename || '?';
        } else {
            titleSpan.textContent = item.title || item.name || item.filename || '?';
        }
        infoDiv.appendChild(titleSpan);

        const metaSpan = document.createElement('span');
        metaSpan.className = 'zune-diff-meta';
        if (this.diffCategory === 'music') {
            if (this.diffTab === 'matched') {
                const parts = [];
                if (item.local?.artist) parts.push(item.local.artist);
                if (item.local?.album) parts.push(item.local.album);
                metaSpan.textContent = parts.join(' \u2014 ');
            } else {
                const parts = [];
                if (item.artist) parts.push(item.artist);
                if (item.album) parts.push(item.album);
                metaSpan.textContent = parts.join(' \u2014 ');
            }
        } else {
            const size = item.size || item.device?.size || item.local?.size || 0;
            if (size > 0) {
                metaSpan.textContent = this._formatSize(size);
            } else {
                metaSpan.textContent = item.filename || item.device?.filename || '';
            }
        }
        if (metaSpan.textContent) infoDiv.appendChild(metaSpan);

        row.appendChild(infoDiv);
        return row;
    }

    _matchesFilter(item) {
        if (!this.diffFilterQuery) return true;
        const q = this.diffFilterQuery;

        if (this.diffTab === 'matched') {
            const loc = item.local || {};
            const dev = item.device || {};
            return (loc.title || dev.title || dev.filename || '').toLowerCase().includes(q)
                || (loc.artist || dev.artist || '').toLowerCase().includes(q)
                || (loc.album || dev.album || '').toLowerCase().includes(q);
        }

        return (item.title || item.name || item.filename || '').toLowerCase().includes(q)
            || (item.artist || '').toLowerCase().includes(q)
            || (item.album || '').toLowerCase().includes(q);
    }

    _getFilteredItems(items, groupBy) {
        if (!this.diffFilterQuery) return items;
        const q = this.diffFilterQuery;

        if (groupBy === 'all') {
            return items.filter(item => this._matchesFilter(item));
        }

        // For grouped modes, keep all tracks in a group if the group name matches
        const groups = new Map();
        for (const item of items) {
            let groupName;
            if (this.diffTab === 'matched') {
                const loc = item.local || {};
                const dev = item.device || {};
                groupName = groupBy === 'album'
                    ? (loc.album || dev.album || 'Unknown Album')
                    : (loc.artist || dev.artist || 'Unknown Artist');
            } else {
                groupName = groupBy === 'album'
                    ? (item.album || 'Unknown Album')
                    : (item.artist || 'Unknown Artist');
            }
            const key = groupName.toLowerCase();
            if (!groups.has(key)) groups.set(key, { name: groupName, tracks: [] });
            groups.get(key).tracks.push(item);
        }

        const result = [];
        for (const [, group] of groups) {
            if (group.name.toLowerCase().includes(q)) {
                result.push(...group.tracks);
            } else {
                result.push(...group.tracks.filter(t => this._matchesFilter(t)));
            }
        }
        return result;
    }

    _getItemKey(item) {
        if (this.diffTab === 'local-only') return item.path;
        if (this.diffTab === 'device-only') return item.handle;
        return null;
    }

    _isItemSelected(item) {
        if (this.diffTab === 'local-only') return this.diffSelectedPaths.has(item.path);
        if (this.diffTab === 'device-only') return this.diffSelectedHandles.has(item.handle);
        return false;
    }

    _toggleGroupSelection(tracks, selected) {
        for (const item of tracks) {
            if (this.diffTab === 'local-only') {
                if (selected) this.diffSelectedPaths.add(item.path);
                else this.diffSelectedPaths.delete(item.path);
            } else if (this.diffTab === 'device-only') {
                if (selected) this.diffSelectedHandles.add(item.handle);
                else this.diffSelectedHandles.delete(item.handle);
            }
        }
    }

    _updateGroupCheckState(checkbox, tracks) {
        const allSelected = tracks.every(t => this._isItemSelected(t));
        const someSelected = tracks.some(t => this._isItemSelected(t));
        checkbox.checked = allSelected;
        checkbox.indeterminate = someSelected && !allSelected;
    }

    _handleSelectAll(checked) {
        const groupBy = (this.diffTab === 'local-only' || this.diffTab === 'device-only')
            ? (this.diffGroupBy || 'all') : 'all';
        let items;
        if (this.diffTab === 'local-only') {
            items = this._getFilteredItems(this.diffResult?.localOnly || [], groupBy);
            for (const item of items) {
                if (checked) this.diffSelectedPaths.add(item.path);
                else this.diffSelectedPaths.delete(item.path);
            }
        } else if (this.diffTab === 'device-only') {
            items = this._getFilteredItems(this.diffResult?.deviceOnly || [], groupBy);
            for (const item of items) {
                if (checked) this.diffSelectedHandles.add(item.handle);
                else this.diffSelectedHandles.delete(item.handle);
            }
        } else {
            return;
        }
        this._renderDiffList();
    }

    _updateSelectAllState(items) {
        const checkbox = document.getElementById('zune-diff-select-all-check');
        const label = document.getElementById('zune-diff-select-all-label');

        if (!items || items.length === 0) {
            checkbox.checked = false;
            checkbox.indeterminate = false;
            const emptyNoun = this.diffCategory === 'music' ? 'tracks' : 'files';
            label.textContent = `select all (0 ${emptyNoun})`;
            return;
        }

        const allSelected = items.every(t => this._isItemSelected(t));
        const someSelected = items.some(t => this._isItemSelected(t));
        checkbox.checked = allSelected;
        checkbox.indeterminate = someSelected && !allSelected;

        const count = items.length;
        const noun = this.diffCategory === 'music' ? 'track' : 'file';
        if (allSelected) {
            label.textContent = `deselect all (${count} ${noun}${count !== 1 ? 's' : ''})`;
        } else {
            label.textContent = `select all (${count} ${noun}${count !== 1 ? 's' : ''})`;
        }
    }

    _updateDiffActionButton() {
        const pushBtn = document.getElementById('zune-push-btn');
        const pullBtn = document.getElementById('zune-pull-btn');
        const deleteBtn = document.getElementById('zune-diff-delete-btn');
        const noun = this.diffCategory === 'music' ? 'tracks' : 'files';

        if (this.diffTab === 'local-only') {
            pushBtn.textContent = this.diffSelectedPaths.size > 0
                ? `sync ${this.diffSelectedPaths.size} to device`
                : `select ${noun} to sync`;
            pushBtn.disabled = this.diffSelectedPaths.size === 0;
        } else if (this.diffTab === 'device-only') {
            pullBtn.textContent = this.diffSelectedHandles.size > 0
                ? `copy ${this.diffSelectedHandles.size} to computer`
                : `select ${noun} to copy`;
            pullBtn.disabled = this.diffSelectedHandles.size === 0;
            deleteBtn.textContent = this.diffSelectedHandles.size > 0
                ? `delete ${this.diffSelectedHandles.size} from device`
                : `select ${noun} to delete`;
            deleteBtn.disabled = this.diffSelectedHandles.size === 0;
            deleteBtn.classList.remove('confirm');
            if (this.diffDeleteConfirmTimer) {
                clearTimeout(this.diffDeleteConfirmTimer);
                this.diffDeleteConfirmTimer = null;
            }
        }
    }

    // ---- Push (sync to device) ----
    async _pushToDevice() {
        if (this.diffSelectedPaths.size === 0) return;

        const paths = Array.from(this.diffSelectedPaths);
        this.diffSelectedPaths.clear();

        // Use existing sendFiles which handles the transfer UI
        await this._sendFiles(paths);

        // After transfer, update cache by merging pushed items
        if (this.deviceKey && this.browseData) {
            const category = this.diffCategory;
            for (const p of paths) {
                const filename = p.split(/[/\\]/).pop();
                if (category === 'music') {
                    const track = this.explorer.musicLibrary.tracks.get(p);
                    if (track) {
                        this.browseData.music.push({
                            handle: 0,
                            filename,
                            title: track.title,
                            artist: track.artist,
                            album: track.album,
                            albumArt: track.albumArt,
                            size: 0,
                        });
                    }
                } else {
                    this.browseData[category].push({
                        handle: 0,
                        filename,
                        size: 0,
                        format: 0,
                    });
                }
            }
            // Save updated cache
            await window.electronAPI.zuneCacheSave(this.deviceKey, {
                model: this.cachedData?.model || this.lastStatus?.model || 'Zune',
                scanDurationMs: this.cachedData?.scanDurationMs || 0,
                counts: {
                    music: this.browseData.music?.length || 0,
                    videos: this.browseData.videos?.length || 0,
                    pictures: this.browseData.pictures?.length || 0,
                },
                contents: this.browseData,
            });
        }

        // Re-compute diff
        this._computeDiff();
        this._renderDiffSummary();
        this._renderDiffList();
    }

    // ---- Pull (copy to computer) ----
    async _pullFromDevice() {
        if (this.diffSelectedHandles.size === 0) return;

        // Ask user where to save before clearing selection
        const destResult = await window.electronAPI.pickPullDestination();
        if (!destResult.success) return;

        const handles = Array.from(this.diffSelectedHandles);
        this.diffSelectedHandles.clear();
        const destDir = destResult.path;

        const pullBtn = document.getElementById('zune-pull-btn');
        pullBtn.textContent = `copying 0 of ${handles.length}...`;
        pullBtn.disabled = true;

        let pulled = 0;
        const pulledFiles = [];
        const category = this.diffCategory;
        const deviceItems = (this.browseData && this.browseData[category]) || [];

        for (const handle of handles) {
            const deviceItem = deviceItems.find(i => i.handle === handle);
            if (!deviceItem) continue;

            const filename = deviceItem.filename || `file_${handle}`;
            const metadata = category === 'music' ? {
                title: deviceItem.title || null,
                artist: deviceItem.artist || null,
                album: deviceItem.album || null,
                genre: deviceItem.genre || null,
                trackNumber: deviceItem.trackNumber || null,
                albumArt: deviceItem.albumArt || null,
            } : {};
            const result = await window.electronAPI.zunePullFile(handle, filename, destDir, metadata);

            if (result.success) {
                pulled++;
                pulledFiles.push({ path: result.path, size: result.size || 0 });
                pullBtn.textContent = `copying ${pulled} of ${handles.length}...`;
            }
        }

        pullBtn.textContent = `${pulled} files copied`;
        pullBtn.disabled = false;

        // Add pulled files to local categorized files
        if (pulledFiles.length > 0) {
            for (const pf of pulledFiles) {
                const ext = pf.path.split('.').pop().toLowerCase();
                this.explorer.categorizedFiles[category].push({
                    path: pf.path,
                    name: pf.path.split(/[/\\]/).pop(),
                    extension: '.' + ext,
                    size: pf.size,
                    modified: new Date(),
                    isDirectory: false,
                });
            }
            // Trigger metadata scan only for music
            if (category === 'music') {
                const paths = pulledFiles.map(pf => pf.path);
                await window.electronAPI.batchScanAudioMetadata(paths, { includeArt: true });
            }
        }

        // Re-compute diff
        this._computeDiff();
        this._renderDiffSummary();
        this._renderDiffList();
    }

    // ---- Delete from device (diff view) ----
    async _deleteFromDevice() {
        const deleteBtn = document.getElementById('zune-diff-delete-btn');
        const count = this.diffSelectedHandles.size;

        if (count === 0) return;

        // Confirm-on-second-click pattern
        if (!deleteBtn.classList.contains('confirm')) {
            deleteBtn.classList.add('confirm');
            deleteBtn.textContent = `confirm: delete ${count} file${count !== 1 ? 's' : ''}?`;

            if (this.diffDeleteConfirmTimer) clearTimeout(this.diffDeleteConfirmTimer);
            this.diffDeleteConfirmTimer = setTimeout(() => {
                deleteBtn.classList.remove('confirm');
                this._updateDiffActionButton();
                this.diffDeleteConfirmTimer = null;
            }, 3000);
            return;
        }

        // Confirmed — execute delete
        if (this.diffDeleteConfirmTimer) {
            clearTimeout(this.diffDeleteConfirmTimer);
            this.diffDeleteConfirmTimer = null;
        }

        const handles = Array.from(this.diffSelectedHandles);
        this.diffSelectedHandles.clear();

        deleteBtn.textContent = 'deleting...';
        deleteBtn.classList.remove('confirm');
        deleteBtn.disabled = true;

        try {
            const result = await window.electronAPI.zuneDeleteObjects(handles);

            if (result.success && result.storage) {
                this._updateStorage(result.storage);
            }

            // Remove deleted items from browseData
            if (result.success && this.browseData) {
                const deletedSet = new Set(handles);
                if (result.errors) {
                    for (const err of result.errors) {
                        deletedSet.delete(err.handle);
                    }
                }
                for (const cat of ['music', 'videos', 'pictures']) {
                    this.browseData[cat] = this.browseData[cat].filter(
                        item => !deletedSet.has(item.handle)
                    );
                }
            }

            // Update cache
            if (this.deviceKey && this.browseData) {
                await window.electronAPI.zuneCacheSave(this.deviceKey, {
                    model: this.cachedData?.model || this.lastStatus?.model || 'Zune',
                    scanDurationMs: this.cachedData?.scanDurationMs || 0,
                    counts: {
                        music: this.browseData.music?.length || 0,
                        videos: this.browseData.videos?.length || 0,
                        pictures: this.browseData.pictures?.length || 0,
                    },
                    contents: this.browseData,
                });
            }
        } catch (e) {
            console.error('Delete from device failed:', e);
        } finally {
            this._computeDiff();
            this._computeStorageBreakdown();
            this._renderDiffSummary();
            this._renderDiffList();
        }
    }

    _formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }
}

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
        this.pinnedItems = [];
        this.fileExtensions = {
            music: ['.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg', '.wma'],
            videos: ['.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v'],
            pictures: ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.bmp', '.webp', '.ico'],
            documents: ['.pdf', '.txt', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.rtf'],
            applications: ['.app', '.exe', '.dmg', '.pkg', '.deb', '.msi']
        };
        this.extensionlessFiles = [];    // music files with no extension (need fixing)
        this.selectedFile = null;
        this.currentPath = null;        // current directory being browsed
        this.pathHistory = [];           // stack of previous paths for back navigation
        this.browsingMode = false;       // true when browsing directories (vs root view)
        this.homePath = null;            // cached home directory path
        this.smartRoots = [];            // populated in init()
        this.externalVolumes = [];
        this.audioPlayer = null;
        this.nowPlayingOpen = false;
        this.zunePanel = null;

        // Music library state
        this.musicLibrary = {
            scanState: 'idle', // 'idle' | 'scanning' | 'complete'
            scannedCount: 0,
            totalCount: 0,
            tracks: new Map(),       // path -> TrackInfo
            albums: new Map(),       // key -> AlbumInfo
            artists: new Map(),      // lowercase name -> ArtistInfo
            genres: new Map(),       // lowercase genre -> { name, tracks[] }
            sortedSongs: [],
            sortedAlbums: [],
            sortedArtists: [],
            sortedGenres: [],
        };
        this.musicSubView = 'albums';  // 'albums' | 'artists' | 'songs' | 'genres'
        this.musicDrillDown = null;    // null | { type: 'album', key } | { type: 'artist', name }

        this.init();
    }

    async init() {
        this.platform = await window.electronAPI.getPlatform();
        if (this.platform === 'win32') {
            document.body.classList.add('platform-win32');
        } else if (this.platform === 'darwin') {
            document.body.classList.add('platform-darwin');
        }
        this.homePath = await window.electronAPI.getHomeDirectory();
        const sf = await window.electronAPI.getSpecialFolders();
        if (this.platform === 'win32') {
            this.smartRoots = [
                { name: 'Desktop',   path: sf.desktop   || `${this.homePath}\\Desktop` },
                { name: 'Documents', path: sf.documents  || `${this.homePath}\\Documents` },
                { name: 'Downloads', path: sf.downloads  || `${this.homePath}\\Downloads` },
                { name: 'Music',     path: sf.music      || `${this.homePath}\\Music` },
                { name: 'Videos',    path: sf.videos     || `${this.homePath}\\Videos` },
                { name: 'Pictures',  path: sf.pictures   || `${this.homePath}\\Pictures` },
                { name: 'Home',      path: sf.home       || this.homePath },
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
        const volResult = await window.electronAPI.getExternalVolumes();
        if (volResult.success) {
            this.externalVolumes = volResult.volumes;
        }
        await this.scanFileSystem();
        this.zunePanel = new ZuneSyncPanel(this);
        this.updateFileCounts();
        await this.loadRecentFiles();
        this.updateRecentFiles();
        await this.loadPins();
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

        // Horizontal swipe/wheel to switch carousel panels
        document.getElementById('panoramic-container').addEventListener('wheel', (e) => {
            if (this.currentView === 'content' || this.currentView === 'sync') return;
            if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 30) {
                e.preventDefault();
                if (e.deltaX > 0 && this.currentView === 'recent') {
                    this.showMenu();
                } else if (e.deltaX < 0 && this.currentView === 'menu') {
                    this.showRecent();
                }
            }
        }, { passive: false });

        // Carousel panel clicks - click behind panel to bring it to front
        // Use capture phase so we intercept before child handlers fire
        document.querySelector('.recent-panel').addEventListener('click', (e) => {
            if (this.currentView === 'menu') {
                e.stopPropagation();
                this.showRecent();
            }
        }, true);

        document.querySelector('.menu-panel').addEventListener('click', (e) => {
            if (this.currentView === 'recent') {
                e.stopPropagation();
                this.showMenu();
            } else if (this.currentView === 'sync') {
                e.stopPropagation();
                if (this.zunePanel) {
                    this.zunePanel._closeDiff();
                }
            }
        }, true);

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
            // Escape closes alpha jump overlay first
            if (e.key === 'Escape' && document.getElementById('alpha-jump-overlay').classList.contains('open')) {
                e.preventDefault();
                this.closeAlphaJump();
                return;
            }

            // Escape closes Now Playing panel from any view
            if (e.key === 'Escape' && this.nowPlayingOpen) {
                e.preventDefault();
                this.closeNowPlaying();
                return;
            }

            // Space bar toggles play/pause when player is active
            if (e.key === ' ' && this.audioPlayer && this.audioPlayer.isPlaying !== undefined && this.audioPlayer.queue.length > 0 && this.currentView !== 'menu') {
                e.preventDefault();
                this.audioPlayer.togglePlayPause();
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

        if (this.currentCategory === 'music') {
            this.musicDrillDown = null;
            this.renderMusicView();
        } else if (this.currentCategory === 'documents') {
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

        // All categories get hero-mode (hides title-group and view-toggle via CSS)
        const contentPanel = document.getElementById('content-panel');
        contentPanel.classList.add('hero-mode');

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
        this.clearElement(fileDisplay);
        fileDisplay.className = 'file-display';

        const categoryView = document.createElement('div');
        categoryView.className = 'category-view';

        const hero = document.createElement('div');
        hero.className = 'hero-header';
        hero.textContent = 'documents';
        categoryView.appendChild(hero);

        const content = document.createElement('div');
        content.className = 'category-content';

        if (this.currentViewMode === 'list') {
            content.classList.add('list-view');
            this.smartRoots.forEach(root => {
                const item = this.createFolderElement({
                    name: root.name,
                    path: root.path,
                    isDirectory: true
                });
                content.appendChild(item);
            });
            this.externalVolumes.forEach(vol => {
                const item = this.createFolderElement({
                    name: vol.name,
                    path: vol.path,
                    isDirectory: true
                });
                content.appendChild(item);
            });
        } else {
            content.classList.add('root-grid');
            this.smartRoots.forEach(root => {
                const tile = document.createElement('div');
                tile.className = 'root-tile';

                const icon = document.createElement('div');
                icon.className = 'root-tile-icon';
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                svg.setAttribute('viewBox', '0 0 48 48');
                svg.setAttribute('fill', 'none');
                const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                p.setAttribute('d', 'M6 12C6 9.79 7.79 8 10 8H18L22 12H38C40.21 12 42 13.79 42 16V36C42 38.21 40.21 40 38 40H10C7.79 40 6 38.21 6 36V12Z');
                p.setAttribute('fill', 'rgba(255, 105, 0, 0.2)');
                p.setAttribute('stroke', '#ff6900');
                p.setAttribute('stroke-width', '2');
                svg.appendChild(p);
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
                content.appendChild(tile);
            });
        }

        categoryView.appendChild(content);

        if (this.externalVolumes.length > 0) {
            const volumeGrid = document.createElement('div');
            volumeGrid.className = 'category-content root-grid volume-grid';
            this.externalVolumes.forEach(vol => {
                const tile = document.createElement('div');
                tile.className = 'root-tile volume-tile';

                const icon = document.createElement('div');
                icon.className = 'root-tile-icon';
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                svg.setAttribute('viewBox', '0 0 48 48');
                svg.setAttribute('fill', 'none');
                const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                p.setAttribute('d', 'M6 12C6 9.79 7.79 8 10 8H18L22 12H38C40.21 12 42 13.79 42 16V36C42 38.21 40.21 40 38 40H10C7.79 40 6 38.21 6 36V12Z');
                p.setAttribute('fill', 'rgba(74, 158, 255, 0.2)');
                p.setAttribute('stroke', '#4a9eff');
                p.setAttribute('stroke-width', '2');
                svg.appendChild(p);
                icon.appendChild(svg);

                const info = document.createElement('div');
                info.className = 'root-tile-info';

                const name = document.createElement('div');
                name.className = 'root-tile-name';
                name.textContent = vol.name;

                const detail = document.createElement('div');
                detail.className = 'root-tile-detail';
                detail.textContent = vol.path;

                info.appendChild(name);
                info.appendChild(detail);
                tile.appendChild(icon);
                tile.appendChild(info);

                tile.addEventListener('click', () => this.navigateToFolder(vol.path));
                volumeGrid.appendChild(tile);
            });
            categoryView.appendChild(volumeGrid);
        }

        fileDisplay.appendChild(categoryView);
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
        this.clearElement(fileDisplay);
        fileDisplay.className = 'file-display';

        // Hero wrapper with folder name
        const folderName = this.currentPath === this.homePath
            ? 'home'
            : this.currentPath.split(/[/\\]/).pop().toLowerCase();

        const categoryView = document.createElement('div');
        categoryView.className = 'category-view';

        const hero = document.createElement('div');
        hero.className = 'hero-header';
        hero.textContent = folderName;
        categoryView.appendChild(hero);

        const content = document.createElement('div');
        content.className = `category-content ${this.currentViewMode}-view`;

        const loadingMsg = document.createElement('div');
        loadingMsg.className = 'empty-state';
        loadingMsg.textContent = 'loading...';
        content.appendChild(loadingMsg);
        categoryView.appendChild(content);
        fileDisplay.appendChild(categoryView);

        const result = await window.electronAPI.getDirectoryContents(this.currentPath);
        this.clearElement(content);

        if (!result.success) {
            this.appendEmptyState(content, 'could not read this folder');
            return;
        }

        let extensions = this.fileExtensions[this.currentCategory] || [];
        // Documents file browser also shows music and video files
        if (this.currentCategory === 'documents') {
            extensions = [...extensions, ...this.fileExtensions.music, ...this.fileExtensions.videos];
        }

        const folders = result.files.filter(f => f.isDirectory && !f.name.startsWith('.'));
        const files = result.files.filter(f =>
            !f.isDirectory &&
            !f.name.startsWith('.') &&
            extensions.includes(f.extension)
        );

        const visibleFolders = await this.filterFoldersWithContent(folders, extensions);

        if (visibleFolders.length === 0 && files.length === 0) {
            this.appendEmptyState(content, `no ${this.currentCategory} here`);
            return;
        }

        visibleFolders.sort((a, b) => a.name.localeCompare(b.name));
        visibleFolders.forEach(folder => {
            content.appendChild(this.createFolderElement(folder));
        });

        if (visibleFolders.length > 0 && files.length > 0) {
            const sep = document.createElement('div');
            sep.className = 'folder-file-separator';
            content.appendChild(sep);
        }

        files.sort((a, b) => a.name.localeCompare(b.name));
        files.forEach(file => {
            content.appendChild(this.createFileElement(file));
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
        container.classList.remove('show-recent', 'show-content', 'show-sync');
        document.getElementById('content-panel').classList.remove('hero-mode');
        this.currentView = 'menu';
        this.focusMenu();
    }

    showRecent() {
        const container = document.getElementById('panoramic-container');
        container.classList.add('show-recent');
        container.classList.remove('show-content');
        this.currentView = 'recent';
    }

    showSync() {
        const container = document.getElementById('panoramic-container');
        container.classList.remove('show-recent', 'show-content');
        container.classList.add('show-sync');
        this.currentView = 'sync';
    }

    hideSync() {
        const container = document.getElementById('panoramic-container');
        container.classList.remove('show-sync');
        this.currentView = 'menu';
        this.focusMenu();
    }

    navigateBack() {
        // Music: drill-down → sub-view → menu
        if (this.currentCategory === 'music') {
            if (this.musicDrillDown) {
                this.musicDrillDown = null;
                this.renderMusicView();
            } else {
                this.showMenu();
            }
            return;
        }

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
                await this.scanDirectoryRecursive(dir, category);
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

    async scanDirectoryRecursive(dirPath, category) {
        try {
            const result = await window.electronAPI.getDirectoryContents(dirPath);
            if (!result.success) return;

            const extensions = this.fileExtensions[category];
            for (const file of result.files) {
                if (file.name.startsWith('.')) continue;
                if (file.isDirectory) {
                    await this.scanDirectoryRecursive(file.path, category);
                } else if (extensions.includes(file.extension)) {
                    if (!this.categorizedFiles[category].some(f => f.path === file.path)) {
                        this.categorizedFiles[category].push(file);
                    }
                } else if (category === 'music' && file.extension === '') {
                    // Extensionless files in Music folder — include for scanning,
                    // music-metadata will detect format from content
                    if (!this.categorizedFiles[category].some(f => f.path === file.path)) {
                        this.categorizedFiles[category].push(file);
                        this.extensionlessFiles.push(file.path);
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
        this.updateRecentPanel();
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

    createRecentFileElement(file) {
        const div = document.createElement('div');
        div.className = 'recent-file';
        div.dataset.path = file.path;

        // Make recent files draggable for sync panel
        div.draggable = true;
        div.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('application/x-zune-paths', JSON.stringify([file.path]));
            e.dataTransfer.effectAllowed = 'copy';
            div.classList.add('dragging');
        });
        div.addEventListener('dragend', () => div.classList.remove('dragging'));

        const category = this.getFileCategory(file);

        // Add image thumbnail for pictures
        if (category === 'pictures') {
            const img = document.createElement('img');
            img.className = 'recent-file-thumb';
            img.src = `file://${file.path}`;
            img.alt = file.name;
            img.onerror = () => { img.style.display = 'none'; };
            div.appendChild(img);
        }

        const fileName = document.createElement('div');
        fileName.className = 'file-name';
        fileName.textContent = file.name;

        const fileType = document.createElement('div');
        fileType.className = 'file-details';
        fileType.textContent = category;

        div.appendChild(fileName);
        div.appendChild(fileType);

        div.addEventListener('click', () => this.handleFileClick(null, file));
        div.addEventListener('contextmenu', (e) => this.showContextMenu(e, file));

        return div;
    }

    // --- Pins ---

    async loadPins() {
        const result = await window.electronAPI.pinsLoad();
        if (result.success) {
            this.pinnedItems = result.data;
        }
        this.updatePinnedPanel();
    }

    async savePins() {
        await window.electronAPI.pinsSave(this.pinnedItems);
    }

    updatePinnedPanel() {
        const section = document.getElementById('pinned-section');
        const container = document.getElementById('pinned-files');

        if (this.pinnedItems.length === 0) {
            section.style.display = 'none';
            return;
        }

        section.style.display = 'block';
        this.clearElement(container);

        this.pinnedItems.forEach(pin => {
            const el = this.createPinnedElement(pin);
            container.appendChild(el);
        });
    }

    createPinnedElement(pin) {
        const div = document.createElement('div');
        div.className = 'recent-file pinned-item';
        div.dataset.pinId = pin.id;

        // Draggable for file/folder types
        if (pin.type === 'file' || pin.type === 'folder') {
            div.draggable = true;
            div.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('application/x-zune-paths', JSON.stringify([pin.path]));
                e.dataTransfer.effectAllowed = 'copy';
            });
        }

        // Thumbnail for pictures
        if (pin.type === 'file' && pin.meta && pin.meta.category === 'pictures') {
            const img = document.createElement('img');
            img.className = 'recent-file-thumb';
            img.src = `file://${pin.path}`;
            img.onerror = () => { img.style.display = 'none'; };
            div.appendChild(img);
        }

        const name = document.createElement('div');
        name.className = 'file-name';
        name.textContent = pin.label;

        const detail = document.createElement('div');
        detail.className = 'file-details';
        detail.textContent = pin.type;

        div.appendChild(name);
        div.appendChild(detail);

        div.addEventListener('click', () => this.navigateToPin(pin));
        div.addEventListener('contextmenu', (e) => this.showPinContextMenu(e, pin));

        return div;
    }

    navigateToPin(pin) {
        switch (pin.type) {
            case 'file':
                this.handleFileClick(null, { path: pin.path, name: pin.label });
                break;
            case 'folder':
                this.currentCategory = pin.meta.category || 'documents';
                this.showContent();
                this.browsingMode = true;
                this.currentPath = pin.path;
                this.renderDirectoryContents();
                break;
            case 'album':
                this.currentCategory = 'music';
                this.showContent();
                this.musicSubView = 'albums';
                this.musicDrillDown = { type: 'album', key: pin.meta.albumKey };
                this.renderMusicView();
                break;
            case 'artist':
                this.currentCategory = 'music';
                this.showContent();
                this.musicSubView = 'artists';
                this.musicDrillDown = { type: 'artist', name: pin.meta.artistName };
                this.renderMusicView();
                break;
            case 'genre':
                this.currentCategory = 'music';
                this.showContent();
                this.musicSubView = 'genres';
                this.musicDrillDown = { type: 'genre', name: pin.meta.genreName };
                this.renderMusicView();
                break;
            case 'playlist':
                this.currentCategory = 'music';
                this.showContent();
                this.musicSubView = 'playlists';
                this.musicDrillDown = { type: 'playlist', id: pin.meta.playlistId };
                this.renderMusicView();
                break;
        }
    }

    showPinContextMenu(e, pin) {
        this.showDynamicContextMenu(e, [
            { label: 'Unpin', action: () => {
                this.pinnedItems = this.pinnedItems.filter(p => p.id !== pin.id);
                this.savePins();
                this.updatePinnedPanel();
            }},
        ]);
    }

    async pinItem(file) {
        const category = this.getFileCategory(file);
        const pin = {
            id: crypto.randomUUID(),
            type: file.isDirectory ? 'folder' : 'file',
            label: file.name,
            path: file.path,
            meta: { category },
            createdAt: new Date().toISOString(),
        };

        if (this.pinnedItems.some(p => p.path === pin.path)) return;

        this.pinnedItems.push(pin);
        await this.savePins();
        this.updatePinnedPanel();
    }

    async unpinItem(path) {
        this.pinnedItems = this.pinnedItems.filter(p => p.path !== path);
        await this.savePins();
        this.updatePinnedPanel();
    }

    async pinMusicItem(type, data) {
        const pin = {
            id: crypto.randomUUID(),
            type,
            label: data.label,
            path: null,
            meta: data.meta,
            createdAt: new Date().toISOString(),
        };

        const isDuplicate = this.pinnedItems.some(p => {
            if (p.type !== type) return false;
            if (type === 'album') return p.meta.albumKey === data.meta.albumKey;
            if (type === 'artist') return p.meta.artistName === data.meta.artistName;
            if (type === 'genre') return p.meta.genreName === data.meta.genreName;
            if (type === 'playlist') return p.meta.playlistId === data.meta.playlistId;
            return false;
        });
        if (isDuplicate) return;

        this.pinnedItems.push(pin);
        await this.savePins();
        this.updatePinnedPanel();
    }

    // --- End Pins ---

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
            if (this.currentCategory === 'music') {
                this.renderMusicView();
            } else if (this.currentCategory === 'documents' && !this.browsingMode) {
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

        this.clearElement(fileDisplay);
        fileDisplay.className = 'file-display';

        // Wrap in category-view with hero header
        const categoryView = document.createElement('div');
        categoryView.className = 'category-view';

        const hero = document.createElement('div');
        hero.className = 'hero-header';
        hero.textContent = this.currentCategory;
        categoryView.appendChild(hero);

        const content = document.createElement('div');
        content.className = `category-content ${this.currentViewMode}-view`;

        if (files.length === 0) {
            this.appendEmptyState(content, 'No files found in this category');
        } else {
            files.sort((a, b) => a.name.localeCompare(b.name));
            files.forEach(file => {
                content.appendChild(this.createFileElement(file));
            });
        }

        categoryView.appendChild(content);
        fileDisplay.appendChild(categoryView);
    }

    createFileElement(file) {
        const div = document.createElement('div');
        div.className = `file-item ${this.currentViewMode}`;
        div.tabIndex = 0;
        div.dataset.path = file.path;

        // Make file items draggable for sync panel
        div.draggable = true;
        div.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('application/x-zune-paths', JSON.stringify([file.path]));
            e.dataTransfer.effectAllowed = 'copy';
            div.classList.add('dragging');
        });
        div.addEventListener('dragend', () => div.classList.remove('dragging'));

        // Create file icon/preview
        const fileIcon = document.createElement('div');
        fileIcon.className = 'file-icon';
        
        const category = this.getFileCategory(file);
        
        // Use image preview for picture files, fallback to icon
        if (category === 'pictures') {
            const img = document.createElement('img');
            img.src = `file://${file.path}`;
            img.draggable = false;
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

    // ========================================
    // Music Library - Data Model & Scanning
    // ========================================

    getSortLetter(text) {
        if (!text) return '#';
        const ch = text.charAt(0).toLowerCase();
        return /[a-z]/.test(ch) ? ch : '#';
    }

    buildLetterGroupedList(items, labelFn) {
        const result = [];
        let currentLetter = null;
        for (const item of items) {
            const letter = this.getSortLetter(labelFn(item));
            if (letter !== currentLetter) {
                currentLetter = letter;
                result.push({ type: 'letter', letter });
            }
            result.push({ type: 'item', data: item });
        }
        return result;
    }

    clearElement(el) {
        while (el.firstChild) el.removeChild(el.firstChild);
    }

    appendEmptyState(parent, message) {
        const div = document.createElement('div');
        div.className = 'empty-state';
        div.textContent = message;
        parent.appendChild(div);
    }

    rebuildMusicIndexes() {
        const lib = this.musicLibrary;
        lib.albums.clear();
        lib.artists.clear();
        lib.genres.clear();

        for (const track of lib.tracks.values()) {
            // Albums
            const albumKey = `${(track.album || 'Unknown Album').toLowerCase()}||${(track.albumArtist || track.artist || 'Unknown Artist').toLowerCase()}`;
            if (!lib.albums.has(albumKey)) {
                lib.albums.set(albumKey, {
                    key: albumKey,
                    name: track.album || 'Unknown Album',
                    artist: track.albumArtist || track.artist || 'Unknown Artist',
                    year: track.year || 0,
                    albumArt: track.albumArt || null,
                    tracks: [],
                    sortLetter: this.getSortLetter(track.album || 'Unknown Album'),
                });
            }
            const album = lib.albums.get(albumKey);
            album.tracks.push(track);
            if (!album.albumArt && track.albumArt) {
                album.albumArt = track.albumArt;
            }

            // Artists
            const artistKey = (track.artist || 'Unknown Artist').toLowerCase();
            if (!lib.artists.has(artistKey)) {
                lib.artists.set(artistKey, {
                    name: track.artist || 'Unknown Artist',
                    albums: new Set(),
                    trackCount: 0,
                    albumArt: track.albumArt || null,
                    sortLetter: this.getSortLetter(track.artist || 'Unknown Artist'),
                });
            }
            const artist = lib.artists.get(artistKey);
            artist.trackCount++;
            artist.albums.add(albumKey);
            if (!artist.albumArt && track.albumArt) {
                artist.albumArt = track.albumArt;
            }

            // Genres
            const genreKey = (track.genre || 'Unknown').toLowerCase();
            if (!lib.genres.has(genreKey)) {
                lib.genres.set(genreKey, { name: track.genre || 'Unknown', tracks: [] });
            }
            lib.genres.get(genreKey).tracks.push(track);
        }

        // Sort album tracks by track number
        for (const album of lib.albums.values()) {
            album.tracks.sort((a, b) => (a.trackNumber || 0) - (b.trackNumber || 0));
        }

        // Build sorted arrays
        lib.sortedSongs = [...lib.tracks.values()].sort((a, b) =>
            (a.title || '').localeCompare(b.title || ''));
        lib.sortedAlbums = [...lib.albums.values()].sort((a, b) =>
            a.name.localeCompare(b.name));
        lib.sortedArtists = [...lib.artists.values()].sort((a, b) =>
            a.name.localeCompare(b.name));
        lib.sortedGenres = [...lib.genres.values()].sort((a, b) =>
            a.name.localeCompare(b.name));
    }

    async scanMusicLibrary() {
        const lib = this.musicLibrary;
        if (lib.scanState === 'scanning') return;

        const musicFiles = this.categorizedFiles.music;
        if (musicFiles.length === 0) {
            lib.scanState = 'complete';
            return;
        }

        lib.scanState = 'scanning';
        lib.totalCount = musicFiles.length;
        lib.scannedCount = 0;

        const paths = musicFiles.map(f => f.path);

        // Listen for progress
        window.electronAPI.onMusicScanProgress((data) => {
            for (const result of data.batch) {
                lib.tracks.set(result.path, result);
            }
            lib.scannedCount = data.scanned;
            this.rebuildMusicIndexes();

            // Update progress UI
            const progressEl = document.getElementById('music-scan-progress');
            if (progressEl) {
                if (data.scanned >= data.total) {
                    progressEl.style.display = 'none';
                    lib.scanState = 'complete';
                    this.applyCachedMetadata();
                    this.promptExtensionlessFix();
                } else {
                    progressEl.style.display = 'block';
                    progressEl.textContent = `scanning ${data.scanned} of ${data.total}...`;
                }
            }

            // Re-render current sub-view if still in music
            if (this.currentCategory === 'music' && this.currentView === 'content') {
                this.renderMusicSubContent();
            }

            // Recompute diff if device browse is active (local library changed)
            if (this.zunePanel && this.zunePanel.diffActive) {
                this.zunePanel._computeDiff();
                this.zunePanel._enrichDeviceArt();
                this.zunePanel._renderDiffSummary();
                this.zunePanel._renderDiffList();
            }
        });

        await window.electronAPI.batchScanAudioMetadata(paths, { batchSize: 15, includeArt: true });
    }

    getTrackFile(track) {
        return this.categorizedFiles.music.find(f => f.path === track.path) || { path: track.path, name: track.title, extension: '.mp3' };
    }

    formatDuration(seconds) {
        if (!seconds || isNaN(seconds)) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    // ========================================
    // Music View - Shell & Navigation
    // ========================================

    renderMusicView() {
        const fileDisplay = document.getElementById('file-display');
        fileDisplay.className = 'file-display';
        this.clearElement(fileDisplay);

        const contentPanel = document.getElementById('content-panel');
        const title = document.getElementById('content-title');
        const breadcrumb = document.getElementById('breadcrumb');

        if (this.musicDrillDown) {
            // Drill-down: show normal header with title
            contentPanel.classList.remove('hero-mode');
            if (this.musicDrillDown.type === 'album') {
                const album = this.musicLibrary.albums.get(this.musicDrillDown.key);
                title.textContent = album ? album.name : 'Album';
                breadcrumb.textContent = 'music';
            } else if (this.musicDrillDown.type === 'artist') {
                const resolvedKey = this.resolveArtistKey(this.musicDrillDown.name);
                const artist = this.musicLibrary.artists.get(resolvedKey);
                title.textContent = artist ? artist.name : 'Artist';
                breadcrumb.textContent = 'music';
            }
            this.renderMusicDrillDown();
            return;
        }

        // Main music view: use hero-mode (hides title-group, shows hero)
        contentPanel.classList.add('hero-mode');
        title.textContent = '';
        breadcrumb.textContent = '';

        const musicView = document.createElement('div');
        musicView.className = 'music-view';

        // Hero header
        const hero = document.createElement('div');
        hero.className = 'hero-header';
        hero.textContent = 'music';
        musicView.appendChild(hero);

        // Sub-tabs
        const tabs = document.createElement('div');
        tabs.className = 'music-sub-tabs';
        const tabNames = ['albums', 'artists', 'songs', 'genres'];
        tabNames.forEach(name => {
            const tab = document.createElement('button');
            tab.className = 'music-sub-tab' + (this.musicSubView === name ? ' active' : '');
            tab.textContent = name.toUpperCase();
            tab.addEventListener('click', () => {
                this.musicSubView = name;
                this.musicDrillDown = null;
                this.renderMusicView();
            });
            tabs.appendChild(tab);
        });
        musicView.appendChild(tabs);

        // Scan progress
        const progress = document.createElement('div');
        progress.id = 'music-scan-progress';
        progress.className = 'music-scan-progress';
        if (this.musicLibrary.scanState === 'scanning') {
            progress.textContent = `scanning ${this.musicLibrary.scannedCount} of ${this.musicLibrary.totalCount}...`;
        } else {
            progress.style.display = 'none';
        }
        musicView.appendChild(progress);

        // Sub-content container
        const subContent = document.createElement('div');
        subContent.id = 'music-sub-content';
        subContent.className = 'music-sub-content';
        musicView.appendChild(subContent);

        fileDisplay.appendChild(musicView);

        // Render sub-view content
        this.renderMusicSubContent();

        // Start scanning if needed
        if (this.musicLibrary.scanState === 'idle') {
            this.scanMusicLibrary();
        }
    }

    renderMusicSubContent() {
        const container = document.getElementById('music-sub-content');
        if (!container) return;

        switch (this.musicSubView) {
            case 'albums': this.renderMusicAlbumsView(container); break;
            case 'artists': this.renderMusicArtistsView(container); break;
            case 'songs': this.renderMusicSongsView(container); break;
            case 'genres': this.renderMusicGenresView(container); break;
        }
    }

    renderMusicDrillDown() {
        if (!this.musicDrillDown) return;
        const fileDisplay = document.getElementById('file-display');
        fileDisplay.className = 'file-display';
        this.clearElement(fileDisplay);

        // Hide grid/list toggle
        const viewToggle = document.querySelector('.view-toggle');
        if (viewToggle) viewToggle.style.display = 'none';

        if (this.musicDrillDown.type === 'album') {
            this.renderAlbumDetail(fileDisplay);
        } else if (this.musicDrillDown.type === 'artist') {
            this.renderArtistDetail(fileDisplay);
        }
    }

    // ========================================
    // Music Sub-Views
    // ========================================

    renderMusicAlbumsView(container) {
        this.clearElement(container);
        const albums = this.musicLibrary.sortedAlbums;

        if (albums.length === 0 && this.musicLibrary.scanState !== 'scanning') {
            this.appendEmptyState(container, 'no albums found');
            return;
        }

        const grouped = this.buildLetterGroupedList(albums, a => a.name);
        const grid = document.createElement('div');
        grid.className = 'music-albums-grid';

        for (const entry of grouped) {
            if (entry.type === 'letter') {
                const tile = document.createElement('div');
                tile.className = 'music-letter-tile';
                tile.dataset.letter = entry.letter;
                tile.textContent = entry.letter;
                tile.addEventListener('click', () => this.openAlphaJump());
                grid.appendChild(tile);
            } else {
                const album = entry.data;
                const tile = document.createElement('div');
                tile.className = 'music-album-tile';
                if (album.albumArt) {
                    tile.style.backgroundImage = `url(${album.albumArt})`;
                }
                const overlay = document.createElement('div');
                overlay.className = 'music-album-overlay';
                const name = document.createElement('div');
                name.className = 'music-album-name';
                name.textContent = album.name;
                const artist = document.createElement('div');
                artist.className = 'music-album-artist';
                artist.textContent = album.artist;
                overlay.appendChild(name);
                overlay.appendChild(artist);
                tile.appendChild(overlay);
                tile.addEventListener('click', () => {
                    this.musicDrillDown = { type: 'album', key: album.key };
                    this.renderMusicView();
                });
                tile.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    this.showMetadataLookup(album.name, album.artist);
                });
                grid.appendChild(tile);
            }
        }
        container.appendChild(grid);
    }

    renderMusicSongsView(container) {
        this.clearElement(container);
        const songs = this.musicLibrary.sortedSongs;

        if (songs.length === 0 && this.musicLibrary.scanState !== 'scanning') {
            this.appendEmptyState(container, 'no songs found');
            return;
        }

        const grouped = this.buildLetterGroupedList(songs, s => s.title);
        const list = document.createElement('div');
        list.className = 'music-songs-list';

        for (const entry of grouped) {
            if (entry.type === 'letter') {
                const row = document.createElement('div');
                row.className = 'music-letter-row';
                row.dataset.letter = entry.letter;
                row.textContent = entry.letter;
                row.addEventListener('click', () => this.openAlphaJump());
                list.appendChild(row);
            } else {
                const track = entry.data;
                const row = document.createElement('div');
                row.className = 'music-song-row';
                row.draggable = true;
                row.addEventListener('dragstart', (e) => {
                    e.dataTransfer.setData('application/x-zune-paths', JSON.stringify([track.path]));
                    e.dataTransfer.effectAllowed = 'copy';
                    row.classList.add('dragging');
                });
                row.addEventListener('dragend', () => row.classList.remove('dragging'));
                const info = document.createElement('div');
                info.className = 'music-song-info';
                const titleEl = document.createElement('div');
                titleEl.className = 'music-song-title';
                titleEl.textContent = track.title;
                const meta = document.createElement('div');
                meta.className = 'music-song-meta';
                meta.textContent = `${track.artist} — ${track.album}`.toUpperCase();
                info.appendChild(titleEl);
                info.appendChild(meta);
                const dur = document.createElement('div');
                dur.className = 'music-song-duration';
                dur.textContent = this.formatDuration(track.duration);
                row.appendChild(info);
                row.appendChild(dur);
                row.addEventListener('click', () => {
                    const file = this.getTrackFile(track);
                    const allFiles = this.musicLibrary.sortedSongs.map(t => this.getTrackFile(t));
                    this.audioPlayer.play(file, allFiles);
                });
                list.appendChild(row);
            }
        }
        container.appendChild(list);
    }

    renderMusicArtistsView(container) {
        this.clearElement(container);
        const artists = this.musicLibrary.sortedArtists;

        if (artists.length === 0 && this.musicLibrary.scanState !== 'scanning') {
            this.appendEmptyState(container, 'no artists found');
            return;
        }

        const grouped = this.buildLetterGroupedList(artists, a => a.name);
        const list = document.createElement('div');
        list.className = 'music-artists-list';

        for (const entry of grouped) {
            if (entry.type === 'letter') {
                const row = document.createElement('div');
                row.className = 'music-letter-row';
                row.dataset.letter = entry.letter;
                row.textContent = entry.letter;
                row.addEventListener('click', () => this.openAlphaJump());
                list.appendChild(row);
            } else {
                const artist = entry.data;
                const row = document.createElement('div');
                row.className = 'music-artist-row';

                const thumb = document.createElement('div');
                thumb.className = 'music-artist-thumb';
                if (artist.albumArt) {
                    const img = document.createElement('img');
                    img.src = artist.albumArt;
                    img.alt = artist.name;
                    thumb.appendChild(img);
                }

                const info = document.createElement('div');
                info.className = 'music-artist-info';
                const nameEl = document.createElement('div');
                nameEl.className = 'music-artist-name';
                nameEl.textContent = artist.name;
                const detail = document.createElement('div');
                detail.className = 'music-artist-detail';
                const albumCount = artist.albums.size;
                detail.textContent = `${albumCount} album${albumCount !== 1 ? 's' : ''}, ${artist.trackCount} song${artist.trackCount !== 1 ? 's' : ''}`;
                info.appendChild(nameEl);
                info.appendChild(detail);

                row.appendChild(thumb);
                row.appendChild(info);
                row.addEventListener('click', () => {
                    this.musicDrillDown = { type: 'artist', name: (artist.name).toLowerCase() };
                    this.renderMusicView();
                });
                row.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    const firstAlbumKey = [...artist.albums][0];
                    const firstAlbum = firstAlbumKey ? this.musicLibrary.albums.get(firstAlbumKey) : null;
                    if (firstAlbum) {
                        this.showMetadataLookup(firstAlbum.name, artist.name);
                    }
                });
                list.appendChild(row);
            }
        }
        container.appendChild(list);
    }

    renderMusicGenresView(container) {
        this.clearElement(container);
        const genres = this.musicLibrary.sortedGenres;

        if (genres.length === 0 && this.musicLibrary.scanState !== 'scanning') {
            this.appendEmptyState(container, 'no genres found');
            return;
        }

        const list = document.createElement('div');
        list.className = 'music-genres-list';

        for (const genre of genres) {
            const row = document.createElement('div');
            row.className = 'music-genre-row';
            const nameEl = document.createElement('div');
            nameEl.className = 'music-genre-name';
            nameEl.textContent = genre.name;
            const count = document.createElement('div');
            count.className = 'music-genre-count';
            count.textContent = `${genre.tracks.length} song${genre.tracks.length !== 1 ? 's' : ''}`;
            row.appendChild(nameEl);
            row.appendChild(count);
            row.addEventListener('click', () => {
                this.renderGenreDetail(container, genre);
            });
            list.appendChild(row);
        }
        container.appendChild(list);
    }

    renderGenreDetail(container, genre) {
        this.clearElement(container);
        const header = document.createElement('div');
        header.className = 'music-genre-detail-header';
        const backBtn = document.createElement('button');
        backBtn.className = 'music-genre-back';
        const backSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        backSvg.setAttribute('width', '32');
        backSvg.setAttribute('height', '32');
        backSvg.setAttribute('viewBox', '0 0 48 48');
        backSvg.setAttribute('fill', 'none');
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', '24');
        circle.setAttribute('cy', '24');
        circle.setAttribute('r', '22');
        circle.setAttribute('stroke', 'currentColor');
        circle.setAttribute('stroke-width', '2.5');
        const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        chevron.setAttribute('d', 'M27 14L17 24L27 34');
        chevron.setAttribute('fill', 'none');
        chevron.setAttribute('stroke', 'currentColor');
        chevron.setAttribute('stroke-width', '4');
        chevron.setAttribute('stroke-linecap', 'square');
        chevron.setAttribute('stroke-linejoin', 'miter');
        const stem = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        stem.setAttribute('x1', '18');
        stem.setAttribute('y1', '24');
        stem.setAttribute('x2', '33');
        stem.setAttribute('y2', '24');
        stem.setAttribute('stroke', 'currentColor');
        stem.setAttribute('stroke-width', '4');
        stem.setAttribute('stroke-linecap', 'square');
        backSvg.appendChild(circle);
        backSvg.appendChild(chevron);
        backSvg.appendChild(stem);
        backBtn.appendChild(backSvg);
        const backLabel = document.createElement('span');
        backLabel.textContent = 'GENRES';
        backBtn.appendChild(backLabel);
        backBtn.addEventListener('click', () => this.renderMusicGenresView(container));
        header.appendChild(backBtn);
        const title = document.createElement('div');
        title.className = 'music-genre-detail-title';
        title.textContent = genre.name;
        header.appendChild(title);
        container.appendChild(header);

        const list = document.createElement('div');
        list.className = 'music-songs-list';
        const sortedTracks = [...genre.tracks].sort((a, b) => (a.title || '').localeCompare(b.title || ''));

        for (const track of sortedTracks) {
            const row = document.createElement('div');
            row.className = 'music-song-row';
            row.draggable = true;
            row.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('application/x-zune-paths', JSON.stringify([track.path]));
                e.dataTransfer.effectAllowed = 'copy';
                row.classList.add('dragging');
            });
            row.addEventListener('dragend', () => row.classList.remove('dragging'));
            const info = document.createElement('div');
            info.className = 'music-song-info';
            const titleEl = document.createElement('div');
            titleEl.className = 'music-song-title';
            titleEl.textContent = track.title;
            const meta = document.createElement('div');
            meta.className = 'music-song-meta';
            meta.textContent = `${track.artist} — ${track.album}`.toUpperCase();
            info.appendChild(titleEl);
            info.appendChild(meta);
            const dur = document.createElement('div');
            dur.className = 'music-song-duration';
            dur.textContent = this.formatDuration(track.duration);
            row.appendChild(info);
            row.appendChild(dur);
            row.addEventListener('click', () => {
                const file = this.getTrackFile(track);
                const allFiles = sortedTracks.map(t => this.getTrackFile(t));
                this.audioPlayer.play(file, allFiles);
            });
            list.appendChild(row);
        }
        container.appendChild(list);
    }

    // ========================================
    // Music Drill-Down Views
    // ========================================

    renderAlbumDetail(fileDisplay) {
        const album = this.musicLibrary.albums.get(this.musicDrillDown.key);
        if (!album) {
            this.appendEmptyState(fileDisplay, 'album not found');
            return;
        }

        const detail = document.createElement('div');
        detail.className = 'music-album-detail';

        // Header
        const header = document.createElement('div');
        header.className = 'music-album-detail-header';

        const art = document.createElement('div');
        art.className = 'music-album-detail-art';
        if (album.albumArt) {
            const img = document.createElement('img');
            img.src = album.albumArt;
            img.alt = album.name;
            art.appendChild(img);
        }
        header.appendChild(art);

        const info = document.createElement('div');
        info.className = 'music-album-detail-info';
        const nameEl = document.createElement('div');
        nameEl.className = 'music-album-detail-name';
        nameEl.textContent = album.name;
        const artistEl = document.createElement('div');
        artistEl.className = 'music-album-detail-artist music-link';
        artistEl.textContent = album.artist;
        artistEl.addEventListener('click', () => {
            this.musicDrillDown = { type: 'artist', name: album.artist.toLowerCase() };
            this.renderMusicView();
        });
        const yearEl = document.createElement('div');
        yearEl.className = 'music-album-detail-year';
        if (album.year) yearEl.textContent = album.year;
        const playAllBtn = document.createElement('button');
        playAllBtn.className = 'music-play-all-btn';
        playAllBtn.textContent = 'play all';
        playAllBtn.addEventListener('click', () => {
            if (album.tracks.length > 0) {
                const files = album.tracks.map(t => this.getTrackFile(t));
                this.audioPlayer.play(files[0], files);
            }
        });
        const lookupLink = document.createElement('button');
        lookupLink.className = 'music-lookup-btn';
        lookupLink.textContent = 'look up metadata';
        lookupLink.addEventListener('click', () => {
            this.showMetadataLookup(album.name, album.artist);
        });
        info.appendChild(nameEl);
        info.appendChild(artistEl);
        info.appendChild(yearEl);
        info.appendChild(playAllBtn);
        info.appendChild(lookupLink);
        header.appendChild(info);
        detail.appendChild(header);

        // Track list
        const trackList = document.createElement('div');
        trackList.className = 'music-album-tracks';
        album.tracks.forEach((track, i) => {
            const row = document.createElement('div');
            row.className = 'music-album-track-row';
            row.draggable = true;
            row.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('application/x-zune-paths', JSON.stringify([track.path]));
                e.dataTransfer.effectAllowed = 'copy';
                row.classList.add('dragging');
            });
            row.addEventListener('dragend', () => row.classList.remove('dragging'));
            const num = document.createElement('div');
            num.className = 'music-album-track-num';
            num.textContent = track.trackNumber || (i + 1);
            const title = document.createElement('div');
            title.className = 'music-album-track-title';
            title.textContent = track.title;
            const dur = document.createElement('div');
            dur.className = 'music-album-track-duration';
            dur.textContent = this.formatDuration(track.duration);
            row.appendChild(num);
            row.appendChild(title);
            row.appendChild(dur);
            row.addEventListener('click', () => {
                const file = this.getTrackFile(track);
                const files = album.tracks.map(t => this.getTrackFile(t));
                this.audioPlayer.play(file, files);
            });
            trackList.appendChild(row);
        });
        detail.appendChild(trackList);
        fileDisplay.appendChild(detail);
    }

    resolveArtistKey(name) {
        const key = name.toLowerCase();
        if (this.musicLibrary.artists.has(key)) return key;
        // albumArtist and artist can differ — find the artist whose albums match
        for (const [artistKey, artist] of this.musicLibrary.artists) {
            for (const albumKey of artist.albums) {
                const album = this.musicLibrary.albums.get(albumKey);
                if (album && album.artist.toLowerCase() === key) return artistKey;
            }
        }
        return key;
    }

    renderArtistDetail(fileDisplay) {
        const resolvedKey = this.resolveArtistKey(this.musicDrillDown.name);
        const artist = this.musicLibrary.artists.get(resolvedKey);
        if (!artist) {
            this.appendEmptyState(fileDisplay, 'artist not found');
            return;
        }

        const detail = document.createElement('div');
        detail.className = 'music-artist-detail';

        // Artist header
        const header = document.createElement('div');
        header.className = 'music-artist-detail-header';
        header.textContent = artist.name;
        detail.appendChild(header);

        // Albums grid (filtered to this artist)
        const grid = document.createElement('div');
        grid.className = 'music-albums-grid';
        const artistAlbums = this.musicLibrary.sortedAlbums.filter(a =>
            artist.albums.has(a.key));

        for (const album of artistAlbums) {
            const tile = document.createElement('div');
            tile.className = 'music-album-tile';
            if (album.albumArt) {
                tile.style.backgroundImage = `url(${album.albumArt})`;
            }
            const overlay = document.createElement('div');
            overlay.className = 'music-album-overlay';
            const name = document.createElement('div');
            name.className = 'music-album-name';
            name.textContent = album.name;
            const artistName = document.createElement('div');
            artistName.className = 'music-album-artist';
            if (album.year) artistName.textContent = album.year;
            overlay.appendChild(name);
            overlay.appendChild(artistName);
            tile.appendChild(overlay);
            tile.addEventListener('click', () => {
                this.musicDrillDown = { type: 'album', key: album.key };
                this.renderMusicView();
            });
            grid.appendChild(tile);
        }
        detail.appendChild(grid);
        fileDisplay.appendChild(detail);
    }

    // ========================================
    // Alpha Jump
    // ========================================

    openAlphaJump() {
        const overlay = document.getElementById('alpha-jump-overlay');
        const grid = document.getElementById('alpha-jump-grid');
        this.clearElement(grid);

        // Gather available letters from current sub-view
        const availableLetters = new Set();
        const letterEls = document.querySelectorAll('[data-letter]');
        letterEls.forEach(el => {
            if (!el.closest('.alpha-jump-overlay')) {
                availableLetters.add(el.dataset.letter);
            }
        });

        const allLetters = ['#', ...'abcdefghijklmnopqrstuvwxyz'.split('')];
        for (const letter of allLetters) {
            const btn = document.createElement('button');
            btn.className = 'alpha-jump-letter' + (availableLetters.has(letter) ? '' : ' disabled');
            btn.textContent = letter;
            if (availableLetters.has(letter)) {
                btn.addEventListener('click', () => {
                    this.closeAlphaJump();
                    const target = document.querySelector(`[data-letter="${letter}"]:not(.alpha-jump-letter)`);
                    if (target) {
                        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }
                });
            }
            grid.appendChild(btn);
        }

        overlay.classList.add('open');

        // Exit button
        document.getElementById('alpha-jump-exit').addEventListener('click', () => {
            this.closeAlphaJump();
        });
    }

    closeAlphaJump() {
        document.getElementById('alpha-jump-overlay').classList.remove('open');
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

    async showMetadataLookup(albumName, artistName) {
        const modal = document.getElementById('metadata-modal');
        const status = document.getElementById('metadata-modal-status');
        const results = document.getElementById('metadata-modal-results');
        const closeBtn = document.getElementById('metadata-modal-close');

        modal.style.display = 'flex';
        status.textContent = `Searching for "${albumName}" by ${artistName}...`;
        status.style.display = 'block';
        results.textContent = '';

        const onClose = () => { modal.style.display = 'none'; };
        closeBtn.onclick = onClose;
        modal.addEventListener('click', (e) => { if (e.target === modal) onClose(); });

        const showResults = (searchResult) => {
            status.textContent = `Found ${searchResult.results.length} match${searchResult.results.length !== 1 ? 'es' : ''} — pick one:`;
            results.textContent = '';

            for (const match of searchResult.results) {
                const item = document.createElement('div');
                item.className = 'metadata-match-item';

                const artContainer = document.createElement('div');
                artContainer.className = 'metadata-match-art';
                // Placeholder: vinyl record icon
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                svg.setAttribute('width', '48');
                svg.setAttribute('height', '48');
                svg.setAttribute('viewBox', '0 0 48 48');
                const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                rect.setAttribute('width', '48');
                rect.setAttribute('height', '48');
                rect.setAttribute('rx', '4');
                rect.setAttribute('fill', '#1a1a1a');
                const circle1 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                circle1.setAttribute('cx', '24');
                circle1.setAttribute('cy', '24');
                circle1.setAttribute('r', '10');
                circle1.setAttribute('fill', 'none');
                circle1.setAttribute('stroke', '#333');
                circle1.setAttribute('stroke-width', '1');
                const circle2 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                circle2.setAttribute('cx', '24');
                circle2.setAttribute('cy', '24');
                circle2.setAttribute('r', '4');
                circle2.setAttribute('fill', '#333');
                svg.appendChild(rect);
                svg.appendChild(circle1);
                svg.appendChild(circle2);
                artContainer.appendChild(svg);
                item.appendChild(artContainer);

                const textWrap = document.createElement('div');
                textWrap.className = 'metadata-match-text';

                const title = document.createElement('div');
                title.className = 'metadata-match-title';
                title.textContent = match.title;

                const detail = document.createElement('div');
                detail.className = 'metadata-match-detail';
                const parts = [match.artist];
                if (match.year) parts.push(match.year);
                if (match.label) parts.push(match.label);
                if (match.trackCount) parts.push(`${match.trackCount} tracks`);
                detail.textContent = parts.join(' — ');

                textWrap.appendChild(title);
                textWrap.appendChild(detail);
                item.appendChild(textWrap);

                item.addEventListener('click', () => {
                    this.showMetadataPreview(modal, status, results, match, albumName, artistName, searchResult, showResults);
                });

                results.appendChild(item);

                // Fetch thumbnail asynchronously
                window.electronAPI.metadataThumbnail(match.mbid).then(res => {
                    if (res.success && res.dataUrl) {
                        const img = document.createElement('img');
                        img.className = 'metadata-match-art-img';
                        img.src = res.dataUrl;
                        img.alt = match.title;
                        artContainer.textContent = '';
                        artContainer.appendChild(img);
                    }
                });
            }
        };

        const searchResult = await window.electronAPI.metadataSearch(albumName, artistName);
        if (!searchResult.success || searchResult.results.length === 0) {
            status.textContent = searchResult.success ? 'No matches found.' : `Error: ${searchResult.error}`;
            return;
        }

        showResults(searchResult);
    }

    async showMetadataPreview(modal, status, results, match, albumName, artistName, searchResult, showResults) {
        status.textContent = 'Fetching metadata and cover art...';
        results.textContent = '';

        // Spinner
        const spinner = document.createElement('div');
        spinner.className = 'metadata-spinner';
        results.appendChild(spinner);

        const fetchResult = await window.electronAPI.metadataFetch(match.mbid);

        if (!fetchResult.success) {
            status.textContent = `Error: ${fetchResult.error}`;
            results.textContent = '';
            return;
        }

        const metadata = fetchResult.result;
        status.style.display = 'none';
        results.textContent = '';

        // Preview card
        const preview = document.createElement('div');
        preview.className = 'metadata-preview';

        // Cover art + info row
        const row = document.createElement('div');
        row.className = 'metadata-preview-row';

        if (metadata.albumArt) {
            const img = document.createElement('img');
            img.className = 'metadata-preview-art';
            img.src = metadata.albumArt;
            img.alt = metadata.title;
            row.appendChild(img);
        }

        const info = document.createElement('div');
        info.className = 'metadata-preview-info';

        const titleEl = document.createElement('div');
        titleEl.className = 'metadata-preview-title';
        titleEl.textContent = metadata.title;
        info.appendChild(titleEl);

        const artistEl = document.createElement('div');
        artistEl.className = 'metadata-preview-artist';
        artistEl.textContent = metadata.artist;
        info.appendChild(artistEl);

        const detailParts = [];
        if (metadata.year) detailParts.push(metadata.year);
        if (metadata.genre) detailParts.push(metadata.genre);
        if (metadata.tracks?.length) detailParts.push(`${metadata.tracks.length} tracks`);
        if (detailParts.length) {
            const detailEl = document.createElement('div');
            detailEl.className = 'metadata-preview-detail';
            detailEl.textContent = detailParts.join(' — ');
            info.appendChild(detailEl);
        }

        row.appendChild(info);
        preview.appendChild(row);

        // Action buttons
        const actions = document.createElement('div');
        actions.className = 'metadata-preview-actions';

        const backBtn = document.createElement('button');
        backBtn.className = 'metadata-preview-back';
        backBtn.textContent = 'back';
        backBtn.addEventListener('click', () => {
            status.style.display = 'block';
            showResults(searchResult);
        });

        const applyBtn = document.createElement('button');
        applyBtn.className = 'metadata-preview-apply';
        applyBtn.textContent = 'apply';
        applyBtn.addEventListener('click', async () => {
            await window.electronAPI.metadataCacheSet(artistName, albumName, metadata);
            this.applyMetadataToLibrary(artistName, albumName, metadata);
            modal.style.display = 'none';
        });

        actions.appendChild(backBtn);
        actions.appendChild(applyBtn);
        preview.appendChild(actions);

        results.appendChild(preview);
    }

    applyMetadataToLibrary(artistName, albumName, metadata) {
        const albumNorm = albumName.toLowerCase();
        const artistNorm = artistName.toLowerCase();
        // Try exact album key first, then fall back to fuzzy match
        // (albumArtist and artist can differ in ID3 tags)
        let album = this.musicLibrary.albums.get(`${albumNorm}||${artistNorm}`);
        if (!album) {
            for (const a of this.musicLibrary.albums.values()) {
                if (a.name.toLowerCase() !== albumNorm) continue;
                const trackArtist = a.tracks.length > 0 ? (a.tracks[0].artist || '').toLowerCase() : '';
                if (a.artist.toLowerCase() === artistNorm || trackArtist === artistNorm) {
                    album = a;
                    break;
                }
            }
        }
        if (album) {
            if (metadata.albumArt) album.albumArt = metadata.albumArt;
            if (metadata.year) album.year = metadata.year;
            if (metadata.genre) album.genre = metadata.genre;
        }

        const artistKey = this.resolveArtistKey(artistName);
        const artist = this.musicLibrary.artists.get(artistKey);
        if (artist && metadata.albumArt && !artist.enrichedArt) {
            artist.albumArt = metadata.albumArt;
            artist.enrichedArt = true;
        }

        if (this.currentCategory === 'music' && this.currentView === 'content') {
            this.renderMusicSubContent();
        }
    }

    async applyCachedMetadata() {
        const result = await window.electronAPI.metadataCacheGetAll();
        if (!result.success || !result.data) return;

        for (const [cacheKey, metadata] of Object.entries(result.data)) {
            const [artistNorm, albumNorm] = cacheKey.split('|');
            for (const [albumKey, album] of this.musicLibrary.albums) {
                const matchesAlbum = album.name.toLowerCase().trim() === albumNorm;
                // album.artist comes from albumArtist tag, which may differ from track artist
                const albumArtistNorm = album.artist.toLowerCase().trim();
                const trackArtistNorm = album.tracks.length > 0 ? (album.tracks[0].artist || '').toLowerCase().trim() : '';
                const matchesArtist = albumArtistNorm === artistNorm || trackArtistNorm === artistNorm;
                if (matchesAlbum && matchesArtist) {
                    if (metadata.albumArt) album.albumArt = metadata.albumArt;
                    if (metadata.year) album.year = metadata.year;
                    if (metadata.genre) album.genre = metadata.genre;
                    break;
                }
            }
        }

        if (this.currentCategory === 'music' && this.currentView === 'content') {
            this.renderMusicSubContent();
        }
    }

    showContextMenu(e, file) {
        e.preventDefault();
        e.stopPropagation();
        this.selectedFile = file;

        const items = [
            { label: 'Open', action: () => this.handleContextMenuAction({ target: { dataset: { action: 'open' } } }) },
            { label: 'Show in Finder', action: () => this.handleContextMenuAction({ target: { dataset: { action: 'show-in-folder' } } }) },
        ];

        // Zune send option
        if (this.zunePanel && this.zunePanel.state === 'connected') {
            items.push({ label: 'Send to Zune', action: () => this.handleContextMenuAction({ target: { dataset: { action: 'send-to-zune' } } }) });
        }

        items.push({ separator: true });

        // Pin/Unpin
        const isPinned = this.pinnedItems.some(p => p.path === file.path);
        items.push({
            label: isPinned ? 'Unpin from sidebar' : 'Pin to sidebar',
            action: () => isPinned ? this.unpinItem(file.path) : this.pinItem(file),
        });

        items.push({ separator: true });
        items.push({ label: 'Delete', action: () => this.handleContextMenuAction({ target: { dataset: { action: 'delete' } } }) });

        this.showDynamicContextMenu(e, items);
    }

    showDynamicContextMenu(e, items) {
        e.preventDefault();
        e.stopPropagation();

        const menu = document.getElementById('context-menu');
        this.clearElement(menu);

        items.forEach(item => {
            if (item.separator) {
                const sep = document.createElement('div');
                sep.className = 'context-menu-separator';
                menu.appendChild(sep);
                return;
            }
            const btn = document.createElement('button');
            btn.className = 'context-menu-item';
            btn.textContent = item.label;
            btn.addEventListener('click', () => {
                item.action();
                this.hideContextMenu();
            });
            menu.appendChild(btn);
        });

        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;
        menu.style.display = 'block';

        // Adjust if off-screen
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) menu.style.left = `${e.clientX - rect.width}px`;
        if (rect.bottom > window.innerHeight) menu.style.top = `${e.clientY - rect.height}px`;
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
                    } else if (this.currentCategory === 'music') {
                        await this.scanFileSystem();
                        this.updateFileCounts();
                        // Re-scan music library after delete
                        this.musicLibrary.scanState = 'idle';
                        this.musicLibrary.tracks.clear();
                        this.renderMusicView();
                    } else if (this.currentCategory !== 'documents') {
                        await this.scanFileSystem();
                        this.updateFileCounts();
                        this.renderCategoryContent();
                    }
                    this.updateRecentFiles();
                }
                break;

            case 'send-to-zune':
                if (this.zunePanel) {
                    await window.electronAPI.zuneSendFiles([this.selectedFile.path]);
                }
                break;
        }
        
        this.hideContextMenu();
    }

    promptExtensionlessFix() {
        // Filter to only extensionless files that were successfully parsed as music
        const fixable = this.extensionlessFiles.filter(p => this.musicLibrary.tracks.has(p));
        if (fixable.length === 0) return;

        const toast = document.createElement('div');
        toast.className = 'extensionless-toast';

        const msg = document.createElement('span');
        msg.textContent = `${fixable.length} music file${fixable.length > 1 ? 's are' : ' is'} missing a file extension.`;
        toast.appendChild(msg);

        const fixBtn = document.createElement('button');
        fixBtn.className = 'ext-fix-btn';
        fixBtn.textContent = 'Fix';
        toast.appendChild(fixBtn);

        const dismissBtn = document.createElement('button');
        dismissBtn.className = 'ext-dismiss-btn';
        dismissBtn.textContent = 'Dismiss';
        toast.appendChild(dismissBtn);

        dismissBtn.addEventListener('click', () => {
            toast.remove();
        });

        fixBtn.addEventListener('click', async () => {
            fixBtn.disabled = true;
            fixBtn.textContent = 'Fixing...';
            const result = await window.electronAPI.fixExtensionlessFiles(fixable);
            if (result.success && result.renamed.length > 0) {
                // Update paths in categorizedFiles and music library
                for (const { oldPath, newPath } of result.renamed) {
                    const file = this.categorizedFiles.music.find(f => f.path === oldPath);
                    if (file) {
                        file.path = newPath;
                        file.extension = newPath.substring(newPath.lastIndexOf('.'));
                        file.name = newPath.split(/[/\\]/).pop();
                    }
                    const track = this.musicLibrary.tracks.get(oldPath);
                    if (track) {
                        this.musicLibrary.tracks.delete(oldPath);
                        track.path = newPath;
                        this.musicLibrary.tracks.set(newPath, track);
                    }
                }
                this.extensionlessFiles = [];
                this.rebuildMusicIndexes();
                if (this.currentCategory === 'music' && this.currentView === 'content') {
                    this.renderMusicSubContent();
                }
            }
            toast.remove();
        });

        document.body.appendChild(toast);
    }
}

// Initialize the Zune Explorer when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new ZuneExplorer();
});