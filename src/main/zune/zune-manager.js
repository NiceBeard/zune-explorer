const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs/promises');

const { UsbTransport, ZUNE_VENDOR_ID, ZUNE_DEVICES } = require('./usb-transport.js');
const { MtpProtocol } = require('./mtp-protocol.js');
const { MtpzAuth } = require('./mtpz-auth.js');
const { ExtensionToFormat, ObjectFormat } = require('./mtp-constants.js');

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
  }

  start() {
    this.transport.onAttach((info) => this._handleAttach(info));
    this.transport.onDetach(() => this._handleDetach());
    this.transport.startHotplugDetection();

    const existing = this.transport.findZune();

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
    this.emit('status', { state: 'connecting', model });

    try {
      this.transport.open(ZUNE_VENDOR_ID, info.productId);

      this.mtp = new MtpProtocol(this.transport);
      await this.mtp.openSession(1);

      this.auth = new MtpzAuth(this.mtp);
      await this.auth.authenticate();

      this.deviceInfo = await this.mtp.getDeviceInfo();

      const storageIDs = await this.mtp.getStorageIDs();
      this.storageId = storageIDs[0];

      this.storageInfo = await this.mtp.getStorageInfo(this.storageId);

      this.connected = true;
      this.emit('status', {
        state: 'connected',
        model,
        storage: this.storageInfo,
      });
    } catch (err) {
      console.error('ZuneManager: connection failed:', err);
      this.emit('status', { state: 'error', error: err.message });
      this.disconnect();
    }
  }

  _handleDetach() {
    this.cancelRequested = true;
    this.disconnect();
    this.emit('status', { state: 'disconnected' });
  }

  disconnect() {
    this.connected = false;
    this.mtp = null;
    this.auth = null;
    this.storageId = null;
    this.deviceInfo = null;
    this.storageInfo = null;
    this.transport.close();
  }

  getDeviceInfo() {
    if (!this.connected) {
      return null;
    }

    return { ...this.deviceInfo, storage: this.storageInfo };
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

        const fileName = path.basename(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const objectFormat = ExtensionToFormat[ext] || ObjectFormat.Undefined;
        const fileData = await fs.readFile(filePath);
        const totalBytes = fileData.length;

        this.emit('transfer-progress', {
          state: 'sending',
          fileName,
          fileIndex: completedFiles,
          totalFiles,
          bytesTransferred: 0,
          totalBytes,
        });

        await this.mtp.sendObjectInfo(this.storageId, 0, {
          objectFormat,
          compressedSize: totalBytes,
          filename: fileName,
        });

        await this.mtp.sendObject(fileData, (sent, total) => {
          this.emit('transfer-progress', {
            state: 'sending',
            fileName,
            fileIndex: completedFiles,
            totalFiles,
            bytesTransferred: sent,
            totalBytes: total,
          });
        });

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
    }
  }

  cancelTransfer() {
    this.cancelRequested = true;
  }
}

module.exports = { ZuneManager };
