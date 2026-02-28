// Comprehensive MTPZ confirmation diagnostic
// Tests multiple approaches for sending the confirmation after a successful handshake
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
  console.log('Connected to Zune');

  // === USB helpers ===
  async function write(data) {
    return device.transferOut(1, data);
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
  // Send DATA as split header + payload (proven to work)
  async function sendDataSplit(txId, code, payload) {
    const hdr = Buffer.alloc(12);
    hdr.writeUInt32LE(12 + payload.length, 0);
    hdr.writeUInt16LE(0x0002, 4);
    hdr.writeUInt16LE(code, 6);
    hdr.writeUInt32LE(txId, 8);
    await write(hdr);
    await write(payload);
  }
  // Send DATA as combined single write
  async function sendDataCombined(txId, code, payload) {
    const buf = Buffer.alloc(12 + payload.length);
    buf.writeUInt32LE(12 + payload.length, 0);
    buf.writeUInt16LE(0x0002, 4);
    buf.writeUInt16LE(code, 6);
    buf.writeUInt32LE(txId, 8);
    payload.copy(buf, 12);
    await write(buf);
  }
  function mtpStr(s) {
    const withNull = s + '\0';
    const buf = Buffer.alloc(1 + withNull.length * 2);
    buf.writeUInt8(withNull.length, 0);
    buf.write(withNull, 1, 'utf16le');
    return buf;
  }

  // === RSA helpers ===
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
  function aesEcb(key, data) {
    const c = crypto.createCipheriv('aes-128-ecb', key, null);
    c.setAutoPadding(false);
    return Buffer.concat([c.update(data), c.final()]);
  }
  function leftShift(buf) {
    const s = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length - 1; i++) s[i] = ((buf[i] << 1) | (buf[i + 1] >> 7)) & 0xFF;
    s[buf.length - 1] = (buf[buf.length - 1] << 1) & 0xFF;
    return s;
  }
  function aesCmac(key, data) {
    const L = aesEcb(key, Buffer.alloc(16));
    const K1 = leftShift(L);
    if (L[0] & 0x80) K1[15] ^= 0x87;
    const K2 = leftShift(K1);
    if (K1[0] & 0x80) K2[15] ^= 0x87;
    const block = Buffer.alloc(16);
    if (data.length === 16) {
      for (let i = 0; i < 16; i++) block[i] = data[i] ^ K1[i];
    } else {
      data.copy(block, 0, 0, data.length);
      block[data.length] = 0x80;
      for (let i = 0; i < 16; i++) block[i] ^= K2[i];
    }
    return aesEcb(key, block);
  }

  // === Build certificate message (same as MtpzAuth) ===
  function buildCertificate() {
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
    const innerHash = crypto.createHash('sha1').update(message.subarray(2, preSignLen)).digest();
    const v16 = Buffer.alloc(28);
    innerHash.copy(v16, 8);
    const hash = crypto.createHash('sha1').update(v16).digest();
    const mask = mgf1(hash, 107);
    const odata = Buffer.alloc(RSA_BLOCK_SIZE);
    odata[106] = 0x01;
    hash.copy(odata, 107);
    for (let i = 0; i < 107; i++) odata[i] ^= mask[i];
    odata[0] &= 0x7F;
    odata[127] = 0xBC;
    const sig = rsaRawPrivate(odata);
    sig.copy(message, offset);
    return { message, random: randomData };
  }

  // === Parse device response ===
  function parseResponse(response, sentRandom) {
    console.log('\n=== PARSING DEVICE RESPONSE ===');
    console.log('Total response length:', response.length);
    console.log('Header:', response.subarray(0, 4).toString('hex'));

    // RSA decrypt
    const encrypted = response.subarray(4, 4 + RSA_BLOCK_SIZE);
    const decrypted = rsaRawPrivate(encrypted);

    // OAEP unmask
    const seedMask = mgf1(decrypted.subarray(21, RSA_BLOCK_SIZE), 20);
    for (let i = 0; i < 20; i++) decrypted[1 + i] ^= seedMask[i];
    const dataMask = mgf1(decrypted.subarray(1, 21), 107);
    for (let i = 0; i < 107; i++) decrypted[21 + i] ^= dataMask[i];

    const hashKey = Buffer.from(decrypted.subarray(112, RSA_BLOCK_SIZE));
    console.log('AES session key:', hashKey.toString('hex'));

    // AES decrypt - read length from bytes 134-135 as big-endian uint16
    const aesLen = response.readUInt16BE(134);
    console.log('AES marker bytes (132-135):', response.subarray(132, 136).toString('hex'));
    console.log('AES length (from uint16BE at 134):', aesLen, 'bytes');

    const iv = Buffer.alloc(16);
    const decipher = crypto.createDecipheriv('aes-128-cbc', hashKey, iv);
    decipher.setAutoPadding(false);
    const ciphertext = response.subarray(136, 136 + aesLen);
    console.log('Actual ciphertext length:', ciphertext.length);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    // Parse plaintext field by field
    let offset = 0;
    console.log('\n--- Plaintext Fields ---');
    console.log(`[${offset}] Type byte: 0x${plaintext[offset].toString(16)}`);
    offset += 1;

    const certsLen = plaintext.readUInt32BE(offset);
    console.log(`[${offset}] Certs length: ${certsLen}`);
    offset += 4;
    console.log(`[${offset}] Certs data (first 8): ${plaintext.subarray(offset, offset + 8).toString('hex')}`);
    offset += certsLen;

    const randLen = plaintext.readUInt16BE(offset);
    console.log(`\n[${offset}] Our random length: ${randLen}`);
    offset += 2;
    const echoedRandom = plaintext.subarray(offset, offset + randLen);
    console.log(`[${offset}] Echoed random: ${echoedRandom.toString('hex')}`);
    console.log(`Random matches: ${echoedRandom.equals(sentRandom)}`);
    if (!echoedRandom.equals(sentRandom)) {
      throw new Error('Echoed random does not match!');
    }
    offset += randLen;

    const devRandLen = plaintext.readUInt16BE(offset);
    console.log(`\n[${offset}] Device random length: ${devRandLen}`);
    offset += 2;
    const devRandom = plaintext.subarray(offset, offset + devRandLen);
    console.log(`[${offset}] Device random: ${devRandom.toString('hex')}`);
    offset += devRandLen;

    const sigMarker = plaintext[offset];
    console.log(`\n[${offset}] Sig marker: 0x${sigMarker.toString(16)}`);
    offset += 1;
    const sigLen = plaintext.readUInt16BE(offset);
    console.log(`[${offset}] Sig length: ${sigLen}`);
    offset += 2;
    console.log(`[${offset}] Signature (first 16): ${plaintext.subarray(offset, offset + 16).toString('hex')}`);
    offset += sigLen;

    const macMarker = plaintext[offset];
    console.log(`\n[${offset}] Mac marker: 0x${macMarker.toString(16)}`);
    offset += 1;
    const macHashLen = plaintext.readUInt16BE(offset);
    console.log(`[${offset}] Mac hash length: ${macHashLen}`);
    offset += 2;
    const macHash = Buffer.from(plaintext.subarray(offset, offset + macHashLen));
    console.log(`[${offset}] Mac hash: ${macHash.toString('hex')}`);
    offset += macHashLen;

    console.log(`\nParsed ${offset} of ${plaintext.length} plaintext bytes`);
    if (offset < plaintext.length) {
      const remaining = plaintext.length - offset;
      console.log(`Remaining ${remaining} bytes: ${plaintext.subarray(offset, Math.min(offset + 32, plaintext.length)).toString('hex')}...`);
    }

    return macHash;
  }

  // === Build confirmation ===
  function buildConfirmation(macHash) {
    const cmacKey = macHash.subarray(0, 16);
    const seed = Buffer.alloc(16);
    seed[15] = 0x01;

    console.log('\n=== CMAC COMPUTATION ===');
    console.log('CMAC key:', cmacKey.toString('hex'));
    console.log('Seed:', seed.toString('hex'));

    const L = aesEcb(cmacKey, Buffer.alloc(16));
    console.log('L = AES(key, 0^16):', L.toString('hex'));
    const K1 = leftShift(L);
    if (L[0] & 0x80) K1[15] ^= 0x87;
    console.log('K1:', K1.toString('hex'));
    const block = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) block[i] = seed[i] ^ K1[i];
    console.log('seed XOR K1:', block.toString('hex'));
    const cmac = aesEcb(cmacKey, block);
    console.log('CMAC result:', cmac.toString('hex'));

    // Also verify with our aesCmac function
    const cmac2 = aesCmac(cmacKey, seed);
    console.log('CMAC (verify):', cmac2.toString('hex'));
    console.log('CMAC match:', cmac.equals(cmac2));

    const confirmation = Buffer.alloc(20);
    confirmation[0] = 0x02;
    confirmation[1] = 0x03;
    confirmation[2] = 0x00;
    confirmation[3] = 0x10;
    cmac.copy(confirmation, 4);
    console.log('Confirmation msg:', confirmation.toString('hex'));
    return confirmation;
  }

  // =====================================================================
  // RUN THE HANDSHAKE WITH MULTIPLE CONFIRMATION STRATEGIES
  // =====================================================================

  async function doHandshake(label, options = {}) {
    const { setInitiator, doReset, confirmStrategy, delayMs } = options;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`ATTEMPT: ${label}`);
    console.log(`Options: setInitiator=${!!setInitiator}, doReset=${!!doReset}, strategy=${confirmStrategy}, delay=${delayMs || 0}ms`);
    console.log('='.repeat(60));

    // OpenSession
    await write(buildCmd(0, 0x1002, [1]));
    const openResp = await readFull();
    const openCode = openResp.readUInt16LE(6);
    console.log('OpenSession:', '0x' + openCode.toString(16));
    if (openCode !== 0x2001) {
      console.log('OpenSession failed, trying close+reopen...');
      await write(buildCmd(1, 0x1003));
      try { await readFull(); } catch {}
      await write(buildCmd(0, 0x1002, [1]));
      await readFull();
    }

    let txId = 0;

    // Always reset MTPZ state first (EndTrustedAppSession 0x9216)
    txId++;
    console.log(`\nClearing MTPZ state (EndTrustedAppSession, txId=${txId})...`);
    await write(buildCmd(txId, 0x9216));
    const clearResp = await readFull();
    console.log('Clear result:', '0x' + clearResp.readUInt16LE(6).toString(16));

    // Optional: Set SessionInitiatorInfo (0xD406)
    if (setInitiator) {
      txId++;
      console.log(`\nSetting SessionInitiatorInfo (txId=${txId})...`);
      await write(buildCmd(txId, 0x1016, [0xD406]));
      const initiatorStr = mtpStr(setInitiator);
      await sendDataSplit(txId, 0x1016, initiatorStr);
      const siResp = await readFull();
      console.log('SetInitiator result:', '0x' + siResp.readUInt16LE(6).toString(16));
    }

    // Optional: Reset handshake (EndTrustedAppSession 0x9216)
    if (doReset) {
      txId++;
      console.log(`\nResetting handshake (txId=${txId})...`);
      await write(buildCmd(txId, 0x9216));
      const resetResp = await readFull();
      console.log('Reset result:', '0x' + resetResp.readUInt16LE(6).toString(16));
    }

    // Step 1: Send certificate
    const { message: certMsg, random } = buildCertificate();
    txId++;
    console.log(`\nSending certificate (txId=${txId}, ${certMsg.length} bytes)...`);
    await write(buildCmd(txId, 0x9212));
    await sendDataSplit(txId, 0x9212, certMsg);
    const certResp = await readFull();
    const certCode = certResp.readUInt16LE(6);
    console.log('Certificate result:', '0x' + certCode.toString(16));
    if (certCode !== 0x2001) {
      console.log('Certificate REJECTED! Aborting this attempt.');
      // Close session
      txId++;
      await write(buildCmd(txId, 0x1003));
      try { await readFull(); } catch {}
      return false;
    }

    // Step 2: Get device response
    txId++;
    console.log(`\nGetting device response (txId=${txId})...`);
    await write(buildCmd(txId, 0x9213));
    const devData = await readFull();  // DATA
    const devResp = await readFull();  // RESPONSE
    const respCode = devResp.readUInt16LE(6);
    console.log('GetResponse result:', '0x' + respCode.toString(16));
    if (respCode !== 0x2001) {
      console.log('GetResponse FAILED! Aborting.');
      txId++;
      await write(buildCmd(txId, 0x1003));
      try { await readFull(); } catch {}
      return false;
    }

    const response = devData.subarray(12); // strip MTP container header
    const macHash = parseResponse(response, random);

    // Optional delay before confirmation
    if (delayMs) {
      console.log(`\nWaiting ${delayMs}ms before confirmation...`);
      await new Promise(r => setTimeout(r, delayMs));
    }

    // Step 3: Send confirmation
    const confirmation = buildConfirmation(macHash);
    txId++;
    console.log(`\nSending confirmation (txId=${txId}, strategy=${confirmStrategy})...`);

    const cmdBuf = buildCmd(txId, 0x9212);
    console.log('CMD bytes:', cmdBuf.toString('hex'));
    await write(cmdBuf);

    // Build the DATA container for logging
    const dataHdr = Buffer.alloc(12);
    dataHdr.writeUInt32LE(12 + confirmation.length, 0);
    dataHdr.writeUInt16LE(0x0002, 4);
    dataHdr.writeUInt16LE(0x9212, 6);
    dataHdr.writeUInt32LE(txId, 8);
    console.log('DATA header bytes:', dataHdr.toString('hex'));
    console.log('DATA payload bytes:', confirmation.toString('hex'));

    switch (confirmStrategy) {
      case 'split':
        await sendDataSplit(txId, 0x9212, confirmation);
        break;
      case 'combined':
        await sendDataCombined(txId, 0x9212, confirmation);
        break;
      case 'padded512': {
        // Pad DATA container to exactly 512 bytes
        const padded = Buffer.alloc(500); // 500 payload + 12 header = 512
        confirmation.copy(padded, 0);
        await sendDataSplit(txId, 0x9212, padded);
        break;
      }
      default:
        await sendDataSplit(txId, 0x9212, confirmation);
    }

    const confirmResp = await readFull();
    const confirmCode = confirmResp.readUInt16LE(6);
    const success = confirmCode === 0x2001;
    console.log('\nConfirmation result:', '0x' + confirmCode.toString(16),
      success ? '*** SUCCESS ***' : 'FAILED');
    if (!success) {
      const paramCount = (confirmResp.length - 12) / 4;
      if (paramCount > 0) {
        const params = [];
        for (let i = 0; i < paramCount; i++) params.push('0x' + confirmResp.readUInt32LE(12 + i * 4).toString(16));
        console.log('Error params:', params.join(', '));
      }
    }

    // Close session
    txId++;
    await write(buildCmd(txId, 0x1003));
    try { await readFull(); } catch {}

    return success;
  }

  // =====================================================================
  // Try multiple strategies
  // =====================================================================

  const strategies = [
    {
      label: '1: C-code exact (initiator + reset + split)',
      setInitiator: 'libmtp/Sajid Anwar - MTPZClassDriver',
      doReset: true,
      confirmStrategy: 'split',
    },
    {
      label: '2: C-code exact + combined DATA',
      setInitiator: 'libmtp/Sajid Anwar - MTPZClassDriver',
      doReset: true,
      confirmStrategy: 'combined',
    },
    {
      label: '3: C-code exact + 100ms delay',
      setInitiator: 'libmtp/Sajid Anwar - MTPZClassDriver',
      doReset: true,
      confirmStrategy: 'split',
      delayMs: 100,
    },
    {
      label: '4: No initiator, no reset, split',
      confirmStrategy: 'split',
    },
    {
      label: '5: No initiator, no reset, combined',
      confirmStrategy: 'combined',
    },
    {
      label: '6: C-code exact + 500ms delay',
      setInitiator: 'libmtp/Sajid Anwar - MTPZClassDriver',
      doReset: true,
      confirmStrategy: 'split',
      delayMs: 500,
    },
  ];

  const results = [];

  for (const strat of strategies) {
    try {
      const success = await doHandshake(strat.label, strat);
      results.push({ label: strat.label, success });
      if (success) {
        console.log('\n*** FOUND WORKING STRATEGY! ***');
        break;
      }
    } catch (err) {
      console.log('Error during attempt:', err.message);
      results.push({ label: strat.label, success: false, error: err.message });
    }

    // Brief pause between attempts for device to reset
    console.log('\nWaiting 2s before next attempt...');
    await new Promise(r => setTimeout(r, 2000));
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  for (const r of results) {
    console.log(`${r.label}: ${r.success ? 'SUCCESS' : 'FAILED'}${r.error ? ' (' + r.error + ')' : ''}`);
  }

  await device.releaseInterface(0);
  await device.close();
  console.log('\nDone!');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
