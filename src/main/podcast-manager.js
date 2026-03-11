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
      if (_redirectCount > 5) {
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
}

module.exports = PodcastManager;
