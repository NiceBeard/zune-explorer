/* global VirtualScroller */

class PodcastPanel {
  constructor(explorer) {
    this.explorer = explorer;
    this.subscriptions = [];
    this.currentSubTab = 'audio'; // 'audio' or 'video'
    this.currentSubscription = null; // drill-down state
    this.episodes = [];
    this._episodeScroller = null;
    this._downloadProgressHandlers = {};
    this._lastPositionSave = 0; // throttle timestamp
    this._positionThrottleMs = 15000;
    this._lastPlayingPodcast = null;
    this._listenersRegistered = false;
  }

  async render() {
    const contentPanel = document.getElementById('content-panel');

    // Fetch subscriptions
    this.subscriptions = await window.electronAPI.podcastGetSubscriptions();
    this._updateCount();

    if (this.currentSubscription) {
      this._renderEpisodeView(contentPanel);
    } else {
      this._renderSubscriptionList(contentPanel);
    }

    // Register AudioPlayer event listeners (guarded, only runs once)
    this._registerEventListeners();

    // Auto-refresh if stale (>15 min)
    this._autoRefreshIfStale();
  }

  _updateCount() {
    const el = document.getElementById('podcasts-count');
    if (el) el.textContent = this.subscriptions.length || '';
  }

  async _autoRefreshIfStale() {
    const fifteenMin = 15 * 60 * 1000;
    const stale = this.subscriptions.some(s =>
      !s.lastRefreshed || (Date.now() - new Date(s.lastRefreshed).getTime()) > fifteenMin
    );
    if (stale && this.subscriptions.length > 0) {
      try {
        await window.electronAPI.podcastRefresh();
        this.subscriptions = await window.electronAPI.podcastGetSubscriptions();
        if (!this.currentSubscription) {
          const contentPanel = document.getElementById('content-panel');
          this._renderSubscriptionList(contentPanel);
        }
      } catch (e) {
        console.error('Auto-refresh failed:', e);
      }
    }
  }

  _renderSubscriptionList(container) {
    const filtered = this.subscriptions.filter(s => s.category === this.currentSubTab);
    const fileDisplay = document.getElementById('file-display');

    // Build subscription list HTML
    let html = '<div class="podcast-view">';
    html += '<div class="hero-header">podcasts</div>';
    html += '<div class="podcast-content" style="position: relative; z-index: 1; margin-top: 130px;">';

    // Sub-tabs
    html += '<div class="podcast-sub-tabs">';
    html += '<span class="podcast-tab ' + (this.currentSubTab === 'audio' ? 'active' : '') + '" data-tab="audio">AUDIO</span>';
    html += '<span class="podcast-tab ' + (this.currentSubTab === 'video' ? 'active' : '') + '" data-tab="video">VIDEO</span>';
    html += '<span class="podcast-actions">';
    html += '<span class="podcast-action-link podcast-add-btn">+ add</span>';
    html += '<span class="podcast-action-link podcast-refresh-all">&#x21bb; refresh all</span>';
    html += '</span>';
    html += '</div>';

    // Subscription rows
    if (filtered.length === 0) {
      html += '<div class="podcast-empty">';
      html += '<p>no ' + this.currentSubTab + ' podcasts yet</p>';
      html += '<p class="podcast-empty-hint">tap + add to subscribe to a podcast</p>';
      html += '</div>';
    } else {
      html += '<div class="podcast-subscription-list">';
      for (const sub of filtered) {
        html += this._renderSubscriptionRow(sub);
      }
      html += '</div>';
    }

    html += '</div></div>';

    fileDisplay.innerHTML = html;

    this._bindSubscriptionEvents(fileDisplay);
  }

  _renderSubscriptionRow(sub) {
    const artSrc = sub.artworkPath
      ? 'file://' + this.explorer.userDataPath + '/podcasts/' + sub.artworkPath
      : '';

    let html = '<div class="podcast-row" data-sub-id="' + sub.id + '">';

    // Artwork
    html += '<div class="podcast-row-art">';
    if (artSrc) {
      html += '<img src="' + artSrc + '" alt="" class="podcast-art-img">';
    } else {
      html += '<div class="podcast-art-placeholder">&#127911;</div>';
    }
    if (sub.newEpisodeCount > 0) {
      html += '<span class="podcast-badge">' + sub.newEpisodeCount + '</span>';
    }
    html += '</div>';

    // Info
    html += '<div class="podcast-row-info">';
    html += '<div class="podcast-row-title">' + this._escapeHtml(sub.title) + '</div>';
    html += '<div class="podcast-row-author">' + this._escapeHtml(sub.author) + '</div>';
    html += '<div class="podcast-row-meta">' + sub.episodeCount + ' episodes</div>';
    if (sub.error) {
      html += '<div class="podcast-row-error">' + this._escapeHtml(sub.error) + '</div>';
    }
    html += '</div>';

    html += '</div>';
    return html;
  }

  _bindSubscriptionEvents(container) {
    // Tab switching
    container.querySelectorAll('.podcast-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        this.currentSubTab = tab.dataset.tab;
        this.render();
      });
    });

    // Row click - drill down
    container.querySelectorAll('.podcast-row').forEach(row => {
      row.addEventListener('click', () => {
        this.explorer.pushNavState();
        const subId = row.dataset.subId;
        this.currentSubscription = this.subscriptions.find(s => s.id === subId);
        this.render();
      });

      // Context menu
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const subId = row.dataset.subId;
        const sub = this.subscriptions.find(s => s.id === subId);
        this.explorer.showDynamicContextMenu(e, [
          { label: 'Refresh', action: () => this._refreshSingle(subId) },
          { label: 'Pin to sidebar', action: () => this.explorer.pinMusicItem('podcast', { subscriptionId: sub.id, title: sub.title, artworkPath: sub.artworkPath }) },
          { separator: true },
          { label: 'Unsubscribe', action: () => this._unsubscribe(subId) },
        ]);
      });
    });

    // Add button
    const addBtn = container.querySelector('.podcast-add-btn');
    if (addBtn) addBtn.addEventListener('click', () => this._showAddModal());

    // Refresh all
    const refreshAll = container.querySelector('.podcast-refresh-all');
    if (refreshAll) refreshAll.addEventListener('click', () => this._refreshAll());
  }

  // ========================================
  // Episode Drill-Down
  // ========================================

  async _renderEpisodeView(container) {
    const sub = this.currentSubscription;
    this.episodes = await window.electronAPI.podcastGetEpisodes(sub.id);

    const fileDisplay = document.getElementById('file-display');

    let html = '<div class="podcast-view podcast-episode-view">';
    html += '<div class="hero-header">podcasts</div>';
    html += '<div class="podcast-content" style="position: relative; z-index: 1; margin-top: 130px;">';

    // Header with artwork
    html += '<div class="podcast-episode-header">';
    if (sub.artworkPath) {
      html += '<img class="podcast-episode-art" src="file://' + this.explorer.userDataPath + '/podcasts/' + sub.artworkPath + '">';
    }
    html += '<div class="podcast-episode-header-info">';
    html += '<div class="podcast-episode-title">' + this._escapeHtml(sub.title) + '</div>';
    html += '<div class="podcast-episode-meta">' + this._escapeHtml(sub.author) + ' &middot; ' + this.episodes.length + ' episodes &middot; <span class="podcast-action-link podcast-refresh-single">&#x21bb; refresh</span></div>';
    html += '</div>';
    html += '</div>';

    // Episode list container (VirtualScroller will populate)
    html += '<div class="podcast-episode-list" id="podcast-episode-list"></div>';

    html += '</div></div>';
    fileDisplay.innerHTML = html;

    // Bind events
    const refreshSingle = fileDisplay.querySelector('.podcast-refresh-single');
    if (refreshSingle) {
      refreshSingle.addEventListener('click', () => {
        this._refreshSingle(sub.id);
      });
    }

    // Render episode list with VirtualScroller
    this._renderEpisodeList();
  }

  _renderEpisodeList() {
    const listEl = document.getElementById('podcast-episode-list');
    if (!listEl) return;

    if (this._episodeScroller) {
      this._episodeScroller.destroy();
      this._episodeScroller = null;
    }

    const self = this;
    this._episodeScroller = new VirtualScroller({
      container: listEl,
      rowTypes: {
        episode: { height: 56, className: 'podcast-ep-row' },
      },
      renderRow: function(el, index, entry) {
        while (el.firstChild) el.removeChild(el.firstChild);
        self._populateEpisodeRow(el, entry.data, index);
      },
    });

    const entries = this.episodes.map(ep => ({ type: 'episode', data: ep }));
    this._episodeScroller.setData(entries);
  }

  _populateEpisodeRow(row, episode, index) {
    row.dataset.episodeId = episode.id;
    row.dataset.index = index;
    if (index % 2 === 0) {
      row.classList.add('even');
    } else {
      row.classList.remove('even');
    }

    // Status dot
    let dotHtml = '';
    if (!episode.played && episode.playbackPosition === 0) {
      dotHtml = '<div class="podcast-dot new"></div>';
    } else if (!episode.played && episode.playbackPosition > 0) {
      dotHtml = '<div class="podcast-dot in-progress"></div>';
    } else {
      dotHtml = '<div class="podcast-dot played"></div>';
    }

    // Duration formatting
    const duration = this._formatDuration(episode.duration);
    const played = episode.played;

    // Progress info for in-progress episodes
    let progressHtml = '';
    if (!episode.played && episode.playbackPosition > 0 && episode.duration > 0) {
      const remaining = episode.duration - episode.playbackPosition;
      const pct = Math.round((episode.playbackPosition / episode.duration) * 100);
      progressHtml = ' &middot; <span class="podcast-ep-remaining">' + this._formatDuration(remaining) + ' left</span>';
      progressHtml += '<div class="podcast-ep-progress"><div class="podcast-ep-progress-bar" style="width: ' + pct + '%"></div></div>';
    }

    // Action buttons
    let actionHtml = '';
    if (episode.downloaded) {
      actionHtml = '<span class="podcast-ep-action downloaded ' + (played ? 'dim' : '') + '">&#10003; downloaded</span>';
    } else {
      actionHtml = '<span class="podcast-ep-action stream" data-action="stream">&#9654; stream</span>';
      actionHtml += '<span class="podcast-ep-action download" data-action="download">&#8615; download</span>';
    }

    // Publish date
    const pubDate = episode.publishDate ? new Date(episode.publishDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';

    row.innerHTML = dotHtml +
      '<div class="podcast-ep-info ' + (played ? 'played' : '') + '">' +
        '<div class="podcast-ep-title">' + this._escapeHtml(episode.title) + '</div>' +
        '<div class="podcast-ep-meta">' + pubDate + ' &middot; ' + duration + progressHtml + '</div>' +
      '</div>' +
      '<div class="podcast-ep-actions">' + actionHtml + '</div>';

    // Event: click title to play
    const titleEl = row.querySelector('.podcast-ep-title');
    if (titleEl) {
      titleEl.addEventListener('click', () => this._playEpisode(episode));
    }

    // Event: stream button
    const streamBtn = row.querySelector('[data-action="stream"]');
    if (streamBtn) {
      streamBtn.addEventListener('click', (e) => { e.stopPropagation(); this._playEpisode(episode); });
    }

    // Event: download button
    const downloadBtn = row.querySelector('[data-action="download"]');
    if (downloadBtn) {
      downloadBtn.addEventListener('click', (e) => { e.stopPropagation(); this._downloadEpisode(episode); });
    }

    // Context menu
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this._showEpisodeContextMenu(e, episode);
    });
  }

  _formatDuration(seconds) {
    if (!seconds || seconds <= 0) return '';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return h + 'h ' + m.toString().padStart(2, '0') + 'm';
    return m + 'm';
  }

  // ========================================
  // Playback Integration
  // ========================================

  _playEpisode(episode) {
    const sub = this.currentSubscription;
    const queueEntry = {
      isPodcast: true,
      id: episode.id,
      title: episode.title,
      podcastName: sub.title,
      artworkPath: sub.artworkPath
        ? this.explorer.userDataPath + '/podcasts/' + sub.artworkPath
        : null,
      duration: episode.duration,
      enclosureUrl: episode.enclosureUrl,
      enclosureType: episode.enclosureType,
      localPath: episode.localPath,
      subscriptionId: sub.id,
      playbackPosition: episode.playbackPosition || 0,
    };

    this.explorer.audioPlayer.play(queueEntry, [queueEntry]);
  }

  _registerEventListeners() {
    // Guard: only register once (called from render(), not per-view)
    if (this._listenersRegistered) return;
    this._listenersRegistered = true;

    // Playback position saving (throttled)
    this._timeupdateHandler = (data) => {
      const currentFile = this.explorer.audioPlayer.getCurrentFile();
      if (!currentFile || !currentFile.isPodcast) return;

      const now = Date.now();
      if (now - this._lastPositionSave >= this._positionThrottleMs) {
        this._lastPositionSave = now;
        window.electronAPI.podcastSavePlaybackPosition(
          currentFile.subscriptionId,
          currentFile.id,
          data.currentTime
        );
      }
    };
    this.explorer.audioPlayer.on('timeupdate', this._timeupdateHandler);

    // Pause - save position immediately
    this._pauseHandler = () => {
      const currentFile = this.explorer.audioPlayer.getCurrentFile();
      if (!currentFile || !currentFile.isPodcast) return;
      window.electronAPI.podcastSavePlaybackPosition(
        currentFile.subscriptionId,
        currentFile.id,
        this.explorer.audioPlayer.audio.currentTime
      );
    };
    this.explorer.audioPlayer.on('pause', this._pauseHandler);

    // Track change - detect episode completion
    this._trackchangeHandler = ({ file }) => {
      // Check if previous track was a podcast that just ended
      const prev = this._lastPlayingPodcast;
      if (prev && prev.isPodcast && (!file || file.id !== prev.id)) {
        // Previous podcast episode ended
        window.electronAPI.podcastMarkPlayed(prev.subscriptionId, prev.id, true);
      }
      this._lastPlayingPodcast = (file && file.isPodcast) ? file : null;
    };
    this.explorer.audioPlayer.on('trackchange', this._trackchangeHandler);

    // Download events
    this._dlProgressHandler = window.electronAPI.onPodcastDownloadProgress((data) => {
      this._updateDownloadProgress(data);
    });
    this._dlCompleteHandler = window.electronAPI.onPodcastDownloadComplete((data) => {
      this._onDownloadComplete(data);
    });
    this._dlErrorHandler = window.electronAPI.onPodcastDownloadError((data) => {
      this.explorer.showToast('Download failed: ' + data.error);
    });
  }

  _updateDownloadProgress(data) {
    const row = document.querySelector('[data-episode-id="' + data.episodeId + '"] .podcast-ep-actions');
    if (row) {
      row.innerHTML = '<span class="podcast-ep-action downloading">' + data.percent + '%</span>';
    }
  }

  _onDownloadComplete(data) {
    // Update local episode data
    const ep = this.episodes.find(e => e.id === data.episodeId);
    if (ep) {
      ep.downloaded = true;
      ep.localPath = data.localPath;
    }
    // Re-render episode list
    this._renderEpisodeList();
  }

  // ========================================
  // Download & Action Methods
  // ========================================

  async _downloadEpisode(episode) {
    const sub = this.currentSubscription;
    // Check if download directory is set
    var prefs = await window.electronAPI.podcastGetPreferences();
    if (!prefs.downloadDirectory) {
      var dir = await window.electronAPI.podcastPickDownloadDirectory();
      if (!dir) return; // cancelled
    }
    try {
      await window.electronAPI.podcastDownloadEpisode(sub.id, episode.id);
    } catch (e) {
      this.explorer.showToast('Download failed: ' + e.message);
    }
  }

  async _refreshSingle(subscriptionId) {
    try {
      await window.electronAPI.podcastRefresh(subscriptionId);
      this.subscriptions = await window.electronAPI.podcastGetSubscriptions();
      if (this.currentSubscription && this.currentSubscription.id === subscriptionId) {
        this.currentSubscription = this.subscriptions.find(s => s.id === subscriptionId);
        this.episodes = await window.electronAPI.podcastGetEpisodes(subscriptionId);
        this._renderEpisodeList();
      }
      this._updateCount();
      this.explorer.showToast('Feed refreshed');
    } catch (e) {
      this.explorer.showToast('Refresh failed: ' + e.message);
    }
  }

  async _refreshAll() {
    this.explorer.showToast('Refreshing all feeds...');
    try {
      await window.electronAPI.podcastRefresh();
      this.subscriptions = await window.electronAPI.podcastGetSubscriptions();
      this._updateCount();
      this.render();
      this.explorer.showToast('All feeds refreshed');
    } catch (e) {
      this.explorer.showToast('Refresh failed: ' + e.message);
    }
  }

  async _unsubscribe(subscriptionId) {
    const sub = this.subscriptions.find(s => s.id === subscriptionId);
    const confirmed = await this.explorer.showConfirmModal(
      'Unsubscribe',
      'Remove "' + (sub ? sub.title : 'this podcast') + '" from your subscriptions?'
    );
    if (!confirmed) return;
    await window.electronAPI.podcastUnsubscribe(subscriptionId);
    this.subscriptions = await window.electronAPI.podcastGetSubscriptions();
    this._updateCount();
    if (this.currentSubscription && this.currentSubscription.id === subscriptionId) {
      this.currentSubscription = null;
    }
    this.render();
  }

  _showEpisodeContextMenu(e, episode) {
    const items = [];
    if (!episode.downloaded) {
      items.push({ label: 'Stream', action: () => this._playEpisode(episode) });
      items.push({ label: 'Download', action: () => this._downloadEpisode(episode) });
    } else {
      items.push({ label: 'Play', action: () => this._playEpisode(episode) });
      items.push({ label: 'Delete download', action: () => this._deleteDownload(episode) });
    }
    items.push({ separator: true });
    items.push({
      label: episode.played ? 'Mark as unplayed' : 'Mark as played',
      action: () => this._togglePlayed(episode),
    });
    items.push({
      label: 'Add to Now Playing',
      action: () => this._addToNowPlaying(episode),
    });
    this.explorer.showDynamicContextMenu(e, items);
  }

  async _deleteDownload(episode) {
    const sub = this.currentSubscription;
    await window.electronAPI.podcastDeleteDownload(sub.id, episode.id);
    episode.downloaded = false;
    episode.localPath = null;
    this._renderEpisodeList();
  }

  async _togglePlayed(episode) {
    const sub = this.currentSubscription;
    const newState = !episode.played;
    await window.electronAPI.podcastMarkPlayed(sub.id, episode.id, newState);
    episode.played = newState;
    if (newState) episode.playbackPosition = 0;
    this._renderEpisodeList();
    // Update subscription count
    this.subscriptions = await window.electronAPI.podcastGetSubscriptions();
    this._updateCount();
  }

  _addToNowPlaying(episode) {
    const sub = this.currentSubscription;
    const queueEntry = {
      isPodcast: true,
      id: episode.id,
      title: episode.title,
      podcastName: sub.title,
      artworkPath: sub.artworkPath
        ? this.explorer.userDataPath + '/podcasts/' + sub.artworkPath
        : null,
      duration: episode.duration,
      enclosureUrl: episode.enclosureUrl,
      enclosureType: episode.enclosureType,
      localPath: episode.localPath,
      subscriptionId: sub.id,
      playbackPosition: episode.playbackPosition || 0,
    };
    this.explorer.audioPlayer.queue.push(queueEntry);
    this.explorer.showToast('Added to Now Playing');
  }

  // ========================================
  // Add / Subscribe Modal
  // ========================================

  _showAddModal() {
    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.className = 'zune-prompt-overlay';
    overlay.style.display = 'flex';

    const box = document.createElement('div');
    box.className = 'zune-prompt-box podcast-add-modal';

    let boxHtml = '<div class="podcast-add-tabs">';
    boxHtml += '<span class="podcast-add-tab active" data-mode="search">search</span>';
    boxHtml += '<span class="podcast-add-tab" data-mode="rss">rss url</span>';
    boxHtml += '<span class="podcast-add-tab" data-mode="opml">import opml</span>';
    boxHtml += '</div>';
    boxHtml += '<div class="podcast-add-body">';
    boxHtml += '<div class="podcast-add-search active" data-panel="search">';
    boxHtml += '<input type="text" class="zune-prompt-input" placeholder="search for podcasts..." id="podcast-search-input">';
    boxHtml += '<div class="podcast-search-results" id="podcast-search-results"></div>';
    boxHtml += '</div>';
    boxHtml += '<div class="podcast-add-search" data-panel="rss" style="display:none">';
    boxHtml += '<input type="text" class="zune-prompt-input" placeholder="paste RSS feed URL..." id="podcast-rss-input">';
    boxHtml += '<div class="podcast-add-actions">';
    boxHtml += '<button class="zune-prompt-btn" id="podcast-rss-submit">subscribe</button>';
    boxHtml += '</div>';
    boxHtml += '</div>';
    boxHtml += '<div class="podcast-add-search" data-panel="opml" style="display:none">';
    boxHtml += '<p class="podcast-opml-hint">Import subscriptions from an OPML file exported from another podcast app.</p>';
    boxHtml += '<button class="zune-prompt-btn" id="podcast-opml-pick">choose file...</button>';
    boxHtml += '<div class="podcast-opml-progress" id="podcast-opml-progress" style="display:none"></div>';
    boxHtml += '</div>';
    boxHtml += '</div>';

    box.innerHTML = boxHtml;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // Close on click outside — refresh list in case subscriptions were added
    overlay.addEventListener('click', async (e) => {
      if (e.target === overlay) {
        overlay.remove();
        this.subscriptions = await window.electronAPI.podcastGetSubscriptions();
        this._updateCount();
        this.render();
      }
    });

    // Tab switching
    box.querySelectorAll('.podcast-add-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        box.querySelectorAll('.podcast-add-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        box.querySelectorAll('[data-panel]').forEach(p => { p.style.display = 'none'; });
        var panel = box.querySelector('[data-panel="' + tab.dataset.mode + '"]');
        if (panel) panel.style.display = '';
      });
    });

    // Search with debounce
    var searchTimeout;
    const searchInput = box.querySelector('#podcast-search-input');
    const resultsDiv = box.querySelector('#podcast-search-results');
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => this._doSearch(searchInput.value, resultsDiv, overlay), 500);
    });
    searchInput.focus();

    // RSS subscribe
    const rssInput = box.querySelector('#podcast-rss-input');
    const rssSubmit = box.querySelector('#podcast-rss-submit');
    rssSubmit.addEventListener('click', async () => {
      const url = rssInput.value.trim();
      if (!url) return;
      try {
        await window.electronAPI.podcastSubscribe(url);
        overlay.remove();
        this.subscriptions = await window.electronAPI.podcastGetSubscriptions();
        this._updateCount();
        this.render();
        this.explorer.showToast('Subscribed!');
      } catch (e) {
        this.explorer.showToast(e.message || "Couldn't subscribe");
      }
    });
    rssInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') rssSubmit.click();
    });

    // OPML import
    box.querySelector('#podcast-opml-pick').addEventListener('click', async () => {
      const filePath = await window.electronAPI.podcastPickOpmlFile();
      if (!filePath) return;
      const progressDiv = box.querySelector('#podcast-opml-progress');
      progressDiv.style.display = '';
      progressDiv.textContent = 'Importing...';

      const progressHandler = window.electronAPI.onPodcastImportProgress((data) => {
        progressDiv.textContent = 'Importing ' + data.current + ' of ' + data.total + '...';
      });

      try {
        const result = await window.electronAPI.podcastImportOpml(filePath);
        window.electronAPI.offPodcastImportProgress(progressHandler);
        overlay.remove();
        this.subscriptions = await window.electronAPI.podcastGetSubscriptions();
        this._updateCount();
        this.render();
        this.explorer.showToast('Imported ' + result.imported + ' podcasts');
      } catch (e) {
        window.electronAPI.offPodcastImportProgress(progressHandler);
        progressDiv.textContent = 'Import failed: ' + e.message;
      }
    });

    // Escape to close
    const escHandler = async (e) => {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', escHandler);
        this.subscriptions = await window.electronAPI.podcastGetSubscriptions();
        this._updateCount();
        this.render();
      }
    };
    document.addEventListener('keydown', escHandler);
  }

  async _doSearch(query, resultsDiv, overlay) {
    if (!query || query.length < 2) {
      resultsDiv.innerHTML = '';
      return;
    }
    resultsDiv.innerHTML = '<div class="podcast-search-loading">Searching...</div>';

    try {
      const results = await window.electronAPI.podcastSearch(query);
      if (results.length === 0) {
        resultsDiv.innerHTML = '<div class="podcast-search-empty">No results found</div>';
        return;
      }

      resultsDiv.innerHTML = '';
      for (const r of results) {
        const resultEl = document.createElement('div');
        resultEl.className = 'podcast-search-result';

        const artHtml = r.artworkBase64
          ? '<img src="' + r.artworkBase64 + '" class="podcast-search-art">'
          : '<div class="podcast-art-placeholder small">&#127911;</div>';

        const alreadySubbed = this.subscriptions.some(s => s.feedUrl === r.feedUrl);

        let resultHtml = artHtml;
        resultHtml += '<div class="podcast-search-info">';
        resultHtml += '<div class="podcast-search-title">' + this._escapeHtml(r.title) + '</div>';
        resultHtml += '<div class="podcast-search-author">' + this._escapeHtml(r.author) + '</div>';
        resultHtml += '</div>';
        resultHtml += '<button class="zune-prompt-btn podcast-subscribe-btn"' + (alreadySubbed ? ' disabled' : '') + '>';
        resultHtml += alreadySubbed ? 'subscribed' : 'subscribe';
        resultHtml += '</button>';

        resultEl.innerHTML = resultHtml;

        if (!alreadySubbed) {
          resultEl.querySelector('.podcast-subscribe-btn').addEventListener('click', async () => {
            const btn = resultEl.querySelector('.podcast-subscribe-btn');
            btn.disabled = true;
            btn.textContent = '...';
            try {
              await window.electronAPI.podcastSubscribe(r.feedUrl);
              btn.textContent = 'subscribed';
              this.subscriptions = await window.electronAPI.podcastGetSubscriptions();
              this._updateCount();
            } catch (e) {
              btn.disabled = false;
              btn.textContent = 'subscribe';
              this.explorer.showToast(e.message || "Couldn't subscribe");
            }
          });
        }

        resultsDiv.appendChild(resultEl);
      }
    } catch (e) {
      resultsDiv.innerHTML = '<div class="podcast-search-empty">Search failed: ' + this._escapeHtml(e.message) + '</div>';
    }
  }

  _escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
