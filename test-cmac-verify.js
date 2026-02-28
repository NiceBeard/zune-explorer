// Verify AES-CMAC implementation against RFC 4493 test vectors
// and test with the actual macHash from the Zune handshake
const crypto = require('crypto');

function aesEcbEncrypt(key, data) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function leftShiftBuffer(buf) {
  const shifted = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length - 1; i++) {
    shifted[i] = ((buf[i] << 1) | (buf[i + 1] >> 7)) & 0xFF;
  }
  shifted[buf.length - 1] = (buf[buf.length - 1] << 1) & 0xFF;
  return shifted;
}

function aesCmac(key, data) {
  const zeroes = Buffer.alloc(16);
  const L = aesEcbEncrypt(key, zeroes);

  const K1 = leftShiftBuffer(L);
  if (L[0] & 0x80) K1[15] ^= 0x87;

  const K2 = leftShiftBuffer(K1);
  if (K1[0] & 0x80) K2[15] ^= 0x87;

  const block = Buffer.alloc(16);

  if (data.length === 16) {
    for (let i = 0; i < 16; i++) block[i] = data[i] ^ K1[i];
  } else {
    data.copy(block, 0, 0, data.length);
    block[data.length] = 0x80;
    for (let i = 0; i < 16; i++) block[i] ^= K2[i];
  }

  return aesEcbEncrypt(key, block);
}

// RFC 4493 Test Vectors
const rfcKey = Buffer.from('2b7e151628aed2a6abf7158809cf4f3c', 'hex');

console.log('=== RFC 4493 AES-CMAC Test Vectors ===\n');

// Test 1: Empty message (0 bytes)
const test1 = aesCmac(rfcKey, Buffer.alloc(0));
const expected1 = 'bb1d6929e95937287fa37d129b756746';
console.log('Test 1 (0 bytes):');
console.log('  Got:      ', test1.toString('hex'));
console.log('  Expected: ', expected1);
console.log('  Match:    ', test1.toString('hex') === expected1 ? 'YES' : 'NO');

// Test 2: 16 bytes
const msg2 = Buffer.from('6bc1bee22e409f96e93d7e117393172a', 'hex');
const test2 = aesCmac(rfcKey, msg2);
const expected2 = '070a16b46b4d4144f79bdd9dd04a287c';
console.log('\nTest 2 (16 bytes):');
console.log('  Got:      ', test2.toString('hex'));
console.log('  Expected: ', expected2);
console.log('  Match:    ', test2.toString('hex') === expected2 ? 'YES' : 'NO');

// Test 3: 40 bytes (multi-block - our implementation only handles 1 block, but test anyway)
// Skip for now since we only need single-block CMAC

// Now test with actual Zune macHash
console.log('\n=== Zune MTPZ CMAC Verification ===\n');
const macHash = Buffer.from('3d1957b4e7af2988e590e65a9e3b9c489c99c2025f92442867b36e830e4fe08e', 'hex');
const cmacKey = macHash.subarray(0, 16);
console.log('CMAC key:', cmacKey.toString('hex'));

// Confirmation CMAC
const seed = Buffer.alloc(16);
seed[15] = 0x01;
console.log('Seed:', seed.toString('hex'));

const confirmCmac = aesCmac(cmacKey, seed);
console.log('Confirmation CMAC:', confirmCmac.toString('hex'));

// Full confirmation message
const confirmation = Buffer.alloc(20);
confirmation[0] = 0x02;
confirmation[1] = 0x03;
confirmation[2] = 0x00;
confirmation[3] = 0x10;
confirmCmac.copy(confirmation, 4);
console.log('Confirmation msg:', confirmation.toString('hex'));

// EnableTrusted CMAC
const macCount = macHash.subarray(16, 20);
console.log('\nmacCount:', macCount.toString('hex'));

const trustedCmac = aesCmac(cmacKey, macCount);
console.log('Trusted CMAC:', trustedCmac.toString('hex'));
console.log('Trusted params:');
console.log('  h1:', '0x' + trustedCmac.readUInt32BE(0).toString(16));
console.log('  h2:', '0x' + trustedCmac.readUInt32BE(4).toString(16));
console.log('  h3:', '0x' + trustedCmac.readUInt32BE(8).toString(16));
console.log('  h4:', '0x' + trustedCmac.readUInt32BE(12).toString(16));
