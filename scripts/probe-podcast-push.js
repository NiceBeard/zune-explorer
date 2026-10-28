#!/usr/bin/env node
/**
 * Podcast push probe for Zune devices.
 *
 * Tries the Zune Desktop podcast upload sequence documented by XuneSyncLibrary
 * (pcap-derived) while doing our own bookkeeping so repeat runs don't create
 * duplicate shows or episodes:
 *   - shows are matched by feed URL from the device's ZMDB, not by folder name
 *   - episodes are de-duplicated by enclosure URL / title within their show
 *   - every step fails fast; objects created in a failed run are deleted
 *
 * Quit Zune Explorer before running — only one process can claim the device.
 *
 * Usage:
 *   node scripts/probe-podcast-push.js inspect
 *   node scripts/probe-podcast-push.js cleanup [--yes]
 *   node scripts/probe-podcast-push.js push <episode.mp3> [options]
 *
 * Push options:
 *   --show <title>          Show title          (default "Zune Explorer Probe")
 *   --feed-url <url>        Show RSS feed URL   (default https://example.com/zune-explorer-probe.xml)
 *   --author <name>         Show/episode author (default "Zune Explorer")
 *   --title <title>         Episode title       (default: file name)
 *   --episode-url <url>     Enclosure URL       (default: derived from feed URL + file name)
 *   --description <text>    Episode description
 *   --art <file.jpg>        Show artwork (JPEG, ideally <= 300x300); new shows only
 *   --no-rollback           Leave partially-created objects in place on failure
 */

const fs = require('fs');
const path = require('path');
const { UsbTransport, ZUNE_VENDOR_ID, ZUNE_DEVICES } = require('../src/main/zune/usb-transport.js');
const { MtpProtocol } = require('../src/main/zune/mtp-protocol.js');
const { MtpzAuth } = require('../src/main/zune/mtpz-auth.js');
const { ZMDBParser } = require('../src/main/zune/zmdb-parser.js');
const { ContainerType, ResponseCode } = require('../src/main/zune/mtp-constants.js');

// ---------------------------------------------------------------------------
// Constants (property codes from XuneSyncLibrary ZuneMtpWriter.h)
// ---------------------------------------------------------------------------

const Op = {
  GetDevicePropValue:      0x1015,
  GetObjectPropDesc:       0x9802,
  GetObjectPropsSupported: 0x9801,
  GetObjectPropList:       0x9805,
  SendObjectPropList:      0x9808,
  DisableTrustedFiles:     0x9215,
  SyncDeviceDB:            0x9217,
  RegisterTrackContext:    0x922A,
};

const Prop = {
  StorageID:       0xDC01,
  ObjectFileName:  0xDC07,
  Name:            0xDC44,
  Artist:          0xDC46,
  DateAuthored:    0xDC47,
  Description:     0xDC48, // AUINT16
  RepSampleFormat: 0xDC81,
  RepSampleData:   0xDC86,
  Duration:        0xDC89,
  MetaGenre:       0xDC95,
  SeriesName:      0xDA9A,
  DA9B:            0xDA9B, // always 0 on episodes
  IsPodcast:       0xDA9C, // u8, 1 on series
  DA9D:            0xDA9D, // u32, 1 on series
  SeriesHandle:    0xDA9E, // u32, episode -> .ser handle
  SourceURL:       0xDD60, // AUINT16, feed URL (series) or enclosure URL (episode)
  DD62:            0xDD62, // u32, always 0 on episodes
};

const Type = { U8: 0x0002, U16: 0x0004, U32: 0x0006, AU16: 0x4004, STR: 0xFFFF };

const Fmt = {
  Folder:        0x3001,
  MP3:           0x3009,
  WMA:           0xB901,
  JPEG:          0x3801,
  PodcastSeries: 0xBA0B,
};

const MetaGenre = { AudioPodcast: 64 };
const ROOT = 0xFFFFFFFF; // GetObjectHandles parent for "root of storage"

const Schema = { Folder: 0x05, Music: 0x01, PodcastShow: 0x0f, PodcastEpisode: 0x10 };
const PodcastFieldId = { Description: 0x41, Filename: 0x44, Url: 0x45, Author: 0x46 };

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

const hex = (n, w = 8) => '0x' + (n >>> 0).toString(16).padStart(w, '0');
const schemaOf = (h) => (h >>> 24) & 0xFF;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s]`, ...a);
const phase = (name) => console.log(`\n=== ${name} ${'='.repeat(Math.max(0, 60 - name.length))}`);

// ---------------------------------------------------------------------------
// Low-level MTP helpers not (yet) in MtpProtocol
// ---------------------------------------------------------------------------

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`TIMEOUT (${ms}ms) on ${label}`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

class ProbeMtp {
  constructor(mtp) {
    this.mtp = mtp;
  }

  /**
   * Generic transaction: command, optional outbound data, optional inbound data.
   * Returns { data, params }. Throws with response code AND params so device
   * rejections like 0xA801 (which report the offending property index) are visible.
   */
  async call(opcode, params = [], outData = null, timeoutMs = 15000) {
    const label = `op ${hex(opcode, 4)}`;
    await this.mtp.sendCommand(opcode, params);
    if (outData) await this.mtp.sendData(opcode, outData);

    let data = null;
    let c = await withTimeout(this.mtp.receiveData(), timeoutMs, label);
    if (c.type === ContainerType.DATA) {
      data = c.payload;
      c = await withTimeout(this.mtp.receiveData(), timeoutMs, label);
    }
    if (c.type !== ContainerType.RESPONSE) {
      throw new Error(`${label}: expected RESPONSE, got container type ${hex(c.type, 4)}`);
    }
    if (c.code !== ResponseCode.OK) {
      const err = new Error(`${label} failed: response ${hex(c.code, 4)} params=[${c.params.map(p => hex(p)).join(', ')}]`);
      err.code = c.code;
      err.params = c.params;
      throw err;
    }
    return { data, params: c.params };
  }

  async tryCall(desc, ...args) {
    try {
      const r = await this.call(...args);
      log(`  ok   ${desc}`);
      return r;
    } catch (e) {
      log(`  warn ${desc}: ${e.message}`);
      return null;
    }
  }

  // ---- property list encoding ----

  static encodeProp(code, type, value, handle = 0) {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(handle >>> 0, 0);
    head.writeUInt16LE(code, 4);
    head.writeUInt16LE(type, 6);
    let body;
    switch (type) {
      case Type.U8:  body = Buffer.alloc(1); body.writeUInt8(value, 0); break;
      case Type.U16: body = Buffer.alloc(2); body.writeUInt16LE(value, 0); break;
      case Type.U32: body = Buffer.alloc(4); body.writeUInt32LE(value >>> 0, 0); break;
      case Type.STR: body = encodeMtpString(value); break;
      case Type.AU16: {
        // AUINT16: u32 element count + UTF-16LE code units, NUL-terminated (count
        // includes the NUL). Without the terminator the firmware copies stale bytes
        // from its previous string into ZMDB (seen as "...mp31", "...xmle Explorer Probe").
        // XuneSyncLibrary's WritePropAuint16String omits it.
        const units = Buffer.from(value ? value + '\0' : '', 'utf16le');
        body = Buffer.alloc(4 + units.length);
        body.writeUInt32LE(units.length / 2, 0);
        units.copy(body, 4);
        break;
      }
      default: throw new Error(`unsupported prop type ${hex(type, 4)}`);
    }
    return Buffer.concat([head, body]);
  }

  static encodePropList(props) {
    const count = Buffer.alloc(4);
    count.writeUInt32LE(props.length, 0);
    return Buffer.concat([count, ...props.map(([c, t, v]) => ProbeMtp.encodeProp(c, t, v))]);
  }

  async sendObjectPropList(storageId, parent, format, size, props) {
    // ObjectSize is split high word first, then low word (MTP spec; AFTL does the same).
    // The parked feat/podcast-sync code sent [lo, hi], which asks for size * 2^32
    // bytes — the likely cause of the StoreFull errors we saw on non-zero sizes.
    const sizeHi = Math.floor(size / 0x100000000);
    const sizeLo = size % 0x100000000;
    const { params } = await this.call(Op.SendObjectPropList,
      [storageId, parent, format, sizeHi, sizeLo],
      ProbeMtp.encodePropList(props));
    return params[2];
  }

  async createFolder(storageId, parent, name) {
    const handle = await this.sendObjectPropList(storageId, parent, Fmt.Folder, 0,
      [[Prop.ObjectFileName, Type.STR, name]]);
    if (!handle) throw new Error(`folder "${name}" creation returned handle 0`);
    return handle;
  }

  async registerTrackContext(name) {
    // 530 bytes: u64 0, u32 100, u32 0, u32 1, UTF-16LE name (NUL-terminated), zero padded
    const buf = Buffer.alloc(530, 0);
    buf.writeUInt32LE(100, 8);
    buf.writeUInt32LE(1, 16);
    Buffer.from(name.slice(0, 250), 'utf16le').copy(buf, 20);
    return this.call(Op.RegisterTrackContext, [], buf);
  }

  async rootReEnum() {
    await this.tryCall('root re-enum StorageID depth=1', Op.GetObjectPropList, [0, 0, Prop.StorageID, 0, 1]);
    await this.tryCall('root re-enum ObjFileName depth=1', Op.GetObjectPropList, [0, 0, Prop.ObjectFileName, 0, 1]);
  }

  async queryDescriptors(format, props, label) {
    let ok = 0;
    for (const p of props) {
      try { await this.call(Op.GetObjectPropDesc, [p, format]); ok++; } catch (_) { /* logged in summary */ }
    }
    log(`  ok   ${label}: ${ok}/${props.length} descriptors`);
  }

  async getU32Prop(handle, prop) {
    const { data } = await this.call(0x9803, [handle, prop]);
    return data.readUInt32LE(0);
  }

  async getStrProp(handle, prop) {
    const { data } = await this.call(0x9803, [handle, prop]);
    return this.mtp._parseMtpString(data, 0).str;
  }
}

function encodeMtpString(str) {
  // MTP strings carry a u8 char count including the NUL — cap at 254 chars.
  const s = (str || '').slice(0, 254);
  if (!s) return Buffer.from([0]);
  const withNull = s + '\0';
  const buf = Buffer.alloc(1 + withNull.length * 2);
  buf.writeUInt8(withNull.length, 0);
  buf.write(withNull, 1, 'utf16le');
  return buf;
}

// ---------------------------------------------------------------------------
// ZMDB podcast extraction (record layouts from XuneSyncLibrary ZuneHDParser /
// ZuneClassicParser). Uses a fixed backwards-varint decoder: the 3-byte size
// path is gated on the continuation bit of byte 2.
// ---------------------------------------------------------------------------

function parseBackwardsVarints(rec, floor) {
  const fields = [];
  let pos = rec.length - 1;
  while (pos >= floor) {
    const id1 = rec[pos--];
    if (id1 === 0) break;
    let fieldId = id1;
    if (id1 & 0x80) {
      if (pos < floor) break;
      fieldId = (rec[pos--] << 7) | (id1 & 0x7F);
    }
    if (pos < floor) break;
    const s1 = rec[pos--];
    let size = s1;
    if (s1 & 0x80) {
      if (pos < floor) break;
      const s2 = rec[pos--];
      size = (s2 << 7) | (s1 & 0x7F);
      if (s2 & 0x80) {
        if (pos < floor) break;
        const s3 = rec[pos--];
        size = (s3 << 14) | (size & 0x3FFF);
      }
    }
    const end = pos + 1;
    if (size > end || end - size < floor) break;
    fields.push({ fieldId, data: rec.slice(end - size, end) });
    pos = end - size - 1;
  }
  return fields;
}

function utf16Field(data) {
  let d = data;
  if (d.length % 2 === 1 && d[0] === 0) d = d.slice(1);
  return d.toString('utf16le').replace(/\0+$/, '').replace(/^\0+/, '');
}

function cstr(buf, off) {
  let i = off;
  while (i < buf.length && buf[i] !== 0) i++;
  return buf.slice(off, i).toString('utf8');
}

function filetimeToIso(ft) {
  if (!ft) return null;
  const ms = Number(ft / 10000n) - 11644473600000;
  return ms > 0 ? new Date(ms).toISOString() : null;
}

function extractPodcasts(zmdbData, isHD) {
  const parser = new ZMDBParser(zmdbData, isHD ? 'hd' : 'classic');
  parser.parse(); // builds indexTable and detects HD vs Classic from the ZMed header
  const hd = parser.isHD;

  const shows = new Map();
  const episodes = [];

  for (const [atomId, offset] of parser.indexTable) {
    const schema = schemaOf(atomId);
    if (schema !== Schema.PodcastShow && schema !== Schema.PodcastEpisode) continue;
    const rec = parser._readRecord(offset);
    if (!rec) continue;

    if (schema === Schema.PodcastShow) {
      if (rec.length < 9) continue;
      const name = cstr(rec, 8);
      const show = {
        atomId, name,
        folderRef: rec.readUInt32LE(0),
        subscribed: rec[5] !== 0,
        serFilename: '', author: '', feedUrl: '',
      };
      for (const f of parseBackwardsVarints(rec, 8 + Buffer.byteLength(name) + 1)) {
        if (f.fieldId === PodcastFieldId.Filename) show.serFilename = utf16Field(f.data);
        else if (f.fieldId === PodcastFieldId.Author) show.author = utf16Field(f.data);
        else if (f.fieldId === PodcastFieldId.Url) show.feedUrl = utf16Field(f.data);
      }
      shows.set(atomId, show);
    } else {
      const titleOff = hd ? 0x24 : 0x20;
      if (rec.length < titleOff) continue;
      const title = cstr(rec, titleOff);
      const ep = {
        atomId, title,
        folderRef: rec.readUInt32LE(0x00),
        showRef: rec.readUInt32LE(0x04),
        durationMs: rec.readUInt32LE(0x08),
        bookmarkMs: rec.readUInt32LE(0x0c),
        published: filetimeToIso(rec.readBigUInt64LE(0x10)),
        sizeBytes: hd ? rec.readUInt32LE(0x18) : null,
        url: '', author: '',
      };
      for (const f of parseBackwardsVarints(rec, titleOff + Buffer.byteLength(title) + 1)) {
        if (f.fieldId === PodcastFieldId.Url) ep.url = utf16Field(f.data);
        else if (f.fieldId === PodcastFieldId.Author) ep.author = utf16Field(f.data);
      }
      episodes.push(ep);
    }
  }

  for (const ep of episodes) ep.showName = shows.get(ep.showRef)?.name ?? null;
  return { shows: [...shows.values()], episodes, isHD: hd };
}

// ---------------------------------------------------------------------------
// Device session
// ---------------------------------------------------------------------------

async function connect() {
  phase('Connect');
  const transport = new UsbTransport();
  const found = await transport.findZune();
  if (!found) throw new Error('No Zune found. Is it plugged in, and is Zune Explorer closed?');
  const model = ZUNE_DEVICES[found.productId] || 'Zune';
  log(`found ${model} (PID ${hex(found.productId, 4)})`);

  await transport.open(ZUNE_VENDOR_ID, found.productId);
  const mtp = new MtpProtocol(transport);
  await mtp.openSession(1);
  log('MTP session open');
  await new MtpzAuth(mtp).authenticate();
  log('MTPZ authenticated');

  const storageId = (await mtp.getStorageIDs())[0];
  log(`storage ${hex(storageId)}`);

  return { transport, mtp, probe: new ProbeMtp(mtp), storageId, model, isHD: found.productId === 0x063E };
}

async function disconnect(dev) {
  try { await dev.mtp.closeSession(); } catch (_) { /* device may be gone */ }
  await dev.transport.close();
  log('disconnected');
}

async function readPodcastDb(dev) {
  const data = await dev.mtp.readZMDB();
  return extractPodcasts(data, dev.isHD);
}

async function listChildren(dev, parent) {
  const handles = await dev.mtp.getObjectHandles(dev.storageId, 0, parent);
  const out = [];
  for (const h of handles) {
    try {
      const info = await dev.mtp.getObjectInfo(h);
      out.push({ handle: h, ...info });
    } catch (e) {
      out.push({ handle: h, error: e.message });
    }
  }
  return out;
}

async function findRootFolder(dev, name) {
  const kids = await listChildren(dev, ROOT);
  return kids.find(k => k.objectFormat === Fmt.Folder && k.filename === name) || null;
}

function sanitizeName(s) {
  // Zune Desktop replaces illegal filename chars with a space ("APM: The Story" -> "APM  The Story")
  return (s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120) || 'Untitled';
}

// `stored` is what ZMDB holds. Strings written without a NUL terminator (Xune, or
// our own first run) carry stale trailing bytes, so accept a prefix match.
function sameUrl(stored, ours) {
  if (!stored || !ours) return false;
  const s = stored.trim().toLowerCase();
  const o = ours.trim().toLowerCase();
  return s === o || s.startsWith(o);
}

function fmtTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.0`;
}

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

function printPodcastDb(db) {
  const byShow = new Map();
  for (const ep of db.episodes) {
    if (!byShow.has(ep.showRef)) byShow.set(ep.showRef, []);
    byShow.get(ep.showRef).push(ep);
  }

  console.log(`\nZMDB (${db.isHD ? 'HD' : 'Classic'} layout): ${db.shows.length} shows, ${db.episodes.length} episodes`);
  for (const s of db.shows) {
    const eps = byShow.get(s.atomId) || [];
    console.log(`\n  SHOW ${hex(s.atomId)} "${s.name}"  episodes=${eps.length} subscribed=${s.subscribed}`);
    console.log(`       ser="${s.serFilename}" author="${s.author}" folderRef=${hex(s.folderRef)}`);
    console.log(`       feed=${s.feedUrl || '(none)'}`);
    for (const e of eps) {
      const size = e.sizeBytes != null ? ` size=${e.sizeBytes}` : '';
      console.log(`    EP ${hex(e.atomId)} "${e.title}" dur=${Math.round(e.durationMs / 1000)}s${size} folderRef=${hex(e.folderRef)}`);
      if (e.url) console.log(`       url=${e.url}`);
    }
  }

  const orphans = db.episodes.filter(e => !db.shows.some(s => s.atomId === e.showRef));
  if (orphans.length) {
    console.log(`\n  ${orphans.length} episode(s) reference a show that isn't in ZMDB:`);
    for (const e of orphans) console.log(`    EP ${hex(e.atomId)} "${e.title}" showRef=${hex(e.showRef)}`);
  }

  const dupes = new Map();
  for (const s of db.shows) {
    const key = (s.feedUrl || s.name).trim().toLowerCase();
    dupes.set(key, [...(dupes.get(key) || []), s]);
  }
  for (const [key, list] of dupes) {
    if (list.length > 1) console.log(`\n  DUPLICATE SHOW "${key}": ${list.map(s => hex(s.atomId)).join(', ')}`);
  }
}

async function scanDeviceTree(dev) {
  const result = { series: null, podcasts: null, seriesChildren: [], podcastObjects: [] };
  result.series = await findRootFolder(dev, 'Series');
  result.podcasts = await findRootFolder(dev, 'Podcasts');

  if (result.series) result.seriesChildren = await listChildren(dev, result.series.handle);
  if (result.podcasts) {
    for (const sub of await listChildren(dev, result.podcasts.handle)) {
      result.podcastObjects.push({ ...sub, folder: '(Podcasts)' });
      if (sub.objectFormat === Fmt.Folder) {
        for (const o of await listChildren(dev, sub.handle)) {
          result.podcastObjects.push({ ...o, folder: sub.filename });
        }
      }
    }
  }
  return result;
}

function printDeviceTree(tree) {
  console.log(`\nMTP tree:`);
  console.log(`  Series/   ${tree.series ? hex(tree.series.handle) : '(missing)'}  children via GetObjectHandles: ${tree.seriesChildren.length}`);
  for (const c of tree.seriesChildren) {
    console.log(`    ${hex(c.handle)} schema=${hex(schemaOf(c.handle), 2)} fmt=${hex(c.objectFormat || 0, 4)} "${c.filename}"`);
  }
  console.log(`  Podcasts/ ${tree.podcasts ? hex(tree.podcasts.handle) : '(missing)'}`);
  for (const o of tree.podcastObjects) {
    if (o.error) { console.log(`    ${hex(o.handle)} error: ${o.error}`); continue; }
    console.log(`    [${o.folder}] ${hex(o.handle)} schema=${hex(schemaOf(o.handle), 2)} fmt=${hex(o.objectFormat, 4)} size=${o.compressedSize} "${o.filename}"`);
  }
}

async function cmdInspect() {
  const dev = await connect();
  try {
    phase('ZMDB podcasts');
    const db = await readPodcastDb(dev);
    printPodcastDb(db);
    phase('MTP folders');
    printDeviceTree(await scanDeviceTree(dev));
  } finally {
    await disconnect(dev);
  }
}

async function cmdDump(handles) {
  const dev = await connect();
  try {
    const data = await dev.mtp.readZMDB();
    const parser = new ZMDBParser(data, dev.isHD ? 'hd' : 'classic');
    parser.parse();
    for (const h of handles.map(x => parseInt(x, 16) >>> 0)) {
      const off = parser.indexTable.get(h);
      const rec = off != null ? parser._readRecord(off) : null;
      console.log(`\n${hex(h)}: ${rec ? `${rec.length} bytes` : 'not in ZMDB'}`);
      if (!rec) continue;
      console.log(rec.toString('hex').replace(/(.{64})/g, '$1\n'));
      const floor = schemaOf(h) === Schema.PodcastShow ? 9 : (parser.isHD ? 0x25 : 0x21);
      for (const f of parseBackwardsVarints(rec, floor)) {
        console.log(`  field ${hex(f.fieldId, 2)} len=${f.data.length} hex=${f.data.toString('hex')}`);
      }
    }
  } finally {
    await disconnect(dev);
  }
}

async function cmdDelete(handles) {
  const ids = handles.map(x => parseInt(x, 16) >>> 0);
  const bad = ids.filter(h => ![Schema.PodcastShow, Schema.PodcastEpisode].includes(schemaOf(h)));
  if (!ids.length || bad.length) {
    throw new Error(`delete only takes podcast show/episode handles (0x0f.../0x10...); rejected: ${bad.map(h => hex(h)).join(', ') || 'none given'}`);
  }
  const dev = await connect();
  try {
    // Episodes before shows
    ids.sort((a, b) => schemaOf(b) - schemaOf(a));
    for (const h of ids) {
      try { await dev.mtp.deleteObject(h); log(`deleted ${hex(h)}`); }
      catch (e) { log(`FAILED ${hex(h)}: ${e.message}`); process.exitCode = 1; }
    }
  } finally {
    await disconnect(dev);
  }
}

async function cmdBookmark(handleHex, msStr) {
  const h = parseInt(handleHex, 16) >>> 0;
  const ms = parseInt(msStr, 10);
  if (schemaOf(h) !== Schema.PodcastEpisode || !(ms >= 0)) throw new Error('usage: bookmark <0x10... handle> <ms>');
  const dev = await connect();
  try {
    const before = await dev.probe.getU32Prop(h, Prop.DD62).catch(e => `read failed: ${e.message}`);
    log(`TimeBookmark (0xDD62) before: ${before}`);
    await dev.mtp.setObjectPropUint32(h, Prop.DD62, ms);
    log(`TimeBookmark after:  ${await dev.probe.getU32Prop(h, Prop.DD62)}`);
    await dev.probe.tryCall('SyncDeviceDB(1)', Op.SyncDeviceDB, [1]);
    const ep = (await readPodcastDb(dev)).episodes.find(e => e.atomId === h);
    log(`ZMDB bookmarkMs: ${ep ? ep.bookmarkMs : '(episode not found)'}`);
  } finally {
    await disconnect(dev);
  }
}

// ---------------------------------------------------------------------------
// cleanup — removes leftovers from the old two-phase experiments
// ---------------------------------------------------------------------------

async function cmdCleanup(opts) {
  const dev = await connect();
  try {
    phase('Find cleanup candidates');
    const db = await readPodcastDb(dev);
    const tree = await scanDeviceTree(dev);
    // Ordered: episodes/files first, then shows, then folders, so nothing is deleted
    // while something still points at it. Video podcasts are schema 0x02 objects in
    // these folders and must be left alone.
    const candidates = [];
    const doomed = new Set();
    const add = (handle, why) => { candidates.push({ handle, why }); doomed.add(handle); };

    for (const o of tree.podcastObjects) {
      if (o.error || o.objectFormat === Fmt.Folder) continue;
      const schema = schemaOf(o.handle);
      if (schema === Schema.PodcastEpisode && o.compressedSize === 0) {
        add(o.handle, `podcast entry with no audio (size 0) "${o.filename}" in [${o.folder}]`);
      } else if (schema === Schema.Music) {
        add(o.handle, `music-schema audio left by two-phase push "${o.filename}" (${o.compressedSize} bytes) in [${o.folder}]`);
      }
    }

    // Shows our old code made: no feed URL, and every episode already doomed
    for (const s of db.shows) {
      const eps = db.episodes.filter(e => e.showRef === s.atomId);
      if (!s.feedUrl && eps.every(e => doomed.has(e.atomId))) {
        add(s.atomId, `show with no feed URL "${s.name}" (${eps.length} episode(s), all being removed)`);
      }
    }

    // Episode folders left empty (or emptied by the deletions above)
    if (tree.podcasts) {
      const subfolders = tree.podcastObjects.filter(o => o.folder === '(Podcasts)' && o.objectFormat === Fmt.Folder);
      for (const f of subfolders) {
        const contents = await dev.mtp.getObjectHandles(dev.storageId, 0, f.handle);
        if (contents.every(h => doomed.has(h))) {
          add(f.handle, `empty episode folder Podcasts/${f.filename}`);
        }
      }
    }

    if (!candidates.length) { log('nothing to clean up'); return; }
    for (const c of candidates) console.log(`  ${hex(c.handle)}  ${c.why}`);

    if (!opts.yes) {
      console.log(`\n${candidates.length} candidate(s). Dry run: re-run with --yes to delete them.`);
      return;
    }

    phase('Delete');
    let deleted = 0;
    for (const c of candidates) {
      try { await dev.mtp.deleteObject(c.handle); deleted++; log(`  deleted ${hex(c.handle)}`); }
      catch (e) { log(`  FAILED  ${hex(c.handle)}: ${e.message}`); }
    }
    log(`deleted ${deleted}/${candidates.length}`);
  } finally {
    await disconnect(dev);
  }
}

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

async function probeDuration(file) {
  try {
    const { parseFile } = await import('music-metadata');
    const meta = await parseFile(file, { duration: true });
    return Math.round((meta.format.duration || 0) * 1000);
  } catch (e) {
    log(`  warn could not read duration: ${e.message}`);
    return 0;
  }
}

async function cmdPush(file, opts) {
  if (!file || !fs.existsSync(file)) throw new Error(`episode file not found: ${file}`);
  const ext = path.extname(file).toLowerCase();
  const format = { '.mp3': Fmt.MP3, '.wma': Fmt.WMA }[ext];
  if (!format) throw new Error('probe supports .mp3 and .wma only');

  const showTitle = opts.show || 'Zune Explorer Probe';
  const feedUrl = opts.feedUrl || 'https://example.com/zune-explorer-probe.xml';
  const author = opts.author || 'Zune Explorer';
  const epTitle = opts.title || path.basename(file, ext);
  const epUrl = opts.episodeUrl || new URL(encodeURIComponent(path.basename(file)), feedUrl).href;
  const fileData = fs.readFileSync(file);
  const durationMs = await probeDuration(file);
  const art = opts.art ? fs.readFileSync(opts.art) : null;

  log(`show="${showTitle}" feed=${feedUrl}`);
  log(`episode="${epTitle}" url=${epUrl} size=${fileData.length} duration=${durationMs}ms`);

  const dev = await connect();
  const { probe, storageId } = dev;
  const created = []; // [{handle, what}] for rollback, in creation order

  try {
    // ---- Pre-upload (Xune: GetDevicePropValue 0xD217 x2, SyncDeviceDB) ----
    phase('Pre-upload');
    for (let i = 1; i <= 2; i++) await probe.tryCall(`GetDevicePropValue(0xD217) #${i}`, Op.GetDevicePropValue, [0xD217]);
    await probe.tryCall('SyncDeviceDB(1)', Op.SyncDeviceDB, [1]);

    // ---- Bookkeeping: what's already on the device ----
    phase('Lookup (ZMDB)');
    const db = await readPodcastDb(dev);
    log(`ZMDB has ${db.shows.length} shows / ${db.episodes.length} episodes`);

    const matches = db.shows.filter(s => sameUrl(s.feedUrl, feedUrl));
    if (matches.length > 1) {
      log(`  warn ${matches.length} shows already share this feed URL: ${matches.map(s => hex(s.atomId)).join(', ')}`);
    }
    // Prefer the matching show with the most episodes
    const epsOf = (s) => db.episodes.filter(e => e.showRef === s.atomId);
    const existingShow = matches.sort((a, b) => epsOf(b).length - epsOf(a).length)[0] || null;

    let seriesHandle = 0;
    let episodeFolder = 0;

    if (existingShow) {
      seriesHandle = existingShow.atomId;
      log(`reusing show ${hex(seriesHandle)} "${existingShow.name}" (${epsOf(existingShow).length} episodes)`);

      const dupe = epsOf(existingShow).find(e => sameUrl(e.url, epUrl) || e.title === epTitle);
      if (dupe) {
        log(`SKIP: episode already on device as ${hex(dupe.atomId)} "${dupe.title}"`);
        return;
      }

      // Confirm the .ser handle is still live before linking to it
      const info = await dev.mtp.getObjectInfo(seriesHandle);
      log(`  .ser object ok: fmt=${hex(info.objectFormat, 4)} "${info.filename}"`);

      // Episode folder: the MTP parent of an existing episode, if any
      const sibling = epsOf(existingShow)[0];
      if (sibling) {
        episodeFolder = (await dev.mtp.getObjectInfo(sibling.atomId)).parentObject;
        log(`  episode folder from existing episode: ${hex(episodeFolder)}`);
      }
    }

    // ---- Create show (.ser) if needed ----
    if (!seriesHandle) {
      phase('Create show');
      let seriesFolder = (await findRootFolder(dev, 'Series'))?.handle;
      if (!seriesFolder) {
        seriesFolder = await probe.createFolder(storageId, 0, 'Series');
        created.push({ handle: seriesFolder, what: 'Series/ folder' });
        log(`  created Series/ ${hex(seriesFolder)}`);
      } else {
        log(`  Series/ exists ${hex(seriesFolder)}`);
      }

      await probe.queryDescriptors(Fmt.PodcastSeries,
        [Prop.IsPodcast, Prop.DA9D, Prop.Artist, Prop.ObjectFileName, Prop.SourceURL], 'series descriptors');

      seriesHandle = await probe.sendObjectPropList(storageId, seriesFolder, Fmt.PodcastSeries, 0, [
        [Prop.IsPodcast, Type.U8, 1],
        [Prop.DA9D, Type.U32, 1],
        [Prop.Artist, Type.STR, author],
        [Prop.ObjectFileName, Type.STR, `${sanitizeName(showTitle)}.ser`],
        [Prop.SourceURL, Type.AU16, feedUrl],
        [Prop.Name, Type.STR, showTitle],
      ]);
      if (!seriesHandle) throw new Error('.ser creation returned handle 0');
      created.push({ handle: seriesHandle, what: '.ser show object' });
      await dev.mtp.sendObject(Buffer.alloc(0));
      log(`  created .ser ${hex(seriesHandle)} (schema ${hex(schemaOf(seriesHandle), 2)})`);

      if (art) {
        try {
          await dev.mtp.setObjectPropArray(seriesHandle, Prop.RepSampleData, art);
          await dev.mtp.setObjectPropUint16(seriesHandle, Prop.RepSampleFormat, Fmt.JPEG);
          log(`  artwork set (${art.length} bytes)`);
        } catch (e) {
          log(`  warn artwork failed: ${e.message}`); // non-fatal, matches Xune
        }
      }
    }

    // ---- Episode folder: Podcasts/<show>/ ----
    phase('Episode folder');
    await probe.registerTrackContext(showTitle);
    log('  RegisterTrackContext ok');
    await probe.rootReEnum();

    if (!episodeFolder) {
      let podcastsFolder = (await findRootFolder(dev, 'Podcasts'))?.handle;
      if (!podcastsFolder) {
        podcastsFolder = await probe.createFolder(storageId, 0, 'Podcasts');
        created.push({ handle: podcastsFolder, what: 'Podcasts/ folder' });
        log(`  created Podcasts/ ${hex(podcastsFolder)}`);
      }
      const folderName = sanitizeName(showTitle);
      const existing = (await listChildren(dev, podcastsFolder))
        .find(c => c.objectFormat === Fmt.Folder && c.filename === folderName);
      if (existing) {
        episodeFolder = existing.handle;
        log(`  reusing Podcasts/${folderName} ${hex(episodeFolder)}`);
      } else {
        episodeFolder = await probe.createFolder(storageId, podcastsFolder, folderName);
        created.push({ handle: episodeFolder, what: `Podcasts/${folderName}/ folder` });
        log(`  created Podcasts/${folderName} ${hex(episodeFolder)}`);
      }
    }

    // ---- Episode: one SendObjectPropList with the real size, then the data ----
    phase('Upload episode');
    await probe.queryDescriptors(format, [
      Prop.SourceURL, Prop.ObjectFileName, Prop.DD62, Prop.SeriesName, Prop.DA9B, Prop.MetaGenre,
      Prop.SeriesHandle, Prop.Name, Prop.Duration, Prop.Artist, Prop.DateAuthored, Prop.Description,
    ], 'episode descriptors');

    const epHandle = await probe.sendObjectPropList(storageId, episodeFolder, format, fileData.length, [
      [Prop.SourceURL, Type.AU16, epUrl],
      [Prop.ObjectFileName, Type.STR, `${sanitizeName(epTitle)}${ext}`],
      [Prop.DD62, Type.U32, 0],
      [Prop.SeriesName, Type.STR, showTitle],
      [Prop.DA9B, Type.U8, 0],
      [Prop.MetaGenre, Type.U16, MetaGenre.AudioPodcast],
      [Prop.SeriesHandle, Type.U32, seriesHandle],
      [Prop.Name, Type.STR, epTitle],
      [Prop.Duration, Type.U32, durationMs],
      [Prop.Artist, Type.STR, author],
      [Prop.DateAuthored, Type.STR, fmtTime(new Date())],
      [Prop.Description, Type.AU16, opts.description || ''],
    ]);
    if (!epHandle) throw new Error('episode creation returned handle 0');
    created.push({ handle: epHandle, what: 'episode object' });
    log(`  episode object ${hex(epHandle)} (schema ${hex(schemaOf(epHandle), 2)})`);

    let lastPct = -1;
    await dev.mtp.sendObject(fileData, (sent, total) => {
      const pct = Math.floor((sent / total) * 10) * 10;
      if (pct !== lastPct) { lastPct = pct; log(`  sending ${pct}%`); }
    });
    log('  audio sent');

    // ---- Verify ----
    phase('Verify (MTP)');
    const checks = [];
    const check = (name, pass, detail) => { checks.push(pass); log(`  ${pass ? 'PASS' : 'FAIL'} ${name}: ${detail}`); };

    const info = await dev.mtp.getObjectInfo(epHandle);
    check('schema byte is 0x10', schemaOf(epHandle) === Schema.PodcastEpisode, hex(schemaOf(epHandle), 2));
    check('object size = file size', info.compressedSize === fileData.length, `${info.compressedSize} vs ${fileData.length}`);
    check('parent = episode folder', info.parentObject === episodeFolder, hex(info.parentObject));
    try {
      const sh = await probe.getU32Prop(epHandle, Prop.SeriesHandle);
      check('SeriesHandle prop', sh === seriesHandle, hex(sh));
    } catch (e) { check('SeriesHandle prop', false, e.message); }
    try {
      check('SeriesName prop', true, `"${await probe.getStrProp(epHandle, Prop.SeriesName)}"`);
    } catch (e) { log(`  info SeriesName read: ${e.message}`); }
    try {
      const refs = await dev.mtp.getObjectReferences(epHandle);
      log(`  info episode references: [${refs.map(r => hex(r)).join(', ')}]`);
    } catch (e) { log(`  info GetObjectReferences: ${e.message}`); }

    // Upload succeeded — from here on nothing is rolled back
    created.length = 0;

    phase('Finalize');
    await probe.tryCall('DisableTrustedFiles (0x9215)', Op.DisableTrustedFiles, []);
    await probe.tryCall('SyncDeviceDB(1)', Op.SyncDeviceDB, [1]);

    phase('Verify (ZMDB re-read)');
    try {
      const after = await readPodcastDb(dev);
      const ep = after.episodes.find(e => e.atomId === epHandle);
      if (ep) {
        check('episode in ZMDB', true, `"${ep.title}"`);
        check('ZMDB showRef = .ser', ep.showRef === seriesHandle, hex(ep.showRef));
        check('ZMDB episode URL', sameUrl(ep.url, epUrl), ep.url || '(none)');
        if (ep.sizeBytes != null) check('ZMDB size', ep.sizeBytes === fileData.length, String(ep.sizeBytes));
      } else {
        log('  info episode not in ZMDB yet — unplug/replug, then run `inspect`');
      }
      const sameFeed = after.shows.filter(s => sameUrl(s.feedUrl, feedUrl));
      if (sameFeed.length) check('exactly one show for this feed', sameFeed.length === 1, `${sameFeed.length} found`);
    } catch (e) {
      log(`  warn ZMDB re-read failed: ${e.message}`);
    }

    const failed = checks.filter(c => !c).length;
    console.log(`\nResult: ${checks.length - failed}/${checks.length} checks passed. Episode ${hex(epHandle)}, show ${hex(seriesHandle)}.`);
    console.log('Next: check the device under podcasts, then run push again with the same args — it should SKIP.');
  } catch (err) {
    log(`ERROR: ${err.message}`);
    if (created.length && !opts.noRollback) {
      phase('Rollback');
      for (const c of [...created].reverse()) {
        try { await dev.mtp.deleteObject(c.handle); log(`  deleted ${c.what} ${hex(c.handle)}`); }
        catch (e) { log(`  could not delete ${c.what} ${hex(c.handle)}: ${e.message}`); }
      }
    } else if (created.length) {
      log(`left in place (--no-rollback): ${created.map(c => `${c.what} ${hex(c.handle)}`).join(', ')}`);
    }
    process.exitCode = 1;
  } finally {
    await disconnect(dev);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  const flags = { '--yes': 'yes', '--no-rollback': 'noRollback' };
  const valued = {
    '--show': 'show', '--feed-url': 'feedUrl', '--author': 'author', '--title': 'title',
    '--episode-url': 'episodeUrl', '--description': 'description', '--art': 'art',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags[a]) opts[flags[a]] = true;
    else if (valued[a]) opts[valued[a]] = argv[++i];
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else positional.push(a);
  }
  return { positional, opts };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, opts } = parseArgs(rest);
  switch (cmd) {
    case 'inspect': return cmdInspect();
    case 'dump':    return cmdDump(positional);
    case 'delete':  return cmdDelete(positional);
    case 'bookmark': return cmdBookmark(positional[0], positional[1]);
    case 'cleanup': return cmdCleanup(opts);
    case 'push':    return cmdPush(positional[0], opts);
    default:
      console.log('usage: node scripts/probe-podcast-push.js inspect | cleanup [--yes] | push <file.mp3> [options]');
      process.exitCode = 2;
  }
}

main().then(() => process.exit(process.exitCode || 0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
