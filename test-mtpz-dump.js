// Dump the full MTPZ handshake with hex output of every step
const { WebUSB } = require('usb');
const crypto = require('crypto');
const {
  MTPZ_MODULUS, MTPZ_PRIVATE_KEY, MTPZ_CERTIFICATES,
} = require('./src/main/zune/mtpz-keys.js');

const RSA_BLOCK_SIZE = 128;

async function main() {
  const webusb = new WebUSB({ allowAllDevices: true });
  const device = await webusb.requestDevice({
    filters: [{ vendorId: 0x045E, productId: 0x063E }],
  });
  await device.open();
  if (device.configuration === null) await device.selectConfiguration(1);
  await device.claimInterface(0);
  console.log('Connected');

  // Helper functions
  async function write(data) {
    const r = await device.transferOut(1, data);
    return r;
  }
  async function readOne() {
    const r = await device.transferIn(1, 16384);
    return Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  }
  async function readFull() {
    const first = await readOne();
    const totalLen = first.readUInt32LE(0);
    if (first.length >= totalLen) return first.subarray(0, totalLen);
    const chunks = [first];
    let got = first.length;
    while (got < totalLen) {
      const chunk = await readOne();
      chunks.push(chunk);
      got += chunk.length;
    }
    return Buffer.concat(chunks).subarray(0, totalLen);
  }
  function buildCmd(txId, code, params = []) {
    const len = 12 + params.length * 4;
    const buf = Buffer.alloc(len);
    buf.writeUInt32LE(len, 0);
    buf.writeUInt16LE(0x0001, 4);
    buf.writeUInt16LE(code, 6);
    buf.writeUInt32LE(txId, 8);
    for (let i = 0; i < params.length; i++) buf.writeUInt32LE(params[i] >>> 0, 12 + i * 4);
    return buf;
  }
  async function sendDataSplit(txId, code, payload) {
    const hdr = Buffer.alloc(12);
    hdr.writeUInt32LE(12 + payload.length, 0);
    hdr.writeUInt16LE(0x0002, 4);
    hdr.writeUInt16LE(code, 6);
    hdr.writeUInt32LE(txId, 8);
    await write(hdr);
    await write(payload);
  }

  // RSA helpers (same as MtpzAuth)
  function modPow(base, exp, mod) {
    let result = 1n;
    base = base % mod;
    while (exp > 0n) {
      if (exp & 1n) result = (result * base) % mod;
      exp >>= 1n;
      base = (base * base) % mod;
    }
    return result;
  }
  function rsaRawPrivate(data) {
    const m = BigInt('0x' + data.toString('hex'));
    const d = BigInt('0x' + MTPZ_PRIVATE_KEY);
    const n = BigInt('0x' + MTPZ_MODULUS);
    const result = modPow(m, d, n);
    return Buffer.from(result.toString(16).padStart(256, '0'), 'hex');
  }
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

  // OpenSession
  await write(buildCmd(0, 0x1002, [1]));
  await readFull();
  console.log('Session opened');

  let txId = 0;

  // === Build and send certificate ===
  const { MtpzAuth } = require('./src/main/zune/mtpz-auth.js');
  const mockMtp = { transactionId: 0 };
  const auth = new MtpzAuth(mockMtp);
  const { message: certMsg, random } = auth._buildAppCertificateMessage();

  txId++;
  await write(buildCmd(txId, 0x9212));
  await sendDataSplit(txId, 0x9212, certMsg);
  const certResp = await readFull();
  console.log('Certificate response:', '0x' + certResp.readUInt16LE(6).toString(16));

  // === Get device response ===
  txId++;
  await write(buildCmd(txId, 0x9213));
  const devData = await readFull();
  const devResp = await readFull(); // RESPONSE
  console.log('GetResponse code:', '0x' + devResp.readUInt16LE(6).toString(16));

  const response = devData.subarray(12); // strip MTP container header
  console.log('\nDevice response:', response.length, 'bytes');
  console.log('Header (0-3):', response.subarray(0, 4).toString('hex'));

  // RSA decrypt
  const encrypted = response.subarray(4, 4 + RSA_BLOCK_SIZE);
  const decrypted = rsaRawPrivate(encrypted);

  // OAEP unmask
  const seedMask = mgf1(decrypted.subarray(21, RSA_BLOCK_SIZE), 20);
  for (let i = 0; i < 20; i++) decrypted[1 + i] ^= seedMask[i];
  const dataMask = mgf1(decrypted.subarray(1, 21), 107);
  for (let i = 0; i < 107; i++) decrypted[21 + i] ^= dataMask[i];

  const hashKey = Buffer.from(decrypted.subarray(112, RSA_BLOCK_SIZE));
  console.log('\nAES key (from RSA block[112:128]):', hashKey.toString('hex'));

  // AES decrypt
  const aesStart = 136;
  const aesLen = response.length - aesStart;
  console.log('AES ciphertext offset:', aesStart, 'length:', aesLen, '(' + (aesLen/16) + ' blocks)');
  console.log('Pre-AES bytes (132-135):', response.subarray(132, 136).toString('hex'));

  const iv = Buffer.alloc(16);
  const decipher = crypto.createDecipheriv('aes-128-cbc', hashKey, iv);
  decipher.setAutoPadding(false);
  const ciphertext = response.subarray(aesStart, aesStart + aesLen);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  console.log('\nDecrypted plaintext:', plaintext.length, 'bytes');

  // Parse plaintext - dump every field
  let offset = 0;
  console.log('\n=== Plaintext Parse ===');
  console.log(`[${offset}] First byte:`, '0x' + plaintext[offset].toString(16));
  offset += 1;

  const certsLen = plaintext.readUInt32BE(offset);
  console.log(`[${offset}] Certs length (uint32BE):`, certsLen);
  console.log(`[${offset}] Raw bytes:`, plaintext.subarray(offset, offset + 4).toString('hex'));
  offset += 4;
  console.log(`[${offset}] Certs data (first 20):`, plaintext.subarray(offset, offset + 20).toString('hex'));
  offset += certsLen;

  const ourRandLen = plaintext.readUInt16BE(offset);
  console.log(`\n[${offset}] Our random length (uint16BE):`, ourRandLen);
  offset += 2;
  const echoedRandom = plaintext.subarray(offset, offset + ourRandLen);
  console.log(`[${offset}] Echoed random:`, echoedRandom.toString('hex'));
  console.log('Random matches:', echoedRandom.equals(random));
  offset += ourRandLen;

  const devRandLen = plaintext.readUInt16BE(offset);
  console.log(`\n[${offset}] Device random length (uint16BE):`, devRandLen);
  offset += 2;
  const devRandom = plaintext.subarray(offset, offset + devRandLen);
  console.log(`[${offset}] Device random:`, devRandom.toString('hex'));
  offset += devRandLen;

  const sigMarker = plaintext[offset];
  console.log(`\n[${offset}] Sig marker:`, '0x' + sigMarker.toString(16));
  offset += 1;
  const sigLen = plaintext.readUInt16BE(offset);
  console.log(`[${offset}] Sig length (uint16BE):`, sigLen);
  offset += 2;
  console.log(`[${offset}] Signature (first 16):`, plaintext.subarray(offset, offset + 16).toString('hex'));
  offset += sigLen;

  const macMarker = plaintext[offset];
  console.log(`\n[${offset}] Mac marker:`, '0x' + macMarker.toString(16));
  offset += 1;
  const macHashLen = plaintext.readUInt16BE(offset);
  console.log(`[${offset}] Mac hash length (uint16BE):`, macHashLen);
  offset += 2;
  const macHash = Buffer.from(plaintext.subarray(offset, offset + macHashLen));
  console.log(`[${offset}] Mac hash:`, macHash.toString('hex'));
  console.log(`Remaining bytes after macHash: ${plaintext.length - offset - macHashLen}`);
  offset += macHashLen;

  // Check what follows
  if (offset < plaintext.length) {
    console.log(`\n[${offset}] Extra data after macHash:`, plaintext.subarray(offset, Math.min(offset + 32, plaintext.length)).toString('hex'));
  }

  // Build confirmation
  console.log('\n=== Confirmation ===');
  const cmacKey = macHash.subarray(0, 16);
  console.log('CMAC key:', cmacKey.toString('hex'));
  const seed = Buffer.alloc(16);
  seed[15] = 0x01;
  console.log('CMAC seed:', seed.toString('hex'));

  // AES-CMAC
  function aesEcb(key, data) {
    const c = crypto.createCipheriv('aes-128-ecb', key, null);
    c.setAutoPadding(false);
    return Buffer.concat([c.update(data), c.final()]);
  }
  const L = aesEcb(cmacKey, Buffer.alloc(16));
  console.log('L = AES(key, 0^16):', L.toString('hex'));
  const K1 = Buffer.alloc(16);
  for (let i = 0; i < 15; i++) K1[i] = ((L[i] << 1) | (L[i+1] >> 7)) & 0xFF;
  K1[15] = (L[15] << 1) & 0xFF;
  if (L[0] & 0x80) K1[15] ^= 0x87;
  console.log('K1:', K1.toString('hex'));
  const block = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) block[i] = seed[i] ^ K1[i];
  console.log('seed XOR K1:', block.toString('hex'));
  const cmac = aesEcb(cmacKey, block);
  console.log('CMAC:', cmac.toString('hex'));

  const confirmation = Buffer.alloc(20);
  confirmation[0] = 0x02;
  confirmation[1] = 0x03;
  confirmation[2] = 0x00;
  confirmation[3] = 0x10;
  cmac.copy(confirmation, 4);
  console.log('Full confirmation:', confirmation.toString('hex'));

  // Send confirmation
  console.log('\n=== Sending Confirmation ===');
  txId++;
  await write(buildCmd(txId, 0x9212));
  await sendDataSplit(txId, 0x9212, confirmation);
  const confirmResp = await readFull();
  const confirmCode = confirmResp.readUInt16LE(6);
  console.log('Response:', '0x' + confirmCode.toString(16),
    confirmCode === 0x2001 ? '*** SUCCESS ***' : 'FAILED');
  if (confirmCode !== 0x2001) {
    console.log('Response params:', Array.from({length: (confirmResp.length-12)/4}, (_, i) =>
      '0x' + confirmResp.readUInt32LE(12 + i*4).toString(16)));
  }

  // Close
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
