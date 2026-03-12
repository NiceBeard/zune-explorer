# Podcast Sync Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full 2-way podcast sync between Zune Explorer and Zune HD, with playback position sync using the "furthest progress wins" strategy.

**Architecture:** Podcasts sync via MTP using AbstractMediacast (0xBA0B) containers for series with standard audio/video objects for episodes. The existing diff view gets a "podcasts" tab. Push creates series containers + episode objects on device; pull downloads episodes and registers them in the podcast system; position sync runs during diff computation.

**Tech Stack:** Electron IPC, MTP protocol (libusb), ZMDB binary parser, existing ffmpeg pipeline for format conversion.

**Spec:** `docs/superpowers/specs/2026-03-11-podcast-sync-design.md`

**Note on testing:** This project has no automated test framework. Each task includes manual verification steps using `npm run dev` and a connected Zune device (where applicable). Tasks 1-7 can be verified without a device; Tasks 8-12 require device testing.

---

## Chunk 1: Foundation (Constants, Parser, Data Source)

### Task 1: Add Podcast MTP Constants

**Files:**
- Modify: `src/main/zune/mtp-constants.js:49-93`

- [ ] **Step 1: Add AbstractMediacast to ObjectFormat**

In `src/main/zune/mtp-constants.js`, add after the `Artist` entry (line 59):

```javascript
  AbstractMediacast: 0xBA0B,
```

- [ ] **Step 2: Add podcast properties to ObjectProperty**

In the same file, add after the `ArtistId` entry (line 92):

```javascript
  URLSource:      0xDD60,
  TimeBookmark:   0xDD62,
  ObjectBookmark: 0xDD63,
  MediaGUID:      0xDD72,
```

- [ ] **Step 3: Verify constants load**

Run: `npm run dev`
Expected: App launches without errors. Open DevTools console — no import/syntax errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/zune/mtp-constants.js
git commit -m "feat(sync): add podcast MTP constants (AbstractMediacast, TimeBookmark, etc.)"
```

---

### Task 2: Add Podcast Parsing to ZMDB Parser

**Files:**
- Modify: `src/main/zune/zmdb-parser.js:224-451`

- [ ] **Step 1: Add `_resolvePodcastShow()` method**

Add after the `_resolveString()` method (after line 451) in `zmdb-parser.js`:

```javascript
  _resolvePodcastShow(atomId) {
    const name = this._resolveString(atomId);
    return name || `Show ${atomId}`;
  }
```

- [ ] **Step 2: Add PodcastEpisode case to parse switch**

In the `parse()` method's switch statement (after the `Schema.Playlist` case, around line 370), add:

```javascript
        case Schema.PodcastEpisode: {
          // Entry size is 32 bytes for HD. Byte offsets are provisional —
          // confirmed offsets require probing on a real device with known podcasts.
          const episode = {
            atomId,
            title: null,
            showAtomId: null,
            showName: null,
            duration: 0,
          };
          // Try reading a show reference at offset 0 as uint32 (all ZMDB references are 32-bit atom IDs)
          if (record.length >= 4) {
            const showRef = readUint32LE(record, 0);
            if (showRef > 0) {
              episode.showAtomId = showRef;
              episode.showName = this._resolvePodcastShow(showRef);
            }
          }
          // Duration — try offset 8 as uint32 (milliseconds), using the parser's helper
          if (record.length >= 12) {
            episode.duration = readUint32LE(record, 8);
          }
          // Title — try reading from the backwards varint fields (same pattern as Album/Artist)
          // Falls back to reading a null-terminated UTF-8 string at the entry size boundary
          const entrySize = this.entrySizes[schema] || 32;
          if (record.length > entrySize) {
            const fields = parseBackwardsVarints(record, entrySize);
            for (const f of fields) {
              if (f.fieldId === 0x44 && f.fieldSize > 2) {
                let start = 0, end = f.data.length;
                if (f.data[0] === 0x00 && f.data[end - 1] === 0x00) { start = 1; end -= 1; }
                episode.title = utf16LEToUTF8(f.data, start, end);
                break;
              }
            }
          }
          // Fallback: try null-terminated UTF-8 at offset entrySize
          if (!episode.title && record.length > entrySize) {
            episode.title = readNullTerminatedUTF8(record, entrySize);
          }
          library.podcastEpisodes.push(episode);
          break;
        }
```

- [ ] **Step 3: Initialize podcastEpisodes array in library object**

In the `parse()` method, find where the `library` object is initialized (should be around line 230-240, where `tracks: []`, `videos: []`, etc. are set). Add:

```javascript
      podcastEpisodes: [],
```

- [ ] **Step 4: Verify parser doesn't crash**

Run: `npm run dev`
Expected: App launches without errors. If a Zune with podcasts is connected, browse it — no crashes even if podcast data is present in ZMDB.

- [ ] **Step 5: Commit**

```bash
git add src/main/zune/zmdb-parser.js
git commit -m "feat(sync): parse podcast episodes from ZMDB (provisional offsets)"
```

---

### Task 3: Add `getAllDownloaded()` to PodcastManager + IPC

**Files:**
- Modify: `src/main/podcast-manager.js:88-94`
- Modify: `src/main/main.js:908`
- Modify: `src/main/preload.js:128`

- [ ] **Step 1: Add `getAllDownloaded()` method to PodcastManager**

In `src/main/podcast-manager.js`, add after the `getEpisodes()` method (around line 94):

```javascript
  getAllDownloaded() {
    const result = [];
    for (const sub of this._subscriptions) {
      const episodes = this._loadEpisodes(sub.id);
      for (const ep of episodes) {
        if (ep.downloaded && ep.localPath) {
          result.push({
            subscriptionId: sub.id,
            subscriptionTitle: sub.title,
            feedUrl: sub.feedUrl,
            episodeId: ep.id,
            title: ep.title,
            localPath: ep.localPath,
            duration: ep.duration,
            publishDate: ep.publishDate,
            playbackPosition: ep.playbackPosition || 0,
            enclosureType: ep.enclosureType || 'audio/mpeg',
          });
        }
      }
    }
    return result;
  }
```

- [ ] **Step 2: Add IPC handler in main.js**

In `src/main/main.js`, add near the other podcast IPC handlers (around line 935):

```javascript
  ipcMain.handle('podcast-get-all-downloaded', async () => {
    try {
      const episodes = podcastManager.getAllDownloaded();
      return { success: true, episodes };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
```

- [ ] **Step 3: Expose in preload.js**

In `src/main/preload.js`, add near the other podcast API methods (around line 129):

```javascript
    podcastGetAllDownloaded: async () => {
      const result = await ipcRenderer.invoke('podcast-get-all-downloaded');
      if (!result.success) throw new Error(result.error);
      return result.episodes;
    },
```

- [ ] **Step 4: Verify IPC works**

Run: `npm run dev`
Open DevTools console, run: `await window.electronAPI.podcastGetAllDownloaded()`
Expected: Returns an array (empty if no downloaded episodes, or populated if some exist).

- [ ] **Step 5: Commit**

```bash
git add src/main/podcast-manager.js src/main/main.js src/main/preload.js
git commit -m "feat(sync): add podcastGetAllDownloaded IPC for sync diff source"
```

---

## Chunk 2: Device Browse Integration

### Task 4: Add Podcasts to ZMDB Browse Path

**Files:**
- Modify: `src/main/zune/zune-manager.js:647-699`

- [ ] **Step 1: Add podcasts array to ZMDB result initialization**

In `_tryZMDB()` (line 664), change the result initialization from:
```javascript
const result = { music: [], videos: [], pictures: [] };
```
to:
```javascript
const result = { music: [], videos: [], pictures: [], podcasts: [] };
```

- [ ] **Step 2: Add podcast episode conversion after the existing loops**

After the existing loops that convert ZMDB tracks/videos/pictures to browse format (around line 699), add:

```javascript
      // Convert podcast episodes
      if (zmdb.podcastEpisodes) {
        for (const ep of zmdb.podcastEpisodes) {
          result.podcasts.push({
            handle: ep.atomId,
            title: ep.title || `Episode ${ep.atomId}`,
            seriesName: ep.showName || 'Unknown Podcast',
            seriesHandle: ep.showAtomId || 0,
            duration: ep.duration || 0,
            releaseDate: null,
            timeBookmark: 0,
            guid: null,
            size: 0,
            format: 0x3009,  // assume MP3 until probed
            filename: null,
          });
        }
      }
```

- [ ] **Step 3: Commit**

```bash
git add src/main/zune/zune-manager.js
git commit -m "feat(sync): include podcasts in ZMDB browse results"
```

---

### Task 5: Add Podcasts to MTP Browse Path

**Files:**
- Modify: `src/main/zune/zune-manager.js:824-1083`

- [ ] **Step 1: Add podcasts array to MTP result initialization**

In `browseContents()` (line 849), change:
```javascript
const result = { music: [], videos: [], pictures: [] };
```
to:
```javascript
const result = { music: [], videos: [], pictures: [], podcasts: [] };
```

- [ ] **Step 2: Add podcastSeriesHandles collection array**

After the `albumObjHandles` and `artistObjHandles` arrays (around line 853), add:

```javascript
      const podcastSeriesHandles = [];
```

- [ ] **Step 3: Collect AbstractMediacast objects during recursive enumeration**

In the format code categorization block (around lines 926-932), add a new case after the Artist collection:

```javascript
          } else if (info.objectFormat === ObjectFormat.AbstractMediacast) {
            podcastSeriesHandles.push(handle);
```

- [ ] **Step 4: Collect AbstractMediacast in flat enumeration pass too**

In the flat enumeration format categorization (around lines 1024-1029), add the same pattern:

```javascript
            } else if (info.objectFormat === ObjectFormat.AbstractMediacast) {
              if (!podcastSeriesHandles.includes(handle)) podcastSeriesHandles.push(handle);
```

- [ ] **Step 5: Add podcast series resolution pass**

After the album resolution pass (after line ~1020, before the `return result` statement), add:

```javascript
      // Pass: Resolve podcast series and their episodes
      if (podcastSeriesHandles.length > 0) {
        this._emitProgress('resolving-podcasts', { count: podcastSeriesHandles.length });
        for (const seriesHandle of podcastSeriesHandles) {
          try {
            const seriesName = await this.mtp.getObjectPropString(seriesHandle, ObjectProperty.Name);
            const episodeHandles = await this.mtp.getObjectReferences(seriesHandle);
            if (!episodeHandles || episodeHandles.length === 0) continue;

            for (const epHandle of episodeHandles) {
              try {
                const title = await this.mtp.getObjectPropString(epHandle, ObjectProperty.Name);
                const duration = await this.mtp.getObjectPropUint32(epHandle, ObjectProperty.Duration);
                const info = await this.mtp.getObjectInfo(epHandle);
                let timeBookmark = 0;
                try {
                  timeBookmark = await this.mtp.getObjectPropUint32(epHandle, ObjectProperty.TimeBookmark);
                } catch (_) { /* property may not be set */ }
                let guid = null;
                try {
                  guid = await this.mtp.getObjectPropString(epHandle, ObjectProperty.MediaGUID);
                } catch (_) { /* property may not be set */ }

                result.podcasts.push({
                  handle: epHandle,
                  title: title || info?.filename || `Episode ${epHandle}`,
                  seriesName: seriesName || 'Unknown Podcast',
                  seriesHandle,
                  duration: duration || 0,
                  releaseDate: null,
                  timeBookmark,
                  guid,
                  size: info?.compressedSize || 0,
                  format: info?.objectFormat || 0x3009,
                  filename: info?.filename || null,
                });
              } catch (epErr) {
                console.warn(`Failed to read podcast episode ${epHandle}:`, epErr.message);
              }
            }
          } catch (serErr) {
            console.warn(`Failed to read podcast series ${seriesHandle}:`, serErr.message);
          }
        }
      }
```

- [ ] **Step 6: Commit**

```bash
git add src/main/zune/zune-manager.js
git commit -m "feat(sync): enumerate podcasts during MTP device browse"
```

---

### Task 6: Add Podcasts Tab to Diff View HTML + CSS

**Files:**
- Modify: `src/renderer/index.html:307-310`
- Modify: `src/assets/css/styles.css`

- [ ] **Step 1: Add podcasts tab button to HTML**

In `src/renderer/index.html`, after the PHOTOS tab button (line 310), add:

```html
      <button class="zune-diff-category-tab" data-category="podcasts">PODCASTS</button>
```

- [ ] **Step 2: Verify tab appears**

Run: `npm run dev`
Connect a Zune (or mock the sync panel opening). The PODCASTS tab should appear in the diff category tabs bar.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/index.html
git commit -m "feat(sync): add podcasts tab to diff view"
```

---

## Chunk 3: Diff Computation & Category Updates

### Task 7: Update Hardcoded Category Lists

**Files:**
- Modify: `src/assets/js/renderer.js` (lines ~1125, ~1137-1145, ~1828-1836, ~2006-2010, ~2018-2022)

- [ ] **Step 1: Update `_showDiffView()` category loop**

In `renderer.js`, find the category loop around line 1125:
```javascript
for (const cat of ['music', 'videos', 'pictures']) {
```
Change to:
```javascript
for (const cat of ['music', 'videos', 'pictures', 'podcasts']) {
```

- [ ] **Step 2: Update cache save counts in `_showDiffView()`**

Find the cache save counts block (around lines 1137-1145) and add:
```javascript
              podcasts: this.browseData.podcasts?.length || 0,
```

- [ ] **Step 3: Update cache save counts in `_pushToDevice()`**

Find the cache save counts block in `_pushToDevice()` (around lines 1828-1836) and add:
```javascript
              podcasts: this.browseData.podcasts?.length || 0,
```

- [ ] **Step 4: Update delete category loop**

Find the delete cleanup loop in `_deleteFromDevice()` (around line 2006):
```javascript
for (const cat of ['music', 'videos', 'pictures']) {
```
Change to:
```javascript
for (const cat of ['music', 'videos', 'pictures', 'podcasts']) {
```

- [ ] **Step 5: Update cache save counts in `_deleteFromDevice()`**

Find the cache save counts in `_deleteFromDevice()` (around lines 2018-2022) and add:
```javascript
              podcasts: this.browseData.podcasts?.length || 0,
```

- [ ] **Step 6: Initialize browseData.podcasts**

Find where `this.browseData` is first assigned from the browse result (in `_showDiffView()` or `_openDiffView()`). Ensure `podcasts` is initialized:
```javascript
this.browseData.podcasts = this.browseData.podcasts || [];
```

- [ ] **Step 7: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat(sync): add podcasts to all hardcoded category lists"
```

---

### Task 8: Implement `_computePodcastDiff()`

**Files:**
- Modify: `src/assets/js/renderer.js` (after `_computeMediaDiff()`)

- [ ] **Step 1: Add dispatch branch in `_computeDiff()`**

Find `_computeDiff()` (line 1151) and make it async with podcast dispatch. Note: callers at lines ~1841, ~1951 already `await` or don't use the return value, so making it async is safe:

```javascript
    async _computeDiff() {
      if (this.diffCategory === 'music') {
        this._computeMusicDiff();
      } else if (this.diffCategory === 'podcasts') {
        await this._computePodcastDiff();
        return; // _computePodcastDiff handles its own rendering
      } else {
        this._computeMediaDiff(this.diffCategory);
      }
    }
```

- [ ] **Step 2: Implement `_computePodcastDiff()` method**

Add after `_computeMediaDiff()` (after line ~1290):

```javascript
    async _computePodcastDiff() {
      // Fetch all downloaded episodes from main process
      let localEpisodes = [];
      try {
        localEpisodes = await window.electronAPI.podcastGetAllDownloaded();
      } catch (err) {
        console.warn('Failed to load downloaded episodes for diff:', err);
      }

      const deviceEpisodes = this.browseData.podcasts || [];

      const matched = [];
      const localOnly = [];
      const deviceOnly = [];

      // Track which items have been matched
      const matchedLocalIds = new Set();
      const matchedDeviceHandles = new Set();

      // Pass 1: Match by GUID
      for (const local of localEpisodes) {
        if (!local.episodeId) continue;
        const deviceMatch = deviceEpisodes.find(
          d => !matchedDeviceHandles.has(d.handle) && d.guid && d.guid === local.episodeId
        );
        if (deviceMatch) {
          matchedLocalIds.add(local.episodeId);
          matchedDeviceHandles.add(deviceMatch.handle);
          matched.push({ local, device: deviceMatch });
        }
      }

      // Pass 2: Match by title + series name (fallback)
      for (const local of localEpisodes) {
        if (matchedLocalIds.has(local.episodeId)) continue;
        const localKey = `${(local.title || '').toLowerCase().trim()}|${(local.subscriptionTitle || '').toLowerCase().trim()}`;
        const deviceMatch = deviceEpisodes.find(d => {
          if (matchedDeviceHandles.has(d.handle)) return false;
          const deviceKey = `${(d.title || '').toLowerCase().trim()}|${(d.seriesName || '').toLowerCase().trim()}`;
          return deviceKey === localKey;
        });
        if (deviceMatch) {
          matchedLocalIds.add(local.episodeId);
          matchedDeviceHandles.add(deviceMatch.handle);
          matched.push({ local, device: deviceMatch });
        }
      }

      // Unmatched items
      for (const local of localEpisodes) {
        if (!matchedLocalIds.has(local.episodeId)) {
          localOnly.push(local);
        }
      }
      for (const device of deviceEpisodes) {
        if (!matchedDeviceHandles.has(device.handle)) {
          deviceOnly.push(device);
        }
      }

      // Run position sync on matched episodes
      await this._syncPodcastPositions(matched);

      this.diffResult = { matched, localOnly, deviceOnly };
      this._renderDiffSummary();
      this._renderDiffList();
    }
```

- [ ] **Step 3: Add stub `_syncPodcastPositions()` method**

Add immediately after `_computePodcastDiff()`:

```javascript
    async _syncPodcastPositions(matched) {
      // Placeholder — implemented in Task 11
      // Will read TimeBookmark from device and apply "furthest wins" logic
    }
```

- [ ] **Step 4: Verify diff computation with downloaded episodes**

Run: `npm run dev`
1. Subscribe to a podcast and download an episode
2. Connect Zune, open sync panel
3. Click the PODCASTS tab
Expected: Downloaded episodes appear in the "local only" section. No crashes.

- [ ] **Step 5: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat(sync): implement podcast diff computation with GUID + title matching"
```

---

## Chunk 4: Push Flow

### Task 9: Implement `sendPodcastEpisodes()` in ZuneManager

**Files:**
- Modify: `src/main/zune/zune-manager.js` (after `_createAlbumObjects()`)

- [ ] **Step 1: Add `sendPodcastEpisodes()` method**

Add after `_createAlbumObjects()` method (around line 620):

```javascript
  async sendPodcastEpisodes(episodes) {
    // episodes: [{ localPath, title, subscriptionTitle, feedUrl, subscriptionId,
    //              episodeId, duration, publishDate, enclosureUrl, playbackPosition, enclosureType }]
    if (!this.mtp) throw new Error('Device not connected');

    // ObjectFormat, ObjectProperty already imported at file top

    // Group episodes by subscription
    const seriesMap = new Map();
    for (const ep of episodes) {
      const key = ep.subscriptionId || ep.subscriptionTitle;
      if (!seriesMap.has(key)) {
        seriesMap.set(key, {
          title: ep.subscriptionTitle,
          feedUrl: ep.feedUrl,
          subscriptionId: ep.subscriptionId,
          episodes: [],
        });
      }
      seriesMap.get(key).episodes.push(ep);
    }

    // Find or create Podcasts folder
    let podcastFolderHandle = await this._findOrCreateFolder('Podcasts');

    const results = { sent: 0, failed: 0, errors: [] };
    const newDeviceEpisodes = [];

    for (const [, series] of seriesMap) {
      // Find or create AbstractMediacast for this series
      let seriesHandle;
      try {
        seriesHandle = await this._findOrCreateMediacast(
          podcastFolderHandle, series.title, series.feedUrl, series.subscriptionId
        );
      } catch (err) {
        console.error(`Failed to create series container for "${series.title}":`, err);
        results.failed += series.episodes.length;
        for (const ep of series.episodes) {
          results.errors.push({ file: ep.localPath, error: err.message });
        }
        continue;
      }

      const episodeHandles = [];

      for (const ep of series.episodes) {
        let attempt = 0;
        let sent = false;
        while (attempt < 3 && !sent) {
          attempt++;
          try {
            const handle = await this._sendPodcastEpisode(ep, podcastFolderHandle, series.title);
            episodeHandles.push(handle);
            newDeviceEpisodes.push({
              handle,
              title: ep.title,
              seriesName: series.title,
              seriesHandle,
              duration: (ep.duration || 0) * 1000,
              releaseDate: ep.publishDate,
              timeBookmark: Math.round((ep.playbackPosition || 0) * 1000),
              guid: ep.episodeId,
              size: 0,
              format: 0x3009,
              filename: null,
            });
            results.sent++;
            sent = true;
            this.emit('transfer-progress', {
              state: 'sending',
              fileName: ep.title,
              fileIndex: results.sent - 1,
              totalFiles: episodes.length,
            });
          } catch (err) {
            if (attempt >= 3) {
              results.failed++;
              results.errors.push({ file: ep.localPath, error: err.message });
            } else {
              await new Promise(r => setTimeout(r, 500));
            }
          }
        }
      }

      // Link episodes to series container
      if (episodeHandles.length > 0) {
        try {
          let existingRefs = [];
          try {
            existingRefs = await this.mtp.getObjectReferences(seriesHandle) || [];
          } catch (_) {}
          const allRefs = [...existingRefs, ...episodeHandles];
          await this.mtp.setObjectReferences(seriesHandle, allRefs);
        } catch (err) {
          console.warn(`Failed to link episodes to series "${series.title}":`, err.message);
        }
      }
    }

    return { ...results, newDeviceEpisodes };
  }
```

- [ ] **Step 2: Add `_sendPodcastEpisode()` helper**

Add after `sendPodcastEpisodes()`:

```javascript
  async _sendPodcastEpisode(episode, parentHandle, seriesTitle) {
    // ObjectFormat, ObjectProperty, path, fs already imported at file top
    let filePath = episode.localPath;
    const ext = path.extname(filePath).toLowerCase();

    // Format conversion for non-native formats
    const nativeAudio = ['.mp3', '.wma', '.m4a', '.aac'];
    const nativeVideo = ['.mp4', '.wmv'];
    if (![...nativeAudio, ...nativeVideo].includes(ext)) {
      filePath = await this._convertForZune(filePath);
    }

    const fileData = await fs.readFile(filePath);
    const finalExt = path.extname(filePath).toLowerCase();

    // Determine format code
    let formatCode = ObjectFormat.MP3;
    if (finalExt === '.wma') formatCode = ObjectFormat.WMA;
    else if (finalExt === '.m4a' || finalExt === '.aac') formatCode = ObjectFormat.AAC;
    else if (finalExt === '.mp4' || finalExt === '.m4v') formatCode = ObjectFormat.MP4;
    else if (finalExt === '.wmv') formatCode = ObjectFormat.WMV;

    // Sanitize filename
    const safeName = (episode.title || 'episode').replace(/[<>:"/\\|?*]/g, '_').substring(0, 200);
    const filename = `${safeName}${finalExt}`;

    // Send to device — parent=0 (auto-place, like music sendFiles pattern)
    const info = await this.mtp.sendObjectInfo(this.storageId, 0, {
      objectFormat: formatCode,
      compressedSize: fileData.length,
      filename,
    });
    const handle = info.objectHandle;
    await this.mtp.sendObject(fileData);

    // Set metadata
    try { await this.mtp.setObjectPropString(handle, ObjectProperty.Name, episode.title || safeName); } catch (_) {}
    try { await this.mtp.setObjectPropString(handle, ObjectProperty.Artist, seriesTitle); } catch (_) {}
    try { await this.mtp.setObjectPropString(handle, ObjectProperty.Genre, 'Podcast'); } catch (_) {}
    if (episode.duration) {
      try { await this.mtp.setObjectPropUint32(handle, ObjectProperty.Duration, Math.round(episode.duration * 1000)); } catch (_) {}
    }
    if (episode.publishDate) {
      try { await this.mtp.setObjectPropString(handle, ObjectProperty.OriginalDate, episode.publishDate); } catch (_) {}
    }
    if (episode.episodeId) {
      try { await this.mtp.setObjectPropString(handle, ObjectProperty.MediaGUID, episode.episodeId); } catch (_) {}
    }
    if (episode.enclosureUrl) {
      try { await this.mtp.setObjectPropString(handle, ObjectProperty.URLSource, episode.enclosureUrl); } catch (_) {}
    }
    if (episode.playbackPosition) {
      try {
        await this.mtp.setObjectPropUint32(handle, ObjectProperty.TimeBookmark, Math.round(episode.playbackPosition * 1000));
      } catch (_) {}
    }

    // Clean up temp converted file
    if (filePath !== episode.localPath) {
      fs.unlink(filePath).catch(() => {});
    }

    return handle;
  }
```

- [ ] **Step 3: Add `_findOrCreateMediacast()` helper**

Add after `_sendPodcastEpisode()`:

```javascript
  async _findOrCreateMediacast(parentHandle, title, feedUrl, subscriptionId) {
    // ObjectFormat, ObjectProperty already imported at file top
    // Try to find existing series by scanning AbstractMediacast objects
    // (This is cached per session to avoid repeated scans)
    if (!this._mediacastCache) {
      this._mediacastCache = new Map();
      try {
        const handles = await this.mtp.getObjectHandles(0xFFFFFFFF, ObjectFormat.AbstractMediacast, 0);
        if (handles) {
          for (const h of handles) {
            try {
              const name = await this.mtp.getObjectPropString(h, ObjectProperty.Name);
              if (name) this._mediacastCache.set(name.toLowerCase(), h);
            } catch (_) {}
          }
        }
      } catch (_) {}
    }

    // Match by name
    const existing = this._mediacastCache.get(title.toLowerCase());
    if (existing) return existing;

    // Create new AbstractMediacast (same pattern as _createAlbumObjects)
    const safeName = title.replace(/[<>:"/\\|?*]/g, '_').substring(0, 200);
    const { objectHandle: handle } = await this.mtp.sendObjectInfo(this.storageId, parentHandle, {
      objectFormat: ObjectFormat.AbstractMediacast,
      compressedSize: 0,
      filename: `${safeName}.pod`,
    });
    // Send empty object data to complete the handshake
    await this.mtp.sendObject(Buffer.alloc(0));

    // Set series metadata
    try { await this.mtp.setObjectPropString(handle, ObjectProperty.Name, title); } catch (_) {}
    try { await this.mtp.setObjectPropString(handle, ObjectProperty.Genre, 'Podcast'); } catch (_) {}
    if (feedUrl) {
      try { await this.mtp.setObjectPropString(handle, ObjectProperty.URLSource, feedUrl); } catch (_) {}
    }
    if (subscriptionId) {
      try { await this.mtp.setObjectPropString(handle, ObjectProperty.MediaGUID, subscriptionId); } catch (_) {}
    }

    this._mediacastCache.set(title.toLowerCase(), handle);
    return handle;
  }
```

- [ ] **Step 4: Add `_findOrCreateFolder()` helper** (if not already present)

Check if a `_findOrCreateFolder()` method exists. If not, add:

```javascript
  async _findOrCreateFolder(folderName) {
    // ObjectFormat already imported at file top
    // Try to find existing folder
    try {
      const handles = await this.mtp.getObjectHandles(0xFFFFFFFF, ObjectFormat.Association, 0);
      if (handles) {
        for (const h of handles) {
          const info = await this.mtp.getObjectInfo(h);
          if (info && info.filename && info.filename.toLowerCase() === folderName.toLowerCase()) {
            return h;
          }
        }
      }
    } catch (_) {}

    // Create folder (same pattern as album/artist object creation)
    const { objectHandle: handle } = await this.mtp.sendObjectInfo(this.storageId, 0, {
      objectFormat: ObjectFormat.Association,
      compressedSize: 0,
      filename: folderName,
    });
    await this.mtp.sendObject(Buffer.alloc(0));
    return handle;
  }
```

- [ ] **Step 5: Commit**

```bash
git add src/main/zune/zune-manager.js
git commit -m "feat(sync): implement sendPodcastEpisodes with AbstractMediacast hierarchy"
```

---

### Task 10: Add Push IPC + Renderer Dispatch

**Files:**
- Modify: `src/main/main.js` (near zune IPC handlers)
- Modify: `src/main/preload.js` (near zune API methods)
- Modify: `src/assets/js/renderer.js` (`_pushToDevice()`)

- [ ] **Step 1: Add IPC handler for podcast push**

In `src/main/main.js`, add near the `zune-send-files` handler (around line 400):

```javascript
  ipcMain.handle('zune-send-podcast-episodes', async (event, episodes) => {
    try {
      const result = await zuneManager.sendPodcastEpisodes(episodes);
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
```

- [ ] **Step 2: Expose in preload.js**

In `src/main/preload.js`, add near the other zune API methods:

```javascript
    zuneSendPodcastEpisodes: async (episodes) => {
      const result = await ipcRenderer.invoke('zune-send-podcast-episodes', episodes);
      if (!result.success) throw new Error(result.error);
      return result;
    },
```

- [ ] **Step 3: Update `_pushToDevice()` to dispatch for podcasts**

In `renderer.js`, find `_pushToDevice()` (line 1791). Add a podcast branch at the top of the method, before the existing `_sendFiles()` call:

```javascript
    async _pushToDevice() {
      if (this.diffCategory === 'podcasts') {
        return this._pushPodcastsToDevice();
      }
      // ... existing music/video/picture push code unchanged ...
```

- [ ] **Step 4: Implement `_pushPodcastsToDevice()`**

Add after `_pushToDevice()`:

```javascript
    async _pushPodcastsToDevice() {
      const selected = this.diffResult.localOnly.filter(ep =>
        this.diffSelectedPaths.has(ep.localPath)
      );
      if (selected.length === 0) return;

      const pushBtn = document.getElementById('zune-push-btn');
      this.diffSelectedPaths.clear();
      pushBtn.disabled = true;
      pushBtn.textContent = 'sending...';

      try {
        const result = await window.electronAPI.zuneSendPodcastEpisodes(selected);

        // Update browse data with newly pushed episodes
        if (result.newDeviceEpisodes) {
          this.browseData.podcasts = [
            ...(this.browseData.podcasts || []),
            ...result.newDeviceEpisodes,
          ];
        }

        // Save updated cache (same pattern as _pushToDevice)
        if (this.deviceKey && this.browseData) {
          await window.electronAPI.zuneCacheSave(this.deviceKey, {
            model: this.cachedData?.model || this.lastStatus?.model || 'Zune',
            scanDurationMs: this.cachedData?.scanDurationMs || 0,
            counts: {
              music: this.browseData.music?.length || 0,
              videos: this.browseData.videos?.length || 0,
              pictures: this.browseData.pictures?.length || 0,
              podcasts: this.browseData.podcasts?.length || 0,
            },
            contents: this.browseData,
          });
        }

        // Recompute diff
        await this._computePodcastDiff();

        if (result.failed > 0) {
          pushBtn.textContent = `${result.sent} sent, ${result.failed} failed`;
          pushBtn.style.color = '#ff6900';
        } else {
          pushBtn.textContent = `${result.sent} episodes sent`;
        }
      } catch (err) {
        pushBtn.textContent = 'push failed';
        pushBtn.style.color = '#ff6900';
        if (typeof showToast === 'function') showToast(`Push failed: ${err.message}`);
      }
      pushBtn.disabled = false;
    }
```

- [ ] **Step 5: Commit**

```bash
git add src/main/main.js src/main/preload.js src/assets/js/renderer.js
git commit -m "feat(sync): wire up podcast push from renderer through IPC to device"
```

---

## Chunk 5: Pull Flow

### Task 11: Implement Podcast Pull

**Files:**
- Modify: `src/main/zune/zune-manager.js`
- Modify: `src/main/main.js`
- Modify: `src/main/preload.js`
- Modify: `src/main/podcast-manager.js`
- Modify: `src/assets/js/renderer.js`

- [ ] **Step 1: Add `pullPodcastEpisode()` to ZuneManager**

Add after `_findOrCreateFolder()` in `zune-manager.js`:

```javascript
  async pullPodcastEpisode(handle, filename, destDir, metadata) {
    // metadata: { title, seriesName, guid, timeBookmark, format }
    // path, fs, os already imported at file top

    // Download file from device (resolveHandle is public, no underscore)
    const realHandle = await this.resolveHandle(handle);
    const fileData = await this.mtp.getObject(realHandle);

    // Determine extension from filename, default to .mp3
    let ext = path.extname(filename || '').toLowerCase();
    if (!ext || ext === '.') ext = '.mp3';

    // Build filename
    const seriesClean = (metadata.seriesName || 'Podcast').replace(/[<>:"/\\|?*]/g, '_');
    const titleClean = (metadata.title || 'Episode').replace(/[<>:"/\\|?*]/g, '_');
    let outName = `${seriesClean} - ${titleClean}${ext}`;
    let outPath = path.join(destDir, outName);

    // Handle collisions
    try {
      await fs.access(outPath);
      // File exists, append date
      const date = new Date().toISOString().split('T')[0];
      outName = `${seriesClean} - ${titleClean} (${date})${ext}`;
      outPath = path.join(destDir, outName);
    } catch (_) { /* file doesn't exist, proceed */ }

    // Save raw file to temp location first (same pattern as zune-pull-file handler)
    const tempRaw = path.join(os.tmpdir(), `zune-pull-${Date.now()}-${titleClean}${ext}`);
    await fs.writeFile(tempRaw, fileData);

    try {
      if (ext === '.wma' || ext === '.asf') {
        // WMA → MP3 conversion via _convertForZune
        const mp3Path = await this._convertForZune(tempRaw);
        outPath = outPath.replace(/\.(wma|asf)$/i, '.mp3');
        outName = outName.replace(/\.(wma|asf)$/i, '.mp3');
        await fs.rename(mp3Path, outPath).catch(async () => {
          await fs.copyFile(mp3Path, outPath);
          await fs.unlink(mp3Path).catch(() => {});
        });
      } else {
        // MP3/AAC — move to destination
        await fs.rename(tempRaw, outPath).catch(async () => {
          await fs.copyFile(tempRaw, outPath);
        });
      }
    } finally {
      fs.unlink(tempRaw).catch(() => {});
    }

    return { localPath: outPath, filename: outName };
  }
```

- [ ] **Step 2: Add `addPulledEpisode()` to PodcastManager**

In `src/main/podcast-manager.js`, add after `getAllDownloaded()`:

```javascript
  addPulledEpisode(seriesName, feedUrl, episode) {
    // episode: { id, title, localPath, duration, publishDate, playbackPosition }
    // Find existing subscription by series name or feed URL
    let sub = this._subscriptions.find(s =>
      s.title.toLowerCase() === seriesName.toLowerCase() ||
      (feedUrl && s.feedUrl && s.feedUrl === feedUrl)
    );

    if (!sub) {
      // Create stub subscription (crypto already imported at file top)
      sub = {
        id: crypto.randomUUID(),
        feedUrl: feedUrl || null,
        title: seriesName,
        author: '',
        description: `Imported from Zune device`,
        artworkUrl: null,
        artworkPath: null,
        category: 'audio',
        episodeCount: 0,
        newEpisodeCount: 0,
        lastRefreshed: null,
        subscribedAt: new Date().toISOString(),
        error: null,
      };
      this._subscriptions.push(sub);
    }

    // Load existing episodes
    const episodes = this._loadEpisodes(sub.id);

    // Check for duplicate
    const exists = episodes.find(e => e.id === episode.id ||
      (e.title && episode.title && e.title.toLowerCase() === episode.title.toLowerCase()));
    if (exists) {
      // Update existing with new local path
      exists.downloaded = true;
      exists.localPath = episode.localPath;
      if (episode.playbackPosition > (exists.playbackPosition || 0)) {
        exists.playbackPosition = episode.playbackPosition;
      }
    } else {
      episodes.unshift({
        id: episode.id || crypto.randomUUID(),
        title: episode.title,
        description: '',
        publishDate: episode.publishDate || null,
        duration: episode.duration || 0,
        enclosureUrl: null,
        enclosureType: 'audio/mpeg',
        enclosureSize: 0,
        played: false,
        playbackPosition: episode.playbackPosition || 0,
        downloaded: true,
        localPath: episode.localPath,
      });
      sub.episodeCount = episodes.length;
      sub.newEpisodeCount++;
    }

    this._saveEpisodes(sub.id, episodes);
    this._saveSubscriptions();
    return sub.id;
  }
```

- [ ] **Step 3: Add pull IPC handlers**

In `src/main/main.js`, add:

```javascript
  ipcMain.handle('zune-pull-podcast-episode', async (event, handle, filename, destDir, metadata) => {
    try {
      const result = await zuneManager.pullPodcastEpisode(handle, filename, destDir, metadata);
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('podcast-add-pulled-episode', async (event, seriesName, feedUrl, episode) => {
    try {
      const subscriptionId = podcastManager.addPulledEpisode(seriesName, feedUrl, episode);
      return { success: true, subscriptionId };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
```

- [ ] **Step 4: Expose in preload.js**

```javascript
    zunePullPodcastEpisode: async (handle, filename, destDir, metadata) => {
      const result = await ipcRenderer.invoke('zune-pull-podcast-episode', handle, filename, destDir, metadata);
      if (!result.success) throw new Error(result.error);
      return result;
    },
    podcastAddPulledEpisode: async (seriesName, feedUrl, episode) => {
      const result = await ipcRenderer.invoke('podcast-add-pulled-episode', seriesName, feedUrl, episode);
      if (!result.success) throw new Error(result.error);
      return result;
    },
```

- [ ] **Step 5: Update `_pullFromDevice()` in renderer.js**

Add podcast dispatch at the top of `_pullFromDevice()` (line 1848):

```javascript
    async _pullFromDevice() {
      if (this.diffCategory === 'podcasts') {
        return this._pullPodcastsFromDevice();
      }
      // ... existing pull code unchanged ...
```

- [ ] **Step 6: Implement `_pullPodcastsFromDevice()`**

Add after `_pullFromDevice()`:

```javascript
    async _pullPodcastsFromDevice() {
      const selected = this.diffResult.deviceOnly.filter(ep =>
        this.diffSelectedHandles.has(ep.handle)
      );
      if (selected.length === 0) return;

      // Get download directory from podcast preferences
      let prefs;
      try {
        prefs = await window.electronAPI.podcastGetPreferences();
      } catch (_) {}
      let destDir = prefs?.downloadDirectory;
      if (!destDir) {
        destDir = await window.electronAPI.podcastPickDownloadDirectory();
        if (!destDir) return; // User cancelled
      }

      const pullBtn = document.getElementById('zune-pull-btn');
      this.diffSelectedHandles.clear();
      pullBtn.disabled = true;

      let pulled = 0;
      let failedCount = 0;
      const failedFiles = [];

      const BATCH_SIZE = 8;
      const MAX_RETRIES = 3;

      for (let batchStart = 0; batchStart < selected.length; batchStart += BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE, selected.length);

        for (let i = batchStart; i < batchEnd; i++) {
          const ep = selected[i];
          let fileSuccess = false;

          for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
              const result = await window.electronAPI.zunePullPodcastEpisode(
                ep.handle, ep.filename, destDir,
                { title: ep.title, seriesName: ep.seriesName, guid: ep.guid, timeBookmark: ep.timeBookmark, format: ep.format }
              );

              // Register in podcast system
              await window.electronAPI.podcastAddPulledEpisode(
                ep.seriesName,
                null, // feedUrl unknown from device
                {
                  id: ep.guid || null,
                  title: ep.title,
                  localPath: result.localPath,
                  duration: (ep.duration || 0) / 1000, // device ms → local seconds
                  publishDate: ep.releaseDate,
                  playbackPosition: (ep.timeBookmark || 0) / 1000,
                }
              );

              pulled++;
              fileSuccess = true;
              break;
            } catch (err) {
              console.log(`Pull "${ep.title}" attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
              if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 500));
            }
          }

          if (!fileSuccess) {
            failedCount++;
            failedFiles.push(ep.title);
          }

          pullBtn.textContent = `copying ${pulled + failedCount} of ${selected.length} — ${ep.title}`;
        }

        // Yield between batches
        await new Promise(r => setTimeout(r, 0));
      }

      if (failedCount > 0) {
        pullBtn.textContent = `${pulled} copied, ${failedCount} failed`;
        pullBtn.style.color = '#ff6900';
      } else {
        pullBtn.textContent = `${pulled} episodes copied`;
        pullBtn.style.color = '';
      }
      pullBtn.disabled = false;

      // Recompute diff
      await this._computePodcastDiff();
    }
```

- [ ] **Step 7: Commit**

```bash
git add src/main/zune/zune-manager.js src/main/main.js src/main/preload.js src/main/podcast-manager.js src/assets/js/renderer.js
git commit -m "feat(sync): implement podcast pull from device with subscription integration"
```

---

## Chunk 6: Position Sync & Polish

### Task 12: Implement Playback Position Sync

**Files:**
- Modify: `src/assets/js/renderer.js` (`_syncPodcastPositions()`)
- Modify: `src/main/main.js`
- Modify: `src/main/preload.js`
- Modify: `src/main/podcast-manager.js`

- [ ] **Step 1: Add `updateEpisodePosition()` to PodcastManager**

In `src/main/podcast-manager.js`, add after `addPulledEpisode()`:

```javascript
  updateEpisodePosition(subscriptionId, episodeId, positionSeconds, markPlayed) {
    const episodes = this._loadEpisodes(subscriptionId);
    const ep = episodes.find(e => e.id === episodeId);
    if (!ep) return false;

    ep.playbackPosition = positionSeconds;
    if (markPlayed && !ep.played) {
      ep.played = true;
      const sub = this.subscriptions.find(s => s.id === subscriptionId);
      if (sub && sub.newEpisodeCount > 0) sub.newEpisodeCount--;
      this._saveSubscriptions();
    }
    this._saveEpisodes(subscriptionId, episodes);
    return true;
  }
```

- [ ] **Step 2: Add position sync IPC handlers**

In `src/main/main.js`:

```javascript
  ipcMain.handle('podcast-update-position-from-sync', async (event, subscriptionId, episodeId, positionSeconds, markPlayed) => {
    try {
      podcastManager.updateEpisodePosition(subscriptionId, episodeId, positionSeconds, markPlayed);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('zune-set-time-bookmark', async (event, handle, positionMs) => {
    try {
      const { ObjectProperty } = require('./zune/mtp-constants');
      await zuneManager.mtp.setObjectPropUint32(handle, ObjectProperty.TimeBookmark, positionMs);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
```

- [ ] **Step 3: Expose in preload.js**

```javascript
    podcastUpdatePositionFromSync: async (subscriptionId, episodeId, positionSeconds, markPlayed) => {
      const result = await ipcRenderer.invoke('podcast-update-position-from-sync', subscriptionId, episodeId, positionSeconds, markPlayed);
      if (!result.success) throw new Error(result.error);
    },
    zuneSetTimeBookmark: async (handle, positionMs) => {
      const result = await ipcRenderer.invoke('zune-set-time-bookmark', handle, positionMs);
      if (!result.success) throw new Error(result.error);
    },
```

- [ ] **Step 4: Implement `_syncPodcastPositions()`**

Replace the stub in `renderer.js`:

```javascript
    async _syncPodcastPositions(matched) {
      const positionWrites = [];

      for (const pair of matched) {
        const { local, device } = pair;
        const devicePositionMs = device.timeBookmark || 0;
        const localPositionMs = Math.round((local.playbackPosition || 0) * 1000);
        // local.duration is in seconds, device.duration is already in ms (MTP convention)
        const durationMs = local.duration ? local.duration * 1000 : (device.duration || 0);

        if (devicePositionMs === localPositionMs) continue;

        if (devicePositionMs > localPositionMs) {
          // Device is further ahead — update local
          const newPositionSec = devicePositionMs / 1000;
          const markPlayed = durationMs > 0 && devicePositionMs >= durationMs * 0.95;
          try {
            await window.electronAPI.podcastUpdatePositionFromSync(
              local.subscriptionId, local.episodeId, newPositionSec, markPlayed
            );
            local.playbackPosition = newPositionSec;
            pair.positionSync = 'from-device';
          } catch (err) {
            console.warn(`Failed to sync position for "${local.title}":`, err);
          }
        } else {
          // Local is further ahead — queue device update
          const markPlayed = durationMs > 0 && localPositionMs >= durationMs * 0.95;
          positionWrites.push({
            handle: device.handle,
            positionMs: localPositionMs,
            title: local.title,
            markPlayed,
          });
          pair.positionSync = 'to-device';
        }
      }

      // Flush position writes to device
      for (const write of positionWrites) {
        try {
          await window.electronAPI.zuneSetTimeBookmark(write.handle, write.positionMs);
        } catch (err) {
          console.warn(`Failed to write position for "${write.title}" to device:`, err);
        }
      }
    }
```

- [ ] **Step 5: Commit**

```bash
git add src/main/podcast-manager.js src/main/main.js src/main/preload.js src/assets/js/renderer.js
git commit -m "feat(sync): implement bidirectional podcast playback position sync"
```

---

### Task 13: Handle Podcast Delete from Device

**Files:**
- Modify: `src/assets/js/renderer.js` (`_deleteFromDevice()`)

- [ ] **Step 1: Add podcast dispatch to `_deleteFromDevice()`**

The category list update in Task 7 already ensures `browseData.podcasts` is filtered on delete. But `_deleteFromDevice()` also needs to handle the case where podcast episodes are selected. The existing delete logic (sending handles to `zuneDeleteObjects`) is format-agnostic — it works for any MTP handle. So no special podcast dispatch is needed.

However, if deleting all episodes from a series, we should also delete the orphaned AbstractMediacast container. Add this cleanup after the main delete loop in `_deleteFromDevice()`:

Find the section after the delete loop completes and cache is updated. Add:

```javascript
      // Clean up orphaned podcast series containers
      if (this.diffCategory === 'podcasts') {
        const remainingEpisodes = this.browseData.podcasts || [];
        const seriesWithEpisodes = new Set(remainingEpisodes.map(e => e.seriesHandle));
        const orphanedSeries = [];
        // Check all known series handles
        for (const ep of deletedPodcastItems) {
          if (ep.seriesHandle && !seriesWithEpisodes.has(ep.seriesHandle)) {
            if (!orphanedSeries.includes(ep.seriesHandle)) {
              orphanedSeries.push(ep.seriesHandle);
            }
          }
        }
        if (orphanedSeries.length > 0) {
          try {
            await window.electronAPI.zuneDeleteObjects(orphanedSeries);
          } catch (err) {
            console.warn('Failed to clean up orphaned podcast series:', err.message);
          }
        }
      }
```

**Important:** `deletedItems` must be captured BEFORE `this.diffSelectedHandles.clear()` at line 1985. Insert this capture at line 1983 (after the confirm timer cleanup, before the clear):

```javascript
      // Capture podcast items for orphan cleanup before handles are cleared
      const deletedPodcastItems = this.diffCategory === 'podcasts'
        ? this.diffResult.deviceOnly.filter(ep => this.diffSelectedHandles.has(ep.handle))
        : [];
```

Then use `deletedPodcastItems` instead of `deletedItems` in the orphan cleanup block below.

- [ ] **Step 2: Commit**

```bash
git add src/assets/js/renderer.js
git commit -m "feat(sync): clean up orphaned podcast series containers on episode delete"
```

---

### Task 14: Clear Mediacast Cache on Disconnect

**Files:**
- Modify: `src/main/zune/zune-manager.js`

- [ ] **Step 1: Clear `_mediacastCache` on device disconnect**

In `disconnect()` at line 128 of `zune-manager.js`, after `this.storageInfo = null;` (line 141), add:

```javascript
    this._mediacastCache = null;
```

This ensures a fresh scan of existing series containers on next connection.

- [ ] **Step 2: Commit**

```bash
git add src/main/zune/zune-manager.js
git commit -m "fix(sync): clear podcast series cache on device disconnect"
```

---

### Task 15: End-to-End Verification

- [ ] **Step 1: Verify push flow**

1. Run `npm run dev`
2. Subscribe to a podcast, download 2-3 episodes
3. Connect Zune HD
4. Open sync panel, click PODCASTS tab
5. Verify downloaded episodes appear in "local only"
6. Select episodes, click push
7. Verify episodes transfer with progress
8. Verify episodes appear on Zune in podcast section

- [ ] **Step 2: Verify pull flow**

1. With podcasts on the Zune (from step 1 or pre-existing)
2. Click PODCASTS tab in diff view
3. Verify device episodes appear in "device only"
4. Select episodes, click pull
5. Verify episodes download to podcast directory
6. Verify episodes appear in podcast subscriptions list

- [ ] **Step 3: Verify position sync**

1. Play a podcast episode locally, stop partway through
2. Connect Zune, open PODCASTS diff tab
3. Push the episode
4. On the Zune, listen further into the episode
5. Reconnect, open PODCASTS diff tab
6. Verify local position updates to match device's further position

- [ ] **Step 4: Verify delete flow**

1. With podcast episodes on device
2. Select episodes in "device only"
3. Click delete, confirm
4. Verify episodes removed from device
5. Verify orphaned series containers cleaned up

- [ ] **Step 5: Commit any fixes discovered during verification**
