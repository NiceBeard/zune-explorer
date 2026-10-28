/**
 * Podcast push to a Zune, following the Zune Desktop sequence documented by
 * XuneSyncLibrary (pcap-derived) and confirmed on a Zune HD:
 *
 *   Series/<show>.ser       format 0xBA0B (schema 0x0f) — the show
 *   Podcasts/<show>/<ep>    MP3/WMA, MetaGenre 64 (schema 0x10) — the episodes,
 *                           linked to the show by the SeriesHandle property
 *
 * Bookkeeping is ours, not Xune's: shows and episodes already on the device are
 * found through ZMDB (shows can't be listed over MTP), so pushing twice never
 * creates duplicates, and objects created for a failed push are removed again.
 */

const path = require('path');
const fs = require('fs/promises');
const { ObjectFormat, ObjectProperty, MetaGenre } = require('./mtp-constants.js');
const { ZMDBParser } = require('./zmdb-parser.js');
const {
  findDeviceShow,
  findDeviceEpisode,
  zuneSafeName,
  formatDateAuthored,
} = require('../../shared/podcast-matching.js');

const ROOT_PARENT = 0xFFFFFFFF; // GetObjectHandles parent meaning "storage root"
const NATIVE_FORMATS = { '.mp3': ObjectFormat.MP3, '.wma': ObjectFormat.WMA };

const EPISODE_DESCRIPTOR_PROPS = [
  ObjectProperty.URLSource, ObjectProperty.ObjectFileName, ObjectProperty.TimeBookmark,
  ObjectProperty.SeriesName, ObjectProperty.PodcastDA9B, ObjectProperty.MetaGenre,
  ObjectProperty.SeriesHandle, ObjectProperty.Name, ObjectProperty.Duration,
  ObjectProperty.Artist, ObjectProperty.DateAuthored, ObjectProperty.Description,
];
const SERIES_DESCRIPTOR_PROPS = [
  ObjectProperty.IsPodcast, ObjectProperty.PodcastDA9D, ObjectProperty.Artist,
  ObjectProperty.ObjectFileName, ObjectProperty.URLSource,
];

class PodcastDeviceSync {
  /**
   * @param {object} ctx
   * @param {MtpProtocol} ctx.mtp
   * @param {number} ctx.storageId
   * @param {boolean} ctx.isHD
   * @param {(event: object) => void} ctx.emitProgress  transfer-progress payloads
   * @param {(inputPath: string) => Promise<string>} ctx.convertToMp3
   */
  constructor({ mtp, storageId, isHD, emitProgress, convertToMp3 }) {
    this.mtp = mtp;
    this.storageId = storageId;
    this.isHD = isHD;
    this.emitProgress = emitProgress;
    this.convertToMp3 = convertToMp3;
    this.tempFiles = [];
  }

  async readLibrary() {
    const data = await this.mtp.readZMDB();
    const library = new ZMDBParser(data, this.isHD ? 'hd' : 'classic').parse();
    return { shows: library.podcastShows, episodes: library.podcastEpisodes };
  }

  /**
   * @param {Array<object>} episodes  { localPath, title, description, publishDate,
   *   enclosureUrl, duration (s), playbackPosition (s), subscriptionId, episodeId,
   *   subscriptionTitle, feedUrl, author }
   * @param {() => boolean} isCancelled
   * @returns {{ sent, skipped, failed, errors, newDeviceEpisodes }}
   */
  async push(episodes, isCancelled = () => false) {
    const result = { sent: 0, skipped: 0, failed: 0, errors: [], newDeviceEpisodes: [] };
    const totalFiles = episodes.length;
    let fileIndex = 0;

    try {
      await this._preUpload();
      const library = await this.readLibrary();

      for (const group of groupBySubscription(episodes)) {
        if (isCancelled()) break;
        try {
          await this._pushShow(group, library, result, {
            isCancelled,
            totalFiles,
            nextIndex: () => fileIndex++,
          });
        } catch (err) {
          // Show-level failure: every episode not yet handled in this group fails
          for (const ep of group.episodes.filter(e => !e._handled)) {
            result.failed++;
            result.errors.push({ file: ep.localPath, title: ep.title, error: err.message });
            fileIndex++;
          }
          console.log(`PodcastSync: show "${group.title}" failed: ${err.message}`);
        }
      }
    } finally {
      await this._finalize();
      for (const tmp of this.tempFiles) fs.unlink(tmp).catch(() => {});
    }

    return result;
  }

  /** Write an episode's resume position (TimeBookmark, ms). */
  async setBookmark(handle, positionMs) {
    await this.mtp.setObjectPropUint32(handle, ObjectProperty.TimeBookmark, Math.max(0, Math.round(positionMs)));
  }

  // ---- show level ----

  async _pushShow(group, library, result, progress) {
    const created = []; // rollback list for this show: { handle, what }
    let sentForShow = 0;

    try {
      const { show, matchedBy, duplicates } = findDeviceShow(library.shows, library.episodes, {
        feedUrl: group.feedUrl,
        title: group.title,
      });
      if (duplicates.length) {
        console.log(`PodcastSync: ${duplicates.length + 1} device shows match "${group.title}"; using 0x${show.atomId.toString(16)}`);
      }

      let seriesHandle = show ? show.atomId : 0;
      let showEpisodes = show ? library.episodes.filter(e => e.showAtomId === show.atomId) : [];
      let episodeFolder = showEpisodes.length ? showEpisodes[0].folderRef : 0;
      if (show) console.log(`PodcastSync: reusing show 0x${seriesHandle.toString(16)} "${show.name}" (matched by ${matchedBy})`);

      if (!seriesHandle) {
        seriesHandle = await this._createSeries(group, created);
        library.shows.push({ atomId: seriesHandle, name: group.title, feedUrl: group.feedUrl });
      }

      await this.mtp.registerTrackContext(group.title);
      await this._rootReEnum();

      if (!episodeFolder) {
        episodeFolder = await this._findOrCreateEpisodeFolder(group.title, created);
      }

      await this._queryDescriptors(group.episodes[0]);

      for (const ep of group.episodes) {
        if (progress.isCancelled()) break;
        const index = progress.nextIndex();
        ep._handled = true;

        const existing = findDeviceEpisode(showEpisodes, { url: ep.enclosureUrl, title: ep.title });
        if (existing) {
          console.log(`PodcastSync: skipping "${ep.title}" — already on device as 0x${existing.atomId.toString(16)}`);
          result.skipped++;
          continue;
        }

        try {
          const device = await this._pushEpisode(ep, { seriesHandle, episodeFolder, group, index, totalFiles: progress.totalFiles });
          result.sent++;
          sentForShow++;
          result.newDeviceEpisodes.push(device);
          showEpisodes.push({ atomId: device.handle, title: device.title, url: device.url, showAtomId: seriesHandle });
          library.episodes.push({ atomId: device.handle, showAtomId: seriesHandle });
        } catch (err) {
          result.failed++;
          result.errors.push({ file: ep.localPath, title: ep.title, error: err.message });
          console.log(`PodcastSync: episode "${ep.title}" failed: ${err.message}`);
        }
      }
    } catch (err) {
      await this._rollback(created);
      throw err;
    }

    // Don't leave a brand-new show behind with nothing in it
    if (sentForShow === 0 && created.length) {
      await this._rollback(created);
    }
  }

  async _createSeries(group, created) {
    const seriesFolder = await this._findOrCreateRootFolder('Series', created);

    for (const prop of SERIES_DESCRIPTOR_PROPS) {
      try { await this.mtp.getObjectPropDesc(prop, ObjectFormat.PodcastSeries); } catch (_) { /* priming only */ }
    }

    const handle = await this.mtp.sendObjectPropList(this.storageId, seriesFolder, ObjectFormat.PodcastSeries, 0, [
      { code: ObjectProperty.IsPodcast, type: 'uint8', value: 1 },
      { code: ObjectProperty.PodcastDA9D, type: 'uint32', value: 1 },
      { code: ObjectProperty.Artist, type: 'string', value: group.author || '' },
      { code: ObjectProperty.ObjectFileName, type: 'string', value: `${zuneSafeName(group.title)}.ser` },
      { code: ObjectProperty.URLSource, type: 'auint16', value: group.feedUrl || '' },
      { code: ObjectProperty.Name, type: 'string', value: group.title },
    ]);
    if (!handle) throw new Error('device returned no handle for the podcast show');
    created.push({ handle, what: 'show' });
    await this.mtp.sendObject(Buffer.alloc(0));
    console.log(`PodcastSync: created show 0x${handle.toString(16)} "${group.title}"`);

    if (group.artworkPath) await this._setSeriesArtwork(handle, group.artworkPath);
    return handle;
  }

  async _setSeriesArtwork(handle, artworkPath) {
    // Same properties as album art; the Zune expects JPEG
    if (!/\.jpe?g$/i.test(artworkPath)) return;
    try {
      const art = await fs.readFile(artworkPath);
      await this.mtp.setObjectPropArray(handle, ObjectProperty.RepresentativeSampleData, art);
      await this.mtp.setObjectPropUint16(handle, ObjectProperty.RepresentativeSampleFormat, ObjectFormat.JPEG);
    } catch (err) {
      console.log(`PodcastSync: show artwork not set: ${err.message}`);
    }
  }

  // ---- episode level ----

  async _pushEpisode(ep, { seriesHandle, episodeFolder, group, index, totalFiles }) {
    let sendPath = ep.localPath;
    let ext = path.extname(sendPath).toLowerCase();
    if (!NATIVE_FORMATS[ext]) {
      this.emitProgress({ state: 'converting', fileName: ep.title, fileIndex: index, totalFiles });
      sendPath = await this.convertToMp3(sendPath);
      this.tempFiles.push(sendPath);
      ext = '.mp3';
    }

    const fileData = await fs.readFile(sendPath);
    const durationMs = Math.round((ep.duration || 0) * 1000);
    const positionMs = Math.round((ep.playbackPosition || 0) * 1000);

    this.emitProgress({ state: 'sending', fileName: ep.title, fileIndex: index, totalFiles, bytesTransferred: 0, totalBytes: fileData.length });

    const handle = await this.mtp.sendObjectPropList(this.storageId, episodeFolder, NATIVE_FORMATS[ext], fileData.length, [
      { code: ObjectProperty.URLSource, type: 'auint16', value: ep.enclosureUrl || '' },
      { code: ObjectProperty.ObjectFileName, type: 'string', value: `${zuneSafeName(ep.title)}${ext}` },
      { code: ObjectProperty.TimeBookmark, type: 'uint32', value: 0 },
      { code: ObjectProperty.SeriesName, type: 'string', value: group.title },
      { code: ObjectProperty.PodcastDA9B, type: 'uint8', value: 0 },
      { code: ObjectProperty.MetaGenre, type: 'uint16', value: MetaGenre.AudioPodcast },
      { code: ObjectProperty.SeriesHandle, type: 'uint32', value: seriesHandle },
      { code: ObjectProperty.Name, type: 'string', value: ep.title },
      { code: ObjectProperty.Duration, type: 'uint32', value: durationMs },
      { code: ObjectProperty.Artist, type: 'string', value: group.author || group.title },
      { code: ObjectProperty.DateAuthored, type: 'string', value: formatDateAuthored(ep.publishDate || new Date()) },
      { code: ObjectProperty.Description, type: 'auint16', value: stripHtml(ep.description) },
    ]);
    if (!handle) throw new Error('device returned no handle for the episode');

    try {
      await this.mtp.sendObject(fileData, (sent, total) => {
        this.emitProgress({ state: 'sending', fileName: ep.title, fileIndex: index, totalFiles, bytesTransferred: sent, totalBytes: total });
      });

      const info = await this.mtp.getObjectInfo(handle);
      if (info.compressedSize !== fileData.length) {
        throw new Error(`device stored ${info.compressedSize} of ${fileData.length} bytes`);
      }
      if (positionMs > 0) await this.setBookmark(handle, positionMs);
    } catch (err) {
      try { await this.mtp.deleteObject(handle); } catch (_) { /* best effort */ }
      throw err;
    }

    console.log(`PodcastSync: sent "${ep.title}" as 0x${handle.toString(16)}`);
    return {
      handle,
      title: ep.title,
      seriesName: group.title,
      seriesHandle,
      url: ep.enclosureUrl || '',
      duration: durationMs,
      bookmarkMs: positionMs,
      size: fileData.length,
      format: NATIVE_FORMATS[ext],
      filename: `${zuneSafeName(ep.title)}${ext}`,
      releaseDate: ep.publishDate || null,
    };
  }

  // ---- folders ----

  async _listChildren(parent) {
    const handles = await this.mtp.getObjectHandles(this.storageId, 0, parent);
    const children = [];
    for (const handle of handles) {
      try {
        const info = await this.mtp.getObjectInfo(handle);
        children.push({ handle, ...info });
      } catch (_) { /* skip unreadable entries */ }
    }
    return children;
  }

  async _findFolder(parent, name) {
    const children = await this._listChildren(parent);
    const folder = children.find(c => c.objectFormat === ObjectFormat.Association && c.filename === name);
    return folder ? folder.handle : 0;
  }

  async _createFolder(parent, name, created) {
    const handle = await this.mtp.sendObjectPropList(this.storageId, parent, ObjectFormat.Association, 0, [
      { code: ObjectProperty.ObjectFileName, type: 'string', value: name },
    ]);
    if (!handle) throw new Error(`device returned no handle for folder "${name}"`);
    created.push({ handle, what: `folder ${name}` });
    return handle;
  }

  async _findOrCreateRootFolder(name, created) {
    return (await this._findFolder(ROOT_PARENT, name)) || this._createFolder(0, name, created);
  }

  async _findOrCreateEpisodeFolder(title, created) {
    const podcasts = await this._findOrCreateRootFolder('Podcasts', created);
    const name = zuneSafeName(title);
    return (await this._findFolder(podcasts, name)) || this._createFolder(podcasts, name, created);
  }

  // ---- session framing (Zune Desktop order) ----

  async _preUpload() {
    for (let i = 0; i < 2; i++) {
      try { await this.mtp.getDevicePropValue(0xD217); } catch (_) { /* optional */ }
    }
    try { await this.mtp.syncDeviceDB(1); } catch (err) {
      console.log(`PodcastSync: SyncDeviceDB failed (continuing): ${err.message}`);
    }
  }

  async _rootReEnum() {
    try { await this.mtp.getObjectPropList(0, 0, ObjectProperty.StorageID, 0, 1); } catch (_) { /* priming only */ }
    try { await this.mtp.getObjectPropList(0, 0, ObjectProperty.ObjectFileName, 0, 1); } catch (_) { /* priming only */ }
  }

  async _queryDescriptors(firstEpisode) {
    const ext = path.extname(firstEpisode.localPath).toLowerCase();
    const format = NATIVE_FORMATS[ext] || ObjectFormat.MP3;
    for (const prop of EPISODE_DESCRIPTOR_PROPS) {
      try { await this.mtp.getObjectPropDesc(prop, format); } catch (_) { /* priming only */ }
    }
  }

  async _finalize() {
    try { await this.mtp.disableTrustedFiles(); } catch (_) { /* optional */ }
    try { await this.mtp.syncDeviceDB(1); } catch (_) { /* optional */ }
  }

  async _rollback(created) {
    for (const { handle, what } of [...created].reverse()) {
      try {
        await this.mtp.deleteObject(handle);
        console.log(`PodcastSync: rolled back ${what} 0x${handle.toString(16)}`);
      } catch (err) {
        console.log(`PodcastSync: could not roll back ${what} 0x${handle.toString(16)}: ${err.message}`);
      }
    }
    created.length = 0;
  }
}

function groupBySubscription(episodes) {
  const groups = new Map();
  for (const ep of episodes) {
    const key = ep.subscriptionId || ep.feedUrl || ep.subscriptionTitle;
    if (!groups.has(key)) {
      groups.set(key, {
        title: ep.subscriptionTitle || 'Podcast',
        feedUrl: ep.feedUrl || '',
        author: ep.author || '',
        artworkPath: ep.artworkPath || null,
        episodes: [],
      });
    }
    groups.get(key).episodes.push(ep);
  }
  return [...groups.values()];
}

function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

module.exports = { PodcastDeviceSync, groupBySubscription };
