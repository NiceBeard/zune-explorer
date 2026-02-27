const crypto = require('crypto');

const { DeviceProperty } = require('./mtp-constants.js');
const {
  MTPZ_MODULUS,
  MTPZ_PRIVATE_KEY,
  MTPZ_CERTIFICATES,
} = require('./mtpz-keys.js');

const RSA_BLOCK_SIZE = 128;

class MtpzAuth {
  constructor(mtp) {
    this.mtp = mtp;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async authenticate() {
    // Step 1: Identify this session to the device
    await this.mtp.setDeviceProperty(
      DeviceProperty.SessionInitiatorInfo,
      'ZuneExplorer/1.0 - MTPZ'
    );

    // Step 2: Reset any prior handshake state
    await this.mtp.resetMtpzHandshake();

    // Step 3: Send our application certificate with RSA signature
    const { message, random } = this._buildAppCertificateMessage();
    await this.mtp.sendMtpzRequest(message);

    // Step 4: Receive and decrypt the device's challenge response
    const response = await this.mtp.getMtpzResponse();
    const { macHash } = this._parseDeviceResponse(response, random);

    // Step 5: Send AES-CMAC confirmation proving we decrypted successfully
    const confirmation = this._buildConfirmation(macHash);
    await this.mtp.sendMtpzRequest(confirmation);

    // Step 6: Enable trusted file operations with derived hash values
    await this._enableTrusted(macHash);

    return true;
  }

  // ---------------------------------------------------------------------------
  // RSA primitives (raw BigInt — no Node.js crypto RSA, we need unpadded ops)
  // ---------------------------------------------------------------------------

  _modPow(base, exp, mod) {
    let result = 1n;
    base = base % mod;

    while (exp > 0n) {
      if (exp & 1n) {
        result = (result * base) % mod;
      }
      exp >>= 1n;
      base = (base * base) % mod;
    }

    return result;
  }

  _rsaRawPrivate(data) {
    const m = BigInt('0x' + data.toString('hex'));
    const d = BigInt('0x' + MTPZ_PRIVATE_KEY);
    const n = BigInt('0x' + MTPZ_MODULUS);

    const result = this._modPow(m, d, n);

    const hex = result.toString(16).padStart(RSA_BLOCK_SIZE * 2, '0');
    return Buffer.from(hex, 'hex');
  }

  // ---------------------------------------------------------------------------
  // MGF1 (Mask Generation Function) per PKCS#1 v2.1
  // ---------------------------------------------------------------------------

  _mgf1Sha1(seed, length) {
    const iterations = Math.ceil(length / 20) + 1;
    const chunks = [];

    for (let counter = 0; counter < iterations; counter++) {
      const counterBuf = Buffer.alloc(4);
      counterBuf.writeUInt32BE(counter, 0);

      const hash = crypto.createHash('sha1');
      hash.update(seed);
      hash.update(counterBuf);
      chunks.push(hash.digest());
    }

    return Buffer.concat(chunks).subarray(0, length);
  }

  // ---------------------------------------------------------------------------
  // Step 3: Build the 785-byte application certificate message
  // ---------------------------------------------------------------------------

  _buildAppCertificateMessage() {
    const certsLen = MTPZ_CERTIFICATES.length;
    const randomData = crypto.randomBytes(16);

    // Calculate total message size before the signature:
    // 5 (header) + 2 (certsLen) + certsLen + 2 (randomLen marker) + 16 (random)
    const preSignLen = 5 + 2 + certsLen + 2 + 16;
    // Total: preSignLen + 3 (signature header) + 128 (signature)
    const totalLen = preSignLen + 3 + RSA_BLOCK_SIZE;

    const message = Buffer.alloc(totalLen);
    let offset = 0;

    // Header bytes
    message[offset++] = 0x02;
    message[offset++] = 0x01;
    message[offset++] = 0x01;
    message[offset++] = 0x00;
    message[offset++] = 0x00;

    // Certificates length (uint16BE) and data
    message.writeUInt16BE(certsLen, offset);
    offset += 2;
    MTPZ_CERTIFICATES.copy(message, offset);
    offset += certsLen;

    // Random length marker and random bytes
    message[offset++] = 0x00;
    message[offset++] = 0x10;
    randomData.copy(message, offset);
    offset += 16;

    // Signature header
    message[offset++] = 0x01;
    message[offset++] = 0x00;
    message[offset++] = 0x80;

    // Compute PSS-like RSA signature over bytes [2..preSignLen)
    const signature = this._computeSignature(message, preSignLen);
    signature.copy(message, offset);

    return { message, random: randomData };
  }

  _computeSignature(message, preSignLen) {
    // Step 1: SHA-1 hash of the message content (bytes [2..preSignLen))
    const innerHash = crypto.createHash('sha1')
      .update(message.subarray(2, preSignLen))
      .digest();

    // Step 2: Place innerHash into a 28-byte buffer at offset 8 (first 8 bytes zero)
    const v16 = Buffer.alloc(28);
    innerHash.copy(v16, 8);

    // Step 3: SHA-1 hash of v16
    const hash = crypto.createHash('sha1').update(v16).digest();

    // Step 4: Generate mask via MGF1
    const mask = this._mgf1Sha1(hash, 107);

    // Step 5: Build the 128-byte padded block for RSA signing
    const odata = Buffer.alloc(RSA_BLOCK_SIZE);

    // odata[0..105] = zeros (already from alloc)
    odata[106] = 0x01;
    hash.copy(odata, 107); // hash at [107..126]

    // XOR first 107 bytes with mask
    for (let i = 0; i < 107; i++) {
      odata[i] ^= mask[i];
    }

    // Clear the top bit and set the trailer byte
    odata[0] &= 0x7F;
    odata[127] = 0xBC;

    // Step 6: RSA raw private key operation
    return this._rsaRawPrivate(odata);
  }

  // ---------------------------------------------------------------------------
  // Step 4: Parse and decrypt the device's response
  // ---------------------------------------------------------------------------

  _parseDeviceResponse(response, sentRandom) {
    if (response[0] !== 0x02 || response[1] !== 0x02 || response[3] !== 0x80) {
      throw new Error(
        'MTPZ: unexpected device response header: ' +
        `[${response[0]}, ${response[1]}, ${response[2]}, ${response[3]}]`
      );
    }

    // RSA-decrypt the 128-byte encrypted block starting at offset 4
    const encrypted = response.subarray(4, 4 + RSA_BLOCK_SIZE);
    const decrypted = this._rsaRawPrivate(encrypted);

    // OAEP unmask
    const seedMask = this._mgf1Sha1(decrypted.subarray(21, RSA_BLOCK_SIZE), 20);
    for (let i = 0; i < 20; i++) {
      decrypted[1 + i] ^= seedMask[i];
    }

    const dataMask = this._mgf1Sha1(decrypted.subarray(1, 21), 107);
    for (let i = 0; i < 107; i++) {
      decrypted[21 + i] ^= dataMask[i];
    }

    // Extract the AES session key from the unmasked data
    const hashKey = Buffer.from(decrypted.subarray(112, RSA_BLOCK_SIZE));

    // Verify the AES-encrypted block header
    if (response[134] !== 0x03) {
      throw new Error(
        `MTPZ: expected 0x03 at response[134], got 0x${response[134].toString(16)}`
      );
    }

    const aesBlockLen = response[135] * 16;
    if (aesBlockLen === 0) {
      throw new Error('MTPZ: AES encrypted block length is zero');
    }

    // AES-128-CBC decrypt the device's encrypted payload
    const iv = Buffer.alloc(16);
    const decipher = crypto.createDecipheriv('aes-128-cbc', hashKey, iv);
    decipher.setAutoPadding(false);

    const ciphertext = response.subarray(136, 136 + aesBlockLen);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    // Parse the decrypted payload
    let offset = 1; // skip first byte

    const certsLength = plaintext.readUInt32BE(offset);
    offset += 4 + certsLength; // skip certs

    const randLength = plaintext.readUInt16BE(offset);
    offset += 2;

    // Verify the echoed random matches what we sent
    const echoedRandom = plaintext.subarray(offset, offset + randLength);
    offset += randLength;

    if (!echoedRandom.equals(sentRandom)) {
      throw new Error('MTPZ: device echoed random does not match sent random');
    }

    // Skip device random
    const devRandLength = plaintext.readUInt16BE(offset);
    offset += 2 + devRandLength;

    // Skip signature block: 1 byte + uint16BE length + data
    offset += 1;
    const sigLength = plaintext.readUInt16BE(offset);
    offset += 2 + sigLength;

    // Read the MAC hash: 1 byte + uint16BE length + data
    offset += 1;
    const macHashLength = plaintext.readUInt16BE(offset);
    offset += 2;

    const macHash = Buffer.from(plaintext.subarray(offset, offset + macHashLength));

    return { macHash };
  }

  // ---------------------------------------------------------------------------
  // AES-CMAC (RFC 4493)
  // ---------------------------------------------------------------------------

  _aesCmac(key, data) {
    // Step 1: AES-encrypt a zero block to derive the subkeys
    const zeroes = Buffer.alloc(16);
    const L = this._aesEcbEncrypt(key, zeroes);

    // Step 2: Derive K1 by left-shifting L; XOR with 0x87 if MSB was set
    const K1 = this._leftShiftBuffer(L);
    if (L[0] & 0x80) {
      K1[15] ^= 0x87;
    }

    // Step 3: Derive K2 by left-shifting K1; same conditional XOR
    const K2 = this._leftShiftBuffer(K1);
    if (K1[0] & 0x80) {
      K2[15] ^= 0x87;
    }

    // Step 4: XOR the data with the appropriate subkey
    const block = Buffer.alloc(16);

    if (data.length === 16) {
      // Complete block: XOR with K1
      for (let i = 0; i < 16; i++) {
        block[i] = data[i] ^ K1[i];
      }
    } else {
      // Incomplete block: pad with 0x80 then zeros, XOR with K2
      data.copy(block, 0, 0, data.length);
      block[data.length] = 0x80;
      for (let i = 0; i < 16; i++) {
        block[i] ^= K2[i];
      }
    }

    // Step 5: Final AES-ECB encryption produces the CMAC tag
    return this._aesEcbEncrypt(key, block);
  }

  _aesEcbEncrypt(key, data) {
    const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(data), cipher.final()]);
  }

  _leftShiftBuffer(buf) {
    const shifted = Buffer.alloc(buf.length);

    for (let i = 0; i < buf.length - 1; i++) {
      shifted[i] = ((buf[i] << 1) | (buf[i + 1] >> 7)) & 0xFF;
    }
    shifted[buf.length - 1] = (buf[buf.length - 1] << 1) & 0xFF;

    return shifted;
  }

  // ---------------------------------------------------------------------------
  // Step 5: Build the 20-byte confirmation message
  // ---------------------------------------------------------------------------

  _buildConfirmation(macHash) {
    const confirmation = Buffer.alloc(20);

    confirmation[0] = 0x02;
    confirmation[1] = 0x03;
    confirmation[2] = 0x00;
    confirmation[3] = 0x10;

    // CMAC seed: 16 zeros with the last byte set to 0x01
    const seed = Buffer.alloc(16);
    seed[15] = 0x01;

    const cmacKey = macHash.subarray(0, 16);
    const cmac = this._aesCmac(cmacKey, seed);
    cmac.copy(confirmation, 4);

    return confirmation;
  }

  // ---------------------------------------------------------------------------
  // Step 6: Enable trusted file operations
  // ---------------------------------------------------------------------------

  async _enableTrusted(macHash) {
    const cmacKey = macHash.subarray(0, 16);
    const macCount = macHash.subarray(16, 20);

    const cmac = this._aesCmac(cmacKey, macCount);

    const h1 = cmac.readUInt32BE(0);
    const h2 = cmac.readUInt32BE(4);
    const h3 = cmac.readUInt32BE(8);
    const h4 = cmac.readUInt32BE(12);

    await this.mtp.enableTrustedFileOperations(h1, h2, h3, h4);
  }
}

module.exports = { MtpzAuth };
