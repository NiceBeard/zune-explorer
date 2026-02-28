// Verify MTPZ crypto independently of USB
const crypto = require('crypto');
const {
  MTPZ_PUBLIC_EXPONENT,
  MTPZ_MODULUS,
  MTPZ_PRIVATE_KEY,
  MTPZ_CERTIFICATES,
} = require('./src/main/zune/mtpz-keys');

const RSA_BLOCK_SIZE = 128;

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

function mgf1Sha1(seed, length) {
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

// Use fixed random for reproducibility
const fixedRandom = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');

console.log('=== MTPZ Crypto Verification ===\n');
console.log('Certificate data length:', MTPZ_CERTIFICATES.length, 'bytes');
console.log('Modulus length:', MTPZ_MODULUS.length, 'hex chars =', MTPZ_MODULUS.length / 2, 'bytes');
console.log('Private key length:', MTPZ_PRIVATE_KEY.length, 'hex chars =', MTPZ_PRIVATE_KEY.length / 2, 'bytes');

// Build certificate message (same as _buildAppCertificateMessage)
const certsLen = MTPZ_CERTIFICATES.length;
const preSignLen = 5 + 2 + certsLen + 2 + 16;
const totalLen = preSignLen + 3 + RSA_BLOCK_SIZE;

console.log('\nMessage structure:');
console.log('  certsLen:', certsLen);
console.log('  preSignLen:', preSignLen);
console.log('  totalLen:', totalLen);

const message = Buffer.alloc(totalLen);
let offset = 0;

message[offset++] = 0x02;
message[offset++] = 0x01;
message[offset++] = 0x01;
message[offset++] = 0x00;
message[offset++] = 0x00;
message.writeUInt16BE(certsLen, offset);
offset += 2;
MTPZ_CERTIFICATES.copy(message, offset);
offset += certsLen;
message[offset++] = 0x00;
message[offset++] = 0x10;
fixedRandom.copy(message, offset);
offset += 16;
message[offset++] = 0x01;
message[offset++] = 0x00;
message[offset++] = 0x80;

console.log('  offset before signature:', offset);

// Compute signature
const innerHash = crypto.createHash('sha1')
  .update(message.subarray(2, preSignLen))
  .digest();
console.log('\n  innerHash (SHA1 of msg[2..preSignLen)):', innerHash.toString('hex'));

const v16 = Buffer.alloc(28);
innerHash.copy(v16, 8);
const hash = crypto.createHash('sha1').update(v16).digest();
console.log('  hash (SHA1 of 8_zeros||innerHash):', hash.toString('hex'));

const mask = mgf1Sha1(hash, 107);
console.log('  mask[0..9]:', mask.subarray(0, 10).toString('hex'));
console.log('  mask[106]:', mask[106].toString(16));

const odata = Buffer.alloc(RSA_BLOCK_SIZE);
odata[106] = 0x01;
hash.copy(odata, 107);

for (let i = 0; i < 107; i++) {
  odata[i] ^= mask[i];
}
odata[0] &= 0x7F;
odata[127] = 0xBC;

console.log('\n  odata[0..9]:', odata.subarray(0, 10).toString('hex'));
console.log('  odata[105..127]:', odata.subarray(105).toString('hex'));

// RSA sign: signature = odata^d mod n
const m = BigInt('0x' + odata.toString('hex'));
const d = BigInt('0x' + MTPZ_PRIVATE_KEY);
const n = BigInt('0x' + MTPZ_MODULUS);
const e = BigInt('0x' + MTPZ_PUBLIC_EXPONENT);

console.log('\nComputing RSA signature (m^d mod n)...');
const sig = modPow(m, d, n);
const sigHex = sig.toString(16).padStart(RSA_BLOCK_SIZE * 2, '0');
const sigBuf = Buffer.from(sigHex, 'hex');

console.log('  signature[0..9]:', sigBuf.subarray(0, 10).toString('hex'));

// Verify: check that sig^e mod n == odata
console.log('\nVerifying: sig^e mod n...');
const verified = modPow(sig, e, n);
const verifiedHex = verified.toString(16).padStart(RSA_BLOCK_SIZE * 2, '0');
const verifiedBuf = Buffer.from(verifiedHex, 'hex');

console.log('  result[0..9]:', verifiedBuf.subarray(0, 10).toString('hex'));
console.log('  matches odata:', odata.equals(verifiedBuf) ? 'YES' : 'NO');

// Copy signature into message
sigBuf.copy(message, offset);

console.log('\n=== Full message hex ===');
console.log('First 20 bytes:', message.subarray(0, 20).toString('hex'));
console.log('Last 20 bytes:', message.subarray(-20).toString('hex'));
console.log('Total length:', message.length);
