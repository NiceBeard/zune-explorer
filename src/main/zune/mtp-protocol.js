const {
  ContainerType,
  OperationCode,
  ResponseCode,
  CONTAINER_HEADER_SIZE,
} = require('./mtp-constants.js');

// Reverse lookup for response codes so error messages are human-readable
const ResponseCodeName = Object.fromEntries(
  Object.entries(ResponseCode).map(([name, code]) => [code, name])
);

const DATA_CHUNK_SIZE = 16384;

class MtpProtocol {
  constructor(transport) {
    this.transport = transport;
    this.transactionId = 0;
    this.sessionId = 0;
  }

  // ---------------------------------------------------------------------------
  // Container encoding / decoding
  // ---------------------------------------------------------------------------

  buildContainer(type, code, params = []) {
    const length = CONTAINER_HEADER_SIZE + params.length * 4;
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

    return Buffer.concat([header, data], length);
  }

  parseContainer(buf) {
    const length = buf.readUInt32LE(0);
    const type = buf.readUInt16LE(4);
    const code = buf.readUInt16LE(6);
    const transactionId = buf.readUInt32LE(8);
    const payload = buf.slice(CONTAINER_HEADER_SIZE, length);

    const params = [];
    for (let offset = 0; offset + 4 <= payload.length; offset += 4) {
      params.push(payload.readUInt32LE(offset));
    }

    return { length, type, code, transactionId, payload, params };
  }

  // ---------------------------------------------------------------------------
  // Transport helpers
  // ---------------------------------------------------------------------------

  async sendCommand(opcode, params = []) {
    this.transactionId++;
    const container = this.buildContainer(ContainerType.COMMAND, opcode, params);
    await this.transport.bulkWrite(container);
  }

  async sendData(opcode, data) {
    // Zune requires DATA containers as two separate USB transfers:
    // 1. The 12-byte container header
    // 2. The payload bytes
    const header = Buffer.alloc(CONTAINER_HEADER_SIZE);
    header.writeUInt32LE(CONTAINER_HEADER_SIZE + data.length, 0);
    header.writeUInt16LE(ContainerType.DATA, 4);
    header.writeUInt16LE(opcode, 6);
    header.writeUInt32LE(this.transactionId, 8);

    await this.transport.bulkWrite(header);
    await this.transport.bulkWrite(data);
  }

  async receiveData() {
    const initial = await this.transport.bulkRead(512);

    const totalLength = initial.readUInt32LE(0);

    if (initial.length >= totalLength) {
      return this.parseContainer(initial.slice(0, totalLength));
    }

    const chunks = [initial];
    let received = initial.length;

    while (received < totalLength) {
      const remaining = totalLength - received;
      const readSize = Math.min(remaining, DATA_CHUNK_SIZE);
      const chunk = await this.transport.bulkRead(readSize);

      chunks.push(chunk);
      received += chunk.length;
    }

    return this.parseContainer(Buffer.concat(chunks, totalLength));
  }

  async receiveResponse() {
    const container = await this.receiveData();

    if (container.type !== ContainerType.RESPONSE) {
      throw new Error(
        `Expected RESPONSE container (type 0x0003), got type 0x${container.type.toString(16).padStart(4, '0')}`
      );
    }

    if (container.code !== ResponseCode.OK) {
      const codeName = ResponseCodeName[container.code] || `0x${container.code.toString(16).padStart(4, '0')}`;
      console.log(`MTP response: code=${codeName} txId=${container.transactionId} params=[${container.params.map(p => '0x' + p.toString(16)).join(', ')}]`);
      throw new Error(`MTP response error: ${codeName}`);
    }

    return container;
  }

  // ---------------------------------------------------------------------------
  // MTP operations
  // ---------------------------------------------------------------------------

  async openSession(sessionId = 1) {
    this.sessionId = sessionId;

    // PTP spec: TransactionID must be 0 for OpenSession (no active session)
    // Send the container directly to bypass sendCommand's auto-increment
    const container = this.buildContainer(
      ContainerType.COMMAND,
      OperationCode.OpenSession,
      [sessionId]
    );
    // transactionId is already 0 from constructor or reset
    await this.transport.bulkWrite(container);

    try {
      await this.receiveResponse();
    } catch (err) {
      // If session is already open or parameter rejected (stale session),
      // try closing the stale session and re-opening
      if (
        err.message.includes('SessionAlreadyOpen') ||
        err.message.includes('InvalidParameter')
      ) {
        console.log('MTP: stale session detected, closing and retrying...');
        this.transactionId = 0;
        await this.sendCommand(OperationCode.CloseSession);
        try {
          await this.receiveResponse();
        } catch {
          // Ignore close errors — session may not actually be open
        }

        // Retry open with TransactionID = 0
        this.transactionId = 0;
        const retry = this.buildContainer(
          ContainerType.COMMAND,
          OperationCode.OpenSession,
          [sessionId]
        );
        await this.transport.bulkWrite(retry);
        await this.receiveResponse();
      } else {
        throw err;
      }
    }

    // After successful open, transaction IDs start at 1
    this.transactionId = 0;
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
    const dataset = this._buildObjectInfoDataset(objectInfo);
    await this.sendData(OperationCode.SendObjectInfo, dataset);
    const response = await this.receiveResponse();

    return {
      storageId: response.params[0],
      parentHandle: response.params[1],
      objectHandle: response.params[2],
    };
  }

  async sendObject(fileData, onProgress) {
    await this.sendCommand(OperationCode.SendObject);

    // Build and send the data container header first
    const totalLength = CONTAINER_HEADER_SIZE + fileData.length;
    const header = Buffer.alloc(CONTAINER_HEADER_SIZE);

    header.writeUInt32LE(totalLength, 0);
    header.writeUInt16LE(ContainerType.DATA, 4);
    header.writeUInt16LE(OperationCode.SendObject, 6);
    header.writeUInt32LE(this.transactionId, 8);

    await this.transport.bulkWrite(header);

    // Send file data in chunks
    let sent = 0;

    while (sent < fileData.length) {
      const end = Math.min(sent + DATA_CHUNK_SIZE, fileData.length);
      const chunk = fileData.slice(sent, end);

      await this.transport.bulkWrite(chunk);
      sent = end;

      if (onProgress) {
        onProgress(sent, fileData.length);
      }
    }

    // Send zero-length packet if total transfer size is a multiple of 512
    if (totalLength % 512 === 0) {
      await this.transport.bulkWrite(Buffer.alloc(0));
    }

    await this.receiveResponse();
  }

  async setDeviceProperty(propCode, value) {
    await this.sendCommand(OperationCode.SetDevicePropValue, [propCode]);
    const encoded = this._encodeMtpString(value);
    await this.sendData(OperationCode.SetDevicePropValue, encoded);
    await this.receiveResponse();
  }

  async setObjectPropString(objectHandle, propCode, value) {
    await this.sendCommand(OperationCode.SetObjectPropValue, [objectHandle, propCode]);
    const encoded = this._encodeMtpString(value);
    await this.sendData(OperationCode.SetObjectPropValue, encoded);
    await this.receiveResponse();
  }

  async setObjectPropUint32(objectHandle, propCode, value) {
    await this.sendCommand(OperationCode.SetObjectPropValue, [objectHandle, propCode]);
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(value, 0);
    await this.sendData(OperationCode.SetObjectPropValue, buf);
    await this.receiveResponse();
  }

  async setObjectPropUint16(objectHandle, propCode, value) {
    await this.sendCommand(OperationCode.SetObjectPropValue, [objectHandle, propCode]);
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(value, 0);
    await this.sendData(OperationCode.SetObjectPropValue, buf);
    await this.receiveResponse();
  }

  // ---------------------------------------------------------------------------
  // MTPZ vendor operations
  // ---------------------------------------------------------------------------

  async sendMtpzRequest(data) {
    this.transactionId++;
    console.log(`MTP: sendMtpzRequest txId=${this.transactionId} dataLen=${data.length}`);
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

  // ---------------------------------------------------------------------------
  // Parsing helpers (private)
  // ---------------------------------------------------------------------------

  _parseUint32Array(buf) {
    const count = buf.readUInt32LE(0);
    const values = [];

    for (let i = 0; i < count; i++) {
      values.push(buf.readUInt32LE(4 + i * 4));
    }

    return values;
  }

  _parseMtpString(buf, offset) {
    const numChars = buf.readUInt8(offset);

    if (numChars === 0) {
      return { str: '', bytesRead: 1 };
    }

    const strBuf = buf.slice(offset + 1, offset + 1 + numChars * 2);
    let str = strBuf.toString('utf16le');

    // Strip trailing null character
    if (str.charCodeAt(str.length - 1) === 0) {
      str = str.slice(0, -1);
    }

    return { str, bytesRead: 1 + numChars * 2 };
  }

  _encodeMtpString(str) {
    const withNull = str + '\0';
    const charCount = withNull.length;
    const buf = Buffer.alloc(1 + charCount * 2);

    buf.writeUInt8(charCount, 0);
    buf.write(withNull, 1, 'utf16le');

    return buf;
  }

  _parseDeviceInfo(buf) {
    let offset = 0;

    const standardVersion = buf.readUInt16LE(offset);
    offset += 2;

    const vendorExtId = buf.readUInt32LE(offset);
    offset += 4;

    const vendorExtVersion = buf.readUInt16LE(offset);
    offset += 2;

    const vendorExtDesc = this._parseMtpString(buf, offset);
    offset += vendorExtDesc.bytesRead;

    const functionalMode = buf.readUInt16LE(offset);

    return {
      standardVersion,
      vendorExtId,
      vendorExtVersion,
      vendorExtDesc: vendorExtDesc.str,
      functionalMode,
    };
  }

  _parseStorageInfo(buf) {
    let offset = 0;

    const storageType = buf.readUInt16LE(offset);
    offset += 2;

    const filesystemType = buf.readUInt16LE(offset);
    offset += 2;

    const accessCapability = buf.readUInt16LE(offset);
    offset += 2;

    // 64-bit max capacity as two 32-bit halves
    const maxCapacityLow = buf.readUInt32LE(offset);
    offset += 4;
    const maxCapacityHigh = buf.readUInt32LE(offset);
    offset += 4;
    const maxCapacity = Number(BigInt(maxCapacityHigh) << 32n | BigInt(maxCapacityLow));

    // 64-bit free space as two 32-bit halves
    const freeSpaceLow = buf.readUInt32LE(offset);
    offset += 4;
    const freeSpaceHigh = buf.readUInt32LE(offset);
    offset += 4;
    const freeSpace = Number(BigInt(freeSpaceHigh) << 32n | BigInt(freeSpaceLow));

    const freeSpaceInImages = buf.readUInt32LE(offset);
    offset += 4;

    const storageDescription = this._parseMtpString(buf, offset);

    return {
      storageType,
      filesystemType,
      accessCapability,
      maxCapacity,
      freeSpace,
      freeSpaceInImages,
      storageDescription: storageDescription.str,
    };
  }

  _parseObjectInfo(buf) {
    let offset = 0;

    const storageId = buf.readUInt32LE(offset);
    offset += 4;

    const objectFormat = buf.readUInt16LE(offset);
    offset += 2;

    const protectionStatus = buf.readUInt16LE(offset);
    offset += 2;

    const compressedSize = buf.readUInt32LE(offset);
    offset += 4;

    // Skip thumbFormat (2), thumbCompressedSize (4), thumbPixWidth (4),
    // thumbPixHeight (4), imagePixWidth (4), imagePixHeight (4),
    // imageBitDepth (4) = 26 bytes
    offset += 26;

    const parentObject = buf.readUInt32LE(offset);
    offset += 4;

    // Skip associationType (2), associationDesc (4), sequenceNumber (4) = 10 bytes
    offset += 10;

    const filename = this._parseMtpString(buf, offset);

    return {
      storageId,
      objectFormat,
      protectionStatus,
      compressedSize,
      parentObject,
      filename: filename.str,
    };
  }

  _buildObjectInfoDataset(info) {
    const filenameBuf = this._encodeMtpString(info.filename);
    // Two empty MTP strings for creation date and modification date
    const emptyStr = Buffer.from([0x00]);

    const fixedSize = 52;
    const totalSize = fixedSize + filenameBuf.length + emptyStr.length * 2;
    const buf = Buffer.alloc(totalSize);

    let offset = 0;

    // storageId
    buf.writeUInt32LE(info.storageId, offset);
    offset += 4;

    // objectFormat
    buf.writeUInt16LE(info.objectFormat, offset);
    offset += 2;

    // protectionStatus
    buf.writeUInt16LE(0, offset);
    offset += 2;

    // compressedSize
    buf.writeUInt32LE(info.compressedSize, offset);
    offset += 4;

    // thumbFormat
    buf.writeUInt16LE(0, offset);
    offset += 2;

    // thumbCompressedSize
    buf.writeUInt32LE(0, offset);
    offset += 4;

    // thumbPixWidth
    buf.writeUInt32LE(0, offset);
    offset += 4;

    // thumbPixHeight
    buf.writeUInt32LE(0, offset);
    offset += 4;

    // imagePixWidth
    buf.writeUInt32LE(0, offset);
    offset += 4;

    // imagePixHeight
    buf.writeUInt32LE(0, offset);
    offset += 4;

    // imageBitDepth
    buf.writeUInt32LE(0, offset);
    offset += 4;

    // parentObject
    buf.writeUInt32LE(info.parentObject, offset);
    offset += 4;

    // associationType
    buf.writeUInt16LE(0, offset);
    offset += 2;

    // associationDesc
    buf.writeUInt32LE(0, offset);
    offset += 4;

    // sequenceNumber
    buf.writeUInt32LE(0, offset);
    offset += 4;

    // filename (MTP string)
    filenameBuf.copy(buf, offset);
    offset += filenameBuf.length;

    // creationDate (empty MTP string)
    emptyStr.copy(buf, offset);
    offset += emptyStr.length;

    // modificationDate (empty MTP string)
    emptyStr.copy(buf, offset);

    return buf;
  }
}

module.exports = { MtpProtocol };
