// Focused test: different strategies for sending host-to-device DATA containers
// Tests whether the Zune actually receives our DATA when sent via WebUSB
const { WebUSB } = require('usb');

const ZUNE_VID = 0x045E;
const ZUNE_PID = 0x063E;

async function main() {
  const webusb = new WebUSB({ allowAllDevices: true });
  const device = await webusb.requestDevice({
    filters: [{ vendorId: ZUNE_VID, productId: ZUNE_PID }],
  });

  await device.open();
  if (device.configuration === null) await device.selectConfiguration(1);
  await device.claimInterface(0);

  // Print endpoint info
  const alt = device.configuration.interfaces[0].alternates[0];
  for (const ep of alt.endpoints) {
    console.log(`EP 0x${(ep.endpointNumber | (ep.direction === 'in' ? 0x80 : 0)).toString(16)}: ${ep.direction} ${ep.type} maxPacket=${ep.packetSize}`);
  }

  function buildCmd(txId, code, params = []) {
    const len = 12 + params.length * 4;
    const buf = Buffer.alloc(len);
    buf.writeUInt32LE(len, 0);
    buf.writeUInt16LE(0x0001, 4);
    buf.writeUInt16LE(code, 6);
    buf.writeUInt32LE(txId, 8);
    for (let i = 0; i < params.length; i++)
      buf.writeUInt32LE(params[i] >>> 0, 12 + i * 4);
    return buf;
  }

  function buildData(txId, code, payload) {
    const len = 12 + payload.length;
    const header = Buffer.alloc(12);
    header.writeUInt32LE(len, 0);
    header.writeUInt16LE(0x0002, 4);
    header.writeUInt16LE(code, 6);
    header.writeUInt32LE(txId, 8);
    return Buffer.concat([header, payload]);
  }

  async function write(data) {
    const r = await device.transferOut(1, data);
    console.log(`  >> ${data.length}B status=${r.status} written=${r.bytesWritten}`);
    return r;
  }

  async function read(len) {
    const r = await device.transferIn(1, len);
    const buf = Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    const type = buf.readUInt16LE(4);
    const code = buf.readUInt16LE(6);
    const typeName = { 1: 'CMD', 2: 'DATA', 3: 'RESP' }[type] || `T${type}`;
    console.log(`  << ${buf.length}B ${typeName} code=0x${code.toString(16).padStart(4, '0')}`);
    return buf;
  }

  // Read a complete container (header might come separately from payload)
  async function readFull(maxSize = 16384) {
    const first = await read(maxSize);
    const totalLen = first.readUInt32LE(0);
    if (first.length >= totalLen) return first.subarray(0, totalLen);
    const chunks = [first];
    let got = first.length;
    while (got < totalLen) {
      const chunk = await read(Math.min(totalLen - got, maxSize));
      chunks.push(chunk);
      got += chunk.length;
    }
    return Buffer.concat(chunks).subarray(0, totalLen);
  }

  const delay = ms => new Promise(r => setTimeout(r, ms));

  // MTP string for the device's name
  function mtpStr(s) {
    const withNull = s + '\0';
    const buf = Buffer.alloc(1 + withNull.length * 2);
    buf.writeUInt8(withNull.length, 0);
    buf.write(withNull, 1, 'utf16le');
    return buf;
  }

  // --- OpenSession ---
  console.log('\n=== OpenSession ===');
  await write(buildCmd(0, 0x1002, [1]));
  const sr = await readFull();
  if (sr.readUInt16LE(6) !== 0x2001) {
    console.log('OpenSession failed!');
    process.exit(1);
  }
  console.log('OK');

  // First, read FriendlyName so we know the current value
  console.log('\n=== Read FriendlyName ===');
  await write(buildCmd(1, 0x1015, [0xD402]));
  const nameData = await readFull();
  const nameResp = await readFull();
  const namePayload = nameData.subarray(12);
  const numChars = namePayload.readUInt8(0);
  let friendlyName = '';
  if (numChars > 0) {
    friendlyName = namePayload.subarray(1, 1 + numChars * 2).toString('utf16le');
    if (friendlyName.charCodeAt(friendlyName.length - 1) === 0)
      friendlyName = friendlyName.slice(0, -1);
  }
  console.log('FriendlyName:', JSON.stringify(friendlyName));

  const nameStr = mtpStr(friendlyName);
  let txId = 1;

  // ---- Strategy A: Standard (CMD write, then DATA write) ----
  console.log('\n=== Strategy A: CMD then DATA (standard) ===');
  txId++;
  await write(buildCmd(txId, 0x1016, [0xD402]));
  await write(buildData(txId, 0x1016, nameStr));
  const respA = await readFull();
  console.log('Result:', '0x' + respA.readUInt16LE(6).toString(16));

  // ---- Strategy B: CMD + 100ms delay + DATA ----
  console.log('\n=== Strategy B: CMD, 100ms delay, then DATA ===');
  txId++;
  await write(buildCmd(txId, 0x1016, [0xD402]));
  await delay(100);
  await write(buildData(txId, 0x1016, nameStr));
  const respB = await readFull();
  console.log('Result:', '0x' + respB.readUInt16LE(6).toString(16));

  // ---- Strategy C: CMD + 500ms delay + DATA ----
  console.log('\n=== Strategy C: CMD, 500ms delay, then DATA ===');
  txId++;
  await write(buildCmd(txId, 0x1016, [0xD402]));
  await delay(500);
  await write(buildData(txId, 0x1016, nameStr));
  const respC = await readFull();
  console.log('Result:', '0x' + respC.readUInt16LE(6).toString(16));

  // ---- Strategy D: Combined CMD+DATA in single write ----
  console.log('\n=== Strategy D: CMD+DATA combined in single write ===');
  txId++;
  const cmd = buildCmd(txId, 0x1016, [0xD402]);
  const data = buildData(txId, 0x1016, nameStr);
  const combined = Buffer.concat([cmd, data]);
  await write(combined);
  const respD = await readFull();
  console.log('Result:', '0x' + respD.readUInt16LE(6).toString(16));

  // ---- Strategy E: CMD, then DATA header only, then payload separately ----
  console.log('\n=== Strategy E: CMD, then DATA header, then payload ===');
  txId++;
  await write(buildCmd(txId, 0x1016, [0xD402]));
  const dataHdr = Buffer.alloc(12);
  const totalDataLen = 12 + nameStr.length;
  dataHdr.writeUInt32LE(totalDataLen, 0);
  dataHdr.writeUInt16LE(0x0002, 4);
  dataHdr.writeUInt16LE(0x1016, 6);
  dataHdr.writeUInt32LE(txId, 8);
  await write(dataHdr);
  await write(nameStr);
  const respE = await readFull();
  console.log('Result:', '0x' + respE.readUInt16LE(6).toString(16));

  // ---- Strategy F: Pad DATA to exactly 512 bytes (max packet size) ----
  console.log('\n=== Strategy F: DATA padded to 512 bytes ===');
  txId++;
  await write(buildCmd(txId, 0x1016, [0xD402]));
  const paddedData = Buffer.alloc(512);
  const realData = buildData(txId, 0x1016, nameStr);
  realData.copy(paddedData);
  // The length field still says the real length, but the USB transfer is exactly 512
  await write(paddedData);
  const respF = await readFull();
  console.log('Result:', '0x' + respF.readUInt16LE(6).toString(16));

  // ---- Strategy G: Send DATA padded to 512 + ZLP ----
  console.log('\n=== Strategy G: DATA padded to 512 bytes + ZLP ===');
  txId++;
  await write(buildCmd(txId, 0x1016, [0xD402]));
  const paddedData2 = Buffer.alloc(512);
  const realData2 = buildData(txId, 0x1016, nameStr);
  realData2.copy(paddedData2);
  await write(paddedData2);
  await write(Buffer.alloc(0)); // Zero-length packet
  const respG = await readFull();
  console.log('Result:', '0x' + respG.readUInt16LE(6).toString(16));

  // Summary
  console.log('\n=== SUMMARY ===');
  console.log('A (standard):      0x' + respA.readUInt16LE(6).toString(16));
  console.log('B (100ms delay):   0x' + respB.readUInt16LE(6).toString(16));
  console.log('C (500ms delay):   0x' + respC.readUInt16LE(6).toString(16));
  console.log('D (combined):      0x' + respD.readUInt16LE(6).toString(16));
  console.log('E (split header):  0x' + respE.readUInt16LE(6).toString(16));
  console.log('F (pad to 512):    0x' + respF.readUInt16LE(6).toString(16));
  console.log('G (pad+ZLP):       0x' + respG.readUInt16LE(6).toString(16));

  // CloseSession
  txId++;
  await write(buildCmd(txId, 0x1003));
  await readFull();

  await device.releaseInterface(0);
  await device.close();
  console.log('\nDone!');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
