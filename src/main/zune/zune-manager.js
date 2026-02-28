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

  async _readMetadata(filePath) {
    try {
      const { parseFile } = await import('music-metadata');
      const metadata = await parseFile(filePath);
      return {
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
      };
    } catch {
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
        }

        completedFiles++;
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

  cancelTransfer() {
    this.cancelRequested = true;
  }
}

module.exports = { ZuneManager };
