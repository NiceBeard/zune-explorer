# Zune USB Sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Connect to a physical Zune HD over USB, authenticate via MTPZ, and push music/video/photo files from the computer to the device.

**Architecture:** Pure JavaScript MTP/MTPZ stack layered as usb-transport → mtp-protocol → mtpz-auth → zune-manager, integrated into the Electron main process via IPC, with a slide-out sync panel in the renderer.

**Tech Stack:** node-usb (USB access), Node.js crypto (AES/RSA/SHA), Electron IPC

---

### Task 1: Install node-usb and verify Zune detection

**Files:**
- Modify: `package.json`
- Create: `src/main/zune/usb-transport.js`

**Step 1: Install node-usb**

Run: `cd /Users/aaronnicely/zune-explorer && npm install usb`
Expected: `usb` added to `dependencies` in package.json

**Step 2: Create usb-transport.js with device detection**

Create `src/main/zune/usb-transport.js`:

```javascript
const { usb } = require('usb');

const ZUNE_VENDOR_ID = 0x045E;
const ZUNE_DEVICES = {
  0x063E: 'Zune HD',
  0x0710: 'Zune 32GB',
};

class UsbTransport {
  constructor() {
    this.device = null;
    this.iface = null;
    this.endpointIn = null;
    this.endpointOut = null;
    this._attachCallbacks = [];
    this._detachCallbacks = [];
  }

  findZune() {
    const devices = usb.getDeviceList();
    for (const dev of devices) {
      const desc = dev.deviceDescriptor;
      if (desc.idVendor === ZUNE_VENDOR_ID && ZUNE_DEVICES[desc.idProduct]) {
        return { device: dev, model: ZUNE_DEVICES[desc.idProduct], productId: desc.idProduct };
      }
    }
    return null;
  }

  open(vendorId, productId) {
    const devices = usb.getDeviceList();
    this.device = devices.find(d =>
      d.deviceDescriptor.idVendor === vendorId &&
      d.deviceDescriptor.idProduct === productId
    );
    if (!this.device) throw new Error('Zune not found');

    this.device.open();
    this.iface = this.device.interface(0);

    // Detach kernel driver if needed (Linux/macOS)
    if (this.iface.isKernelDriverActive()) {
      this.iface.detachKernelDriver();
    }
    this.iface.claim();

    // Find bulk endpoints
    for (const ep of this.iface.endpoints) {
      if (ep.direction === 'in' && ep.transferType === usb.LIBUSB_TRANSFER_TYPE_BULK) {
        this.endpointIn = ep;
      } else if (ep.direction === 'out' && ep.transferType === usb.LIBUSB_TRANSFER_TYPE_BULK) {
        this.endpointOut = ep;
      }
    }

    if (!this.endpointIn || !this.endpointOut) {
      throw new Error('Could not find bulk endpoints');
    }
  }

  bulkWrite(data) {
    return new Promise((resolve, reject) => {
      this.endpointOut.transfer(data, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  bulkRead(length) {
    return new Promise((resolve, reject) => {
      this.endpointIn.transfer(length, (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    });
  }

  close() {
    if (this.iface) {
      try { this.iface.release(true); } catch (e) { /* ignore */ }
    }
    if (this.device) {
      try { this.device.close(); } catch (e) { /* ignore */ }
    }
    this.device = null;
    this.iface = null;
    this.endpointIn = null;
    this.endpointOut = null;
  }

  startHotplugDetection() {
    usb.on('attach', (device) => {
      const desc = device.deviceDescriptor;
      if (desc.idVendor === ZUNE_VENDOR_ID && ZUNE_DEVICES[desc.idProduct]) {
        const model = ZUNE_DEVICES[desc.idProduct];
        this._attachCallbacks.forEach(cb => cb({ device, model, productId: desc.idProduct }));
      }
    });
    usb.on('detach', (device) => {
      const desc = device.deviceDescriptor;
      if (desc.idVendor === ZUNE_VENDOR_ID && ZUNE_DEVICES[desc.idProduct]) {
        this._detachCallbacks.forEach(cb => cb());
      }
    });
  }

  stopHotplugDetection() {
    usb.removeAllListeners('attach');
    usb.removeAllListeners('detach');
  }

  onAttach(callback) { this._attachCallbacks.push(callback); }
  onDetach(callback) { this._detachCallbacks.push(callback); }
}

module.exports = { UsbTransport, ZUNE_VENDOR_ID, ZUNE_DEVICES };
```

**Step 3: Manually test detection**

Plug in the Zune HD. Add a temporary test at the bottom of `usb-transport.js`:

```javascript
if (require.main === module) {
  const t = new UsbTransport();
  const found = t.findZune();
  console.log(found ? `Found: ${found.model}` : 'No Zune found');
}
```

Run: `cd /Users/aaronnicely/zune-explorer && node src/main/zune/usb-transport.js`
Expected: `Found: Zune HD` (if plugged in) or `No Zune found`

**Step 4: Remove test code and commit**

Remove the `if (require.main === module)` block, then:

```bash
git add package.json package-lock.json src/main/zune/usb-transport.js
git commit -m "feat(zune): add USB transport layer with Zune detection and hotplug"
```

---

### Task 2: MTP constants and container encoding/decoding

**Files:**
- Create: `src/main/zune/mtp-constants.js`
- Create: `src/main/zune/mtp-protocol.js`

**Step 1: Create MTP constants**

Create `src/main/zune/mtp-constants.js`:

```javascript
// MTP Container Types
const ContainerType = {
  COMMAND:  0x0001,
  DATA:     0x0002,
  RESPONSE: 0x0003,
  EVENT:    0x0004,
};

// MTP Operation Codes
const OperationCode = {
  GetDeviceInfo:    0x1001,
  OpenSession:      0x1002,
  CloseSession:     0x1003,
  GetStorageIDs:    0x1004,
  GetStorageInfo:   0x1005,
  GetNumObjects:    0x1006,
  GetObjectHandles: 0x1007,
  GetObjectInfo:    0x1008,
  SendObjectInfo:   0x100C,
  SendObject:       0x100D,
  // WMDRMPD vendor extensions (used by MTPZ)
  SendWMDRMPDAppRequest:            0x9212,
  GetWMDRMPDAppResponse:            0x9213,
  EnableTrustedFilesOperations:     0x9214,
  EndTrustedAppSession:             0x9216,
};

// MTP Response Codes
const ResponseCode = {
  OK:                    0x2001,
  GeneralError:          0x2002,
  SessionNotOpen:        0x2003,
  InvalidTransactionID:  0x2004,
  OperationNotSupported: 0x2005,
  ParameterNotSupported: 0x2006,
  InvalidObjectHandle:   0x2009,
  InvalidStorageID:      0x2008,
  StoreFull:             0x200C,
  ObjectWriteProtected:  0x200D,
};

// MTP Object Format Codes
const ObjectFormat = {
  Undefined:  0x3000,
  Association: 0x3001, // folder
  MP3:        0x3009,
  JPEG:       0x3801,
  WMA:        0xB901,
  AAC:        0xB903,
  WMV:        0xB981,
  MP4:        0xB982,
};

// Map file extensions to MTP format codes
const ExtensionToFormat = {
  '.mp3':  ObjectFormat.MP3,
  '.wma':  ObjectFormat.WMA,
  '.aac':  ObjectFormat.AAC,
  '.m4a':  ObjectFormat.AAC,
  '.wmv':  ObjectFormat.WMV,
  '.mp4':  ObjectFormat.MP4,
  '.m4v':  ObjectFormat.MP4,
  '.jpg':  ObjectFormat.JPEG,
  '.jpeg': ObjectFormat.JPEG,
};

// MTP Device Property Codes
const DeviceProperty = {
  SessionInitiatorInfo: 0xD406,
};

// MTP Storage Types
const StorageType = {
  FixedROM: 0x0001,
  RemovableROM: 0x0002,
  FixedRAM: 0x0003,
  RemovableRAM: 0x0004,
};

// Container header size (length + type + code + transactionId)
const CONTAINER_HEADER_SIZE = 12;

module.exports = {
  ContainerType,
  OperationCode,
  ResponseCode,
  ObjectFormat,
  ExtensionToFormat,
  DeviceProperty,
  StorageType,
  CONTAINER_HEADER_SIZE,
};
```

**Step 2: Create MTP protocol layer**

Create `src/main/zune/mtp-protocol.js`:

```javascript
const { ContainerType, OperationCode, ResponseCode, ObjectFormat,
        ExtensionToFormat, DeviceProperty, CONTAINER_HEADER_SIZE } = require('./mtp-constants');

class MtpProtocol {
  constructor(transport) {
    this.transport = transport;
    this.transactionId = 0;
    this.sessionId = 0;
  }

  // --- Container encoding/decoding ---

  buildContainer(type, code, params = []) {
    const paramBytes = params.length * 4;
    const length = CONTAINER_HEADER_SIZE + paramBytes;
    const buf = Buffer.alloc(length);

    buf.writeUInt32LE(length, 0);
    buf.writeUInt16LE(type, 4);
    buf.writeUInt16LE(code, 6);
    buf.writeUInt32LE(this.transactionId, 8);

    for (let i = 0; i < params.length; i++) {
      buf.writeUInt32LE(params[i] >>> 0, CONTAINER_HEADER_SIZE + i * 4);
    }

    return buf;
  }

  buildDataContainer(code, data) {
    const length = CONTAINER_HEADER_SIZE + data.length;
    const header = Buffer.alloc(CONTAINER_HEADER_SIZE);

    header.writeUInt32LE(length, 0);
    header.writeUInt16LE(ContainerType.DATA, 4);
    header.writeUInt16LE(code, 6);
    header.writeUInt32LE(this.transactionId, 8);

    return Buffer.concat([header, data]);
  }

  parseContainer(buf) {
    if (buf.length < CONTAINER_HEADER_SIZE) {
      throw new Error(`Container too short: ${buf.length} bytes`);
    }
    const length = buf.readUInt32LE(0);
    const type = buf.readUInt16LE(4);
    const code = buf.readUInt16LE(6);
    const transactionId = buf.readUInt32LE(8);
    const payload = buf.slice(CONTAINER_HEADER_SIZE, length);

    // Parse params from payload (uint32 LE each)
    const params = [];
    for (let i = 0; i + 4 <= payload.length; i += 4) {
      params.push(payload.readUInt32LE(i));
    }

    return { length, type, code, transactionId, payload, params };
  }

  // --- Transport helpers ---

  async sendCommand(opcode, params = []) {
    this.transactionId++;
    const cmd = this.buildContainer(ContainerType.COMMAND, opcode, params);
    await this.transport.bulkWrite(cmd);
  }

  async sendData(opcode, data) {
    const pkt = this.buildDataContainer(opcode, data);
    await this.transport.bulkWrite(pkt);
  }

  async receiveData() {
    // First read: get the header to know the full length
    const headerBuf = await this.transport.bulkRead(512);
    if (headerBuf.length < CONTAINER_HEADER_SIZE) {
      throw new Error('Short read on MTP response');
    }
    const totalLength = headerBuf.readUInt32LE(0);

    if (headerBuf.length >= totalLength) {
      return this.parseContainer(headerBuf.slice(0, totalLength));
    }

    // Need to read more data
    const chunks = [headerBuf];
    let received = headerBuf.length;
    while (received < totalLength) {
      const chunk = await this.transport.bulkRead(Math.min(16384, totalLength - received));
      chunks.push(chunk);
      received += chunk.length;
    }
    const full = Buffer.concat(chunks);
    return this.parseContainer(full.slice(0, totalLength));
  }

  async receiveResponse() {
    const container = await this.receiveData();
    if (container.type !== ContainerType.RESPONSE) {
      throw new Error(`Expected response, got type ${container.type}`);
    }
    if (container.code !== ResponseCode.OK) {
      const codeName = Object.entries(ResponseCode).find(([, v]) => v === container.code);
      throw new Error(`MTP error: ${codeName ? codeName[0] : '0x' + container.code.toString(16)}`);
    }
    return container;
  }

  // --- MTP Operations ---

  async openSession(sessionId = 1) {
    this.sessionId = sessionId;
    await this.sendCommand(OperationCode.OpenSession, [sessionId]);
    await this.receiveResponse();
  }

  async closeSession() {
    await this.sendCommand(OperationCode.CloseSession);
    await this.receiveResponse();
    this.sessionId = 0;
  }

  async getDeviceInfo() {
    await this.sendCommand(OperationCode.GetDeviceInfo);
    const data = await this.receiveData();
    await this.receiveResponse();
    return this._parseDeviceInfo(data.payload);
  }

  async getStorageIDs() {
    await this.sendCommand(OperationCode.GetStorageIDs);
    const data = await this.receiveData();
    await this.receiveResponse();
    return this._parseUint32Array(data.payload);
  }

  async getStorageInfo(storageId) {
    await this.sendCommand(OperationCode.GetStorageInfo, [storageId]);
    const data = await this.receiveData();
    await this.receiveResponse();
    return this._parseStorageInfo(data.payload);
  }

  async getObjectHandles(storageId, formatCode = 0, parent = 0) {
    await this.sendCommand(OperationCode.GetObjectHandles, [storageId, formatCode, parent]);
    const data = await this.receiveData();
    await this.receiveResponse();
    return this._parseUint32Array(data.payload);
  }

  async getObjectInfo(objectHandle) {
    await this.sendCommand(OperationCode.GetObjectInfo, [objectHandle]);
    const data = await this.receiveData();
    await this.receiveResponse();
    return this._parseObjectInfo(data.payload);
  }

  async sendObjectInfo(storageId, parentHandle, objectInfo) {
    await this.sendCommand(OperationCode.SendObjectInfo, [storageId, parentHandle]);
    const data = this._buildObjectInfoDataset(objectInfo);
    await this.sendData(OperationCode.SendObjectInfo, data);
    const resp = await this.receiveResponse();
    // Response params: [storageId, parentHandle, objectHandle]
    return {
      storageId: resp.params[0],
      parentHandle: resp.params[1],
      objectHandle: resp.params[2],
    };
  }

  async sendObject(fileData, onProgress) {
    await this.sendCommand(OperationCode.SendObject);

    // Build data container with file contents
    const totalLength = CONTAINER_HEADER_SIZE + fileData.length;
    const header = Buffer.alloc(CONTAINER_HEADER_SIZE);
    header.writeUInt32LE(totalLength, 0);
    header.writeUInt16LE(ContainerType.DATA, 4);
    header.writeUInt16LE(OperationCode.SendObject, 6);
    header.writeUInt32LE(this.transactionId, 8);

    // Send header
    await this.transport.bulkWrite(header);

    // Send file data in chunks
    const CHUNK_SIZE = 16384;
    let sent = 0;
    while (sent < fileData.length) {
      const end = Math.min(sent + CHUNK_SIZE, fileData.length);
      const chunk = fileData.slice(sent, end);
      await this.transport.bulkWrite(chunk);
      sent = end;
      if (onProgress) onProgress(sent, fileData.length);
    }

    // If total transfer was a multiple of max packet size, send ZLP
    if (totalLength % 512 === 0) {
      await this.transport.bulkWrite(Buffer.alloc(0));
    }

    await this.receiveResponse();
  }

  async setDeviceProperty(propCode, value) {
    await this.sendCommand(0x1016, [propCode]); // SetDevicePropValue
    // Encode string as MTP string (uint8 length + UTF-16LE chars + null terminator)
    const strBuf = this._encodeMtpString(value);
    await this.sendData(0x1016, strBuf);
    await this.receiveResponse();
  }

  // --- Vendor operations for MTPZ ---

  async sendMtpzRequest(data) {
    this.transactionId++;
    const cmd = this.buildContainer(ContainerType.COMMAND, OperationCode.SendWMDRMPDAppRequest);
    await this.transport.bulkWrite(cmd);
    await this.sendData(OperationCode.SendWMDRMPDAppRequest, data);
    await this.receiveResponse();
  }

  async getMtpzResponse() {
    this.transactionId++;
    const cmd = this.buildContainer(ContainerType.COMMAND, OperationCode.GetWMDRMPDAppResponse);
    await this.transport.bulkWrite(cmd);
    const data = await this.receiveData();
    await this.receiveResponse();
    return data.payload;
  }

  async resetMtpzHandshake() {
    this.transactionId++;
    const cmd = this.buildContainer(ContainerType.COMMAND, OperationCode.EndTrustedAppSession);
    await this.transport.bulkWrite(cmd);
    await this.receiveResponse();
  }

  async enableTrustedFileOperations(hash1, hash2, hash3, hash4) {
    this.transactionId++;
    const cmd = this.buildContainer(
      ContainerType.COMMAND,
      OperationCode.EnableTrustedFilesOperations,
      [hash1, hash2, hash3, hash4]
    );
    await this.transport.bulkWrite(cmd);
    await this.receiveResponse();
  }

  // --- Data parsing helpers ---

  _parseUint32Array(buf) {
    const count = buf.readUInt32LE(0);
    const arr = [];
    for (let i = 0; i < count; i++) {
      arr.push(buf.readUInt32LE(4 + i * 4));
    }
    return arr;
  }

  _parseMtpString(buf, offset) {
    const numChars = buf.readUInt8(offset);
    if (numChars === 0) return { str: '', bytesRead: 1 };
    const str = buf.slice(offset + 1, offset + 1 + numChars * 2).toString('utf16le').replace(/\0$/, '');
    return { str, bytesRead: 1 + numChars * 2 };
  }

  _encodeMtpString(str) {
    const chars = str + '\0';
    const buf = Buffer.alloc(1 + chars.length * 2);
    buf.writeUInt8(chars.length, 0);
    buf.write(chars, 1, 'utf16le');
    return buf;
  }

  _parseDeviceInfo(buf) {
    let offset = 0;
    const standardVersion = buf.readUInt16LE(offset); offset += 2;
    const vendorExtId = buf.readUInt32LE(offset); offset += 4;
    const vendorExtVersion = buf.readUInt16LE(offset); offset += 2;
    const { str: vendorExtDesc, bytesRead: b1 } = this._parseMtpString(buf, offset); offset += b1;
    const functionalMode = buf.readUInt16LE(offset); offset += 2;

    // Skip operations/events/properties arrays for now
    return { standardVersion, vendorExtId, vendorExtVersion, vendorExtDesc, functionalMode };
  }

  _parseStorageInfo(buf) {
    let offset = 0;
    const storageType = buf.readUInt16LE(offset); offset += 2;
    const filesystemType = buf.readUInt16LE(offset); offset += 2;
    const accessCapability = buf.readUInt16LE(offset); offset += 2;
    const maxCapacityLow = buf.readUInt32LE(offset); offset += 4;
    const maxCapacityHigh = buf.readUInt32LE(offset); offset += 4;
    const freeSpaceLow = buf.readUInt32LE(offset); offset += 4;
    const freeSpaceHigh = buf.readUInt32LE(offset); offset += 4;
    const freeSpaceInImages = buf.readUInt32LE(offset); offset += 4;
    const { str: storageDescription } = this._parseMtpString(buf, offset);

    const maxCapacity = BigInt(maxCapacityHigh) * BigInt(0x100000000) + BigInt(maxCapacityLow);
    const freeSpace = BigInt(freeSpaceHigh) * BigInt(0x100000000) + BigInt(freeSpaceLow);

    return {
      storageType, filesystemType, accessCapability,
      maxCapacity: Number(maxCapacity),
      freeSpace: Number(freeSpace),
      storageDescription,
    };
  }

  _parseObjectInfo(buf) {
    let offset = 0;
    const storageId = buf.readUInt32LE(offset); offset += 4;
    const objectFormat = buf.readUInt16LE(offset); offset += 2;
    const protectionStatus = buf.readUInt16LE(offset); offset += 2;
    const compressedSizeLow = buf.readUInt32LE(offset); offset += 4;
    const thumbFormat = buf.readUInt16LE(offset); offset += 2;
    const thumbCompressedSize = buf.readUInt32LE(offset); offset += 4;
    const thumbPixWidth = buf.readUInt32LE(offset); offset += 4;
    const thumbPixHeight = buf.readUInt32LE(offset); offset += 4;
    const imagePixWidth = buf.readUInt32LE(offset); offset += 4;
    const imagePixHeight = buf.readUInt32LE(offset); offset += 4;
    const imageBitDepth = buf.readUInt32LE(offset); offset += 4;
    const parentObject = buf.readUInt32LE(offset); offset += 4;
    const associationType = buf.readUInt16LE(offset); offset += 2;
    const associationDesc = buf.readUInt32LE(offset); offset += 4;
    const sequenceNumber = buf.readUInt32LE(offset); offset += 4;
    const { str: filename, bytesRead: b1 } = this._parseMtpString(buf, offset); offset += b1;

    return {
      storageId, objectFormat, protectionStatus,
      compressedSize: compressedSizeLow,
      parentObject, filename,
    };
  }

  _buildObjectInfoDataset(info) {
    // Build the ObjectInfo dataset for SendObjectInfo
    // Fixed fields (52 bytes) + filename string + capture date + modification date
    const filenameBuf = this._encodeMtpString(info.filename);
    const emptyDate = this._encodeMtpString('');

    const fixedSize = 52;
    const totalSize = fixedSize + filenameBuf.length + emptyDate.length * 2;
    const buf = Buffer.alloc(totalSize);
    let offset = 0;

    buf.writeUInt32LE(info.storageId || 0, offset); offset += 4;            // StorageID
    buf.writeUInt16LE(info.objectFormat || ObjectFormat.Undefined, offset); offset += 2; // ObjectFormat
    buf.writeUInt16LE(0, offset); offset += 2;                              // ProtectionStatus
    buf.writeUInt32LE(info.compressedSize || 0, offset); offset += 4;       // CompressedSize
    buf.writeUInt16LE(0, offset); offset += 2;                              // ThumbFormat
    buf.writeUInt32LE(0, offset); offset += 4;                              // ThumbCompressedSize
    buf.writeUInt32LE(0, offset); offset += 4;                              // ThumbPixWidth
    buf.writeUInt32LE(0, offset); offset += 4;                              // ThumbPixHeight
    buf.writeUInt32LE(0, offset); offset += 4;                              // ImagePixWidth
    buf.writeUInt32LE(0, offset); offset += 4;                              // ImagePixHeight
    buf.writeUInt32LE(0, offset); offset += 4;                              // ImageBitDepth
    buf.writeUInt32LE(info.parentObject || 0, offset); offset += 4;         // ParentObject
    buf.writeUInt16LE(0, offset); offset += 2;                              // AssociationType
    buf.writeUInt32LE(0, offset); offset += 4;                              // AssociationDesc
    buf.writeUInt32LE(0, offset); offset += 4;                              // SequenceNumber

    filenameBuf.copy(buf, offset); offset += filenameBuf.length;
    emptyDate.copy(buf, offset); offset += emptyDate.length; // capture date
    emptyDate.copy(buf, offset); // modification date

    return buf;
  }
}

module.exports = { MtpProtocol };
```

**Step 3: Commit**

```bash
git add src/main/zune/mtp-constants.js src/main/zune/mtp-protocol.js
git commit -m "feat(zune): add MTP constants and protocol layer with container encoding"
```

---

### Task 3: MTPZ keys and authentication

**Files:**
- Create: `src/main/zune/mtpz-keys.js`
- Create: `src/main/zune/mtpz-auth.js`

**Step 1: Create mtpz-keys.js**

Fetch the `.mtpz-data` file content from the libmtp-zune repo and parse it.

Run: `curl -s https://raw.githubusercontent.com/kbhomes/libmtp-zune/master/src/.mtpz-data`

Take the 5 lines and create `src/main/zune/mtpz-keys.js`:

```javascript
// MTPZ authentication keys extracted from libmtp-zune project
// https://github.com/kbhomes/libmtp-zune/blob/master/src/.mtpz-data
// These are constant across all Zune devices ever manufactured.
//
// Line 1: RSA public exponent (hex string)
// Line 2: AES-128 encryption key (hex string → 16 bytes)
// Line 3: RSA modulus (hex string)
// Line 4: RSA private key (hex string)
// Line 5: Certificate chain blob (hex string → bytes)

const MTPZ_PUBLIC_EXPONENT = '<LINE 1 FROM .mtpz-data>';
const MTPZ_MODULUS = '<LINE 3 FROM .mtpz-data>';
const MTPZ_PRIVATE_KEY = '<LINE 4 FROM .mtpz-data>';

function hexToBytes(hex) {
  const buf = Buffer.alloc(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    buf[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return buf;
}

const MTPZ_ENCRYPTION_KEY = hexToBytes('<LINE 2 FROM .mtpz-data>');
const MTPZ_CERTIFICATES = hexToBytes('<LINE 5 FROM .mtpz-data>');

module.exports = {
  MTPZ_PUBLIC_EXPONENT,
  MTPZ_MODULUS,
  MTPZ_PRIVATE_KEY,
  MTPZ_ENCRYPTION_KEY,
  MTPZ_CERTIFICATES,
  hexToBytes,
};
```

Note: Replace the `<LINE N>` placeholders with the actual hex strings from the curl output.

**Step 2: Create mtpz-auth.js**

Create `src/main/zune/mtpz-auth.js` implementing the 6-step MTPZ handshake:

```javascript
const crypto = require('crypto');
const { DeviceProperty } = require('./mtp-constants');
const keys = require('./mtpz-keys');

class MtpzAuth {
  constructor(mtpProtocol) {
    this.mtp = mtpProtocol;
    this.rsaKey = this._buildRsaPrivateKey();
  }

  async authenticate() {
    // Step 1: Set session initiator
    await this.mtp.setDeviceProperty(
      DeviceProperty.SessionInitiatorInfo,
      'ZuneExplorer/1.0 - MTPZ'
    );

    // Step 2: Reset any previous handshake
    await this.mtp.resetMtpzHandshake();

    // Step 3: Build and send application certificate message (785 bytes)
    const { message: certMsg, random } = this._buildAppCertificateMessage();
    await this.mtp.sendMtpzRequest(Buffer.from(certMsg));

    // Step 4: Receive and validate device response
    const response = await this.mtp.getMtpzResponse();
    const { macHash } = this._parseDeviceResponse(response, random);

    // Step 5: Send confirmation
    const confirmation = this._buildConfirmation(macHash);
    await this.mtp.sendMtpzRequest(confirmation);

    // Step 6: Enable trusted file operations
    await this._enableTrusted(macHash);

    return true;
  }

  _buildRsaPrivateKey() {
    // Build RSA key from raw hex components
    const n = BigInt('0x' + keys.MTPZ_MODULUS);
    const d = BigInt('0x' + keys.MTPZ_PRIVATE_KEY);
    const e = BigInt('0x' + keys.MTPZ_PUBLIC_EXPONENT);
    return { n, d, e, nBytes: keys.hexToBytes(keys.MTPZ_MODULUS) };
  }

  _rsaRawPrivate(data) {
    // Raw RSA private key operation: m^d mod n
    // Convert data buffer to BigInt
    let m = BigInt(0);
    for (const byte of data) {
      m = (m << BigInt(8)) | BigInt(byte);
    }
    // Modular exponentiation
    const result = this._modPow(m, this.rsaKey.d, this.rsaKey.n);
    // Convert back to 128-byte buffer
    const buf = Buffer.alloc(128);
    let val = result;
    for (let i = 127; i >= 0; i--) {
      buf[i] = Number(val & BigInt(0xFF));
      val >>= BigInt(8);
    }
    return buf;
  }

  _modPow(base, exp, mod) {
    let result = BigInt(1);
    base = base % mod;
    while (exp > BigInt(0)) {
      if (exp & BigInt(1)) {
        result = (result * base) % mod;
      }
      exp >>= BigInt(1);
      base = (base * base) % mod;
    }
    return result;
  }

  _mgf1Sha1(seed, length) {
    // MGF1 mask generation function using SHA-1 (PKCS#1 v2.1)
    const iterations = Math.ceil(length / 20) + 1;
    const output = Buffer.alloc(iterations * 20);
    for (let i = 0; i < iterations; i++) {
      const counterBuf = Buffer.alloc(4);
      counterBuf.writeUInt32BE(i, 0);
      const hash = crypto.createHash('sha1')
        .update(Buffer.isBuffer(seed) ? seed : Buffer.from(seed))
        .update(counterBuf)
        .digest();
      hash.copy(output, i * 20);
    }
    return output.slice(0, length);
  }

  _buildAppCertificateMessage() {
    // Build 785-byte application certificate message
    const certs = keys.MTPZ_CERTIFICATES;
    const certsLen = certs.length;
    const random = crypto.randomBytes(16);

    // Message structure:
    // [0]    = 0x02 (TLV type)
    // [1]    = 0x01 (message type: app cert)
    // [2]    = 0x01 (sub-type)
    // [3-4]  = 0x00, 0x00 (padding)
    // [5-6]  = certificate length (big-endian uint16)
    // [7..7+certsLen-1] = certificate data
    // next 2 bytes = 0x00, 0x10 (random length = 16)
    // next 16 bytes = random data
    // next 3 bytes = 0x01, 0x00, 0x80 (signature header)
    // next 128 bytes = RSA signature

    const preSignLen = 7 + certsLen + 2 + 16;
    const totalLen = preSignLen + 3 + 128;
    const msg = Buffer.alloc(totalLen);

    let offset = 0;
    msg[offset++] = 0x02;
    msg[offset++] = 0x01;
    msg[offset++] = 0x01;
    msg[offset++] = 0x00;
    msg[offset++] = 0x00;
    msg.writeUInt16BE(certsLen, offset); offset += 2;
    certs.copy(msg, offset); offset += certsLen;
    msg[offset++] = 0x00;
    msg[offset++] = 0x10;
    random.copy(msg, offset); offset += 16;

    // Build PSS-like RSA signature
    // Hash bytes 2..preSignLen (the cert + random portion)
    const hashInput = msg.slice(2, preSignLen);

    // Double SHA-1 with padding
    const v16 = Buffer.alloc(28);
    const innerHash = crypto.createHash('sha1').update(hashInput).digest();
    innerHash.copy(v16, 8);

    const hash = crypto.createHash('sha1').update(v16).digest();

    // Build EMSA-PSS block
    const mask = this._mgf1Sha1(hash, 107);
    const odata = Buffer.alloc(128);
    odata[106] = 0x01;
    hash.copy(odata, 107); // hash at bytes 107..126
    for (let i = 0; i < 107; i++) odata[i] ^= mask[i];
    odata[0] &= 0x7F;
    odata[127] = 0xBC;

    // RSA sign (raw private key operation)
    const signature = this._rsaRawPrivate(odata);

    // Append signature header and signature
    msg[offset++] = 0x01;
    msg[offset++] = 0x00;
    msg[offset++] = 0x80;
    signature.copy(msg, offset);

    return { message: msg, random };
  }

  _parseDeviceResponse(response, sentRandom) {
    // Verify markers
    if (response[0] !== 0x02 || response[1] !== 0x02) {
      throw new Error('Invalid MTPZ response marker');
    }
    if (response[3] !== 0x80) {
      throw new Error('Invalid RSA block length marker');
    }

    // Extract 128-byte RSA-encrypted block
    const rsaBlock = response.slice(4, 132);

    // Decrypt with RSA private key
    const decrypted = this._rsaRawPrivate(rsaBlock);

    // OAEP-like unmasking
    // decrypted[0] should be 0x00
    // decrypted[1..20] = masked seed
    // decrypted[21..127] = masked data

    // Unmask seed: seed = maskedSeed XOR MGF(maskedData, 20)
    const seedMask = this._mgf1Sha1(decrypted.slice(21, 128), 20);
    for (let i = 0; i < 20; i++) decrypted[i + 1] ^= seedMask[i];

    // Unmask data: data = maskedData XOR MGF(seed, 107)
    const dataMask = this._mgf1Sha1(decrypted.slice(1, 21), 107);
    for (let i = 0; i < 107; i++) decrypted[i + 21] ^= dataMask[i];

    // Extract AES session key from decrypted OAEP data
    const hashKey = decrypted.slice(112, 128);

    // Verify markers for AES-CBC block
    if (response[134] !== 0x03 || response[135] !== 0x40) {
      throw new Error('Invalid AES block markers in MTPZ response');
    }

    // Decrypt 832-byte AES-CBC block
    const encryptedBlock = response.slice(136, 136 + 832);
    const decipher = crypto.createDecipheriv('aes-128-cbc', hashKey, Buffer.alloc(16));
    decipher.setAutoPadding(false);
    const decryptedBlock = Buffer.concat([
      decipher.update(encryptedBlock),
      decipher.final()
    ]);

    // Parse the decrypted block
    let offset = 1; // skip first byte
    const certsLength = decryptedBlock.readUInt32BE(offset); offset += 4;
    offset += certsLength; // skip device certs

    const randLength = decryptedBlock.readUInt16BE(offset); offset += 2;
    const echoedRandom = decryptedBlock.slice(offset, offset + randLength); offset += randLength;

    // Verify echoed random matches what we sent
    if (!sentRandom.equals(echoedRandom)) {
      throw new Error('MTPZ random verification failed - device echoed wrong random');
    }

    const devRandLength = decryptedBlock.readUInt16BE(offset); offset += 2;
    offset += devRandLength; // skip device random

    offset += 1; // skip marker
    const sigLength = decryptedBlock.readUInt16BE(offset); offset += 2;
    offset += sigLength; // skip signature

    offset += 1; // skip marker
    const macHashLength = decryptedBlock.readUInt16BE(offset); offset += 2;
    const macHash = decryptedBlock.slice(offset, offset + macHashLength);

    return { macHash };
  }

  _aesCmac(key, data) {
    // AES-CMAC (RFC 4493)
    const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
    cipher.setAutoPadding(false);

    // Generate subkeys
    const zeros = Buffer.alloc(16);
    const L = cipher.update(zeros);

    // K1 = double(L) in GF(2^128)
    const K1 = Buffer.alloc(16);
    for (let i = 0; i < 15; i++) {
      K1[i] = ((L[i] << 1) | (L[i + 1] >> 7)) & 0xFF;
    }
    K1[15] = (L[15] << 1) & 0xFF;
    if (L[0] & 0x80) K1[15] ^= 0x87;

    // K2 = double(K1)
    const K2 = Buffer.alloc(16);
    for (let i = 0; i < 15; i++) {
      K2[i] = ((K1[i] << 1) | (K1[i + 1] >> 7)) & 0xFF;
    }
    K2[15] = (K1[15] << 1) & 0xFF;
    if (K1[0] & 0x80) K2[15] ^= 0x87;

    // Apply subkey to last block
    const padded = Buffer.alloc(16);
    if (data.length === 16) {
      for (let i = 0; i < 16; i++) padded[i] = data[i] ^ K1[i];
    } else {
      data.copy(padded, 0, 0, data.length);
      padded[data.length] = 0x80;
      for (let i = 0; i < 16; i++) padded[i] ^= K2[i];
    }

    // Final AES-CBC encrypt
    const cipher2 = crypto.createCipheriv('aes-128-ecb', key, null);
    cipher2.setAutoPadding(false);
    return cipher2.update(padded);
  }

  _buildConfirmation(macHash) {
    // Build 20-byte confirmation message
    const msg = Buffer.alloc(20);
    msg[0] = 0x02;
    msg[1] = 0x03;
    msg[2] = 0x00;
    msg[3] = 0x10; // payload length = 16

    // CMAC of seed (16 zeros with last byte = 0x01) using macHash as key
    const seed = Buffer.alloc(16);
    seed[15] = 0x01;
    const cmac = this._aesCmac(macHash.slice(0, 16), seed);
    cmac.copy(msg, 4);

    return msg;
  }

  async _enableTrusted(macHash) {
    // Compute CMAC of macCount using hash as key
    const hashKey = macHash.slice(0, 16);
    const macCount = macHash.readUInt32LE(16);
    const macCountBuf = Buffer.alloc(4);
    macCountBuf.writeUInt32LE(macCount, 0);

    const mch = this._aesCmac(hashKey, macCountBuf);

    // Send as 4 big-endian uint32 parameters
    await this.mtp.enableTrustedFileOperations(
      mch.readUInt32BE(0),
      mch.readUInt32BE(4),
      mch.readUInt32BE(8),
      mch.readUInt32BE(12)
    );
  }
}

module.exports = { MtpzAuth };
```

**Step 3: Commit**

```bash
git add src/main/zune/mtpz-keys.js src/main/zune/mtpz-auth.js
git commit -m "feat(zune): add MTPZ authentication with RSA/AES/CMAC handshake"
```

---

### Task 4: Zune Manager — orchestrator and transfer queue

**Files:**
- Create: `src/main/zune/zune-manager.js`

**Step 1: Create zune-manager.js**

```javascript
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs').promises;
const { UsbTransport, ZUNE_VENDOR_ID, ZUNE_DEVICES } = require('./usb-transport');
const { MtpProtocol } = require('./mtp-protocol');
const { MtpzAuth } = require('./mtpz-auth');
const { ExtensionToFormat, ObjectFormat } = require('./mtp-constants');

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
    this.transport.startHotplugDetection();
    this.transport.onAttach((info) => this._handleAttach(info));
    this.transport.onDetach(() => this._handleDetach());

    // Check if already plugged in
    const found = this.transport.findZune();
    if (found) {
      this._handleAttach(found);
    }
  }

  stop() {
    this.transport.stopHotplugDetection();
    this.disconnect();
  }

  async _handleAttach(info) {
    this.emit('status', { state: 'connecting', model: info.model });

    try {
      this.transport.open(ZUNE_VENDOR_ID, info.productId);
      this.mtp = new MtpProtocol(this.transport);
      this.auth = new MtpzAuth(this.mtp);

      // MTP session
      await this.mtp.openSession(1);

      // MTPZ authentication
      await this.auth.authenticate();

      // Get device info
      const deviceInfo = await this.mtp.getDeviceInfo();

      // Get storage
      const storageIds = await this.mtp.getStorageIDs();
      this.storageId = storageIds[0];
      const storageInfo = await this.mtp.getStorageInfo(this.storageId);

      this.deviceInfo = {
        model: info.model,
        vendorExtDesc: deviceInfo.vendorExtDesc,
      };
      this.storageInfo = {
        maxCapacity: storageInfo.maxCapacity,
        freeSpace: storageInfo.freeSpace,
        description: storageInfo.storageDescription,
      };
      this.connected = true;

      this.emit('status', {
        state: 'connected',
        model: info.model,
        storage: this.storageInfo,
      });
    } catch (err) {
      console.error('Zune connection failed:', err);
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
    if (!this.connected) return null;
    return {
      ...this.deviceInfo,
      storage: this.storageInfo,
    };
  }

  async sendFiles(filePaths) {
    if (!this.connected || this.transferring) {
      throw new Error(this.transferring ? 'Transfer already in progress' : 'Zune not connected');
    }

    this.transferring = true;
    this.cancelRequested = false;
    const totalFiles = filePaths.length;
    let completedFiles = 0;

    try {
      for (let i = 0; i < filePaths.length; i++) {
        if (this.cancelRequested) {
          this.emit('transfer-progress', {
            state: 'cancelled',
            fileIndex: i,
            totalFiles,
          });
          break;
        }

        const filePath = filePaths[i];
        const fileName = path.basename(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const format = ExtensionToFormat[ext] || ObjectFormat.Undefined;

        // Read file
        const fileData = await fs.readFile(filePath);

        this.emit('transfer-progress', {
          state: 'sending',
          fileName,
          fileIndex: i,
          totalFiles,
          bytesTransferred: 0,
          totalBytes: fileData.length,
        });

        // SendObjectInfo
        const result = await this.mtp.sendObjectInfo(this.storageId, 0, {
          objectFormat: format,
          compressedSize: fileData.length,
          filename: fileName,
        });

        // SendObject with progress
        await this.mtp.sendObject(fileData, (sent, total) => {
          this.emit('transfer-progress', {
            state: 'sending',
            fileName,
            fileIndex: i,
            totalFiles,
            bytesTransferred: sent,
            totalBytes: total,
          });
        });

        completedFiles++;
      }

      // Refresh storage info
      if (this.connected && this.storageId) {
        this.storageInfo = await this.mtp.getStorageInfo(this.storageId);
      }

      this.emit('transfer-progress', {
        state: 'complete',
        completedFiles,
        totalFiles,
        storage: this.storageInfo,
      });
    } catch (err) {
      console.error('Transfer error:', err);
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
```

**Step 2: Commit**

```bash
git add src/main/zune/zune-manager.js
git commit -m "feat(zune): add ZuneManager orchestrator with transfer queue"
```

---

### Task 5: Wire up IPC handlers in main.js and preload.js

**Files:**
- Modify: `src/main/main.js`
- Modify: `src/main/preload.js`

**Step 1: Add Zune IPC to main.js**

Add after the existing `require` statements at the top of `main.js`:

```javascript
const { ZuneManager } = require('./zune/zune-manager');
const zuneManager = new ZuneManager();
```

Add in the `app.whenReady().then()` callback, after `createWindow()`:

```javascript
  // Start Zune USB detection
  zuneManager.start();

  // Forward Zune events to renderer
  zuneManager.on('status', (status) => {
    if (mainWindow) mainWindow.webContents.send('zune-status', status);
  });
  zuneManager.on('transfer-progress', (progress) => {
    if (mainWindow) mainWindow.webContents.send('zune-transfer-progress', progress);
  });
```

Add new IPC handlers alongside the existing ones:

```javascript
ipcMain.handle('zune-device-info', async () => {
  return zuneManager.getDeviceInfo();
});

ipcMain.handle('zune-send-files', async (event, filePaths) => {
  try {
    await zuneManager.sendFiles(filePaths);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('zune-cancel-transfer', async () => {
  zuneManager.cancelTransfer();
  return { success: true };
});
```

Add cleanup in the `window-all-closed` handler:

```javascript
app.on('window-all-closed', () => {
  zuneManager.stop();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
```

**Step 2: Add Zune IPC to preload.js**

Add to the `contextBridge.exposeInMainWorld('electronAPI', { ... })` object:

```javascript
  // Zune sync
  zuneDeviceInfo: () => ipcRenderer.invoke('zune-device-info'),
  zuneSendFiles: (paths) => ipcRenderer.invoke('zune-send-files', paths),
  zuneCancelTransfer: () => ipcRenderer.invoke('zune-cancel-transfer'),
  onZuneStatus: (callback) => ipcRenderer.on('zune-status', (event, status) => callback(status)),
  onZuneTransferProgress: (callback) => ipcRenderer.on('zune-transfer-progress', (event, progress) => callback(progress)),
```

**Step 3: Commit**

```bash
git add src/main/main.js src/main/preload.js
git commit -m "feat(zune): wire up Zune IPC handlers in main process and preload"
```

---

### Task 6: Sync panel HTML and CSS

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/assets/css/styles.css`

**Step 1: Add sync panel HTML to index.html**

Add before the `<div class="context-menu">` element:

```html
    <!-- Zune Sync Panel -->
    <div class="zune-sync-panel" id="zune-sync-panel">
        <div class="zune-sync-header">
            <h1 class="zune-sync-title" id="zune-sync-title">zune hd</h1>
            <p class="zune-sync-subtitle" id="zune-sync-subtitle">connecting...</p>
        </div>

        <div class="zune-sync-storage" id="zune-sync-storage" style="display:none">
            <div class="zune-storage-bar">
                <div class="zune-storage-fill" id="zune-storage-fill"></div>
            </div>
            <span class="zune-storage-text" id="zune-storage-text">0 GB free</span>
        </div>

        <div class="zune-sync-idle" id="zune-sync-idle" style="display:none">
            <div class="zune-drop-zone" id="zune-drop-zone">
                <p class="zune-drop-text">drag files here</p>
                <p class="zune-drop-subtext">or use the buttons below</p>
            </div>
            <div class="zune-sync-buttons">
                <button class="zune-sync-btn" id="zune-sync-music">sync music</button>
                <button class="zune-sync-btn" id="zune-sync-videos">sync videos</button>
                <button class="zune-sync-btn" id="zune-sync-pictures">sync pictures</button>
            </div>
        </div>

        <div class="zune-sync-progress" id="zune-sync-progress" style="display:none">
            <p class="zune-progress-count" id="zune-progress-count">sending 0 of 0</p>
            <p class="zune-progress-file" id="zune-progress-file"></p>
            <div class="zune-progress-bar">
                <div class="zune-progress-fill" id="zune-progress-fill"></div>
            </div>
            <p class="zune-progress-bytes" id="zune-progress-bytes"></p>
            <p class="zune-progress-label">overall</p>
            <div class="zune-progress-bar">
                <div class="zune-progress-overall" id="zune-progress-overall"></div>
            </div>
            <button class="zune-cancel-btn" id="zune-cancel-btn">cancel</button>
        </div>

        <div class="zune-sync-complete" id="zune-sync-complete" style="display:none">
            <p class="zune-complete-text" id="zune-complete-text">0 files synced</p>
        </div>
    </div>

    <button class="zune-toggle-btn" id="zune-toggle-btn" style="display:none" title="Zune Sync">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="5" y="2" width="14" height="20" rx="2"/>
            <circle cx="12" cy="16" r="2"/>
            <line x1="9" y1="6" x2="15" y2="6"/>
        </svg>
    </button>
```

**Step 2: Add sync panel CSS to styles.css**

Append to the end of `styles.css`:

```css
/* === Zune Sync Panel === */

.zune-toggle-btn {
    position: fixed;
    bottom: 80px;
    right: 20px;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: rgba(255, 105, 0, 0.2);
    border: 1px solid var(--zune-orange);
    color: var(--zune-orange);
    cursor: pointer;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background var(--transition-duration) var(--transition-easing);
}

.zune-toggle-btn:hover {
    background: rgba(255, 105, 0, 0.4);
}

.zune-toggle-btn.pulse {
    animation: zunePulse 2s ease-in-out infinite;
}

@keyframes zunePulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(255, 105, 0, 0.4); }
    50% { box-shadow: 0 0 0 10px rgba(255, 105, 0, 0); }
}

.zune-sync-panel {
    position: fixed;
    top: 0;
    right: -320px;
    width: 300px;
    height: 100vh;
    background: linear-gradient(180deg, #0a0a0a 0%, #000000 100%);
    border-left: 1px solid #1a1a1a;
    z-index: 900;
    padding: 40px 24px;
    display: flex;
    flex-direction: column;
    gap: 24px;
    transition: right var(--transition-duration) var(--transition-easing);
    overflow-y: auto;
}

.zune-sync-panel.open {
    right: 0;
}

.zune-sync-title {
    font-size: 36px;
    font-weight: 200;
    letter-spacing: -1px;
    color: var(--zune-text);
    text-transform: lowercase;
}

.zune-sync-subtitle {
    font-size: 13px;
    color: var(--zune-text-dim);
    margin-top: 4px;
}

.zune-sync-storage {
    margin-top: 8px;
}

.zune-storage-bar {
    height: 4px;
    background: #1a1a1a;
    border-radius: 2px;
    overflow: hidden;
}

.zune-storage-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--zune-orange), var(--zune-magenta));
    border-radius: 2px;
    transition: width 0.6s var(--transition-easing);
}

.zune-storage-text {
    font-size: 12px;
    color: var(--zune-text-secondary);
    margin-top: 6px;
    display: block;
}

.zune-drop-zone {
    border: 1px dashed #333;
    border-radius: 8px;
    padding: 32px 16px;
    text-align: center;
    transition: border-color 0.2s, background 0.2s;
}

.zune-drop-zone.dragover {
    border-color: var(--zune-orange);
    background: rgba(255, 105, 0, 0.05);
}

.zune-drop-text {
    font-size: 15px;
    color: var(--zune-text-secondary);
    font-weight: 300;
}

.zune-drop-subtext {
    font-size: 12px;
    color: var(--zune-text-dim);
    margin-top: 6px;
}

.zune-sync-buttons {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 16px;
}

.zune-sync-btn {
    background: none;
    border: 1px solid #333;
    color: var(--zune-text-secondary);
    padding: 12px 16px;
    font-size: 14px;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    transition: border-color 0.2s, color 0.2s;
    text-transform: lowercase;
}

.zune-sync-btn:hover {
    border-color: var(--zune-orange);
    color: var(--zune-text);
}

.zune-progress-count {
    font-size: 14px;
    color: var(--zune-text-secondary);
}

.zune-progress-file {
    font-size: 13px;
    color: var(--zune-text);
    margin-top: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.zune-progress-bar {
    height: 3px;
    background: #1a1a1a;
    border-radius: 2px;
    overflow: hidden;
    margin-top: 8px;
}

.zune-progress-fill,
.zune-progress-overall {
    height: 100%;
    background: var(--zune-orange);
    border-radius: 2px;
    transition: width 0.15s linear;
    width: 0%;
}

.zune-progress-bytes {
    font-size: 11px;
    color: var(--zune-text-dim);
    margin-top: 4px;
}

.zune-progress-label {
    font-size: 12px;
    color: var(--zune-text-dim);
    margin-top: 16px;
}

.zune-cancel-btn {
    background: none;
    border: 1px solid #333;
    color: var(--zune-text-dim);
    padding: 8px 16px;
    font-size: 13px;
    font-family: inherit;
    cursor: pointer;
    margin-top: 16px;
    text-transform: lowercase;
    transition: border-color 0.2s, color 0.2s;
}

.zune-cancel-btn:hover {
    border-color: #ff3333;
    color: #ff3333;
}

.zune-complete-text {
    font-size: 16px;
    color: var(--zune-orange);
    font-weight: 300;
}
```

**Step 3: Commit**

```bash
git add src/renderer/index.html src/assets/css/styles.css
git commit -m "feat(zune): add sync panel HTML and CSS with slide-out design"
```

---

### Task 7: Sync panel renderer logic

**Files:**
- Modify: `src/assets/js/renderer.js`

**Step 1: Add Zune sync panel logic to renderer.js**

Add a new `ZuneSyncPanel` class. Add this **before** the `ZuneExplorer` class, and load it from the constructor:

In the `ZuneExplorer` constructor, after `this.audioPlayer = null;` add:

```javascript
        this.zunePanel = null;
```

In the `init()` method, after `this.scanFileSystem();` add:

```javascript
        this.zunePanel = new ZuneSyncPanel(this);
```

Add the following class before the `ZuneExplorer` class definition:

```javascript
class ZuneSyncPanel {
    constructor(explorer) {
        this.explorer = explorer;
        this.open = false;
        this.state = 'disconnected'; // disconnected, connecting, connected, transferring, complete

        this.panel = document.getElementById('zune-sync-panel');
        this.toggleBtn = document.getElementById('zune-toggle-btn');
        this.dropZone = document.getElementById('zune-drop-zone');

        this._bindEvents();
        this._listenForZune();
    }

    _bindEvents() {
        // Toggle panel
        this.toggleBtn.addEventListener('click', () => this.toggle());

        // Drop zone
        this.dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            this.dropZone.classList.add('dragover');
        });
        this.dropZone.addEventListener('dragleave', () => {
            this.dropZone.classList.remove('dragover');
        });
        this.dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            this.dropZone.classList.remove('dragover');
            // Files from drag will be handled via dataTransfer
            const paths = [];
            if (e.dataTransfer.files.length > 0) {
                for (const f of e.dataTransfer.files) paths.push(f.path);
            }
            if (paths.length > 0) this._sendFiles(paths);
        });

        // Quick sync buttons
        document.getElementById('zune-sync-music').addEventListener('click', () => {
            const paths = this.explorer.categorizedFiles.music.map(f => f.path);
            if (paths.length > 0) this._sendFiles(paths);
        });
        document.getElementById('zune-sync-videos').addEventListener('click', () => {
            const paths = this.explorer.categorizedFiles.videos.map(f => f.path);
            if (paths.length > 0) this._sendFiles(paths);
        });
        document.getElementById('zune-sync-pictures').addEventListener('click', () => {
            const paths = this.explorer.categorizedFiles.pictures.map(f => f.path);
            if (paths.length > 0) this._sendFiles(paths);
        });

        // Cancel
        document.getElementById('zune-cancel-btn').addEventListener('click', () => {
            window.electronAPI.zuneCancelTransfer();
        });
    }

    _listenForZune() {
        window.electronAPI.onZuneStatus((status) => {
            this.state = status.state;
            this._updateUI(status);
        });

        window.electronAPI.onZuneTransferProgress((progress) => {
            this._updateProgress(progress);
        });
    }

    toggle() {
        this.open = !this.open;
        this.panel.classList.toggle('open', this.open);
    }

    show() {
        this.open = true;
        this.panel.classList.add('open');
    }

    _updateUI(status) {
        const title = document.getElementById('zune-sync-title');
        const subtitle = document.getElementById('zune-sync-subtitle');
        const storageEl = document.getElementById('zune-sync-storage');
        const idleEl = document.getElementById('zune-sync-idle');
        const progressEl = document.getElementById('zune-sync-progress');
        const completeEl = document.getElementById('zune-sync-complete');

        // Hide all state sections
        storageEl.style.display = 'none';
        idleEl.style.display = 'none';
        progressEl.style.display = 'none';
        completeEl.style.display = 'none';

        switch (status.state) {
            case 'connecting':
                this.toggleBtn.style.display = 'flex';
                this.toggleBtn.classList.add('pulse');
                title.textContent = (status.model || 'zune').toLowerCase();
                subtitle.textContent = 'connecting...';
                this.show();
                break;

            case 'connected':
                this.toggleBtn.classList.remove('pulse');
                title.textContent = (status.model || 'zune').toLowerCase();
                subtitle.textContent = 'connected';
                if (status.storage) {
                    this._updateStorage(status.storage);
                    storageEl.style.display = 'block';
                }
                idleEl.style.display = 'block';
                break;

            case 'disconnected':
                this.toggleBtn.style.display = 'none';
                this.toggleBtn.classList.remove('pulse');
                this.open = false;
                this.panel.classList.remove('open');
                break;

            case 'error':
                subtitle.textContent = 'error: ' + (status.error || 'unknown');
                break;
        }
    }

    _updateStorage(storage) {
        const fill = document.getElementById('zune-storage-fill');
        const text = document.getElementById('zune-storage-text');
        const usedPercent = ((storage.maxCapacity - storage.freeSpace) / storage.maxCapacity) * 100;
        fill.style.width = usedPercent.toFixed(1) + '%';
        const freeGB = (storage.freeSpace / (1024 * 1024 * 1024)).toFixed(1);
        text.textContent = freeGB + ' GB free';
    }

    _updateProgress(progress) {
        const countEl = document.getElementById('zune-progress-count');
        const fileEl = document.getElementById('zune-progress-file');
        const fillEl = document.getElementById('zune-progress-fill');
        const overallEl = document.getElementById('zune-progress-overall');
        const bytesEl = document.getElementById('zune-progress-bytes');
        const idleEl = document.getElementById('zune-sync-idle');
        const progressEl = document.getElementById('zune-sync-progress');
        const completeEl = document.getElementById('zune-sync-complete');

        switch (progress.state) {
            case 'sending':
                idleEl.style.display = 'none';
                progressEl.style.display = 'block';
                completeEl.style.display = 'none';

                countEl.textContent = `sending ${progress.fileIndex + 1} of ${progress.totalFiles}`;
                fileEl.textContent = progress.fileName;

                const filePercent = progress.totalBytes > 0
                    ? (progress.bytesTransferred / progress.totalBytes) * 100 : 0;
                fillEl.style.width = filePercent.toFixed(1) + '%';

                const overallPercent = ((progress.fileIndex + filePercent / 100) / progress.totalFiles) * 100;
                overallEl.style.width = overallPercent.toFixed(1) + '%';

                const sentMB = (progress.bytesTransferred / (1024 * 1024)).toFixed(1);
                const totalMB = (progress.totalBytes / (1024 * 1024)).toFixed(1);
                bytesEl.textContent = `${sentMB} / ${totalMB} MB`;
                break;

            case 'complete':
                progressEl.style.display = 'none';
                completeEl.style.display = 'block';
                document.getElementById('zune-complete-text').textContent =
                    `${progress.completedFiles} files synced`;
                if (progress.storage) this._updateStorage(progress.storage);

                // Fade back to idle after 3 seconds
                setTimeout(() => {
                    completeEl.style.display = 'none';
                    idleEl.style.display = 'block';
                }, 3000);
                break;

            case 'cancelled':
                progressEl.style.display = 'none';
                idleEl.style.display = 'block';
                break;

            case 'error':
                progressEl.style.display = 'none';
                idleEl.style.display = 'block';
                document.getElementById('zune-sync-subtitle').textContent =
                    'transfer error: ' + (progress.error || 'unknown');
                break;
        }
    }

    async _sendFiles(filePaths) {
        await window.electronAPI.zuneSendFiles(filePaths);
    }
}
```

**Step 2: Add "Send to Zune" to the context menu**

In `index.html`, add a new button to the context menu before the delete separator:

```html
        <button class="context-menu-item" data-action="send-to-zune" id="ctx-send-to-zune" style="display:none">Send to Zune</button>
```

In `renderer.js` in the `showContextMenu` method, add after the menu is positioned:

```javascript
        // Show/hide "Send to Zune" based on connection state
        const sendToZune = document.getElementById('ctx-send-to-zune');
        if (sendToZune) {
            sendToZune.style.display = (this.zunePanel && this.zunePanel.state === 'connected') ? 'block' : 'none';
        }
```

In the `handleContextMenuAction` method, add a new case:

```javascript
            case 'send-to-zune':
                if (this.zunePanel) {
                    await window.electronAPI.zuneSendFiles([this.selectedFile.path]);
                }
                break;
```

**Step 3: Commit**

```bash
git add src/assets/js/renderer.js src/renderer/index.html
git commit -m "feat(zune): add sync panel renderer with drag-drop, progress, context menu"
```

---

### Task 8: Electron rebuild and integration test

**Files:**
- Modify: `package.json` (if needed for electron-rebuild)

**Step 1: Rebuild native modules for Electron**

The `usb` package contains native code that needs to be compiled for Electron's Node.js version.

Run: `cd /Users/aaronnicely/zune-explorer && npx electron-rebuild`
Expected: Successful rebuild of the `usb` native module for the Electron version.

If `electron-rebuild` is not installed:
Run: `npm install --save-dev @electron/rebuild && npx @electron/rebuild`

**Step 2: Launch the app and verify no crashes**

Run: `cd /Users/aaronnicely/zune-explorer && npm run dev`

Expected:
- App launches without errors
- Console shows no `usb` module loading errors
- No sync panel visible (no Zune plugged in)

**Step 3: Plug in the Zune HD and observe**

With the app running in dev mode:
1. Plug in the Zune HD via USB
2. Expected: Toggle button appears (orange, pulsing), panel slides open showing "zune hd" / "connecting..."
3. If MTPZ auth succeeds: "connected" state with storage bar and sync buttons
4. If MTPZ auth fails: "error" message in the subtitle — this is the most likely first-run outcome and will require debugging the handshake

**Step 4: Debug MTPZ if needed**

Add `console.log` statements in `mtpz-auth.js` at each handshake step to trace where it fails. Common issues:
- Endpoint detection: wrong interface or endpoint direction
- Byte ordering: MTP uses little-endian, MTPZ certificate fields use big-endian
- RSA padding: the PSS-like signature must exactly match the C implementation
- AES-CBC: zero IV, no padding — verify `setAutoPadding(false)`

**Step 5: Test file transfer**

Once connected:
1. Click "sync music" — should start transferring scanned music files
2. Verify progress bar updates
3. Verify files appear on the Zune (disconnect and check device)

**Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix(zune): integration fixes from device testing"
```

---

### Task 9: Final cleanup and edge cases

**Files:**
- Possibly modify: any files that needed fixes during integration testing

**Step 1: Handle edge cases**

Verify and fix:
- Unplugging Zune mid-transfer gracefully cancels and shows error
- Re-plugging Zune after disconnect re-establishes connection
- Sending 0 files (empty category) shows no-op message
- Files with unsupported extensions are skipped with a warning
- Very large files (>100MB videos) transfer without timeout

**Step 2: Update electron-builder config if needed**

The `usb` native module may need special packaging. In `package.json` under `build`, add if needed:

```json
"afterSign": null,
"asar": true,
"asarUnpack": ["node_modules/usb/**"]
```

**Step 3: Final commit**

```bash
git add -A
git commit -m "feat(zune): complete Zune USB sync with edge case handling"
```
