// Test: Send DATA container as split header + payload (matching how device sends to us)
const { WebUSB } = require('usb');

async function main() {
  const webusb = new WebUSB({ allowAllDevices: true });
  const device = await webusb.requestDevice({
    filters: [{ vendorId: 0x045E, productId: 0x063E }],
  });

  await device.open();
  if (device.configuration === null) await device.selectConfiguration(1);
  await device.claimInterface(0);
  console.log('Connected to Zune HD');

  async function write(label, data) {
    const r = await device.transferOut(1, data);
    console.log(`  >> ${label}: ${data.length}B status=${r.status} written=${r.bytesWritten} hex=${data.toString('hex')}`);
    return r;
  }

  async function readOne() {
    const r = await device.transferIn(1, 512);
    const buf = Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    const type = buf.length >= 6 ? buf.readUInt16LE(4) : -1;
    const code = buf.length >= 8 ? buf.readUInt16LE(6) : -1;
    const typeName = { 1: 'CMD', 2: 'DATA', 3: 'RESP' }[type] || `T${type}`;
    console.log(`  << ${buf.length}B ${typeName} code=0x${code.toString(16).padStart(4, '0')} hex=${buf.toString('hex')}`);
    return buf;
  }

  function mtpStr(s) {
    const withNull = s + '\0';
    const buf = Buffer.alloc(1 + withNull.length * 2);
    buf.writeUInt8(withNull.length, 0);
    buf.write(withNull, 1, 'utf16le');
    return buf;
  }

  // OpenSession
  console.log('\n--- OpenSession ---');
  const openCmd = Buffer.alloc(16);
  openCmd.writeUInt32LE(16, 0);
  openCmd.writeUInt16LE(0x0001, 4);
  openCmd.writeUInt16LE(0x1002, 6);
  openCmd.writeUInt32LE(0, 8);
  openCmd.writeUInt32LE(1, 12);
  await write('CMD', openCmd);
  await readOne();

  let txId = 0;

  // Read current FriendlyName for reference
  console.log('\n--- Read FriendlyName ---');
  txId++;
  const getCmd = Buffer.alloc(16);
  getCmd.writeUInt32LE(16, 0);
  getCmd.writeUInt16LE(0x0001, 4);
  getCmd.writeUInt16LE(0x1015, 6);
  getCmd.writeUInt32LE(txId, 8);
  getCmd.writeUInt32LE(0xD402, 12);
  await write('CMD', getCmd);
  const dataHdr = await readOne();  // 12-byte DATA header
  const dataPayload = await readOne();  // payload
  const respGet = await readOne();  // RESPONSE
  console.log('Response:', '0x' + respGet.readUInt16LE(6).toString(16));

  // Parse the name
  const nameBuf = dataPayload;
  const nc = nameBuf.readUInt8(0);
  let name = nameBuf.subarray(1, 1 + nc * 2).toString('utf16le');
  if (name.charCodeAt(name.length - 1) === 0) name = name.slice(0, -1);
  console.log('Name:', JSON.stringify(name));

  const namePayload = mtpStr(name);

  // ===========================================================
  // Strategy 1: SPLIT DATA (12-byte header, then payload separately)
  // This matches how the device sends DATA to us
  // ===========================================================
  console.log('\n--- Strategy 1: SPLIT DATA (header then payload) ---');
  txId++;
  const setCmd1 = Buffer.alloc(16);
  setCmd1.writeUInt32LE(16, 0);
  setCmd1.writeUInt16LE(0x0001, 4);
  setCmd1.writeUInt16LE(0x1016, 6);
  setCmd1.writeUInt32LE(txId, 8);
  setCmd1.writeUInt32LE(0xD402, 12);
  await write('CMD', setCmd1);

  // DATA header (12 bytes) - separate write
  const dh1 = Buffer.alloc(12);
  dh1.writeUInt32LE(12 + namePayload.length, 0);
  dh1.writeUInt16LE(0x0002, 4);
  dh1.writeUInt16LE(0x1016, 6);
  dh1.writeUInt32LE(txId, 8);
  await write('DATA-HDR', dh1);

  // Payload - separate write
  await write('DATA-PAYLOAD', namePayload);

  const resp1 = await readOne();
  console.log('Result:', '0x' + resp1.readUInt16LE(6).toString(16),
    resp1.readUInt16LE(6) === 0x2001 ? '*** SUCCESS ***' : 'FAILED');

  // ===========================================================
  // Strategy 2: COMBINED DATA (standard - for comparison)
  // ===========================================================
  console.log('\n--- Strategy 2: COMBINED DATA (standard) ---');
  txId++;
  const setCmd2 = Buffer.alloc(16);
  setCmd2.writeUInt32LE(16, 0);
  setCmd2.writeUInt16LE(0x0001, 4);
  setCmd2.writeUInt16LE(0x1016, 6);
  setCmd2.writeUInt32LE(txId, 8);
  setCmd2.writeUInt32LE(0xD402, 12);
  await write('CMD', setCmd2);

  // Combined DATA (header + payload in one write)
  const combined = Buffer.alloc(12 + namePayload.length);
  combined.writeUInt32LE(12 + namePayload.length, 0);
  combined.writeUInt16LE(0x0002, 4);
  combined.writeUInt16LE(0x1016, 6);
  combined.writeUInt32LE(txId, 8);
  namePayload.copy(combined, 12);
  await write('DATA-COMBINED', combined);

  const resp2 = await readOne();
  console.log('Result:', '0x' + resp2.readUInt16LE(6).toString(16),
    resp2.readUInt16LE(6) === 0x2001 ? '*** SUCCESS ***' : 'FAILED');

  // ===========================================================
  // Strategy 3: SPLIT + delay between header and payload
  // ===========================================================
  console.log('\n--- Strategy 3: SPLIT DATA with 50ms delay ---');
  txId++;
  const setCmd3 = Buffer.alloc(16);
  setCmd3.writeUInt32LE(16, 0);
  setCmd3.writeUInt16LE(0x0001, 4);
  setCmd3.writeUInt16LE(0x1016, 6);
  setCmd3.writeUInt32LE(txId, 8);
  setCmd3.writeUInt32LE(0xD402, 12);
  await write('CMD', setCmd3);

  const dh3 = Buffer.alloc(12);
  dh3.writeUInt32LE(12 + namePayload.length, 0);
  dh3.writeUInt16LE(0x0002, 4);
  dh3.writeUInt16LE(0x1016, 6);
  dh3.writeUInt32LE(txId, 8);
  await write('DATA-HDR', dh3);
  await new Promise(r => setTimeout(r, 50));
  await write('DATA-PAYLOAD', namePayload);

  const resp3 = await readOne();
  console.log('Result:', '0x' + resp3.readUInt16LE(6).toString(16),
    resp3.readUInt16LE(6) === 0x2001 ? '*** SUCCESS ***' : 'FAILED');

  // Summary
  console.log('\n=== SUMMARY ===');
  console.log('1 (split hdr+payload):', '0x' + resp1.readUInt16LE(6).toString(16));
  console.log('2 (combined):         ', '0x' + resp2.readUInt16LE(6).toString(16));
  console.log('3 (split + delay):    ', '0x' + resp3.readUInt16LE(6).toString(16));

  // Close
  txId++;
  const closeCmd = Buffer.alloc(12);
  closeCmd.writeUInt32LE(12, 0);
  closeCmd.writeUInt16LE(0x0001, 4);
  closeCmd.writeUInt16LE(0x1003, 6);
  closeCmd.writeUInt32LE(txId, 8);
  await write('CMD', closeCmd);
  await readOne();

  await device.releaseInterface(0);
  await device.close();
  console.log('\nDone!');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
