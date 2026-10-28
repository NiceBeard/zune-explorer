const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ZMDBParser, parseBackwardsVarints } = require('../src/main/zune/zmdb-parser.js');

// Real records read from a Zune HD's ZMDB (written by the original Zune software).
const HD_EPISODE_0x10000084 = Buffer.from(
  '0e0000053500000f2ef90c000000000080a954a82bf5ca01bd64680000000930' +
  '000000004170722e2031302c20323031303a20546865204e6577732066726f6d' +
  '204c616b6520576f6265676f6e0041006d00650072006900630061006e002000' +
  '5000750062006c006900630020004d00650064006900610000002c4649007400' +
  '2700730020006200650065006e0020007700610072006d00200065006e006f00' +
  '750067006800200066006f007200200061006c006c0020006e006f0072006d00' +
  '61006c00200070007500720070006f007300650073002c00200073006f002000' +
  '700065006f0070006c006500200069006e0020004c0061006b00650020005700' +
  '6f006200650067006f006e002000680061007600650020006200650065006e00' +
  '200073006c0065006500700069006e0067002000770069007400680020007400' +
  '68006500690072002000770069006e0064006f007700730020006f0070006500' +
  '6e002e00000001ea4168007400740070003a002f002f0064006f0077006e006c' +
  '006f00610064002e007000750062006c006900630072006100640069006f002e' +
  '006f00720067002f0070006f00640063006100730074002f006e0066006c0077' +
  '002f0032003000310030002f00300034002f00310030002f006e0066006c0077' +
  '005f00320030003100300030003400310030005f00360034002e006d00700033' +
  '000000019a4500caa14f0553d1010870',
  'hex'
);

const HD_SHOW_0x0f000035 = Buffer.from(
  '0c0000050000010041504d3a2041205072616972696520486f6d6520436f6d70' +
  '616e696f6e2773204e6577732066726f6d204c616b6520576f6265676f6e0041' +
  '0050004d0020002000410020005000720061006900720069006500200048006f' +
  '006d006500200043006f006d00700061006e0069006f006e002700730020004e' +
  '006500770073002000660072006f006d0020004c0061006b006500200057006f' +
  '006200650067006f006e002e007300650072000000764468007400740070003a' +
  '002f002f0061006d00650072006900630061006e007000750062006c00690063' +
  '006d0065006400690061002e007000750062006c006900630072006100640069' +
  '006f002e006f00720067002f0070006f006400630061007300740073002f0078' +
  '006d006c002f0070007200610069007200690065005f0068006f006d0065005f' +
  '0063006f006d00700061006e0069006f006e002f006e006500770073005f0066' +
  '0072006f006d005f006c0061006b0065005f0077006f006200650067006f006e' +
  '002e0078006d006c00000001d445',
  'hex'
);

test('backwards varints: 2-byte sizes >= 128 decode without eating a third byte', () => {
  // The URL field is 154 bytes (size bytes 0x9a 0x01). The old decoder treated any
  // non-zero second byte as a 3-byte size and lost every field after it.
  const fields = parseBackwardsVarints(HD_EPISODE_0x10000084, 0x24);
  const ids = fields.map(f => f.fieldId);
  assert.deepEqual(ids, [0x46, 0x41, 0x45, 0x70]);
  const url = fields.find(f => f.fieldId === 0x45);
  assert.equal(url.data.length, 154);
});

test('HD podcast episode record decodes header and variable fields', () => {
  const parser = new ZMDBParser(Buffer.alloc(0), 'hd');
  const ep = parser._parsePodcastEpisode(HD_EPISODE_0x10000084, 0x10000084);

  assert.equal(ep.atomId, 0x10000084);
  assert.equal(ep.title, 'Apr. 10, 2010: The News from Lake Wobegon');
  assert.equal(ep.folderRef, 0x0500000e);
  assert.equal(ep.showAtomId, 0x0f000035);
  assert.equal(ep.duration, 850222);
  assert.equal(ep.bookmarkMs, 0);
  assert.equal(ep.size, 6841533);
  assert.equal(ep.codecId, 0x3009);
  assert.equal(ep.url, 'http://download.publicradio.org/podcast/nflw/2010/04/10/nflw_20100410_64.mp3');
  assert.equal(ep.author, 'American Public Media');
  assert.match(ep.description, /^It's been warm enough/);
  // Xune calls +0x10 the publish date; for this episode (aired Apr 10) the device
  // holds May 16, so it may be the date the Zune software downloaded it.
  assert.equal(ep.releaseDate, '2010-05-16T19:11:59.000Z');
});

test('podcast show record decodes name, .ser filename and feed URL', () => {
  const parser = new ZMDBParser(Buffer.alloc(0), 'hd');
  const show = parser._parsePodcastShow(HD_SHOW_0x0f000035, 0x0f000035);

  assert.equal(show.atomId, 0x0f000035);
  assert.equal(show.name, "APM: A Prairie Home Companion's News from Lake Wobegon");
  assert.equal(show.serFilename, "APM  A Prairie Home Companion's News from Lake Wobegon.ser");
  assert.equal(show.feedUrl, 'http://americanpublicmedia.publicradio.org/podcasts/xml/prairie_home_companion/news_from_lake_wobegon.xml');
  assert.equal(show.folderRef, 0x0500000c);
  assert.equal(show.subscribed, false);
});

test('Classic podcast episode uses the 32-byte header layout', () => {
  // Synthetic record following XuneSyncLibrary's Classic layout:
  // +0 folder, +4 show, +8 duration, +0c bookmark, +10 FILETIME, +1a codec, +1c played, +20 title
  const head = Buffer.alloc(0x20);
  head.writeUInt32LE(0x05000010, 0x00);
  head.writeUInt32LE(0x0f000037, 0x04);
  head.writeUInt32LE(45000, 0x08);
  head.writeUInt32LE(12000, 0x0c);
  head.writeUInt16LE(0x3009, 0x1a);
  const title = Buffer.from('Classic Episode\0', 'utf8');
  const urlData = Buffer.from('http://x/y.mp3\0', 'utf16le');
  const record = Buffer.concat([head, title, urlData, Buffer.from([urlData.length, 0x45])]);

  const parser = new ZMDBParser(Buffer.alloc(0), 'classic');
  const ep = parser._parsePodcastEpisode(record, 0x10000043);
  assert.equal(ep.title, 'Classic Episode');
  assert.equal(ep.showAtomId, 0x0f000037);
  assert.equal(ep.duration, 45000);
  assert.equal(ep.bookmarkMs, 12000);
  assert.equal(ep.codecId, 0x3009);
  assert.equal(ep.size, 0); // not stored on Classic
  assert.equal(ep.url, 'http://x/y.mp3');
});
