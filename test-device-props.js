// Investigate SessionInitiatorInfo and other device properties
const { UsbTransport, ZUNE_VENDOR_ID } = require('./src/main/zune/usb-transport');
const { MtpProtocol } = require('./src/main/zune/mtp-protocol');

const MTP_TYPE_NAMES = {
  0x0000: 'UNDEF', 0x0001: 'INT8', 0x0002: 'UINT8', 0x0003: 'INT16',
  0x0004: 'UINT16', 0x0005: 'INT32', 0x0006: 'UINT32', 0x0007: 'INT64',
  0x0008: 'UINT64', 0x0009: 'INT128', 0x000A: 'UINT128', 0xFFFF: 'STR',
  0x4002: 'AUINT8', 0x4004: 'AUINT16', 0x4006: 'AUINT32',
};

function parseMtpString(buf, offset) {
  const numChars = buf.readUInt8(offset);
  if (numChars === 0) return { str: '', bytesRead: 1 };
  const strBuf = buf.subarray(offset + 1, offset + 1 + numChars * 2);
  let str = strBuf.toString('utf16le');
  if (str.charCodeAt(str.length - 1) === 0) str = str.slice(0, -1);
  return { str, bytesRead: 1 + numChars * 2 };
}

async function getDevicePropDesc(mtp, propCode) {
  await mtp.sendCommand(0x1014, [propCode]); // GetDevicePropDesc
  const data = await mtp.receiveData();
  await mtp.receiveResponse();

  const buf = data.payload;
  let offset = 0;

  const code = buf.readUInt16LE(offset); offset += 2;
  const dataType = buf.readUInt16LE(offset); offset += 2;
  const getSet = buf.readUInt8(offset); offset += 1;

  return {
    code: '0x' + code.toString(16).padStart(4, '0'),
    dataType: MTP_TYPE_NAMES[dataType] || '0x' + dataType.toString(16),
    dataTypeRaw: dataType,
    getSet: getSet === 0 ? 'Get-only (read-only)' : 'Get/Set (read-write)',
    getSetRaw: getSet,
    rawHex: buf.subarray(0, Math.min(64, buf.length)).toString('hex'),
  };
}

async function getDevicePropValue(mtp, propCode) {
  await mtp.sendCommand(0x1015, [propCode]); // GetDevicePropValue
  const data = await mtp.receiveData();
  await mtp.receiveResponse();
  return data.payload;
}

async function main() {
  const transport = new UsbTransport();
  const found = await transport.findZune();
  if (!found) { console.log('No Zune found.'); process.exit(1); }

  await transport.open(ZUNE_VENDOR_ID, found.productId);
  const mtp = new MtpProtocol(transport);
  await mtp.openSession(1);
  console.log('Session opened.\n');

  // Check SessionInitiatorInfo (0xD406)
  console.log('=== SessionInitiatorInfo (0xD406) ===');
  try {
    const desc = await getDevicePropDesc(mtp, 0xD406);
    console.log('  Type:', desc.dataType);
    console.log('  Access:', desc.getSet);
    console.log('  Raw hex:', desc.rawHex);
  } catch (err) {
    console.log('  GetDevicePropDesc failed:', err.message);
  }

  try {
    const val = await getDevicePropValue(mtp, 0xD406);
    const str = parseMtpString(val, 0);
    console.log('  Current value:', JSON.stringify(str.str));
    console.log('  Raw value hex:', val.toString('hex'));
  } catch (err) {
    console.log('  GetDevicePropValue failed:', err.message);
  }

  // Check FriendlyName (0xD402) for comparison
  console.log('\n=== FriendlyName (0xD402) ===');
  try {
    const desc = await getDevicePropDesc(mtp, 0xD402);
    console.log('  Type:', desc.dataType);
    console.log('  Access:', desc.getSet);
  } catch (err) {
    console.log('  GetDevicePropDesc failed:', err.message);
  }

  try {
    const val = await getDevicePropValue(mtp, 0xD402);
    const str = parseMtpString(val, 0);
    console.log('  Current value:', JSON.stringify(str.str));
  } catch (err) {
    console.log('  GetDevicePropValue failed:', err.message);
  }

  // Try setting FriendlyName (to test if SetDevicePropValue works at all)
  console.log('\n=== Testing SetDevicePropValue on FriendlyName ===');
  try {
    // First read current value
    const curVal = await getDevicePropValue(mtp, 0xD402);
    const curStr = parseMtpString(curVal, 0);
    console.log('  Current:', JSON.stringify(curStr.str));

    // Try setting to the same value
    await mtp.setDeviceProperty(0xD402, curStr.str);
    console.log('  Set OK!');
  } catch (err) {
    console.log('  Set failed:', err.message);
  }

  // Check a few more interesting properties
  const propsToCheck = [0xD401, 0xD405, 0xD501];
  for (const p of propsToCheck) {
    console.log(`\n=== Property 0x${p.toString(16).padStart(4, '0')} ===`);
    try {
      const desc = await getDevicePropDesc(mtp, p);
      console.log('  Type:', desc.dataType, '| Access:', desc.getSet);
    } catch (err) {
      console.log('  Error:', err.message);
    }
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
