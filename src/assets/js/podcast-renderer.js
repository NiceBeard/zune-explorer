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

  _escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
