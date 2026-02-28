// Test different strategies for sending DATA containers to the Zune
const { WebUSB, usb } = require('usb');

const ZUNE_VENDOR_ID = 0x045E;
const ZUNE_PID = 0x063E;
const BULK_OUT = 1;
const BULK_IN = 1;

async function main() {
  const webusb = new WebUSB({ allowAllDevices: true });
  const device = await webusb.requestDevice({
    filters: [{ vendorId: ZUNE_VENDOR_ID, productId: ZUNE_PID }],
  });

  await device.open();
  if (device.configuration === null) await device.selectConfiguration(1);
  await device.claimInterface(0);

  // List the interface's endpoints
  const iface = device.configuration.interfaces[0];
  const alt = iface.alternates[0];
  console.log('Interface 0, alt 0:');
  console.log('  Class:', alt.interfaceClass);
  console.log('  Subclass:', alt.interfaceSubclass);
  for (const ep of alt.endpoints) {
    console.log(`  Endpoint 0x${(ep.endpointNumber | (ep.direction === 'in' ? 0x80 : 0)).toString(16)}: ${ep.direction} ${ep.type} maxPacket=${ep.packetSize}`);
  }

  async function bulkWrite(data) {
    const result = await device.transferOut(BULK_OUT, data);
    console.log(`  >> ${data.length}B status=${result.status} bytesWritten=${result.bytesWritten}`);
    return result;
  }

  async function bulkRead(len) {
    const result = await device.transferIn(BULK_IN, len);
    const buf = Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength);
    console.log(`  << ${buf.length}B status=${result.status}`);
    return buf;
  }

  function buildCmd(code, txId, params = []) {
    const len = 12 + params.length * 4;
    const buf = Buffer.alloc(len);
    buf.writeUInt32LE(len, 0);
    buf.writeUInt16LE(0x0001, 4); // COMMAND
    buf.writeUInt16LE(code, 6);
    buf.writeUInt32LE(txId, 8);
    for (let i = 0; i < params.length; i++) {
      buf.writeUInt32LE(params[i] >>> 0, 12 + i * 4);
    }
    return buf;
  }

  function buildData(code, txId, payload) {
    const len = 12 + payload.length;
    const header = Buffer.alloc(12);
    header.writeUInt32LE(len, 0);
    header.writeUInt16LE(0x0002, 4); // DATA
    header.writeUInt16LE(code, 6);
    header.writeUInt32LE(txId, 8);
    return Buffer.concat([header, payload]);
  }

  // MTP string for "Test"
  const testStr = Buffer.alloc(1 + 5 * 2);
  testStr.writeUInt8(5, 0);
  testStr.write('Test\0', 1, 'utf16le');

  // OpenSession with txId=0
  console.log('\n--- OpenSession ---');
  await bulkWrite(buildCmd(0x1002, 0, [1]));
  const sessResp = await bulkRead(512);
  console.log('Response code:', '0x' + sessResp.readUInt16LE(6).toString(16));

  let txId = 0;

  // Strategy 1: Separate COMMAND and DATA (current approach)
  console.log('\n--- Strategy 1: Separate CMD + DATA ---');
  txId++;
  await bulkWrite(buildCmd(0x1016, txId, [0xD406]));
  await bulkWrite(buildData(0x1016, txId, testStr));
  const resp1 = await bulkRead(512);
  console.log('Response:', '0x' + resp1.readUInt16LE(6).toString(16));

  // Strategy 2: Combined CMD + DATA in single write
  console.log('\n--- Strategy 2: Combined CMD+DATA in one write ---');
  txId++;
  const cmd2 = buildCmd(0x1016, txId, [0xD406]);
  const data2 = buildData(0x1016, txId, testStr);
  const combined = Buffer.concat([cmd2, data2]);
  await bulkWrite(combined);
  const resp2 = await bulkRead(512);
  console.log('Response:', '0x' + resp2.readUInt16LE(6).toString(16));

  // Strategy 3: DATA as separate header + payload writes
  console.log('\n--- Strategy 3: DATA header and payload as separate writes ---');
  txId++;
  await bulkWrite(buildCmd(0x1016, txId, [0xD406]));
  const dataHeader = Buffer.alloc(12);
  const totalLen = 12 + testStr.length;
  dataHeader.writeUInt32LE(totalLen, 0);
  dataHeader.writeUInt16LE(0x0002, 4);
  dataHeader.writeUInt16LE(0x1016, 6);
  dataHeader.writeUInt32LE(txId, 8);
  await bulkWrite(dataHeader);
  await bulkWrite(testStr);
  const resp3 = await bulkRead(512);
  console.log('Response:', '0x' + resp3.readUInt16LE(6).toString(16));

  // Strategy 4: Try selectAlternateInterface first
  console.log('\n--- Strategy 4: selectAlternateInterface(0,0) then retry ---');
  try {
    await device.selectAlternateInterface(0, 0);
    console.log('selectAlternateInterface OK');
  } catch (err) {
    console.log('selectAlternateInterface failed (probably already selected):', err.message);
  }
  txId++;
  await bulkWrite(buildCmd(0x1016, txId, [0xD406]));
  await bulkWrite(buildData(0x1016, txId, testStr));
  const resp4 = await bulkRead(512);
  console.log('Response:', '0x' + resp4.readUInt16LE(6).toString(16));

  // CloseSession
  console.log('\n--- CloseSession ---');
  txId++;
  await bulkWrite(buildCmd(0x1003, txId));
  const closeResp = await bulkRead(512);
  console.log('Response:', '0x' + closeResp.readUInt16LE(6).toString(16));

  await device.releaseInterface(0);
  await device.close();
  console.log('\nDone!');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
