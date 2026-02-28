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
  }

  async start() {
    this.transport.onAttach((info) => this._handleAttach(info));
    this.transport.onDetach(() => this._handleDetach());
    this.transport.startHotplugDetection();

    const existing = await this.transport.findZune();

    if (existing) {
      this._handleAttach(existing);
    }
  }

  stop() {
    this.transport.stopHotplugDetection();
    this.disconnect();
  }

  async _handleAttach(info) {
    const model = ZUNE_DEVICES[info.productId] || 'Unknown Zune';
    this.currentStatus = { state: 'connecting', model };
    this.emit('status', this.currentStatus);

    try {
      await this.transport.open(ZUNE_VENDOR_ID, info.productId);
      console.log('ZuneManager: USB device opened, starting MTP...');

      this.mtp = new MtpProtocol(this.transport);
      await this.mtp.openSession(1);
      console.log('ZuneManager: MTP session opened');

      this.auth = new MtpzAuth(this.mtp);
      await this.auth.authenticate();
      console.log('ZuneManager: MTPZ authentication complete');

      this.deviceInfo = await this.mtp.getDeviceInfo();

      const storageIDs = await this.mtp.getStorageIDs();
      this.storageId = storageIDs[0];

      this.storageInfo = await this.mtp.getStorageInfo(this.storageId);

      this.connected = true;
      this.currentStatus = {
        state: 'connected',
        model,
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

  async browseContents() {
    if (!this.connected) {
      throw new Error('No Zune device connected');
    }

    const handles = await this.mtp.getObjectHandles(this.storageId, 0, 0xFFFFFFFF);
    const result = { music: [], videos: [], pictures: [] };

    for (const handle of handles) {
      try {
        const info = await this.mtp.getObjectInfo(handle);

        // Skip folders
        if (info.objectFormat === ObjectFormat.Association) continue;

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
          } else {
            category = 'music';
          }
        }

        result[category].push(item);
      } catch (err) {
        console.log(`ZuneManager: skipping handle ${handle}: ${err.message}`);
      }
    }

    // Second pass: try reading metadata for music/video files.
    // If any property read fails, abort ALL metadata reads immediately —
    // a failed read stalls the USB pipe and every command after it will hang.
    const mediaItems = [...result.music, ...result.videos];
    let metadataAborted = false;

    for (let i = 0; i < mediaItems.length && !metadataAborted; i++) {
      const item = mediaItems[i];

      // Try title
      const title = await this._tryGetPropString(item.handle, ObjectProperty.Name);
      if (title === null) {
        console.log(`ZuneManager: metadata read failed at handle ${item.handle} (Name), aborting metadata`);
        metadataAborted = true;
        break;
      }
      item.title = title;

      // Try artist
      const artist = await this._tryGetPropString(item.handle, ObjectProperty.Artist);
      if (artist === null) {
        console.log(`ZuneManager: metadata read failed at handle ${item.handle} (Artist), aborting metadata`);
        metadataAborted = true;
        break;
      }
      item.artist = artist;

      // Try album
      const album = await this._tryGetPropString(item.handle, ObjectProperty.AlbumName);
      if (album === null) {
        console.log(`ZuneManager: metadata read failed at handle ${item.handle} (AlbumName), aborting metadata`);
        metadataAborted = true;
        break;
      }
      item.album = album;

      if (i === 0) {
        console.log(`ZuneManager: metadata read OK (title="${title}", artist="${artist}", album="${album}"), reading rest...`);
      }
    }

    if (!metadataAborted && mediaItems.length > 0) {
      console.log(`ZuneManager: metadata read complete for ${mediaItems.length} items`);
    }

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
