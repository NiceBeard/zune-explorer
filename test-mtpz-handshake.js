// Detailed MTPZ handshake test with wire-level logging
const { UsbTransport, ZUNE_VENDOR_ID } = require('./src/main/zune/usb-transport');
const { MtpProtocol } = require('./src/main/zune/mtp-protocol');
const { MtpzAuth } = require('./src/main/zune/mtpz-auth');

// Wrap transport to log all USB traffic
function wrapTransport(transport) {
  const origWrite = transport.bulkWrite.bind(transport);
  const origRead = transport.bulkRead.bind(transport);

  transport.bulkWrite = async (data) => {
    const buf = Buffer.from(data);
    const type = buf.length >= 6 ? buf.readUInt16LE(4) : 0;
    const code = buf.length >= 8 ? buf.readUInt16LE(6) : 0;
    const typeName = { 1: 'CMD', 2: 'DATA', 3: 'RESP' }[type] || `T${type}`;
    console.log(`  >> WRITE ${typeName} 0x${code.toString(16).padStart(4,'0')} ${buf.length}B: ${buf.subarray(0, Math.min(32, buf.length)).toString('hex')}${buf.length > 32 ? '...' : ''}`);
    return origWrite(data);
  };

  transport.bulkRead = async (len) => {
    const result = await origRead(len);
    const type = result.length >= 6 ? result.readUInt16LE(4) : 0;
    const code = result.length >= 8 ? result.readUInt16LE(6) : 0;
    const typeName = { 1: 'CMD', 2: 'DATA', 3: 'RESP' }[type] || `T${type}`;
    console.log(`  << READ  ${typeName} 0x${code.toString(16).padStart(4,'0')} ${result.length}B: ${result.subarray(0, Math.min(32, result.length)).toString('hex')}${result.length > 32 ? '...' : ''}`);
    return result;
  };
}

async function main() {
  const transport = new UsbTransport();
  const found = await transport.findZune();
  if (!found) { console.log('No Zune found.'); process.exit(1); }

  console.log(`Found: ${found.model}\n`);
  await transport.open(ZUNE_VENDOR_ID, found.productId);
  wrapTransport(transport);
  const mtp = new MtpProtocol(transport);

  console.log('--- OpenSession ---');
  await mtp.openSession(1);
  console.log('OK\n');

  // Test 1: Try certificate send WITHOUT reset
  console.log('--- Test 1: Certificate send WITHOUT reset ---');
  try {
    const auth = new MtpzAuth(mtp);
    const { message } = auth._buildAppCertificateMessage();
    console.log(`Certificate message: ${message.length} bytes`);

    mtp.transactionId++;
    console.log(`Sending command (txId=${mtp.transactionId})...`);
    const cmd = mtp.buildContainer(0x0001, 0x9212);
    await transport.bulkWrite(cmd);

    console.log('Sending data...');
    await mtp.sendData(0x9212, message);

    console.log('Reading response...');
    const resp = await mtp.receiveData();
    console.log(`Response: type=${resp.type} code=0x${resp.code.toString(16)} params=[${resp.params.map(p => '0x' + p.toString(16)).join(',')}]`);
  } catch (err) {
    console.log('FAILED:', err.message);
  }

  // Close and reopen session for test 2
  try { await mtp.closeSession(); } catch {}
  mtp.transactionId = 0;
  mtp.sessionId = 0;

  console.log('\n--- Reopening session ---');
  await mtp.openSession(1);
  console.log('OK\n');

  // Test 2: Reset first, then certificate
  console.log('--- Test 2: Reset THEN certificate ---');
  try {
    console.log('Sending EndTrustedAppSession...');
    await mtp.resetMtpzHandshake();
    console.log('Reset OK\n');

    const auth = new MtpzAuth(mtp);
    const { message } = auth._buildAppCertificateMessage();

    mtp.transactionId++;
    console.log(`Sending certificate (txId=${mtp.transactionId})...`);
    const cmd = mtp.buildContainer(0x0001, 0x9212);
    await transport.bulkWrite(cmd);
    await mtp.sendData(0x9212, message);

    console.log('Reading response...');
    const resp = await mtp.receiveData();
    console.log(`Response: type=${resp.type} code=0x${resp.code.toString(16)} params=[${resp.params.map(p => '0x' + p.toString(16)).join(',')}]`);
  } catch (err) {
    console.log('FAILED:', err.message);
  }

  try { await mtp.closeSession(); } catch {}
  await transport.close();
  console.log('\nDone!');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
