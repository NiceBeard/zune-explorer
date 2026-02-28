// Try different MTPZ handshake variants
const crypto = require('crypto');
const { UsbTransport, ZUNE_VENDOR_ID } = require('./src/main/zune/usb-transport');
const { MtpProtocol } = require('./src/main/zune/mtp-protocol');
const {
  MTPZ_PUBLIC_EXPONENT, MTPZ_MODULUS, MTPZ_PRIVATE_KEY, MTPZ_CERTIFICATES,
} = require('./src/main/zune/mtpz-keys');

async function tryMtpzSend(mtp, transport, data, label, withParam) {
  console.log(`\n--- ${label} ---`);
  try {
    mtp.transactionId++;
    const params = withParam ? [0] : [];
    const cmd = mtp.buildContainer(0x0001, 0x9212, params);
    await transport.bulkWrite(cmd);
    console.log(`  CMD: ${cmd.length}B (${withParam ? 'Param1=0' : 'no params'})`);

    const container = mtp.buildDataContainer(0x9212, data);
    await transport.bulkWrite(container);
    console.log(`  DATA: ${container.length}B`);

    const resp = await mtp.receiveData();
    const codeHex = '0x' + resp.code.toString(16).padStart(4, '0');
    console.log(`  RESP: code=${codeHex} type=${resp.type}`);
    return resp.code;
  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
    return -1;
  }
}

// Build certificate message using Node.js crypto for RSA instead of BigInt
function buildCertMessageCrypto() {
  const RSA_BLOCK_SIZE = 128;
  const certsLen = MTPZ_CERTIFICATES.length;
  const randomData = crypto.randomBytes(16);
  const preSignLen = 5 + 2 + certsLen + 2 + 16;
  const totalLen = preSignLen + 3 + RSA_BLOCK_SIZE;

  const message = Buffer.alloc(totalLen);
  let offset = 0;

  message[offset++] = 0x02;
  message[offset++] = 0x01;
  message[offset++] = 0x01;
  message[offset++] = 0x00;
  message[offset++] = 0x00;
  message.writeUInt16BE(certsLen, offset); offset += 2;
  MTPZ_CERTIFICATES.copy(message, offset); offset += certsLen;
  message[offset++] = 0x00;
  message[offset++] = 0x10;
  randomData.copy(message, offset); offset += 16;
  message[offset++] = 0x01;
  message[offset++] = 0x00;
  message[offset++] = 0x80;

  // Compute signature using Node.js crypto RSA
  const innerHash = crypto.createHash('sha1')
    .update(message.subarray(2, preSignLen))
    .digest();

  const v16 = Buffer.alloc(28);
  innerHash.copy(v16, 8);
  const hash = crypto.createHash('sha1').update(v16).digest();

  // MGF1-SHA1
  function mgf1(seed, length) {
    const iters = Math.ceil(length / 20) + 1;
    const chunks = [];
    for (let c = 0; c < iters; c++) {
      const cb = Buffer.alloc(4);
      cb.writeUInt32BE(c, 0);
      chunks.push(crypto.createHash('sha1').update(seed).update(cb).digest());
    }
    return Buffer.concat(chunks).subarray(0, length);
  }

  const mask = mgf1(hash, 107);
  const odata = Buffer.alloc(RSA_BLOCK_SIZE);
  odata[106] = 0x01;
  hash.copy(odata, 107);
  for (let i = 0; i < 107; i++) odata[i] ^= mask[i];
  odata[0] &= 0x7F;
  odata[127] = 0xBC;

  // RSA raw private: sig = odata^d mod n (using BigInt)
  const m = BigInt('0x' + odata.toString('hex'));
  const d = BigInt('0x' + MTPZ_PRIVATE_KEY);
  const n = BigInt('0x' + MTPZ_MODULUS);
  let result = 1n;
  let base = m % n;
  let exp = d;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % n;
    exp >>= 1n;
    base = (base * base) % n;
  }
  const sigHex = result.toString(16).padStart(RSA_BLOCK_SIZE * 2, '0');
  Buffer.from(sigHex, 'hex').copy(message, offset);

  // Verify
  const e = BigInt('0x' + MTPZ_PUBLIC_EXPONENT);
  let vBase = result % n;
  let vExp = e;
  let vResult = 1n;
  while (vExp > 0n) {
    if (vExp & 1n) vResult = (vResult * vBase) % n;
    vExp >>= 1n;
    vBase = (vBase * vBase) % n;
  }
  const verifiedHex = vResult.toString(16).padStart(RSA_BLOCK_SIZE * 2, '0');
  const verified = Buffer.from(verifiedHex, 'hex');
  console.log('RSA signature verifies:', odata.equals(verified) ? 'YES' : 'NO');

  return message;
}

async function main() {
  const transport = new UsbTransport();
  const found = await transport.findZune();
  if (!found) { console.log('No Zune found.'); process.exit(1); }

  await transport.open(ZUNE_VENDOR_ID, found.productId);
  const mtp = new MtpProtocol(transport);
  await mtp.openSession(1);
  console.log('Session opened.\n');

  // Reset handshake state
  await mtp.resetMtpzHandshake();
  console.log('Handshake reset OK.');

  const certMessage = buildCertMessageCrypto();
  console.log('Certificate message:', certMessage.length, 'bytes');

  // Test A: No params (original)
  const codeA = await tryMtpzSend(mtp, transport, certMessage, 'Test A: Nparam=0', false);

  // Close and reopen for clean state
  try { await mtp.closeSession(); } catch {}
  mtp.transactionId = 0;
  await mtp.openSession(1);
  await mtp.resetMtpzHandshake();

  // Test B: With Param1=0
  const codeB = await tryMtpzSend(mtp, transport, certMessage, 'Test B: Nparam=1 Param1=0', true);

  // Close and reopen for clean state
  try { await mtp.closeSession(); } catch {}
  mtp.transactionId = 0;
  await mtp.openSession(1);
  await mtp.resetMtpzHandshake();

  // Test C: Send just a minimal message (test if format matters)
  const minimal = Buffer.from([0x02, 0x01, 0x00, 0x00]);
  const codeC = await tryMtpzSend(mtp, transport, minimal, 'Test C: Minimal 4-byte payload', false);

  console.log('\n=== Summary ===');
  console.log('Test A (no params):', '0x' + (codeA >= 0 ? codeA.toString(16) : 'error'));
  console.log('Test B (param=0): ', '0x' + (codeB >= 0 ? codeB.toString(16) : 'error'));
  console.log('Test C (minimal):  ', '0x' + (codeC >= 0 ? codeC.toString(16) : 'error'));

  try { await mtp.closeSession(); } catch {}
  await transport.close();
  console.log('\nDone!');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
