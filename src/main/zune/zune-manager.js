const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const ffmpegPath = require('ffmpeg-static');

const { UsbTransport, ZUNE_VENDOR_ID, ZUNE_DEVICES } = require('./usb-transport.js');
const { MtpProtocol } = require('./mtp-protocol.js');
const { MtpzAuth } = require('./mtpz-auth.js');
const { ExtensionToFormat, ObjectFormat, ObjectProperty } = require('./mtp-constants.js');
const { ZMDBParser } = require('./zmdb-parser.js');

// Audio formats the Zune can play natively
const ZUNE_NATIVE_AUDIO = new Set(['.mp3', '.wma', '.aac', '.m4a']);
// Audio formats we can convert to AAC for the Zune
const CONVERTIBLE_AUDIO = new Set(['.wav', '.flac', '.ogg', '.alac', '.aiff', '.aif']);

class ZuneManager extends EventEmitter {
  constructor() {
    super();
    this.transport = new UsbTransport();
    this.mtp = null;
    this.auth = null;
    this.connected = false;
    this.deviceInfo = null;
    this.storageInfo = null;
    this.storageId = null;
    this.transferring = false;
    this.cancelRequested = false;
    this.currentStatus = null;
    this.productId = null;
  }

  async start() {
    this.transport.onAttach((info) => this._handleAttach(info));
    this.transport.onDetach(() => this._handleDetach());
    this.transport.startHotplugDetection();

    const existing = await this.transport.findZune();

    if (existing) {
      this._handleAttach(existing);
    } else if (process.platform === 'win32') {
      const needsDriver = await this.transport.detectMissingDriver();
      if (needsDriver) {
        this.currentStatus = { state: 'driver-needed' };
        this.emit('status', this.currentStatus);
      }
    }
  }

  stop() {
    this.transport.stopHotplugDetection();
    this.disconnect();
  }

  async _handleAttach(info) {
    this.productId = info.productId;
    const model = ZUNE_DEVICES[info.productId] || 'Unknown Zune';
    this.currentStatus = { state: 'connecting', model, productId: info.productId };
    this.emit('status', this.currentStatus);

    try {
      // Use libusb device directly if available (hotplug), otherwise requestDevice (startup)
      if (info.libusbDevice) {
        // Device may not be ready immediately after hotplug — retry with delay
        let lastErr;
        for (let attempt = 1; attempt <= 5; attempt++) {
          try {
            await new Promise(r => setTimeout(r, attempt * 500));
            await this.transport.openFromLibusb(info.libusbDevice);
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            console.log(`ZuneManager: hotplug open attempt ${attempt}/5 failed: ${err.message}`);
          }
        }
        if (lastErr) throw lastErr;
      } else {
        await this.transport.open(ZUNE_VENDOR_ID, info.productId);
      }
      console.log('ZuneManager: USB device opened, starting MTP...');

      this.mtp = new MtpProtocol(this.transport);
      await this.mtp.openSession(1);
      console.log('ZuneManager: MTP session opened');

      this.auth = new MtpzAuth(this.mtp);
      await this.auth.authenticate();
      console.log('ZuneManager: MTPZ authentication complete');

      this.deviceInfo = await this.mtp.getDeviceInfo();

      const storageIDs = await this.mtp.getStorageIDs();
      console.log(`ZuneManager: storage IDs: [${storageIDs.map(id => '0x' + id.toString(16)).join(', ')}]`);
      this.storageId = storageIDs[0];

      this.storageInfo = await this.mtp.getStorageInfo(this.storageId);

      this.connected = true;
      this.currentStatus = {
        state: 'connected',
        model,
        productId: info.productId,
        storage: this.storageInfo,
      };
      this.emit('status', this.currentStatus);
    } catch (err) {
      console.error('ZuneManager: connection failed:', err);
      this.currentStatus = { state: 'error', error: err.message };
      this.emit('status', this.currentStatus);
      this.disconnect();
    }
  }

  _handleDetach() {
    this.cancelRequested = true;
    this.disconnect();
    this.currentStatus = { state: 'disconnected' };
    this.emit('status', this.currentStatus);
  }

  async disconnect() {
    if (this.mtp) {
      try {
        await this.mtp.closeSession();
      } catch {
        // Device may already be disconnected
      }
    }
    this.connected = false;
    this.mtp = null;
    this.auth = null;
    this.storageId = null;
    this.deviceInfo = null;
    this.storageInfo = null;
    await this.transport.close();
  }

  getCurrentStatus() {
    return this.currentStatus;
  }

  getDeviceInfo() {
    if (!this.connected) {
      return null;
    }

    return { ...this.deviceInfo, storage: this.storageInfo };
  }

  async _convertForZune(inputPath) {
    const baseName = path.basename(inputPath, path.extname(inputPath));
    const outputPath = path.join(os.tmpdir(), `zune-${Date.now()}-${baseName}.mp3`);

    await execFileAsync(ffmpegPath, [
      '-i', inputPath,
      '-c:a', 'libmp3lame',
      '-b:a', '320k',
      '-ar', '44100',
      '-ac', '2',
      '-map_metadata', '0',
      '-id3v2_version', '3',
      '-y',
      outputPath,
    ]);

    return outputPath;
  }

  async _retagToId3v23(inputPath) {
    const baseName = path.basename(inputPath, path.extname(inputPath));
    const outputPath = path.join(os.tmpdir(), `zune-${Date.now()}-${baseName}.mp3`);

    await execFileAsync(ffmpegPath, [
      '-i', inputPath,
      '-c', 'copy',
      '-map_metadata', '0',
      '-id3v2_version', '3',
      '-write_id3v1', '1',
      '-y',
      outputPath,
    ]);

    return outputPath;
  }

  async _readMetadata(filePath) {
    try {
      const { parseFile } = await import('music-metadata');
      const metadata = await parseFile(filePath);
      const result = {
        title: metadata.common.title || null,
        artist: metadata.common.artist || null,
        album: metadata.common.album || null,
        albumArtist: metadata.common.albumartist || null,
        genre: metadata.common.genre ? metadata.common.genre[0] : null,
        track: metadata.common.track ? metadata.common.track.no : null,
        duration: metadata.format.duration
          ? Math.round(metadata.format.duration * 1000)
          : null,
        year: metadata.common.year ? String(metadata.common.year) : null,
        albumArt: null,
      };
      // Extract embedded album art (first picture)
      if (metadata.common.picture && metadata.common.picture.length > 0) {
        const pic = metadata.common.picture[0];
        result.albumArt = {
          data: pic.data, // raw Buffer
          format: pic.format, // e.g. 'image/jpeg'
        };
      }
      console.log(`ZuneManager: read metadata: title="${result.title}" artist="${result.artist}" album="${result.album}"`);
      return result;
    } catch (err) {
      console.log(`ZuneManager: _readMetadata failed: ${err.message}`);
      return {};
    }
  }

  async _setObjectMetadata(objectHandle, metadata) {
    const props = [
      [ObjectProperty.Name, metadata.title, 'string'],
      [ObjectProperty.Artist, metadata.artist, 'string'],
      [ObjectProperty.AlbumName, metadata.album, 'string'],
      [ObjectProperty.AlbumArtist, metadata.albumArtist, 'string'],
      [ObjectProperty.Genre, metadata.genre, 'string'],
      [ObjectProperty.OriginalDate, metadata.year, 'string'],
      [ObjectProperty.Track, metadata.track, 'uint16'],
      [ObjectProperty.Duration, metadata.duration, 'uint32'],
    ];

    for (const [propCode, value, type] of props) {
      if (value == null) continue;
      try {
        if (type === 'string') {
          await this.mtp.setObjectPropString(objectHandle, propCode, String(value));
        } else if (type === 'uint32') {
          await this.mtp.setObjectPropUint32(objectHandle, propCode, value >>> 0);
        } else if (type === 'uint16') {
          await this.mtp.setObjectPropUint16(objectHandle, propCode, value & 0xFFFF);
        }
      } catch (err) {
        console.log(`ZuneManager: could not set property 0x${propCode.toString(16)}: ${err.message}`);
      }
    }
  }

  async sendFiles(filePaths) {
    if (!this.connected) {
      throw new Error('No Zune device connected');
    }

    if (this.transferring) {
      throw new Error('A transfer is already in progress');
    }

    this.transferring = true;
    this.cancelRequested = false;

    const totalFiles = filePaths.length;
    let completedFiles = 0;
    const tempFiles = [];

    // Track sent files by album so we can create album objects afterward
    // Key: "artist|||album", Value: { artist, albumArtist, album, genre, trackHandles[] }
    const albumMap = new Map();

    try {
      for (const filePath of filePaths) {
        if (this.cancelRequested) {
          this.emit('transfer-progress', {
            state: 'cancelled',
            completedFiles,
            totalFiles,
          });
          break;
        }

        const ext = path.extname(filePath).toLowerCase();
        let sendPath = filePath;
        let needsConvert = CONVERTIBLE_AUDIO.has(ext);

        // Read metadata from the original file before any conversion
        const metadata = await this._readMetadata(filePath);

        // Enrich with cached MusicBrainz metadata
        if (this.metadataCache && metadata.artist && metadata.album) {
          const cached = await this.metadataCache.get(metadata.artist, metadata.album);
          if (cached) {
            if (cached.genre && !metadata.genre) metadata.genre = cached.genre;
            if (cached.year && !metadata.year) metadata.year = String(cached.year);
            if (cached.albumArt && !metadata.albumArt) {
              const base64Match = cached.albumArt.match(/^data:([^;]+);base64,(.+)$/);
              if (base64Match) {
                metadata.albumArt = {
                  data: Buffer.from(base64Match[2], 'base64'),
                  format: base64Match[1],
                };
              }
            }
          }
        }

        if (needsConvert) {
          const fileName = path.basename(filePath);
          this.emit('transfer-progress', {
            state: 'converting',
            fileName,
            fileIndex: completedFiles,
            totalFiles,
          });

          console.log(`ZuneManager: converting ${fileName} to MP3 320k`);
          sendPath = await this._convertForZune(filePath);
          tempFiles.push(sendPath);
        } else if (ext === '.mp3') {
          // Retag MP3s to ID3v2.3 — the Zune can't read ID3v2.4 tags
          // and will show "Unknown Artist" / "Unknown Album" otherwise.
          // This is a stream copy (no re-encoding), so it's fast.
          try {
            console.log(`ZuneManager: retagging ${path.basename(filePath)} to ID3v2.3`);
            const retagged = await this._retagToId3v23(filePath);
            sendPath = retagged;
            tempFiles.push(retagged);
          } catch (err) {
            console.log(`ZuneManager: retag failed, sending original: ${err.message}`);
          }
        }

        const sendExt = path.extname(sendPath).toLowerCase();
        const objectFormat = ExtensionToFormat[sendExt] || ObjectFormat.Undefined;
        const sendName = path.basename(filePath, ext) + (needsConvert ? '.mp3' : path.extname(filePath));
        const fileData = await fs.readFile(sendPath);
        const totalBytes = fileData.length;

        this.emit('transfer-progress', {
          state: 'sending',
          fileName: sendName,
          fileIndex: completedFiles,
          totalFiles,
          bytesTransferred: 0,
          totalBytes,
        });

        const { objectHandle } = await this.mtp.sendObjectInfo(this.storageId, 0, {
          objectFormat,
          compressedSize: totalBytes,
          filename: sendName,
        });

        await this.mtp.sendObject(fileData, (sent, total) => {
          this.emit('transfer-progress', {
            state: 'sending',
            fileName: sendName,
            fileIndex: completedFiles,
            totalFiles,
            bytesTransferred: sent,
            totalBytes: total,
          });
        });

        // Set metadata via MTP object properties
        if (objectHandle) {
          console.log(`ZuneManager: setting metadata for handle ${objectHandle}`);
          await this._setObjectMetadata(objectHandle, metadata);

          // Group this track by album for abstract album creation
          const isAudio = ZUNE_NATIVE_AUDIO.has(ext) || CONVERTIBLE_AUDIO.has(ext);
          if (isAudio && metadata.album) {
            const artist = metadata.artist || 'Unknown Artist';
            const key = `${artist}|||${metadata.album}`;
            if (!albumMap.has(key)) {
              albumMap.set(key, {
                artist,
                albumArtist: metadata.albumArtist || artist,
                album: metadata.album,
                genre: metadata.genre || null,
                albumArt: metadata.albumArt || null,
                trackHandles: [],
              });
            }
            const entry = albumMap.get(key);
            entry.trackHandles.push(objectHandle);
            // Use the first available album art we find
            if (!entry.albumArt && metadata.albumArt) {
              entry.albumArt = metadata.albumArt;
            }
          }
        }

        completedFiles++;
      }

      // Create abstract audio album objects and link tracks to them.
      // The Zune requires these to display artist/album metadata in its UI.
      if (albumMap.size > 0 && this.connected && !this.cancelRequested) {
        await this._createAlbumObjects(albumMap);
      }

      if (this.connected) {
        this.storageInfo = await this.mtp.getStorageInfo(this.storageId);
      }

      if (!this.cancelRequested) {
        this.emit('transfer-progress', {
          state: 'complete',
          completedFiles,
          totalFiles,
          storage: this.storageInfo,
        });
      }
    } catch (err) {
      this.emit('transfer-progress', {
        state: 'error',
        error: err.message,
        completedFiles,
        totalFiles,
      });
    } finally {
      this.transferring = false;
      for (const tmp of tempFiles) {
        fs.unlink(tmp).catch(() => {});
      }
    }
  }

  async _createAlbumObjects(albumMap) {
    // First, create Artist objects for each unique artist.
    // The Zune uses Artist objects (format 0xB218) to manage artist metadata.
    // Albums and tracks link to artists via ArtistId (0xDAB9) property.
    const artistHandles = new Map(); // artist name -> object handle

    for (const [, albumInfo] of albumMap) {
      const artistName = albumInfo.artist;
      if (artistHandles.has(artistName)) continue;

      try {
        const artistFilename = `${artistName}.art`;
        console.log(`ZuneManager: creating artist object "${artistName}"`);

        const { objectHandle: artistHandle } = await this.mtp.sendObjectInfo(this.storageId, 0, {
          objectFormat: ObjectFormat.Artist,
          compressedSize: 0,
          filename: artistFilename,
        });

        // Send empty object data to complete the handshake
        await this.mtp.sendObject(Buffer.alloc(0));

        // Set the artist name
        try {
          await this.mtp.setObjectPropString(artistHandle, ObjectProperty.Name, artistName);
        } catch (err) {
          console.log(`ZuneManager: could not set artist Name: ${err.message}`);
        }

        artistHandles.set(artistName, artistHandle);
        console.log(`ZuneManager: artist object created (handle=${artistHandle})`);
      } catch (err) {
        console.log(`ZuneManager: failed to create artist object for "${artistName}": ${err.message}`);
      }
    }

    // Now create album objects and link them to artists and tracks
    for (const [key, albumInfo] of albumMap) {
      try {
        const { artist, album, genre, albumArt, trackHandles } = albumInfo;
        const albumFilename = `${artist}--${album}.alb`;
        const artistHandle = artistHandles.get(artist);

        console.log(`ZuneManager: creating album "${album}" by "${artist}" (${trackHandles.length} tracks)`);

        // Create the AbstractAudioAlbum object
        const { objectHandle: albumHandle } = await this.mtp.sendObjectInfo(this.storageId, 0, {
          objectFormat: ObjectFormat.AbstractAudioAlbum,
          compressedSize: 0,
          filename: albumFilename,
        });

        // Send empty object data to complete the handshake
        await this.mtp.sendObject(Buffer.alloc(0));

        console.log(`ZuneManager: album object created (handle=${albumHandle}), setting properties`);

        // Set album name
        try {
          await this.mtp.setObjectPropString(albumHandle, ObjectProperty.Name, album);
        } catch (err) {
          console.log(`ZuneManager: could not set album Name: ${err.message}`);
        }

        // Set artist string (may be ignored, but try it)
        try {
          await this.mtp.setObjectPropString(albumHandle, ObjectProperty.Artist, artist);
        } catch (err) {
          console.log(`ZuneManager: could not set album Artist: ${err.message}`);
        }

        // Link album to artist via ArtistId
        if (artistHandle) {
          try {
            await this.mtp.setObjectPropUint32(albumHandle, ObjectProperty.ArtistId, artistHandle);
            console.log(`ZuneManager: linked album to artist (artistHandle=${artistHandle})`);
          } catch (err) {
            console.log(`ZuneManager: could not set album ArtistId: ${err.message}`);
          }
        }

        if (genre) {
          try {
            await this.mtp.setObjectPropString(albumHandle, ObjectProperty.Genre, genre);
          } catch (err) {
            console.log(`ZuneManager: could not set album Genre: ${err.message}`);
          }
        }

        // Link track handles to the album via SetObjectReferences
        try {
          await this.mtp.setObjectReferences(albumHandle, trackHandles);
          console.log(`ZuneManager: linked ${trackHandles.length} tracks to album "${album}"`);
        } catch (err) {
          console.log(`ZuneManager: could not set object references for album "${album}": ${err.message}`);
        }

        // Also set ArtistId on each track so the Zune associates tracks with the artist
        if (artistHandle) {
          for (const trackHandle of trackHandles) {
            try {
              await this.mtp.setObjectPropUint32(trackHandle, ObjectProperty.ArtistId, artistHandle);
            } catch (err) {
              console.log(`ZuneManager: could not set ArtistId on track ${trackHandle}: ${err.message}`);
            }
          }
          console.log(`ZuneManager: set ArtistId on ${trackHandles.length} tracks`);
        }

        // Set album art via RepresentativeSampleData on the album object
        if (albumArt && albumArt.data) {
          const artData = Buffer.isBuffer(albumArt.data) ? albumArt.data : Buffer.from(albumArt.data);
          console.log(`ZuneManager: attempting album art (${artData.length} bytes, ${albumArt.format})`);

          // Try setting each property independently — the Zune may only support some
          try {
            await this.mtp.setObjectPropArray(albumHandle, ObjectProperty.RepresentativeSampleData, artData);
            console.log(`ZuneManager: set RepresentativeSampleData OK`);
          } catch (err) {
            console.log(`ZuneManager: RepresentativeSampleData failed: ${err.message}`);
          }

          try {
            await this.mtp.setObjectPropUint32(albumHandle, ObjectProperty.RepresentativeSampleSize, artData.length);
            console.log(`ZuneManager: set RepresentativeSampleSize OK`);
          } catch (err) {
            console.log(`ZuneManager: RepresentativeSampleSize failed: ${err.message}`);
          }

          try {
            await this.mtp.setObjectPropUint16(albumHandle, ObjectProperty.RepresentativeSampleFormat, ObjectFormat.JPEG);
            console.log(`ZuneManager: set RepresentativeSampleFormat OK`);
          } catch (err) {
            console.log(`ZuneManager: RepresentativeSampleFormat failed: ${err.message}`);
          }
        }
      } catch (err) {
        console.log(`ZuneManager: failed to create album object for "${key}": ${err.message}`);
      }
    }
  }

  cancelTransfer() {
    this.cancelRequested = true;
  }

  /**
   * Try ZMDB fast path: fetch the device's binary database in one bulk transfer
   * and parse it locally. Returns null if the device doesn't support it.
   */
  async _tryZMDB() {
    const start = Date.now();
    console.log('ZuneManager: attempting ZMDB fast path...');

    try {
      const zmdbData = await this.mtp.readZMDB();
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`ZuneManager: ZMDB fetched in ${elapsed}s (${zmdbData.length} bytes)`);

      const isHD = (this.model || '').toLowerCase().includes('hd');
      const parser = new ZMDBParser(zmdbData, isHD ? 'hd' : 'classic');
      const library = parser.parse();

      const parseElapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`ZuneManager: ZMDB parsed in ${parseElapsed}s`);

      // Convert ZMDB library to our browseContents format
      const result = { music: [], videos: [], pictures: [] };

      for (const track of library.tracks) {
        result.music.push({
          handle: track.atomId, // use atomId as unique handle for selection/pull
          filename: track.filename || track.title || 'unknown',
          size: track.size,
          format: track.codecId,
          title: track.title,
          artist: track.artist,
          album: track.album,
          albumArt: null, // ZMDB doesn't include art data
          genre: track.genre,
          trackNumber: track.trackNumber,
          duration: track.duration,
        });
      }

      for (const video of library.videos) {
        result.videos.push({
          handle: video.atomId,
          filename: video.filename || video.title || 'unknown',
          size: video.size,
          format: video.codecId,
        });
      }

      for (const pic of library.pictures) {
        result.pictures.push({
          handle: pic.atomId,
          filename: pic.filename || pic.title || 'unknown',
          size: 0,
          format: 0,
        });
      }

      return result;
    } catch (err) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`ZuneManager: ZMDB fast path failed in ${elapsed}s: ${err.message}`);
      return null;
    }
  }

  /**
   * After ZMDB parse, probe whether atom IDs work as MTP handles for GetObject.
   * If not, build a filename→handle map lazily when files are actually pulled.
   */
  async _probeZMDBHandles(zmdbResult) {
    if (!zmdbResult.music.length) return;

    // Try GetObject with the first track's atomId to see if it works
    const probe = zmdbResult.music[0];
    console.log(`ZuneManager: probing GetObject with atomId 0x${probe.handle.toString(16)} (filename: "${probe.filename}")...`);

    try {
      const data = await Promise.race([
        this.mtp.getObject(probe.handle),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
      ]);
      if (data && data.length > 0) {
        console.log(`ZuneManager: GetObject(atomId) works! Got ${data.length} bytes — ZMDB handles are valid MTP handles`);
        this.zmdbHandlesValid = true;
        return;
      }
    } catch (err) {
      console.log(`ZuneManager: GetObject(atomId) failed: ${err.message}`);
      // Clear any USB pipe stalls
      try { await this.transport.clearHalt('in'); } catch (_) {}
      try { await this.transport.clearHalt('out'); } catch (_) {}
    }

    // Atom IDs don't work as handles — need to resolve at pull time
    this.zmdbHandlesValid = false;
    console.log('ZuneManager: ZMDB atom IDs are not valid MTP handles — will resolve on pull');

    // Build a filename→atomId map from ZMDB so we can match at pull time
    this._zmdbFilenameMap = new Map();
    for (const track of zmdbResult.music) {
      if (track.filename) {
        this._zmdbFilenameMap.set(track.handle, track.filename);
      }
    }
  }

  /**
   * Resolve a ZMDB atom ID to a real MTP handle by searching the device.
   * Called lazily at pull time when ZMDB handles aren't valid MTP handles.
   */
  async resolveHandle(atomId) {
    // If ZMDB handles work as MTP handles, no resolution needed
    if (this.zmdbHandlesValid !== false) return atomId;

    // Check cache first
    if (this._handleCache && this._handleCache.has(atomId)) {
      return this._handleCache.get(atomId);
    }

    // Build handle cache on first pull (one-time cost)
    if (!this._handleCache) {
      console.log('ZuneManager: building handle cache for pull (first time)...');
      this._handleCache = new Map();

      // Get all handles from root and scan for filenames
      const folderQueue = [0];
      const seen = new Set();

      while (folderQueue.length > 0) {
        const parent = folderQueue.shift();
        let handles;
        try {
          handles = await Promise.race([
            this.mtp.getObjectHandles(this.storageId, 0, parent),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
          ]);
        } catch (_) { continue; }

        for (const h of handles) {
          if (seen.has(h)) continue;
          seen.add(h);
          try {
            const info = await Promise.race([
              this.mtp.getObjectInfo(h),
              new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
            ]);
            if (info.objectFormat === 0x3001) { folderQueue.push(h); continue; }
            if (info.filename) {
              // Match MTP filename to ZMDB tracks by basename
              for (const [aId, zmdbFn] of this._zmdbFilenameMap.entries()) {
                const zmdbBase = zmdbFn.split(/[/\\]/).pop().toLowerCase();
                if (info.filename.toLowerCase() === zmdbBase) {
                  this._handleCache.set(aId, h);
                  break;
                }
              }
            }
          } catch (_) {}

          if (seen.size % 500 === 0) {
            this.emit('pull-progress', { phase: 'resolving', resolved: this._handleCache.size, total: this._zmdbFilenameMap.size });
          }
        }
      }

      console.log(`ZuneManager: handle cache built — ${this._handleCache.size} handles resolved`);
    }

    return this._handleCache.get(atomId) || atomId;
  }

  async browseContents() {
    if (!this.connected) {
      throw new Error('No Zune device connected');
    }

    const browseStart = Date.now();
    const elapsed = () => `${((Date.now() - browseStart) / 1000).toFixed(1)}s`;
    console.log(`ZuneManager: browseContents() starting`);

    // Try ZMDB fast path first
    this.emit('browse-progress', { phase: 'scanning', scanned: 0, total: 0, foldersScanned: 0, contents: { music: [], videos: [], pictures: [] } });
    const zmdbResult = await this._tryZMDB();
    if (zmdbResult) {
      console.log(`ZuneManager: [${elapsed()}] ZMDB fast path succeeded — ${zmdbResult.music.length} tracks, ${zmdbResult.videos.length} videos, ${zmdbResult.pictures.length} pictures`);
      this.emit('browse-progress', { phase: 'enriching', enriched: zmdbResult.music.length, enrichTotal: zmdbResult.music.length, contents: zmdbResult });

      // Probe if ZMDB atom IDs work as MTP handles (fast — one GetObject test)
      await this._probeZMDBHandles(zmdbResult);

      return zmdbResult;
    }

    console.log(`ZuneManager: [${elapsed()}] falling back to MTP enumeration`);

    const result = { music: [], videos: [], pictures: [] };

    // Collect abstract objects for hierarchy building
    const artistObjHandles = [];
    const albumObjHandles = [];
    const musicItems = [];

    // ---- Pass 1: Recursively enumerate all objects from root ----
    // The Zune stores content in folders (Association objects). We must
    // traverse the folder tree starting from root (parent=0) to find
    // all content, including songs synced by the original Zune software.
    // NOTE: The Zune may return the same handle from multiple parent folders
    // (virtual folder views by artist, album, genre, etc.), so we deduplicate.
    console.log(`ZuneManager: [${elapsed()}] Pass 1 — recursive folder enumeration`);
    const folderQueue = [0]; // start at root
    const seenHandles = new Set(); // deduplicate across all folders
    let totalHandles = 0;
    let foldersScanned = 0;

    while (folderQueue.length > 0) {
      const parentHandle = folderQueue.shift();
      let handles;
      try {
        console.log(`ZuneManager: [${elapsed()}] getObjectHandles(parent=${parentHandle})...`);
        handles = await Promise.race([
          this.mtp.getObjectHandles(this.storageId, 0, parentHandle),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ]);
        console.log(`ZuneManager: [${elapsed()}]   -> ${handles.length} handles`);
      } catch (err) {
        console.log(`ZuneManager: [${elapsed()}] getObjectHandles failed for parent ${parentHandle}: ${err.message}`);
        if (err.message === 'timeout' || err.message.includes('PIPE') || err.message.includes('STALL')) {
          try { await this.transport.clearHalt('in'); } catch (_) {}
          try { await this.transport.clearHalt('out'); } catch (_) {}
        }
        continue;
      }

      foldersScanned++;
      totalHandles += handles.length;

      // Emit scan progress so the renderer can show a progress bar
      this.emit('browse-progress', {
        phase: 'scanning',
        scanned: result.music.length + result.videos.length + result.pictures.length,
        total: totalHandles,
        foldersScanned,
        contents: result,
      });

      for (let hi = 0; hi < handles.length; hi++) {
        const handle = handles[hi];
        if (seenHandles.has(handle)) continue;
        seenHandles.add(handle);
        try {
          // Log every 50 handles, and every handle in the last 51 (to catch late stalls)
          if ((hi % 50 === 0 && hi > 0) || (handles.length > 50 && hi >= handles.length - 51)) {
            console.log(`ZuneManager: [${elapsed()}]   getObjectInfo ${hi}/${handles.length} handle=${handle} (folder ${parentHandle})`);
          }
          // Emit scanning progress every 50 handles within a folder
          if (hi > 0 && hi % 50 === 0) {
            this.emit('browse-progress', {
              phase: 'scanning',
              scanned: result.music.length + result.videos.length + result.pictures.length,
              total: handles.length,
              foldersScanned,
              handleProgress: hi,
              handleTotal: handles.length,
              contents: result,
            });
          }
          const info = await Promise.race([
            this.mtp.getObjectInfo(handle),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
          ]);

          // Collect abstract objects for hierarchy building
          if (info.objectFormat === ObjectFormat.Artist) {
            artistObjHandles.push(handle);
            continue;
          }
          if (info.objectFormat === ObjectFormat.AbstractAudioAlbum) {
            albumObjHandles.push(handle);
            continue;
          }

          // Queue folders for recursive traversal
          if (info.objectFormat === ObjectFormat.Association) {
            folderQueue.push(handle);
            continue;
          }

          const item = {
            handle,
            filename: info.filename,
            size: info.compressedSize,
            format: info.objectFormat,
          };

          const isMusic =
            info.objectFormat === ObjectFormat.MP3 ||
            info.objectFormat === ObjectFormat.WMA ||
            info.objectFormat === ObjectFormat.AAC;

          const isVideo =
            info.objectFormat === ObjectFormat.WMV ||
            info.objectFormat === ObjectFormat.MP4;

          const isImage = info.objectFormat === ObjectFormat.JPEG;

          // For unknown formats, categorize by extension
          let category = null;
          if (isMusic) {
            category = 'music';
          } else if (isVideo) {
            category = 'videos';
          } else if (isImage) {
            category = 'pictures';
          } else {
            const ext = (info.filename || '').toLowerCase();
            if (ext.endsWith('.mp3') || ext.endsWith('.wma') || ext.endsWith('.aac') || ext.endsWith('.m4a')) {
              category = 'music';
            } else if (ext.endsWith('.wmv') || ext.endsWith('.mp4') || ext.endsWith('.m4v')) {
              category = 'videos';
            } else if (ext.endsWith('.jpg') || ext.endsWith('.jpeg') || ext.endsWith('.png')) {
              category = 'pictures';
            }
          }

          if (category) {
            result[category].push(item);
            if (category === 'music') {
              musicItems.push(item);
            }
          }
        } catch (err) {
          console.log(`ZuneManager: [${elapsed()}] skipping handle ${handle}: ${err.message}`);
          if (err.message === 'timeout' || err.message.includes('PIPE') || err.message.includes('STALL')) {
            try { await this.transport.clearHalt('in'); } catch (_) {}
            try { await this.transport.clearHalt('out'); } catch (_) {}
          }
        }
      }
      console.log(`ZuneManager: [${elapsed()}] folder ${parentHandle} done (${handles.length} handles). Queued subfolders: ${folderQueue.length}`);
    }

    console.log(`ZuneManager: [${elapsed()}] Pass 1 done — scanned ${foldersScanned} folders, ${totalHandles} total handles ` +
      `(${result.music.length} music, ${result.videos.length} videos, ${result.pictures.length} pictures, ` +
      `${artistObjHandles.length} artist objs, ${albumObjHandles.length} album objs)`);

    // Also try flat enumeration with 0xFFFFFFFF to catch orphaned/root-level
    // abstract objects that may not live inside any folder
    // seenHandles is already populated from Pass 1 with all content + abstract handles
    console.log(`ZuneManager: [${elapsed()}] Flat enumeration (0xFFFFFFFF)...`);

    try {
      const flatHandles = await Promise.race([
        this.mtp.getObjectHandles(this.storageId, 0, 0xFFFFFFFF),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
      ]);
      console.log(`ZuneManager: [${elapsed()}] flat enumeration returned ${flatHandles.length} handles (${seenHandles.size} already seen)`);
      let flatNew = 0;
      let flatChecked = 0;
      for (const handle of flatHandles) {
        if (seenHandles.has(handle)) continue;
        seenHandles.add(handle);
        flatChecked++;
        try {
          if (flatChecked % 50 === 0) {
            console.log(`ZuneManager: [${elapsed()}]   flat getObjectInfo progress: ${flatChecked} new handles checked`);
          }
          const info = await Promise.race([
            this.mtp.getObjectInfo(handle),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
          ]);
          if (info.objectFormat === ObjectFormat.Artist) {
            artistObjHandles.push(handle);
            flatNew++;
          } else if (info.objectFormat === ObjectFormat.AbstractAudioAlbum) {
            albumObjHandles.push(handle);
            flatNew++;
          } else if (info.objectFormat === ObjectFormat.Association) {
            // Skip folders in flat pass — we already traversed
          } else {
            const item = {
              handle,
              filename: info.filename,
              size: info.compressedSize,
              format: info.objectFormat,
            };

            const isMusic =
              info.objectFormat === ObjectFormat.MP3 ||
              info.objectFormat === ObjectFormat.WMA ||
              info.objectFormat === ObjectFormat.AAC;
            const isVideo =
              info.objectFormat === ObjectFormat.WMV ||
              info.objectFormat === ObjectFormat.MP4;
            const isImage = info.objectFormat === ObjectFormat.JPEG;

            let category = null;
            if (isMusic) category = 'music';
            else if (isVideo) category = 'videos';
            else if (isImage) category = 'pictures';
            else {
              const ext = (info.filename || '').toLowerCase();
              if (ext.endsWith('.mp3') || ext.endsWith('.wma') || ext.endsWith('.aac') || ext.endsWith('.m4a')) {
                category = 'music';
              } else if (ext.endsWith('.wmv') || ext.endsWith('.mp4') || ext.endsWith('.m4v')) {
                category = 'videos';
              } else if (ext.endsWith('.jpg') || ext.endsWith('.jpeg') || ext.endsWith('.png')) {
                category = 'pictures';
              }
            }

            if (category) {
              result[category].push(item);
              if (category === 'music') musicItems.push(item);
              flatNew++;
            }
          }
        } catch (err) {
          console.log(`ZuneManager: [${elapsed()}] skipping flat handle ${handle}: ${err.message}`);
          if (err.message === 'timeout' || err.message.includes('PIPE') || err.message.includes('STALL')) {
            try { await this.transport.clearHalt('in'); } catch (_) {}
            try { await this.transport.clearHalt('out'); } catch (_) {}
          }
        }
      }
      if (flatNew > 0) {
        console.log(`ZuneManager: flat enumeration found ${flatNew} additional objects`);
      }
    } catch (err) {
      console.log(`ZuneManager: flat enumeration (0xFFFFFFFF) failed: ${err.message}`);
    }

    console.log(`ZuneManager: enumerated ${totalHandles} objects across folder tree: ` +
      `${result.music.length} music, ${result.videos.length} videos, ${result.pictures.length} pictures, ` +
      `${artistObjHandles.length} artists, ${albumObjHandles.length} albums`);

    // Send initial results so the UI can render filenames + sizes immediately
    this.emit('browse-progress', { phase: 'enumerated', contents: result });

    // ---- Pass 2: Build artist handle -> name map ----
    console.log(`ZuneManager: [${elapsed()}] Pass 2 — resolving ${artistObjHandles.length} artist names`);
    const artistMap = new Map(); // handle -> artistName

    for (const handle of artistObjHandles) {
      const name = await this._tryGetPropString(handle, ObjectProperty.Name);
      if (name) {
        artistMap.set(handle, name);
      }
    }

    if (artistMap.size > 0) {
      console.log(`ZuneManager: resolved ${artistMap.size} artist objects`);
    }

    // ---- Pass 3: Build track handle -> album metadata map ----
    console.log(`ZuneManager: [${elapsed()}] Pass 3 — resolving ${albumObjHandles.length} album objects`);
    const trackToAlbumMap = new Map(); // trackHandle -> { albumName, artistName, genre, albumArt }

    for (let ai = 0; ai < albumObjHandles.length; ai++) {
      if (ai > 0 && ai % 10 === 0) {
        console.log(`ZuneManager: [${elapsed()}]   album progress: ${ai}/${albumObjHandles.length}`);
        this.emit('browse-progress', { phase: 'resolving-albums', resolved: ai, resolveTotal: albumObjHandles.length, contents: result });
      }
      const albumHandle = albumObjHandles[ai];
      // Read album name
      const albumName = await this._tryGetPropString(albumHandle, ObjectProperty.Name);
      if (!albumName) continue;

      // Read artist via ArtistId (uint32 handle pointing to an Artist object)
      let artistName = null;
      const artistId = await this._tryGetPropUint32(albumHandle, ObjectProperty.ArtistId);
      if (artistId !== null && artistMap.has(artistId)) {
        artistName = artistMap.get(artistId);
      }
      // Fallback: try reading Artist string directly on the album object
      if (!artistName) {
        artistName = await this._tryGetPropString(albumHandle, ObjectProperty.Artist);
      }

      // Read genre
      const genre = await this._tryGetPropString(albumHandle, ObjectProperty.Genre);

      // Read album art from RepresentativeSampleData
      let albumArt = null;
      const artData = await this._tryGetPropArray(albumHandle, ObjectProperty.RepresentativeSampleData);
      if (artData && artData.length > 0) {
        const base64 = artData.toString('base64');
        albumArt = `data:image/jpeg;base64,${base64}`;
      }

      // Get track references for this album
      let trackRefs = [];
      try {
        trackRefs = await Promise.race([
          this.mtp.getObjectReferences(albumHandle),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ]);
      } catch (err) {
        console.log(`ZuneManager: getObjectReferences failed for album "${albumName}": ${err.message}`);
        if (err.message === 'timeout' || err.message.includes('PIPE') || err.message.includes('STALL')) {
          await this.transport.clearHalt('in');
          await this.transport.clearHalt('out');
        }
      }

      console.log(`ZuneManager: album "${albumName}" by "${artistName || '?'}" -> ${trackRefs.length} tracks`);

      // Map each referenced track handle to this album's metadata
      const albumMeta = { albumName, artistName, genre, albumArt };
      for (const trackHandle of trackRefs) {
        trackToAlbumMap.set(trackHandle, albumMeta);
      }
    }

    if (trackToAlbumMap.size > 0) {
      console.log(`ZuneManager: mapped ${trackToAlbumMap.size} tracks to albums via hierarchy`);
    }

    // ---- Apply hierarchy metadata to music items (fast, no MTP calls) ----
    for (const item of musicItems) {
      const hierarchyMeta = trackToAlbumMap.get(item.handle);
      if (hierarchyMeta) {
        item.artist = hierarchyMeta.artistName || '';
        item.album = hierarchyMeta.albumName || '';
        item.genre = hierarchyMeta.genre || '';
        item.albumArt = hierarchyMeta.albumArt || null;
      }
    }

    // Send results with album hierarchy metadata (artist, album, art)
    this.emit('browse-progress', { phase: 'albums-resolved', enriched: 0, enrichTotal: musicItems.length, contents: result });

    // ---- Pass 4: Enrich music tracks with per-track property reads ----
    console.log(`ZuneManager: [${elapsed()}] Pass 4 — enriching ${musicItems.length} music tracks with per-track metadata`);
    let perTrackReadsFailed = false;

    for (let i = 0; i < musicItems.length; i++) {
      if (i > 0 && i % 25 === 0) {
        console.log(`ZuneManager: [${elapsed()}]   track enrichment progress: ${i}/${musicItems.length}${perTrackReadsFailed ? ' (per-track reads stopped)' : ''}`);
      }
      if (i > 0 && i % 25 === 0) {
        this.emit('browse-progress', { phase: 'enriching', enriched: i, enrichTotal: musicItems.length, contents: result });
      }
      const item = musicItems[i];

      const hierarchyMeta = trackToAlbumMap.get(item.handle);
      const hasHierarchyMeta = hierarchyMeta && hierarchyMeta.artistName && hierarchyMeta.albumName;

      // Per-track property reads
      if (!perTrackReadsFailed) {
        // Always read title (hierarchy only has album/artist, not per-track title)
        const title = await this._tryGetPropString(item.handle, ObjectProperty.Name);
        if (title === null) {
          console.log(`ZuneManager: per-track Name read failed (handle=${item.handle}), stopping per-track reads`);
          perTrackReadsFailed = true;
        } else if (title) {
          item.title = title;
        }
      }

      if (!perTrackReadsFailed && !hasHierarchyMeta) {
        // Only read per-track Artist/AlbumName if hierarchy didn't provide them
        const trackArtist = await this._tryGetPropString(item.handle, ObjectProperty.Artist);
        if (trackArtist === null) {
          perTrackReadsFailed = true;
        } else if (trackArtist) {
          item.artist = item.artist || trackArtist;
        }

        const trackAlbum = await this._tryGetPropString(item.handle, ObjectProperty.AlbumName);
        if (trackAlbum === null) {
          perTrackReadsFailed = true;
        } else if (trackAlbum) {
          item.album = item.album || trackAlbum;
        }
      }

      // Step C: Duration, track number, and genre fallback
      if (!perTrackReadsFailed) {
        const duration = await this._tryGetPropUint32(item.handle, ObjectProperty.Duration);
        if (duration !== null) {
          item.duration = duration;
        }

        const trackNum = await this._tryGetPropUint16(item.handle, ObjectProperty.Track);
        if (trackNum !== null) {
          item.trackNumber = trackNum;
        }

        // Read genre from track if hierarchy didn't provide it
        if (!item.genre) {
          const genre = await this._tryGetPropString(item.handle, ObjectProperty.Genre);
          if (genre === null) {
            perTrackReadsFailed = true;
          } else if (genre) {
            item.genre = genre;
          }
        }
      }

      if (i === 0 && !perTrackReadsFailed) {
        console.log(`ZuneManager: first track metadata OK (title="${item.title}", artist="${item.artist}", album="${item.album}"), reading rest...`);
      }
    }

    // Also read title for video items
    console.log(`ZuneManager: [${elapsed()}] Reading titles for ${result.videos.length} videos`);
    let videoReadsFailed = false;
    for (const item of result.videos) {
      if (videoReadsFailed) break;
      const title = await this._tryGetPropString(item.handle, ObjectProperty.Name);
      if (title === null) {
        videoReadsFailed = true;
      } else {
        item.title = title;
      }
    }

    if (perTrackReadsFailed) {
      console.log(`ZuneManager: per-track reads failed, relying on hierarchy data for remaining tracks`);
    }

    console.log(`ZuneManager: [${elapsed()}] browse complete: ${result.music.length} music, ${result.videos.length} videos, ${result.pictures.length} pictures`);
    return result;
  }

  async deleteObjects(handles) {
    if (!this.connected) {
      throw new Error('No Zune device connected');
    }

    let deleted = 0;
    let failed = 0;
    const errors = [];

    for (const handle of handles) {
      try {
        await this.mtp.deleteObject(handle);
        deleted++;
      } catch (err) {
        // InvalidObjectHandle means the item is already gone — count as deleted
        if (err.message.includes('InvalidObjectHandle')) {
          console.log(`ZuneManager: handle ${handle} already gone (InvalidObjectHandle)`);
          deleted++;
        } else {
          failed++;
          errors.push({ handle, error: err.message });
          console.log(`ZuneManager: failed to delete handle ${handle}: ${err.message}`);
        }
      }
    }

    // Refresh storage info
    if (this.connected) {
      try {
        this.storageInfo = await this.mtp.getStorageInfo(this.storageId);
      } catch (err) {
        console.log(`ZuneManager: failed to refresh storage after delete: ${err.message}`);
      }
    }

    return { deleted, failed, errors, storage: this.storageInfo };
  }

  async getFile(handle) {
    if (!this.connected) {
      throw new Error('No Zune device connected');
    }
    // If ZMDB handles aren't valid MTP handles, resolve first
    const realHandle = await this.resolveHandle(handle);
    const data = await this.mtp.getObject(realHandle);
    return data;
  }

  async _tryGetPropString(handle, propCode, timeoutMs = 3000) {
    try {
      const result = await Promise.race([
        this.mtp.getObjectPropString(handle, propCode),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), timeoutMs)
        ),
      ]);
      return result;
    } catch (err) {
      // If the read timed out or stalled, try to clear the USB pipes
      // so subsequent MTP commands can still work
      if (err.message === 'timeout' || err.message.includes('PIPE') || err.message.includes('STALL')) {
        console.log(`ZuneManager: property read stalled (handle=${handle}, prop=0x${propCode.toString(16)}), clearing pipes`);
        await this.transport.clearHalt('in');
        await this.transport.clearHalt('out');
      }
      return null;
    }
  }

  async _tryGetPropUint32(handle, propCode, timeoutMs = 3000) {
    try {
      const result = await Promise.race([
        this.mtp.getObjectPropUint32(handle, propCode),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), timeoutMs)
        ),
      ]);
      return result;
    } catch (err) {
      if (err.message === 'timeout' || err.message.includes('PIPE') || err.message.includes('STALL')) {
        console.log(`ZuneManager: uint32 read stalled (handle=${handle}, prop=0x${propCode.toString(16)}), clearing pipes`);
        await this.transport.clearHalt('in');
        await this.transport.clearHalt('out');
      }
      return null;
    }
  }

  async _tryGetPropUint16(handle, propCode, timeoutMs = 3000) {
    try {
      const result = await Promise.race([
        this.mtp.getObjectPropUint16(handle, propCode),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), timeoutMs)
        ),
      ]);
      return result;
    } catch (err) {
      if (err.message === 'timeout' || err.message.includes('PIPE') || err.message.includes('STALL')) {
        console.log(`ZuneManager: uint16 read stalled (handle=${handle}, prop=0x${propCode.toString(16)}), clearing pipes`);
        await this.transport.clearHalt('in');
        await this.transport.clearHalt('out');
      }
      return null;
    }
  }

  async _tryGetPropArray(handle, propCode, timeoutMs = 5000) {
    try {
      const result = await Promise.race([
        this.mtp.getObjectPropArray(handle, propCode),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), timeoutMs)
        ),
      ]);
      return result;
    } catch (err) {
      if (err.message === 'timeout' || err.message.includes('PIPE') || err.message.includes('STALL')) {
        console.log(`ZuneManager: array read stalled (handle=${handle}, prop=0x${propCode.toString(16)}), clearing pipes`);
        await this.transport.clearHalt('in');
        await this.transport.clearHalt('out');
      }
      return null;
    }
  }

  async probeObjectProperties(handle) {
    if (!this.connected) {
      throw new Error('No Zune device connected');
    }

    const props = [
      { name: 'Name',         code: ObjectProperty.Name,         type: 'string' },
      { name: 'Artist',       code: ObjectProperty.Artist,       type: 'string' },
      { name: 'AlbumName',    code: ObjectProperty.AlbumName,    type: 'string' },
      { name: 'AlbumArtist',  code: ObjectProperty.AlbumArtist,  type: 'string' },
      { name: 'Genre',        code: ObjectProperty.Genre,        type: 'string' },
      { name: 'OriginalDate', code: ObjectProperty.OriginalDate, type: 'string' },
      { name: 'Track',        code: ObjectProperty.Track,        type: 'uint16' },
      { name: 'Duration',     code: ObjectProperty.Duration,     type: 'uint32' },
    ];

    const results = [];

    for (const prop of props) {
      // Read
      let readValue = null;
      let readError = null;
      try {
        const raw = await Promise.race([
          this.mtp.getObjectPropValue(handle, prop.code),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout (3s)')), 3000)),
        ]);
        if (prop.type === 'string') {
          const { str } = this.mtp._parseMtpString(raw, 0);
          readValue = str;
        } else if (prop.type === 'uint32') {
          readValue = raw.readUInt32LE(0);
        } else if (prop.type === 'uint16') {
          readValue = raw.readUInt16LE(0);
        }
      } catch (err) {
        readError = err.message;
        // Clear pipes after stall
        if (err.message.includes('timeout') || err.message.includes('PIPE') || err.message.includes('STALL')) {
          await this.transport.clearHalt('in');
          await this.transport.clearHalt('out');
        }
      }

      results.push({
        name: prop.name,
        code: '0x' + prop.code.toString(16).toUpperCase(),
        type: prop.type,
        readValue,
        readError,
      });

      console.log(
        `  ${prop.name} (${results[results.length - 1].code}): ` +
        (readError ? `ERROR: ${readError}` : `"${readValue}"`)
      );
    }

    return results;
  }

  async probeWmdrmpd() {
    if (!this.connected) {
      throw new Error('No Zune device connected');
    }

    const results = [];

    // The WMDRMPD app request/response tunnel uses a structured inner protocol.
    // After MTPZ auth, the device may accept other request types.
    // The first bytes of the request payload typically indicate the command type.
    // Let's probe with small payloads to see what the device responds to.

    // Known request type from MTPZ auth: type 2 (certificate), type 4 (confirmation)
    // Try some other types to see if any trigger a library-related response.

    const probePayloads = [
      { label: 'type 0x00 (empty)', data: Buffer.from([0x00]) },
      { label: 'type 0x01', data: Buffer.from([0x01]) },
      { label: 'type 0x03', data: Buffer.from([0x03]) },
      { label: 'type 0x05', data: Buffer.from([0x05]) },
      { label: 'type 0x06', data: Buffer.from([0x06]) },
      { label: 'type 0x07', data: Buffer.from([0x07]) },
      { label: 'type 0x08', data: Buffer.from([0x08]) },
      { label: 'type 0x10', data: Buffer.from([0x10]) },
      { label: 'type 0x20', data: Buffer.from([0x20]) },
      { label: 'type 0xFF', data: Buffer.from([0xFF]) },
    ];

    for (const probe of probePayloads) {
      let response = null;
      let error = null;

      try {
        await this.mtp.sendMtpzRequest(probe.data);

        // Try to read a response (with timeout)
        const resp = await Promise.race([
          this.mtp.getMtpzResponse(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
        ]);
        response = resp ? resp.toString('hex').substring(0, 200) : '(empty)';
      } catch (err) {
        error = err.message;
        if (err.message.includes('timeout') || err.message.includes('PIPE') || err.message.includes('STALL')) {
          await this.transport.clearHalt('in');
          await this.transport.clearHalt('out');
        }
      }

      const entry = { label: probe.label, response, error };
      results.push(entry);
      console.log(
        `  ${probe.label}: ` +
        (error ? `ERROR: ${error}` : `RESPONSE (${response.length / 2} bytes): ${response}`)
      );

      // If we got a stall, the session might be corrupted — stop probing
      if (error && (error.includes('timeout') || error.includes('PIPE'))) {
        console.log('  Pipe stalled, stopping probe');
        break;
      }
    }

    return results;
  }

  async eject() {
    await this.disconnect();
    this.currentStatus = { state: 'disconnected' };
    this.emit('status', this.currentStatus);
  }
}

module.exports = { ZuneManager };
