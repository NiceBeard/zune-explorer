const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

class PodcastManager {
  constructor(userDataPath) {
    this._userDataPath = userDataPath;
    this._podcastDir = path.join(userDataPath, 'podcasts');
    this._episodesDir = path.join(this._podcastDir, 'episodes');
    this._artworkDir = path.join(this._podcastDir, 'artwork');
    this._subscriptionsPath = path.join(this._podcastDir, 'subscriptions.json');
    this._preferencesPath = path.join(this._podcastDir, 'preferences.json');

    this._xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    this._downloadQueue = [];
    this._activeDownloads = new Map();
    this._lastPlaybackState = null;

    this._subscriptions = [];
    this._preferences = {};

    // Ensure directories exist
    fs.mkdirSync(this._podcastDir, { recursive: true });
    fs.mkdirSync(this._episodesDir, { recursive: true });
    fs.mkdirSync(this._artworkDir, { recursive: true });

    // Load persisted data
    this._loadSubscriptions();
    this._loadPreferences();
  }

  // --- Persistence ---

  _loadSubscriptions() {
    try {
      const data = fs.readFileSync(this._subscriptionsPath, 'utf-8');
      this._subscriptions = JSON.parse(data);
    } catch {
      this._subscriptions = [];
    }
  }

  _saveSubscriptions() {
    fs.writeFileSync(this._subscriptionsPath, JSON.stringify(this._subscriptions, null, 2));
  }

  _loadEpisodes(subscriptionId) {
    try {
      const filePath = path.join(this._episodesDir, `${subscriptionId}.json`);
      const data = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  _saveEpisodes(subscriptionId, episodes) {
    const filePath = path.join(this._episodesDir, `${subscriptionId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(episodes, null, 2));
  }

  _loadPreferences() {
    try {
      const data = fs.readFileSync(this._preferencesPath, 'utf-8');
      this._preferences = JSON.parse(data);
    } catch {
      this._preferences = {};
    }
  }

  _savePreferences() {
    fs.writeFileSync(this._preferencesPath, JSON.stringify(this._preferences, null, 2));
  }

  // --- Public getters ---

  getSubscriptions() {
    return [...this._subscriptions];
  }

  getEpisodes(subscriptionId) {
    return this._loadEpisodes(subscriptionId);
  }

  getPreferences() {
    return { ...this._preferences };
  }

  // --- HTTP fetching ---

  _fetchUrl(url, _redirectCount = 0) {
    return new Promise((resolve, reject) => {
      if (_redirectCount >= 5) {
        return reject(new Error('Too many redirects'));
      }
      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, {
        headers: {
          'User-Agent': 'ZuneExplorer/1.4.0 (https://github.com/NiceBeard/zune-explorer)',
          'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        },
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          let redirectUrl = res.headers.location;
          if (redirectUrl.startsWith('/')) {
            const parsed = new URL(url);
            redirectUrl = `${parsed.protocol}//${parsed.host}${redirectUrl}`;
          }
          this._fetchUrl(redirectUrl, _redirectCount + 1).then(resolve, reject);
          return;
        }
        if (res.statusCode === 401 || res.statusCode === 403) {
          reject(new Error('This feed requires authentication'));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
    });
  }

  // --- RSS / Atom parsing ---

  _parseFeed(xml) {
    const parsed = this._xmlParser.parse(xml);

    // RSS 2.0
    if (parsed.rss && parsed.rss.channel) {
      return this._parseRSSChannel(parsed.rss.channel);
    }

    // Atom
    if (parsed.feed) {
      return this._parseAtomFeed(parsed.feed);
    }

    // Some feeds wrap <channel> without <rss>
    if (parsed.channel) {
      return this._parseRSSChannel(parsed.channel);
    }

    throw new Error("Feed isn't valid RSS — check the URL");
  }

  _parseRSSChannel(channel) {
    const itunesImage = channel['itunes:image'];
    let artworkUrl = null;
    if (itunesImage) {
      artworkUrl = typeof itunesImage === 'string' ? itunesImage : itunesImage['@_href'] || null;
    }
    if (!artworkUrl && channel.image) {
      artworkUrl = typeof channel.image === 'string' ? channel.image : channel.image.url || null;
    }

    const items = Array.isArray(channel.item)
      ? channel.item
      : channel.item ? [channel.item] : [];

    const episodes = items.map(item => this._parseRSSItem(item));

    return {
      title: channel.title || 'Untitled Podcast',
      author: channel['itunes:author'] || channel.author || channel.managingEditor || '',
      description: channel.description || channel['itunes:summary'] || '',
      artworkUrl,
      category: this._detectCategory(channel, episodes),
      episodes,
    };
  }

  _parseRSSItem(item) {
    const enclosure = item.enclosure || {};
    const enclosureUrl = enclosure['@_url'] || '';
    const enclosureType = enclosure['@_type'] || '';
    const enclosureSize = parseInt(enclosure['@_length'] || '0', 10) || 0;

    // Episode ID: guid → enclosure URL → UUID fallback
    let guid = item.guid;
    if (guid && typeof guid === 'object') {
      guid = guid['#text'] || guid['@_isPermaLink'] || null;
    }
    const id = guid || enclosureUrl || crypto.randomUUID();

    const publishDate = item.pubDate
      ? new Date(item.pubDate).toISOString()
      : null;

    const duration = this._parseDuration(
      item['itunes:duration'] || item.duration || null
    );

    // Description: prefer itunes:summary for cleaner text, fall back to description
    const description = item['itunes:summary'] || item.description || item['content:encoded'] || '';

    return {
      id,
      title: item.title || 'Untitled Episode',
      description: typeof description === 'string' ? description : '',
      publishDate,
      duration,
      enclosureUrl,
      enclosureType,
      enclosureSize,
      played: false,
      playbackPosition: 0,
      downloaded: false,
      localPath: null,
    };
  }

  _parseAtomFeed(feed) {
    let artworkUrl = null;
    const itunesImage = feed['itunes:image'];
    if (itunesImage) {
      artworkUrl = typeof itunesImage === 'string' ? itunesImage : itunesImage['@_href'] || null;
    }
    if (!artworkUrl && feed.logo) {
      artworkUrl = feed.logo;
    }
    if (!artworkUrl && feed.icon) {
      artworkUrl = feed.icon;
    }

    const entries = Array.isArray(feed.entry)
      ? feed.entry
      : feed.entry ? [feed.entry] : [];

    const episodes = entries.map(entry => {
      // Find enclosure link
      const links = Array.isArray(entry.link) ? entry.link : entry.link ? [entry.link] : [];
      const enclosureLink = links.find(l => l['@_rel'] === 'enclosure') || {};
      const enclosureUrl = enclosureLink['@_href'] || '';
      const enclosureType = enclosureLink['@_type'] || '';
      const enclosureSize = parseInt(enclosureLink['@_length'] || '0', 10) || 0;

      const id = entry.id || enclosureUrl || crypto.randomUUID();

      const publishDate = entry.published || entry.updated
        ? new Date(entry.published || entry.updated).toISOString()
        : null;

      const duration = this._parseDuration(
        entry['itunes:duration'] || null
      );

      const summary = entry.summary || entry.content || '';
      const description = typeof summary === 'object' ? (summary['#text'] || '') : summary;

      return {
        id,
        title: entry.title || 'Untitled Episode',
        description,
        publishDate,
        duration,
        enclosureUrl,
        enclosureType,
        enclosureSize,
        played: false,
        playbackPosition: 0,
        downloaded: false,
        localPath: null,
      };
    });

    const authorObj = feed.author;
    let author = '';
    if (authorObj) {
      author = typeof authorObj === 'string' ? authorObj : authorObj.name || '';
    }
    if (!author) {
      author = feed['itunes:author'] || '';
    }

    const feedTitle = typeof feed.title === 'object' ? (feed.title['#text'] || '') : (feed.title || 'Untitled Podcast');

    return {
      title: feedTitle,
      author,
      description: feed.subtitle || feed.summary || '',
      artworkUrl,
      category: this._detectCategory(feed, episodes),
      episodes,
    };
  }

  _detectCategory(channel, episodes) {
    // Check itunes:category
    const itunesCat = channel['itunes:category'];
    if (itunesCat) {
      const catText = typeof itunesCat === 'string'
        ? itunesCat
        : (Array.isArray(itunesCat) ? itunesCat[0] : itunesCat)?.['@_text'] || '';
      if (/video/i.test(catText)) return 'video';
    }

    // Check itunes:type or medium
    const itunesType = channel['itunes:type'] || '';
    if (/video/i.test(itunesType)) return 'video';

    // Check enclosure types of episodes
    if (episodes && episodes.length > 0) {
      const videoCount = episodes.filter(e => e.enclosureType && e.enclosureType.startsWith('video/')).length;
      if (videoCount > episodes.length / 2) return 'video';
    }

    return 'audio';
  }

  _parseDuration(raw) {
    if (raw == null) return 0;

    // Already a number (seconds)
    if (typeof raw === 'number') return Math.floor(raw);

    const str = String(raw).trim();
    if (!str) return 0;

    // Pure numeric string — seconds
    if (/^\d+$/.test(str)) return parseInt(str, 10);

    // HH:MM:SS or MM:SS
    const parts = str.split(':').map(Number);
    if (parts.length === 3) {
      return (parts[0] * 3600) + (parts[1] * 60) + Math.floor(parts[2]);
    }
    if (parts.length === 2) {
      return (parts[0] * 60) + Math.floor(parts[1]);
    }

    return 0;
  }

  // --- Artwork ---

  _fetchArtwork(subscriptionId, url) {
    return new Promise((resolve, reject) => {
      if (!url) return resolve(null);

      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, {
        headers: { 'User-Agent': 'ZuneExplorer/1.4.0' },
      }, (res) => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this._fetchArtwork(subscriptionId, res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          return resolve(null);
        }

        const contentType = res.headers['content-type'] || '';
        let ext = '.jpg';
        if (contentType.includes('png')) ext = '.png';
        else if (contentType.includes('webp')) ext = '.webp';
        else if (contentType.includes('gif')) ext = '.gif';

        const filename = `${subscriptionId}${ext}`;
        const filePath = path.join(this._artworkDir, filename);
        const writeStream = fs.createWriteStream(filePath);

        res.pipe(writeStream);
        writeStream.on('finish', () => resolve(`artwork/${filename}`));
        writeStream.on('error', () => resolve(null));
      });
      req.on('error', () => resolve(null));
      req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    });
  }

  // --- Subscribe / Unsubscribe ---

  async subscribe(feedUrl) {
    // Check for duplicate
    const existing = this._subscriptions.find(s => s.feedUrl === feedUrl);
    if (existing) {
      return existing;
    }

    const xml = await this._fetchUrl(feedUrl);
    const feed = this._parseFeed(xml);

    const subscriptionId = crypto.randomUUID();
    const artworkPath = await this._fetchArtwork(subscriptionId, feed.artworkUrl);

    const subscription = {
      id: subscriptionId,
      feedUrl,
      title: feed.title,
      author: feed.author,
      description: feed.description,
      artworkUrl: feed.artworkUrl,
      artworkPath,
      category: feed.category,
      episodeCount: feed.episodes.length,
      newEpisodeCount: feed.episodes.length,
      lastRefreshed: new Date().toISOString(),
      subscribedAt: new Date().toISOString(),
      error: null,
    };

    this._subscriptions.push(subscription);
    this._saveSubscriptions();
    this._saveEpisodes(subscriptionId, feed.episodes);

    return subscription;
  }

  unsubscribe(subscriptionId) {
    const index = this._subscriptions.findIndex(s => s.id === subscriptionId);
    if (index === -1) return;

    const sub = this._subscriptions[index];

    // Remove episode file
    const episodePath = path.join(this._episodesDir, `${subscriptionId}.json`);
    try { fs.unlinkSync(episodePath); } catch { /* ignore */ }

    // Remove artwork file
    if (sub.artworkPath) {
      const artworkFullPath = path.join(this._podcastDir, sub.artworkPath);
      try { fs.unlinkSync(artworkFullPath); } catch { /* ignore */ }
    }

    this._subscriptions.splice(index, 1);
    this._saveSubscriptions();
  }

  // --- Feed refresh ---

  async refresh(subscriptionId) {
    const sub = this._subscriptions.find(s => s.id === subscriptionId);
    if (!sub) throw new Error('Subscription not found');

    try {
      const xml = await this._fetchUrl(sub.feedUrl);
      const feed = this._parseFeed(xml);

      // Load existing episodes and build ID set
      const existingEpisodes = this._loadEpisodes(subscriptionId);
      const existingIds = new Set(existingEpisodes.map(e => e.id));

      // Find new episodes (not already stored)
      const newEpisodes = feed.episodes.filter(e => !existingIds.has(e.id));

      // Merge: new episodes first, then existing (preserves playback state)
      const merged = [...newEpisodes, ...existingEpisodes];

      // Update subscription metadata
      sub.title = feed.title;
      sub.author = feed.author;
      sub.description = feed.description;
      sub.episodeCount = merged.length;
      sub.newEpisodeCount = newEpisodes.length;
      sub.lastRefreshed = new Date().toISOString();
      sub.error = null;

      // Update artwork if changed
      if (feed.artworkUrl && feed.artworkUrl !== sub.artworkUrl) {
        const artworkPath = await this._fetchArtwork(subscriptionId, feed.artworkUrl);
        if (artworkPath) {
          sub.artworkUrl = feed.artworkUrl;
          sub.artworkPath = artworkPath;
        }
      }

      this._saveSubscriptions();
      this._saveEpisodes(subscriptionId, merged);

      return { subscriptionId, newEpisodeCount: newEpisodes.length };
    } catch (err) {
      sub.error = err.message;
      sub.lastRefreshed = new Date().toISOString();
      this._saveSubscriptions();
      return { subscriptionId, newEpisodeCount: 0, error: err.message };
    }
  }

  async refreshAll(webContents) {
    const subscriptions = [...this._subscriptions];
    const batchSize = 5;

    for (let i = 0; i < subscriptions.length; i += batchSize) {
      const batch = subscriptions.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(sub => this.refresh(sub.id))
      );

      // Emit results for each completed refresh
      for (const result of results) {
        if (result.status === 'fulfilled' && webContents && !webContents.isDestroyed()) {
          webContents.send('podcast-refresh-complete', result.value);
        }
      }
    }
  }

  // --- iTunes search ---

  async search(query) {
    const encoded = encodeURIComponent(query);
    const url = `https://itunes.apple.com/search?media=podcast&term=${encoded}&limit=25`;

    const body = await new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: { 'User-Agent': 'ZuneExplorer/1.4.0' },
      }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`iTunes API returned HTTP ${res.statusCode}`));
          return;
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
    });

    const data = JSON.parse(body);
    const results = (data.results || []).map(r => ({
      feedUrl: r.feedUrl || '',
      title: r.collectionName || r.trackName || '',
      author: r.artistName || '',
      artworkUrl: r.artworkUrl100 || r.artworkUrl60 || '',
      artworkBase64: null, // filled in below
      genre: r.primaryGenreName || '',
      trackCount: r.trackCount || 0,
    }));

    // Fetch artwork as base64 for CSP compliance (img-src doesn't allow https:)
    await Promise.allSettled(
      results.map(async (result) => {
        if (!result.artworkUrl) return;
        try {
          const imgData = await this._fetchBinaryUrl(result.artworkUrl);
          result.artworkBase64 = `data:${imgData.contentType};base64,${imgData.data.toString('base64')}`;
        } catch {
          // Leave artworkBase64 as null — renderer will use placeholder
        }
      })
    );

    return results.filter(r => r.feedUrl);
  }

  _fetchBinaryUrl(url) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, {
        headers: { 'User-Agent': 'ZuneExplorer/1.4.0' },
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this._fetchBinaryUrl(res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({
          data: Buffer.concat(chunks),
          contentType: res.headers['content-type'] || 'image/jpeg',
        }));
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timeout')); });
    });
  }

  // --- OPML import ---

  parseOPML(xml) {
    const parsed = this._xmlParser.parse(xml);

    const feedUrls = [];

    const extractOutlines = (outlines) => {
      if (!outlines) return;
      const list = Array.isArray(outlines) ? outlines : [outlines];
      for (const outline of list) {
        const xmlUrl = outline['@_xmlUrl'] || outline['@_xmlurl'] || outline['@_url'] || '';
        if (xmlUrl) {
          feedUrls.push(xmlUrl);
        }
        // Recurse into nested outlines (folder groupings)
        if (outline.outline) {
          extractOutlines(outline.outline);
        }
      }
    };

    if (parsed.opml && parsed.opml.body) {
      extractOutlines(parsed.opml.body.outline);
    }

    return feedUrls;
  }

  async importOPML(filePath, webContents) {
    const xml = fs.readFileSync(filePath, 'utf-8');
    const feedUrls = this.parseOPML(xml);

    if (feedUrls.length === 0) {
      throw new Error('No podcast feeds found in OPML file');
    }

    let processed = 0;
    const total = feedUrls.length;
    const batchSize = 5;

    for (let i = 0; i < feedUrls.length; i += batchSize) {
      const batch = feedUrls.slice(i, i + batchSize);
      await Promise.allSettled(
        batch.map(async (feedUrl) => {
          try {
            const sub = await this.subscribe(feedUrl);
            processed++;
            if (webContents && !webContents.isDestroyed()) {
              webContents.send('podcast-import-progress', {
                current: processed,
                total,
                title: sub.title,
              });
            }
          } catch {
            processed++;
            if (webContents && !webContents.isDestroyed()) {
              webContents.send('podcast-import-progress', {
                current: processed,
                total,
                title: feedUrl,
              });
            }
          }
        })
      );
    }

    return processed;
  }

  // --- Download manager ---

  _sanitizeFilename(name) {
    // Remove filesystem-unsafe characters
    return name
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .replace(/\s+/g, ' ')
      .trim() || 'untitled';
  }

  async pickDownloadDirectory(dialog) {
    const result = await dialog.showOpenDialog({
      title: 'Choose Podcast Download Directory',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: this._preferences.downloadDirectory || undefined,
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return null;
    }

    this._preferences.downloadDirectory = result.filePaths[0];
    this._savePreferences();
    return result.filePaths[0];
  }

  async downloadEpisode(subscriptionId, episodeId, webContents) {
    const sub = this._subscriptions.find(s => s.id === subscriptionId);
    if (!sub) throw new Error('Subscription not found');

    const episodes = this._loadEpisodes(subscriptionId);
    const episode = episodes.find(e => e.id === episodeId);
    if (!episode) throw new Error('Episode not found');
    if (!episode.enclosureUrl) throw new Error('No download URL for this episode');

    if (!this._preferences.downloadDirectory) {
      throw new Error('No download directory set');
    }

    // Build destination path: <downloadDir>/<podcast>/<episode>.<ext>
    const podcastDir = path.join(
      this._preferences.downloadDirectory,
      this._sanitizeFilename(sub.title)
    );
    fs.mkdirSync(podcastDir, { recursive: true });

    // Determine file extension from enclosure type or URL
    let ext = '.mp3';
    if (episode.enclosureType) {
      const typeMap = {
        'audio/mpeg': '.mp3',
        'audio/mp3': '.mp3',
        'audio/mp4': '.m4a',
        'audio/x-m4a': '.m4a',
        'audio/aac': '.aac',
        'audio/ogg': '.ogg',
        'audio/wav': '.wav',
        'audio/flac': '.flac',
        'video/mp4': '.mp4',
        'video/x-m4v': '.m4v',
        'video/quicktime': '.mov',
      };
      ext = typeMap[episode.enclosureType] || ext;
    } else {
      // Try to extract from URL path (before query string)
      try {
        const urlPath = new URL(episode.enclosureUrl).pathname;
        const urlExt = path.extname(urlPath);
        if (urlExt) ext = urlExt;
      } catch { /* use default */ }
    }

    const sanitizedTitle = this._sanitizeFilename(episode.title);
    let filename = `${sanitizedTitle}${ext}`;
    const finalPath = path.join(podcastDir, filename);

    // Handle filename collision: append publish date
    if (fs.existsSync(finalPath)) {
      const dateStr = episode.publishDate
        ? new Date(episode.publishDate).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10);
      filename = `${sanitizedTitle} (${dateStr})${ext}`;
    }

    const destPath = path.join(podcastDir, filename);
    const partialPath = `${destPath}.partial`;

    return new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(partialPath);
      const client = episode.enclosureUrl.startsWith('https') ? https : http;

      const req = client.get(episode.enclosureUrl, {
        headers: { 'User-Agent': 'ZuneExplorer/1.4.0' },
      }, (res) => {
        // Follow redirects — destroy outer req cleanly, then re-download
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); // drain the response so the socket is released
          writeStream.close();
          try { fs.unlinkSync(partialPath); } catch { /* ignore */ }
          req.removeAllListeners('error');
          const redirectUrl = res.headers.location;
          episode.enclosureUrl = redirectUrl;
          this._saveEpisodes(subscriptionId, this._loadEpisodes(subscriptionId).map(e =>
            e.id === episodeId ? { ...e, enclosureUrl: redirectUrl } : e
          ));
          this.downloadEpisode(subscriptionId, episodeId, webContents).then(resolve, reject);
          return;
        }

        if (res.statusCode !== 200) {
          writeStream.close();
          try { fs.unlinkSync(partialPath); } catch { /* ignore */ }
          const err = new Error(`Download failed: HTTP ${res.statusCode}`);
          if (webContents && !webContents.isDestroyed()) {
            webContents.send('podcast-download-error', { episodeId, error: err.message });
          }
          reject(err);
          return;
        }

        const bytesTotal = parseInt(res.headers['content-length'] || '0', 10);
        let bytesDownloaded = 0;

        // Store active download for cancellation
        this._activeDownloads.set(episodeId, { req, writeStream, partialPath });

        res.on('data', (chunk) => {
          bytesDownloaded += chunk.length;
          if (webContents && !webContents.isDestroyed()) {
            const percent = bytesTotal > 0 ? Math.round((bytesDownloaded / bytesTotal) * 100) : 0;
            webContents.send('podcast-download-progress', {
              episodeId,
              percent,
              bytesDownloaded,
              bytesTotal,
            });
          }
        });

        res.pipe(writeStream);

        writeStream.on('finish', () => {
          this._activeDownloads.delete(episodeId);

          // Rename from .partial to final
          try {
            fs.renameSync(partialPath, destPath);
          } catch (err) {
            try { fs.unlinkSync(partialPath); } catch { /* ignore */ }
            if (webContents && !webContents.isDestroyed()) {
              webContents.send('podcast-download-error', { episodeId, error: err.message });
            }
            reject(err);
            return;
          }

          // Update episode record
          episode.downloaded = true;
          episode.localPath = destPath;
          this._saveEpisodes(subscriptionId, episodes);

          if (webContents && !webContents.isDestroyed()) {
            webContents.send('podcast-download-complete', { episodeId, localPath: destPath });
          }
          resolve(destPath);
        });

        writeStream.on('error', (err) => {
          this._activeDownloads.delete(episodeId);
          try { fs.unlinkSync(partialPath); } catch { /* ignore */ }
          const message = err.code === 'ENOSPC' ? 'Not enough disk space' : err.message;
          if (webContents && !webContents.isDestroyed()) {
            webContents.send('podcast-download-error', { episodeId, error: message });
          }
          reject(new Error(message));
        });
      });

      req.on('error', (err) => {
        this._activeDownloads.delete(episodeId);
        writeStream.close();
        try { fs.unlinkSync(partialPath); } catch { /* ignore */ }
        if (webContents && !webContents.isDestroyed()) {
          webContents.send('podcast-download-error', { episodeId, error: err.message });
        }
        reject(err);
      });

      req.setTimeout(30000, () => {
        req.destroy();
        // error handler above will clean up
      });
    });
  }

  cancelDownload(episodeId) {
    const active = this._activeDownloads.get(episodeId);
    if (!active) return;

    const { req, writeStream, partialPath } = active;
    req.destroy();
    writeStream.close();
    try { fs.unlinkSync(partialPath); } catch { /* ignore */ }
    this._activeDownloads.delete(episodeId);
  }

  deleteDownload(subscriptionId, episodeId) {
    const episodes = this._loadEpisodes(subscriptionId);
    const episode = episodes.find(e => e.id === episodeId);
    if (!episode) return;

    if (episode.localPath) {
      try { fs.unlinkSync(episode.localPath); } catch { /* ignore */ }
    }

    episode.downloaded = false;
    episode.localPath = null;
    this._saveEpisodes(subscriptionId, episodes);
  }

  // --- Playback position tracking ---

  savePlaybackPosition(subscriptionId, episodeId, position) {
    const episodes = this._loadEpisodes(subscriptionId);
    const episode = episodes.find(e => e.id === episodeId);
    if (!episode) return;

    episode.playbackPosition = position;
    this._saveEpisodes(subscriptionId, episodes);

    this._lastPlaybackState = { subscriptionId, episodeId, position };
  }

  markPlayed(subscriptionId, episodeId, played) {
    const episodes = this._loadEpisodes(subscriptionId);
    const episode = episodes.find(e => e.id === episodeId);
    if (!episode) return;

    episode.played = played;
    if (played) {
      episode.playbackPosition = 0;
    }
    this._saveEpisodes(subscriptionId, episodes);

    // Update subscription newEpisodeCount
    const sub = this._subscriptions.find(s => s.id === subscriptionId);
    if (sub) {
      // Decrement/increment newEpisodeCount based on the change
      // (newEpisodeCount tracks newly-added episodes from refresh, not total unplayed)
      if (played && sub.newEpisodeCount > 0) {
        sub.newEpisodeCount--;
      }
      this._saveSubscriptions();
    }
  }

  persistLastPlaybackState() {
    if (!this._lastPlaybackState) return;
    const { subscriptionId, episodeId, position } = this._lastPlaybackState;
    this.savePlaybackPosition(subscriptionId, episodeId, position);
  }

  cleanupPartialDownloads() {
    const downloadDir = this._preferences.downloadDirectory;
    if (!downloadDir) return;

    try {
      if (!fs.existsSync(downloadDir)) return;
    } catch {
      return;
    }

    const walkAndClean = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkAndClean(fullPath);
        } else if (entry.name.endsWith('.partial')) {
          try { fs.unlinkSync(fullPath); } catch { /* ignore */ }
        }
      }
    };

    walkAndClean(downloadDir);
  }
}

module.exports = PodcastManager;
