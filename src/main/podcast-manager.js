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
}

module.exports = PodcastManager;
