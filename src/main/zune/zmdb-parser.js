/**
 * ZMDB (Zune Media Database) Parser
 *
 * Parses the Zune's internal binary database to extract the full media library
 * (tracks, albums, artists, genres, videos, pictures, playlists) in a single pass.
 *
 * Based on reverse-engineering work from XuneSyncLibrary by magicisinthehole.
 * Format: proprietary Microsoft binary with ZMDB/ZMed/ZArr headers and 96 descriptors.
 *
 * Two format versions:
 *   ZMed version 2 = Classic (Zune 30/80/120, flash 4/8/16)
 *   ZMed version 5 = Zune HD
 */

// Schema type constants (upper byte of atom_id)
const Schema = {
  Music:          0x01,
  Video:          0x02,
  Picture:        0x03,
  Filename:       0x05,
  Album:          0x06,
  Playlist:       0x07,
  Artist:         0x08,
  Genre:          0x09,
  VideoTitle:     0x0a,
  PhotoAlbum:     0x0b,
  Collection:     0x0c,
  PodcastShow:    0x0f,
  PodcastEpisode: 0x10,
  AudiobookTitle: 0x11,
  AudiobookTrack: 0x12,
};

// Fixed-size portion of each schema's record (before variable-length strings/varints)
// HD and Classic have different layouts for some schemas
const ENTRY_SIZES_HD = {
  [Schema.Music]:          32,
  [Schema.Video]:          32,
  [Schema.Picture]:        24,
  [Schema.Filename]:       8,
  [Schema.Album]:          20,
  [Schema.Playlist]:       12,
  [Schema.Artist]:         4,
  [Schema.Genre]:          1,
  [Schema.VideoTitle]:     4,
  [Schema.PhotoAlbum]:     12,
  [Schema.Collection]:     12,
  [Schema.PodcastShow]:    8,
  [Schema.PodcastEpisode]: 32,
  [Schema.AudiobookTitle]: 8,
  [Schema.AudiobookTrack]: 36,
};

const ENTRY_SIZES_CLASSIC = {
  [Schema.Music]:          28,  // no codecId/rating fields at 28-30
  [Schema.Video]:          32,
  [Schema.Picture]:        24,
  [Schema.Filename]:       8,
  [Schema.Album]:          12,  // no FILETIME at 12-19, title starts at 12
  [Schema.Playlist]:       12,
  [Schema.Artist]:         1,   // just 1 flag byte before name
  [Schema.Genre]:          1,
  [Schema.VideoTitle]:     4,
  [Schema.PhotoAlbum]:     12,
  [Schema.Collection]:     12,
  [Schema.PodcastShow]:    8,
  [Schema.PodcastEpisode]: 32,
  [Schema.AudiobookTitle]: 8,
  [Schema.AudiobookTrack]: 36,
};

// Zune HD descriptor-to-schema mapping
const HD_DESCRIPTOR_MAP = {
  1:  Schema.Music,
  11: Schema.Playlist,
  12: Schema.Video,
  16: Schema.Picture,
  19: Schema.PodcastEpisode,
  26: Schema.AudiobookTrack,
};

// Classic descriptor-to-schema mapping
const CLASSIC_DESCRIPTOR_MAP = {
  1:  Schema.Music,
  2:  Schema.Playlist,
  12: Schema.Video,
};

// --------------------------------------------------------------------------
// Binary reading helpers
// --------------------------------------------------------------------------

function readUint16LE(buf, offset) {
  if (offset + 2 > buf.length) return 0;
  return buf[offset] | (buf[offset + 1] << 8);
}

function readUint32LE(buf, offset) {
  if (offset + 4 > buf.length) return 0;
  return (buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24)) >>> 0;
}

function readInt32LE(buf, offset) {
  if (offset + 4 > buf.length) return 0;
  return buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24);
}

function readUint64LE(buf, offset) {
  if (offset + 8 > buf.length) return 0n;
  const lo = readUint32LE(buf, offset);
  const hi = readUint32LE(buf, offset + 4);
  return BigInt(lo) | (BigInt(hi) << 32n);
}

function readNullTerminatedUTF8(buf, offset, maxLen) {
  if (offset >= buf.length) return '';
  const end = Math.min(offset + (maxLen || 1024), buf.length);
  let i = offset;
  while (i < end && buf[i] !== 0) i++;
  if (i === offset) return '';
  return buf.slice(offset, i).toString('utf8');
}

function utf16LEToUTF8(data, start, end) {
  start = start || 0;
  end = end || data.length;
  let result = '';
  for (let i = start; i + 1 < end; i += 2) {
    const code = data[i] | (data[i + 1] << 8);
    if (code === 0) break;
    result += String.fromCharCode(code);
  }
  return result;
}

// --------------------------------------------------------------------------
// Backwards varint parser
// --------------------------------------------------------------------------

function parseBackwardsVarints(recordData, entrySize) {
  const fields = [];
  if (recordData.length <= entrySize) return fields;

  let pos = recordData.length - 1;

  while (pos >= entrySize) {
    // Read field_id (1-2 bytes)
    if (pos < entrySize) break;
    const idByte1 = recordData[pos--];
    if (idByte1 === 0) break;

    let fieldId = idByte1;
    if (idByte1 & 0x80) {
      if (pos < entrySize) break;
      const idByte2 = recordData[pos--];
      fieldId = (idByte2 << 7) | (idByte1 & 0x7F);
    }

    // Read field_size (1-3 bytes)
    if (pos < entrySize) break;
    const sizeByte1 = recordData[pos--];
    let fieldSize = sizeByte1;

    if (sizeByte1 & 0x80) {
      if (pos < entrySize) break;
      const sizeByte2 = recordData[pos--];
      fieldSize = (sizeByte2 << 7) | (sizeByte1 & 0x7F);
      if (sizeByte2 !== 0) {
        if (pos < entrySize) break;
        const sizeByte3 = recordData[pos--];
        fieldSize = (sizeByte3 << 14) | (fieldSize & 0x3FFF);
      }
    }

    // Extract field data
    const fieldEnd = pos + 1;
    if (fieldSize > fieldEnd || fieldEnd - fieldSize < entrySize) break;
    const fieldStart = fieldEnd - fieldSize;

    fields.push({
      fieldId,
      fieldSize,
      data: recordData.slice(fieldStart, fieldEnd),
    });

    pos = fieldStart - 1;
  }

  fields.reverse();
  return fields;
}

// --------------------------------------------------------------------------
// ZMDB Parser
// --------------------------------------------------------------------------

class ZMDBParser {
  constructor(data, deviceFamily) {
    this.data = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.isHD = deviceFamily === 'hd';
    this.entrySizes = this.isHD ? ENTRY_SIZES_HD : ENTRY_SIZES_CLASSIC;
    this.descriptors = [];
    this.indexTable = new Map(); // atom_id -> record_offset
    this.stringCache = new Map();
    this.artistCache = new Map();
    this.albumCache = new Map();
    this.genreCache = new Map();
  }

  parse() {
    const library = {
      tracks: [],
      albums: {},      // atom_id -> album
      artists: {},     // atom_id -> artist
      genres: {},      // atom_id -> genre
      videos: [],
      pictures: [],
      playlists: [],
    };

    if (this.data.length < 0x30) return library;

    // Verify ZMDB magic
    if (this.data.slice(0, 4).toString('ascii') !== 'ZMDB') {
      throw new Error('Not a ZMDB file (bad magic)');
    }

    // Verify ZMed header at 0x20
    if (this.data.slice(0x20, 0x24).toString('ascii') !== 'ZMed') {
      throw new Error('Missing ZMed header');
    }

    // Find ZArr descriptor block (search 0x30 to 0x100)
    let zarrOffset = 0;
    for (let offset = 0x30; offset < 0x100 && offset + 4 <= this.data.length; offset += 4) {
      if (this.data.slice(offset, offset + 4).toString('ascii') === 'ZArr') {
        zarrOffset = offset;
        break;
      }
    }
    if (!zarrOffset) throw new Error('ZArr descriptor block not found');

    // Parse 96 descriptors (20 bytes each, starting after the ZArr marker)
    const descStart = zarrOffset + 4; // skip 'ZArr' itself? No — descriptors start AT zarrOffset per the C++ code
    // Re-check: the C++ does descriptor_offset = offset (where ZArr was found), then desc_offset = descriptor_offset + (i * 20)
    // So the ZArr marker IS the first descriptor area. Let me reread...
    // Actually looking at the C++ more carefully: it finds 'ZArr' at some offset, then parses descriptors starting from that offset.
    // Each descriptor is 20 bytes. The ZArr marker itself is 4 bytes, so descriptors likely start at zarrOffset or zarrOffset+4.
    // The C++ code: desc_offset = descriptor_offset + (i * 20), and reads entry_size at desc_offset + 6.
    // If descriptor_offset = zarrOffset and i=0, that would read entry_size from zarrOffset+6, which is 2 bytes into the 'ZArr' string area.
    // That seems wrong. Let me look again... The C++ does:
    //   for (size_t offset = 0x30; ... offset += 4) { if matches ZArr, descriptor_offset = offset; break; }
    //   for (int i = 0; i < 96; i++) { size_t desc_offset = descriptor_offset + (i * 20); ... }
    // So yes, descriptor_offset IS the ZArr offset. The ZArr is probably a 4-byte marker followed by the first descriptor.
    // But 96 * 20 = 1920 bytes. The descriptors are part of a ZArr structure. Looking at the 20-byte layout:
    //   offset +6: entry_size (uint16), +8: entry_count (uint32), +16: data_offset (uint32)
    // If i=0, reading from zarrOffset+0, the first 4 bytes would be 'ZArr', then bytes 4-5 unknown, bytes 6-7 entry_size.
    // That makes sense — the ZArr header IS the first "descriptor" slot with the marker in bytes 0-3.
    // So descriptor 0 contains the index table. Let's follow the C++ exactly.

    this.descriptors = new Array(96);
    for (let i = 0; i < 96; i++) {
      const dOff = zarrOffset + (i * 20);
      if (dOff + 20 > this.data.length) break;
      this.descriptors[i] = {
        entrySize:  readUint16LE(this.data, dOff + 6),
        entryCount: readUint32LE(this.data, dOff + 8),
        dataOffset: readUint32LE(this.data, dOff + 16),
      };
    }

    // Build index table from descriptor 0 (8-byte entries: atom_id + record_offset)
    const desc0 = this.descriptors[0];
    if (desc0 && desc0.entryCount > 0 && desc0.entrySize === 8) {
      for (let i = 0; i < desc0.entryCount; i++) {
        const eOff = desc0.dataOffset + (i * 8);
        if (eOff + 8 > this.data.length) break;
        const atomId = readUint32LE(this.data, eOff);
        const recordOffset = readUint32LE(this.data, eOff + 4);
        this.indexTable.set(atomId, recordOffset);
      }
    }

    console.log(`ZMDB: parsed ${this.indexTable.size} index entries from ${this.descriptors.length} descriptors`);

    // Extract media from descriptors using device-specific mapping
    const descMap = this.isHD ? HD_DESCRIPTOR_MAP : CLASSIC_DESCRIPTOR_MAP;

    for (const [descIdx] of Object.entries(descMap)) {
      const idx = Number(descIdx);
      if (idx >= this.descriptors.length || !this.descriptors[idx]) continue;
      const desc = this.descriptors[idx];
      if (!desc.entryCount) continue;

      for (let i = 0; i < desc.entryCount; i++) {
        const eOff = desc.dataOffset + (i * desc.entrySize);
        if (eOff + 4 > this.data.length) break;

        const atomId = readUint32LE(this.data, eOff);
        const schema = (atomId >> 24) & 0xFF;

        // Look up record in index
        if (!this.indexTable.has(atomId)) continue;
        const recordOffset = this.indexTable.get(atomId);

        const record = this._readRecord(recordOffset);
        if (!record) continue;

        // Filter root entries (all reference fields zero)
        if (record.length >= 12) {
          const ref0 = readUint32LE(record, 0);
          const ref1 = readUint32LE(record, 4);
          const ref2 = readUint32LE(record, 8);
          if (ref0 === 0 && ref1 === 0 && ref2 === 0) continue;
        }

        // Parse by schema type
        switch (schema) {
          case Schema.Music: {
            const track = this._parseTrack(record, atomId);
            if (track) library.tracks.push(track);
            break;
          }
          case Schema.Video: {
            const video = this._parseVideo(record, atomId);
            if (video) library.videos.push(video);
            break;
          }
          case Schema.Picture: {
            const pic = this._parsePicture(record, atomId);
            if (pic) library.pictures.push(pic);
            break;
          }
          case Schema.Playlist: {
            const pl = this._parsePlaylist(record, atomId);
            if (pl) library.playlists.push(pl);
            break;
          }
        }
      }
    }

    // Move caches to library
    library.albums = Object.fromEntries(this.albumCache);
    library.artists = Object.fromEntries(this.artistCache);
    library.genres = Object.fromEntries(this.genreCache);

    console.log(`ZMDB: ${library.tracks.length} tracks, ${Object.keys(library.albums).length} albums, ${Object.keys(library.artists).length} artists, ${Object.keys(library.genres).length} genres, ${library.videos.length} videos, ${library.pictures.length} pictures, ${library.playlists.length} playlists`);

    return library;
  }

  // ---- Record reading ----

  _readRecord(offset) {
    if (offset < 4 || offset >= this.data.length) return null;

    // 4-byte header at offset-4: 24-bit size + 8-bit flags
    const headerVal = readUint32LE(this.data, offset - 4);
    if (headerVal & 0x80000000) return null; // sign bit must be 0

    const recordSize = headerVal & 0x00FFFFFF;
    if (offset + recordSize > this.data.length) return null;

    return this.data.slice(offset, offset + recordSize);
  }

  // ---- Reference resolution ----

  _resolveString(atomId) {
    if (!atomId) return '';
    if (this.stringCache.has(atomId)) return this.stringCache.get(atomId);

    if (!this.indexTable.has(atomId)) return '';
    const record = this._readRecord(this.indexTable.get(atomId));
    if (!record) return '';

    const schema = (atomId >> 24) & 0xFF;
    let result = '';

    switch (schema) {
      case Schema.Filename:
        if (record.length > 8) result = readNullTerminatedUTF8(record, 8);
        break;
      case Schema.Genre:
        if (record.length > 1) result = readNullTerminatedUTF8(record, 1);
        break;
      case Schema.VideoTitle:
        if (record.length > 4) result = readNullTerminatedUTF8(record, 4);
        break;
      case Schema.PhotoAlbum:
      case Schema.Collection:
        if (record.length >= 20) result = readNullTerminatedUTF8(record, 12);
        break;
      case Schema.PodcastShow:
      case Schema.AudiobookTitle:
        if (record.length > 8) result = readNullTerminatedUTF8(record, 8);
        break;
      case Schema.Album:
      case Schema.Artist: {
        // UTF-16LE filename in backwards varint field 0x44
        const entrySize = this.entrySizes[schema] || 0;
        if (entrySize) {
          const fields = parseBackwardsVarints(record, entrySize);
          for (const f of fields) {
            if (f.fieldId === 0x44 && f.fieldSize > 2) {
              let start = 0, end = f.data.length;
              if (f.data[0] === 0x00 && f.data[end - 1] === 0x00) { start = 1; end -= 1; }
              result = utf16LEToUTF8(f.data, start, end);
              break;
            }
          }
        }
        break;
      }
    }

    this.stringCache.set(atomId, result);
    return result;
  }

  _resolveArtist(atomId) {
    if (!atomId) return null;
    if (this.artistCache.has(atomId)) return this.artistCache.get(atomId);

    if (!this.indexTable.has(atomId)) return null;
    const record = this._readRecord(this.indexTable.get(atomId));
    if (!record) return null;

    const artist = { atomId, name: '', filename: '', guid: '' };

    const entrySize = this.entrySizes[Schema.Artist]; // 4 for HD, 1 for Classic
    if (record.length > entrySize) artist.name = readNullTerminatedUTF8(record, entrySize);
    const fields = parseBackwardsVarints(record, entrySize);
    for (const f of fields) {
      if (f.fieldId === 0x44 && f.fieldSize > 2) {
        let start = 0, end = f.data.length;
        if (f.data[0] === 0x00 && f.data[end - 1] === 0x00) { start = 1; end -= 1; }
        artist.filename = utf16LEToUTF8(f.data, start, end);
      } else if (f.fieldId === 0x14 && f.fieldSize === 16) {
        // GUID field — format as string for debugging
        const d = f.data;
        const hex = (b) => b.toString(16).padStart(2, '0');
        artist.guid = `{${hex(d[3])}${hex(d[2])}${hex(d[1])}${hex(d[0])}-${hex(d[5])}${hex(d[4])}-${hex(d[7])}${hex(d[6])}-${hex(d[8])}${hex(d[9])}-${hex(d[10])}${hex(d[11])}${hex(d[12])}${hex(d[13])}${hex(d[14])}${hex(d[15])}}`;
      }
    }

    this.artistCache.set(atomId, artist);
    return artist;
  }

  _resolveAlbum(atomId) {
    if (!atomId) return null;
    if (this.albumCache.has(atomId)) return this.albumCache.get(atomId);

    if (!this.indexTable.has(atomId)) return null;
    const record = this._readRecord(this.indexTable.get(atomId));
    if (!record || record.length < 20) return null;

    const album = {
      atomId,
      artistRef: readUint32LE(record, 0),
      title: '',
      artistName: '',
      releaseYear: 0,
      filename: '',
    };

    // Release year from FILETIME at offset 12
    const filetime = readUint64LE(record, 12);
    if (filetime > 0n) {
      const TICKS_PER_SEC = 10000000n;
      const EPOCH_DIFF = 11644473600n;
      const secSince1601 = filetime / TICKS_PER_SEC;
      if (secSince1601 > EPOCH_DIFF) {
        const unixTime = Number(secSince1601 - EPOCH_DIFF);
        album.releaseYear = new Date(unixTime * 1000).getUTCFullYear();
      }
    }

    // Title after fixed fields (20 on HD, 12 on Classic — Classic has no FILETIME)
    const albumTitleOffset = this.entrySizes[Schema.Album]; // 20 for HD, 12 for Classic
    if (record.length > albumTitleOffset) album.title = readNullTerminatedUTF8(record, albumTitleOffset);

    // Resolve artist
    if (album.artistRef) {
      const artist = this._resolveArtist(album.artistRef);
      if (artist) album.artistName = artist.name;
    }

    // Filename from backwards varint 0x44
    const entrySize = this.entrySizes[Schema.Album] || 20;
    const fields = parseBackwardsVarints(record, entrySize);
    for (const f of fields) {
      if (f.fieldId === 0x44 && f.fieldSize > 2) {
        let start = 0, end = f.data.length;
        if (f.data[0] === 0x00 && f.data[end - 1] === 0x00) { start = 1; end -= 1; }
        album.filename = utf16LEToUTF8(f.data, start, end);
        break;
      }
    }

    this.albumCache.set(atomId, album);
    return album;
  }

  _resolveGenre(atomId) {
    if (!atomId) return '';
    if (this.genreCache.has(atomId)) return this.genreCache.get(atomId).name;

    const name = this._resolveString(atomId);
    if (name) this.genreCache.set(atomId, { atomId, name });
    return name;
  }

  // ---- Media parsers ----

  _parseTrack(record, atomId) {
    const titleOffset = this.entrySizes[Schema.Music]; // 32 for HD, 28 for Classic
    if (record.length < titleOffset) return null;

    const albumRef    = readUint32LE(record, 0);
    const artistRef   = readUint32LE(record, 4);
    const genreRef    = readUint32LE(record, 8);
    const filenameRef = readUint32LE(record, 12);

    const track = {
      atomId,
      title:       record.length > titleOffset ? readNullTerminatedUTF8(record, titleOffset) : '',
      artist:      '',
      album:       '',
      albumArtist: '',
      genre:       '',
      trackNumber: readUint16LE(record, 24),
      discNumber:  1,
      duration:    readInt32LE(record, 16),
      size:        readInt32LE(record, 20),
      playcount:   readUint16LE(record, 26),
      codecId:     this.isHD ? readUint16LE(record, 28) : 0,
      rating:      this.isHD ? record[30] : 0,
      filename:    '',
      albumRef,
      genreRef,
    };

    // Backwards varints for optional fields
    const fields = parseBackwardsVarints(record, titleOffset);
    for (const f of fields) {
      if (f.fieldId === 0x6c && f.fieldSize >= 1 && f.fieldSize <= 4) {
        track.discNumber = readUint32LE(f.data, 0) || 1;
      }
    }

    // Resolve references
    if (albumRef) {
      const album = this._resolveAlbum(albumRef);
      if (album) {
        track.album = album.title;
        track.albumArtist = album.artistName;
      }
    }
    if (artistRef) {
      const artist = this._resolveArtist(artistRef);
      if (artist) track.artist = artist.name;
    }
    if (genreRef) {
      track.genre = this._resolveGenre(genreRef);
    }
    if (filenameRef) {
      track.filename = this._resolveString(filenameRef);
    }

    return track;
  }

  _parseVideo(record, atomId) {
    if (record.length < 16) return null;

    const folderRef = readUint32LE(record, 0);
    const titleRef  = readUint32LE(record, 4);
    const fileRef   = readUint32LE(record, 12);

    const video = {
      atomId,
      title:    titleRef ? this._resolveString(titleRef) : '',
      folder:   folderRef ? this._resolveString(folderRef) : '',
      size:     record.length >= 40 ? readUint32LE(record, 32) : 0,
      codecId:  record.length >= 40 ? readUint32LE(record, 36) : 0,
      filename: '',
    };

    // Filename from backwards varint 0x44
    const fields = parseBackwardsVarints(record, this.entrySizes[Schema.Video]);
    for (const f of fields) {
      if (f.fieldId === 0x44 && f.fieldSize > 2) {
        let start = 0, end = f.data.length;
        if (f.data[0] === 0x00 && f.data[end - 1] === 0x00) { start = 1; end -= 1; }
        video.filename = utf16LEToUTF8(f.data, start, end);
        break;
      }
    }

    return video;
  }

  _parsePicture(record, atomId) {
    if (record.length < 24) return null;

    const folderRef     = readUint32LE(record, 0);
    const albumRef      = readUint32LE(record, 4);
    const collectionRef = readUint32LE(record, 8);
    const fileRef       = readUint32LE(record, 12);

    return {
      atomId,
      title:      record.length > 24 ? readNullTerminatedUTF8(record, 24) : '',
      photoAlbum: albumRef ? this._resolveString(albumRef) : '',
      folder:     folderRef ? this._resolveString(folderRef) : '',
      collection: collectionRef ? this._resolveString(collectionRef) : '',
      filename:   fileRef ? this._resolveString(fileRef) : '',
    };
  }

  _parsePlaylist(record, atomId) {
    if (record.length < 12) return null;

    const trackCount = readUint32LE(record, 0);
    const folderRef  = readUint32LE(record, 8);

    const playlist = {
      atomId,
      name:     '',
      folder:   folderRef ? this._resolveString(folderRef) : '',
      filename: '',
      trackCount,
      trackAtomIds: [],
    };

    // Name at offset 12 (UTF-8, null-terminated)
    if (record.length <= 12) return playlist;

    let nullPos = 12;
    while (nullPos < record.length && record[nullPos] !== 0) nullPos++;
    if (nullPos > 12) {
      playlist.name = record.slice(12, nullPos).toString('utf8');
    }

    // After the null terminator: optional GUID, then UTF-16LE filename, then track atom_ids
    if (nullPos + 3 >= record.length) return playlist;

    let pos = nullPos + 1;
    const hasGuid = record[pos + 1] !== 0x00;

    if (hasGuid && pos + 18 < record.length) {
      pos += 16; // skip GUID
      pos += 2;  // skip 2-byte field
    }

    // UTF-16LE filename
    const utf16Start = pos;
    while (pos + 1 < record.length) {
      if (record[pos] === 0 && record[pos + 1] === 0) break;
      pos += 2;
    }
    if (pos > utf16Start) {
      playlist.filename = utf16LEToUTF8(record, utf16Start, pos);
    }

    // Skip double-null + 2-byte pre-track field
    pos += 4;

    // Track atom_ids
    while (pos + 4 <= record.length) {
      const trackId = readUint32LE(record, pos);
      if (trackId === 0) break;
      const trackSchema = (trackId >> 24) & 0xFF;
      if (trackSchema === Schema.Music) {
        playlist.trackAtomIds.push(trackId);
      }
      pos += 4;
    }

    return playlist;
  }
}

module.exports = { ZMDBParser, Schema };
