// Dump full DeviceInfo from the Zune to check supported operations
const { UsbTransport, ZUNE_VENDOR_ID } = require('./src/main/zune/usb-transport');
const { MtpProtocol } = require('./src/main/zune/mtp-protocol');

function parseUint16Array(buf, offset) {
  const count = buf.readUInt32LE(offset);
  offset += 4;
  const values = [];
  for (let i = 0; i < count; i++) {
    values.push(buf.readUInt16LE(offset));
    offset += 2;
  }
  return { values, bytesRead: 4 + count * 2 };
}

function parseMtpString(buf, offset) {
  const numChars = buf.readUInt8(offset);
  if (numChars === 0) return { str: '', bytesRead: 1 };
  const strBuf = buf.subarray(offset + 1, offset + 1 + numChars * 2);
  let str = strBuf.toString('utf16le');
  if (str.charCodeAt(str.length - 1) === 0) str = str.slice(0, -1);
  return { str, bytesRead: 1 + numChars * 2 };
}

async function main() {
  const transport = new UsbTransport();
  const found = await transport.findZune();
  if (!found) { console.log('No Zune found.'); process.exit(1); }

  console.log(`Found: ${found.model}`);
  await transport.open(ZUNE_VENDOR_ID, found.productId);
  const mtp = new MtpProtocol(transport);

  // Get raw device info data
  // Use transactionId=0 for pre-session GetDeviceInfo
  const cmd = mtp.buildContainer(0x0001, 0x1001); // COMMAND, GetDeviceInfo
  await transport.bulkWrite(cmd);
  const data = await mtp.receiveData();
  const resp = await mtp.receiveResponse();
  const buf = data.payload;

  console.log('\n=== Raw DeviceInfo payload ===');
  console.log('Total bytes:', buf.length);

  let offset = 0;

  const stdVer = buf.readUInt16LE(offset); offset += 2;
  console.log('Standard Version:', stdVer);

  const vendorExtId = buf.readUInt32LE(offset); offset += 4;
  console.log('Vendor Extension ID:', vendorExtId);

  const vendorExtVer = buf.readUInt16LE(offset); offset += 2;
  console.log('Vendor Extension Version:', vendorExtVer);

  const vendorExtDesc = parseMtpString(buf, offset);
  offset += vendorExtDesc.bytesRead;
  console.log('Vendor Extension Desc:', vendorExtDesc.str);

  const funcMode = buf.readUInt16LE(offset); offset += 2;
  console.log('Functional Mode:', funcMode);

  // Operations Supported (uint16 array)
  const ops = parseUint16Array(buf, offset);
  offset += ops.bytesRead;
  console.log('\nSupported Operations (' + ops.values.length + '):');
  for (const op of ops.values) {
    const hex = '0x' + op.toString(16).padStart(4, '0');
    let name = '';
    if (op === 0x9212) name = ' ← SendWMDRMPDAppRequest';
    if (op === 0x9213) name = ' ← GetWMDRMPDAppResponse';
    if (op === 0x9214) name = ' ← EnableTrustedFilesOperations';
    if (op === 0x9216) name = ' ← EndTrustedAppSession';
    if (op === 0x1002) name = ' ← OpenSession';
    if (op === 0x1016) name = ' ← SetDevicePropValue';
    if (op === 0x1001) name = ' ← GetDeviceInfo';
    if (op >= 0x9200 && op <= 0x9299) name = name || ' ← WMDRMPD vendor op';
    console.log('  ' + hex + name);
  }

  // Events Supported (uint16 array)
  const events = parseUint16Array(buf, offset);
  offset += events.bytesRead;
  console.log('\nSupported Events (' + events.values.length + ')');

  // Device Properties Supported (uint16 array)
  const props = parseUint16Array(buf, offset);
  offset += props.bytesRead;
  console.log('\nSupported Device Properties (' + props.values.length + '):');
  for (const p of props.values) {
    const hex = '0x' + p.toString(16).padStart(4, '0');
    let name = '';
    if (p === 0xD406) name = ' ← SessionInitiatorInfo';
    if (p === 0xD402) name = ' ← FriendlyName';
    console.log('  ' + hex + name);
  }

  // Now try opening a session and checking MTPZ
  console.log('\n=== Opening session... ===');
  mtp.transactionId = 0;
  await mtp.openSession(1);
  console.log('Session opened.');

  // Try SetDevicePropValue for SessionInitiatorInfo
  console.log('\n=== Testing SetDevicePropValue... ===');
  try {
    await mtp.setDeviceProperty(0xD406, 'libmtp/Sajid Anwar - MTPZClassDriver');
    console.log('SetDevicePropValue: OK');
  } catch (err) {
    console.log('SetDevicePropValue failed:', err.message);
  }

  await mtp.closeSession();
  await transport.close();
  console.log('\nDone!');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
