const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MtpProtocol } = require('../src/main/zune/mtp-protocol.js');
const { ObjectProperty, ObjectFormat } = require('../src/main/zune/mtp-constants.js');

// Records every bulk write and replays queued device containers.
class FakeTransport {
  constructor() {
    this.writes = [];
    this.reads = [];
  }
  queue(type, code, txId, params = [], payload = Buffer.alloc(0)) {
    const buf = Buffer.alloc(12 + params.length * 4 + payload.length);
    buf.writeUInt32LE(buf.length, 0);
    buf.writeUInt16LE(type, 4);
    buf.writeUInt16LE(code, 6);
    buf.writeUInt32LE(txId, 8);
    params.forEach((p, i) => buf.writeUInt32LE(p >>> 0, 12 + i * 4));
    payload.copy(buf, 12 + params.length * 4);
    this.reads.push(buf);
  }
  async bulkWrite(data) { this.writes.push(Buffer.from(data)); }
  async bulkRead() { return this.reads.shift(); }
}

function commandParams(buf) {
  const out = [];
  for (let o = 12; o < buf.readUInt32LE(0); o += 4) out.push(buf.readUInt32LE(o));
  return out;
}

test('encodePropList: AUINT16 strings are NUL-terminated and counted', () => {
  const mtp = new MtpProtocol(new FakeTransport());
  const buf = mtp.encodePropList([
    { code: ObjectProperty.URLSource, type: 'auint16', value: 'ab' },
  ]);
  // count(4) | handle(4) prop(2) type(2) | n(4) 'a' 'b' NUL as u16
  assert.equal(buf.readUInt32LE(0), 1);
  assert.equal(buf.readUInt32LE(4), 0);
  assert.equal(buf.readUInt16LE(8), 0xDD60);
  assert.equal(buf.readUInt16LE(10), 0x4004);
  assert.equal(buf.readUInt32LE(12), 3);
  assert.deepEqual([...buf.subarray(16)], [0x61, 0, 0x62, 0, 0, 0]);
});

test('encodePropList: empty AUINT16 is a zero-length array', () => {
  const mtp = new MtpProtocol(new FakeTransport());
  const buf = mtp.encodePropList([{ code: ObjectProperty.Description, type: 'auint16', value: '' }]);
  assert.equal(buf.length, 4 + 8 + 4);
  assert.equal(buf.readUInt32LE(12), 0);
});

test('encodePropList: scalar and string types', () => {
  const mtp = new MtpProtocol(new FakeTransport());
  const buf = mtp.encodePropList([
    { code: 0xDA9B, type: 'uint8', value: 0 },
    { code: ObjectProperty.MetaGenre, type: 'uint16', value: 64 },
    { code: ObjectProperty.SeriesHandle, type: 'uint32', value: 0x0f000681 },
    { code: ObjectProperty.Name, type: 'string', value: 'Hi' },
  ]);
  assert.equal(buf.readUInt32LE(0), 4);
  let o = 4;
  assert.equal(buf.readUInt16LE(o + 6), 0x0002); assert.equal(buf[o + 8], 0); o += 9;
  assert.equal(buf.readUInt16LE(o + 6), 0x0004); assert.equal(buf.readUInt16LE(o + 8), 64); o += 10;
  assert.equal(buf.readUInt16LE(o + 6), 0x0006); assert.equal(buf.readUInt32LE(o + 8), 0x0f000681); o += 12;
  assert.equal(buf.readUInt16LE(o + 6), 0xFFFF);
  assert.equal(buf[o + 8], 3); // 'H' 'i' NUL
  assert.equal(buf.length, o + 8 + 1 + 6);
});

test('sendObjectPropList sends the object size high word first', async () => {
  const t = new FakeTransport();
  const mtp = new MtpProtocol(t);
  t.queue(3, 0x2001, 1, [0x00010001, 0x05000681, 0x10000700]);

  const size = 0x1_0000_0005; // > 4 GiB so both words are non-zero
  const handle = await mtp.sendObjectPropList(0x00010001, 0x05000681, ObjectFormat.MP3, size, [
    { code: ObjectProperty.Name, type: 'string', value: 'x' },
  ]);

  assert.equal(handle, 0x10000700);
  const cmd = t.writes[0];
  assert.equal(cmd.readUInt16LE(6), 0x9808);
  assert.deepEqual(commandParams(cmd), [0x00010001, 0x05000681, 0x3009, 0x1, 0x5]);
  // data phase: 12-byte header then the property list
  assert.equal(t.writes[1].readUInt16LE(4), 2);
  assert.equal(t.writes[2].readUInt32LE(0), 1);
});

test('transaction reads an optional data phase and reports response params on failure', async () => {
  const t = new FakeTransport();
  const mtp = new MtpProtocol(t);
  t.queue(2, 0x9217, 1, [], Buffer.from([1, 2, 3]));
  t.queue(3, 0x2001, 1);
  const ok = await mtp.transaction(0x9217, [1]);
  assert.deepEqual([...ok.data], [1, 2, 3]);

  t.queue(3, 0xA801, 2, [7]);
  await assert.rejects(mtp.transaction(0x9808, []), (err) => {
    assert.equal(err.code, 0xA801);
    assert.deepEqual(err.params, [7]);
    return true;
  });
});

test('registerTrackContext sends the 530-byte context block', async () => {
  const t = new FakeTransport();
  const mtp = new MtpProtocol(t);
  t.queue(3, 0x2001, 1);
  await mtp.registerTrackContext('Show');
  const data = t.writes[2];
  assert.equal(data.length, 530);
  assert.equal(data.readUInt32LE(8), 100);
  assert.equal(data.readUInt32LE(16), 1);
  assert.equal(data.subarray(20, 28).toString('utf16le'), 'Show');
  assert.equal(data.readUInt16LE(28), 0);
});
