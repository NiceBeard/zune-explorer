// Test using classic libusb API instead of WebUSB polyfill
// This bypasses the WebUSB layer entirely to test if bulk OUT DATA works
const usb = require('usb');

const ZUNE_VID = 0x045E;
const ZUNE_PID = 0x063E;

function buildCmd(txId, code, params = []) {
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

function buildData(txId, code, payload) {
  const len = 12 + payload.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(len, 0);
  header.writeUInt16LE(0x0002, 4); // DATA
  header.writeUInt16LE(code, 6);
  header.writeUInt32LE(txId, 8);
  return Buffer.concat([header, payload]);
}

function bulkWrite(outEp, data) {
  return new Promise((resolve, reject) => {
    outEp.transfer(data, (err) => {
      if (err) {
        console.log(`  >> WRITE ${data.length}B ERROR: ${err.message}`);
        reject(err);
      } else {
        console.log(`  >> ${data.length}B OK  hex=${data.subarray(0, Math.min(32, data.length)).toString('hex')}${data.length > 32 ? '...' : ''}`);
        resolve();
      }
    });
  });
}

function bulkReadOnce(inEp, len) {
  return new Promise((resolve, reject) => {
    inEp.transfer(len, (err, data) => {
      if (err) reject(err);
      else resolve(Buffer.from(data));
    });
  });
}

// Read a complete MTP container (may span multiple USB transfers)
async function readContainer(inEp) {
  const first = await bulkReadOnce(inEp, 512);
  const totalLen = first.readUInt32LE(0);
  const type = first.readUInt16LE(4);
  const code = first.readUInt16LE(6);
  const typeName = { 1: 'CMD', 2: 'DATA', 3: 'RESP' }[type] || `T${type}`;

  if (first.length >= totalLen) {
    console.log(`  << ${first.length}B ${typeName} 0x${code.toString(16).padStart(4, '0')} (complete)`);
    return first.subarray(0, totalLen);
  }

  // Need more reads
  const chunks = [first];
  let received = first.length;
  while (received < totalLen) {
    const chunk = await bulkReadOnce(inEp, Math.min(totalLen - received, 16384));
    chunks.push(chunk);
    received += chunk.length;
  }
  const full = Buffer.concat(chunks);
  console.log(`  << ${full.length}B ${typeName} 0x${code.toString(16).padStart(4, '0')} (${chunks.length} transfers)`);
  return full.subarray(0, totalLen);
}

// MTP string encoder
function mtpString(str) {
  const withNull = str + '\0';
  const charCount = withNull.length;
  const buf = Buffer.alloc(1 + charCount * 2);
  buf.writeUInt8(charCount, 0);
  buf.write(withNull, 1, 'utf16le');
  return buf;
}

// Parse MTP string from buffer
function parseMtpString(buf, offset) {
  const numChars = buf.readUInt8(offset);
  if (numChars === 0) return '';
  let str = buf.subarray(offset + 1, offset + 1 + numChars * 2).toString('utf16le');
  if (str.charCodeAt(str.length - 1) === 0) str = str.slice(0, -1);
  return str;
}

async function main() {
  const device = usb.findByIds(ZUNE_VID, ZUNE_PID);
  if (!device) { console.log('No Zune found.'); process.exit(1); }

  console.log('Found Zune HD');
  device.open();

  // Match what WebUSB does: explicitly set configuration
  const configValue = device.configDescriptor.bConfigurationValue;
  console.log('Config value:', configValue);
  try {
    device.setConfiguration(configValue, (err) => {
      if (err) console.log('setConfiguration error (may be OK):', err.message);
      else console.log('setConfiguration OK');
    });
  } catch (e) {
    console.log('setConfiguration exception (may be OK):', e.message);
  }

  // Small delay to let config settle
  await new Promise(r => setTimeout(r, 200));

  const iface = device.interface(0);
  console.log('Kernel driver active:', iface.isKernelDriverActive());

  if (iface.isKernelDriverActive()) {
    console.log('Detaching kernel driver...');
    iface.detachKernelDriver();
  }

  iface.claim();
  console.log('Interface claimed.', 'Endpoints:', iface.endpoints.length);

  const outEp = iface.endpoint(0x01);
  const inEp = iface.endpoint(0x81);
  // Set timeouts (ms) so we don't hang forever
  outEp.timeout = 5000;
  inEp.timeout = 5000;
  console.log(`OUT: 0x${outEp.address.toString(16)} maxPacket=${outEp.descriptor.wMaxPacketSize} timeout=${outEp.timeout}ms`);
  console.log(`IN:  0x${inEp.address.toString(16)} maxPacket=${inEp.descriptor.wMaxPacketSize} timeout=${inEp.timeout}ms`);

  // OpenSession (txId=0)
  console.log('\n--- OpenSession ---');
  await bulkWrite(outEp, buildCmd(0, 0x1002, [1]));
  const sessResp = await readContainer(inEp);
  const sessCode = sessResp.readUInt16LE(6);
  console.log('Response:', '0x' + sessCode.toString(16));
  if (sessCode !== 0x2001) {
    console.log('OpenSession failed!');
    iface.release(() => device.close());
    process.exit(1);
  }

  let txId = 0;

  // Test 1: Read FriendlyName (should work)
  console.log('\n--- Test 1: GetDevicePropValue (FriendlyName 0xD402) ---');
  txId++;
  await bulkWrite(outEp, buildCmd(txId, 0x1015, [0xD402]));
  const propDataContainer = await readContainer(inEp);
  const propPayload = propDataContainer.subarray(12);
  const friendlyNameValue = parseMtpString(propPayload, 0);
  console.log('FriendlyName:', JSON.stringify(friendlyNameValue));
  const propResp = await readContainer(inEp);
  console.log('Response:', '0x' + propResp.readUInt16LE(6).toString(16));

  // Test 2: WRITE FriendlyName (this is what fails with WebUSB!)
  console.log('\n--- Test 2: SetDevicePropValue (FriendlyName = same value) ---');
  txId++;
  const namePayload = mtpString(friendlyNameValue);
  const cmdBuf = buildCmd(txId, 0x1016, [0xD402]);
  const dataBuf = buildData(txId, 0x1016, namePayload);
  console.log(`  CMD: ${cmdBuf.length}B  DATA: ${dataBuf.length}B`);
  await bulkWrite(outEp, cmdBuf);
  await bulkWrite(outEp, dataBuf);
  const setResp = await readContainer(inEp);
  const setCode = setResp.readUInt16LE(6);
  console.log('Response:', '0x' + setCode.toString(16), setCode === 0x2001 ? '*** SUCCESS ***' : 'FAILED');

  if (setCode === 0x2001) {
    // Test 3: SessionInitiatorInfo
    console.log('\n--- Test 3: SetDevicePropValue (SessionInitiatorInfo 0xD406) ---');
    txId++;
    const initPayload = mtpString('ZuneExplorer');
    await bulkWrite(outEp, buildCmd(txId, 0x1016, [0xD406]));
    await bulkWrite(outEp, buildData(txId, 0x1016, initPayload));
    const resp3 = await readContainer(inEp);
    console.log('Response:', '0x' + resp3.readUInt16LE(6).toString(16));

    // Test 4: MTPZ reset
    console.log('\n--- Test 4: EndTrustedAppSession ---');
    txId++;
    await bulkWrite(outEp, buildCmd(txId, 0x9216));
    const resp4 = await readContainer(inEp);
    console.log('Response:', '0x' + resp4.readUInt16LE(6).toString(16));
  } else {
    console.log('\n*** SetDevicePropValue failed with classic API too ***');
    console.log('The issue is NOT WebUSB-specific — it is at the USB/device level.');
  }

  // CloseSession
  console.log('\n--- CloseSession ---');
  txId++;
  await bulkWrite(outEp, buildCmd(txId, 0x1003));
  const closeResp = await readContainer(inEp);
  console.log('Response:', '0x' + closeResp.readUInt16LE(6).toString(16));

  iface.release(() => {
    device.close();
    console.log('\nDone!');
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
