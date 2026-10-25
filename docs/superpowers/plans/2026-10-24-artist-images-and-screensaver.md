# Artist Images & Screensaver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opt-in artist photos (fanart.tv → Deezer) as the full-page backdrop of artist and album pages, plus a Zune HD-style screensaver that scrolls the current track's text and cover across that photo.

**Architecture:** Network fetching and the on-disk cache live in a new main-process module (`artist-images.js`) behind IPC that refuses to touch the network unless `artistImages.enabled` is on. All decision logic that can be pure is in small `src/shared/` modules tested with `node --test`: name matching, the screensaver motion/collision model, and the idle timer. The renderer gets a backdrop helper on `ZuneExplorer` and a new `Screensaver` class (`src/assets/js/screensaver.js`) that drives DOM rows with the Web Animations API, using the shared motion model to choose when and from where the next set enters.

**Tech Stack:** Electron 45, vanilla JS (no bundler; renderer scripts are `<script>` tags), Node `https`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-24-artist-images-and-screensaver-design.md`

## Global Constraints

- Artist images are **off by default** (`artistImages.enabled: false`). With it off: zero artist-image network requests, pages render exactly as today.
- Sources: fanart.tv `https://webservice.fanart.tv/v3/music/{mbid}?api_key=…` (prefer `artistbackground`, else `artistthumb`), then Deezer `https://api.deezer.com/search/artist?q=…` → `picture_xl`.
- MBID lookup goes through `src/main/musicbrainz.js`'s existing 1 req/s queue and `USER_AGENT` (`ZuneExplorer/1.5.1 …`, must match `package.json` version).
- Better no photo than the wrong person: only accept exact matches after normalising.
- The fanart.tv key is never committed. Release CI writes it from the `FANART_API_KEY` secret; local builds without a key use Deezer only, silently.
- Photos keep their original colours (no `filter: grayscale`); darken with gradients/overlays only.
- Screensaver: 4 directions `0` (horizontal), `90` (vertical), `-45` (↗), `45` (↘), never the same twice in a row; each set 35–50 s; every row scrolls once; **no fades**; rows of different sets never visibly cross; the next set enters from edges the old set has vacated; an empty screen only as a last resort.
- Auto-start: audio playing + no input to the app window for `screensaver.idleMinutes` (default 2; choices 1, 2, 5, 10) + `screensaver.autoStart` (default true) + window not hidden/minimized. Unfocused windows still auto-start.
- Exit on mouse movement over the window, click, wheel, or key press; that input must not reach the page underneath. Playback is unaffected.
- Settings strings are lowercase, matching the existing settings view.
- Watch out: `.music-artist-detail` is defined twice in `styles.css` (artist list row subtitle at ~2861 and artist page at ~3053). Add new artist-page rules under a new class (`.has-artist-photo`), don't edit those.

## Review Focus

1. **Offline / network error during a lookup** → must not record a "not found" miss (or the artist never gets a photo once online). Pinned in Task 4 (`find: network error is not cached as a miss`).
2. **Same artist requested twice at once** (artist page + screensaver, or quick back/forward) → one fetch, both callers get the same result. Pinned in Task 4 (`find: concurrent calls share one fetch`).
3. **Photo arrives after the user has navigated to a different artist/page** → must not paint onto the wrong page. Pinned in Task 6 step (stale-token check) and its manual check.
4. **Artist names with diacritics, "&" vs "and", leading "The", or "feat." credits** → match the same artist, but never a different one. Pinned in Task 2 tests.
5. **The window is minimized or covered while the screensaver runs** → animation and the next-set scheduler pause together, so on return no set has been "skipped" into a collision. Pinned in Task 9 (manual check) and Task 7 (`isClear` uses each row's own elapsed time, not wall clock).

---

### Task 1: Preference defaults

**Files:**
- Modify: `src/main/preferences.js` (`defaultPrefs`)
- Test: `tests/preferences.test.js`

**Interfaces:**
- Produces: `preferences.get('artistImages.enabled') -> boolean` (default `false`); `preferences.get('screensaver.autoStart') -> boolean` (default `true`); `preferences.get('screensaver.idleMinutes') -> number` (default `2`).

- [ ] **Step 1: Write the failing tests**

```js
test('defaults: artistImages off, screensaver on at 2 minutes', async () => {
  const prefs = freshModule();
  const store = await prefs.load(tmpDir, { defaultHome: '/Users/test' });
  assert.equal(store.artistImages.enabled, false);
  assert.equal(store.screensaver.autoStart, true);
  assert.equal(store.screensaver.idleMinutes, 2);
});

test('defaults: existing file without new sections gets them merged', async () => {
  await fs.writeFile(path.join(tmpDir, 'preferences.json'), JSON.stringify({ version: 1, library: { music: ['/a'] } }));
  const prefs = freshModule();
  const store = await prefs.load(tmpDir, { defaultHome: '/Users/test' });
  assert.equal(store.artistImages.enabled, false);
  assert.equal(store.screensaver.idleMinutes, 2);
});
```

- [ ] **Step 2: Run** `npm test` — Expected: the two new tests FAIL (`Cannot read properties of undefined`).
- [ ] **Step 3: Add** `artistImages: { enabled: false }` and `screensaver: { autoStart: true, idleMinutes: 2 }` to `defaultPrefs`. No schema version bump (deepMergeDefaults fills them in).
- [ ] **Step 4: Run** `npm test` — Expected: all PASS.
- [ ] **Step 5: Commit** `feat(prefs): add artistImages and screensaver defaults`

---

### Task 2: Artist name matching

**Files:**
- Create: `src/shared/artist-name.js` (same dual export pattern as `src/shared/path-utils.js`: `module.exports` + `window.artistName`)
- Test: `tests/artist-name.test.js`

**Interfaces:**
- Produces: `normalizeArtistName(name: string) -> string`; `artistNamesMatch(a: string, b: string) -> boolean`; `primaryArtist(name: string) -> string`.

Normalising: Unicode NFKD and strip combining marks; lowercase; `&`/`+` → `and`; drop a leading `the `; remove everything that isn't a letter, digit or space; collapse whitespace; trim. `artistNamesMatch` is equality of normalised, non-empty names. `primaryArtist` cuts at the first ` feat. `, ` feat `, ` ft. `, ` featuring `, ` with ` (case-insensitive) and trims.

- [ ] **Step 1: Write the failing tests**

```js
test('normalize: case, diacritics, ampersand, leading the', () => {
  assert.equal(normalizeArtistName('Beyoncé'), 'beyonce');
  assert.equal(normalizeArtistName('Tom Petty & The Heartbreakers'), 'tom petty and the heartbreakers');
  assert.equal(normalizeArtistName('The Beatles'), 'beatles');
  assert.equal(normalizeArtistName('  AC/DC  '), 'acdc');
});
test('match: equivalent spellings match', () => {
  assert.equal(artistNamesMatch('Tom Petty and the Heartbreakers', 'Tom Petty & The Heartbreakers'), true);
  assert.equal(artistNamesMatch('Sigur Rós', 'Sigur Ros'), true);
});
test('match: different artists never match', () => {
  assert.equal(artistNamesMatch('Tom Petty', 'Tom Petty & The Heartbreakers'), false);
  assert.equal(artistNamesMatch('Prince', 'Princess'), false);
  assert.equal(artistNamesMatch('', ''), false);
});
test('primaryArtist: strips featured credits', () => {
  assert.equal(primaryArtist('Calvin Harris feat. Rihanna'), 'Calvin Harris');
  assert.equal(primaryArtist('Santana Featuring Rob Thomas'), 'Santana');
  assert.equal(primaryArtist('Simon & Garfunkel'), 'Simon & Garfunkel');
});
```

- [ ] **Step 2: Run** `npm test` — Expected: FAIL (`Cannot find module '../src/shared/artist-name'`).
- [ ] **Step 3: Implement** the three functions.
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: artist name normalisation and matching`

---

### Task 3: fanart.tv key plumbing (build-time injection)

**Files:**
- Create: `src/main/app-config.js`, `scripts/write-build-config.js`
- Modify: `.gitignore` (add `src/main/build-config.json`), `.github/workflows/release.yml` (one step in each of the three build jobs, after `npm ci`)
- Test: `tests/app-config.test.js`

**Interfaces:**
- Produces: `getFanartApiKey({ env = process.env, readBuildConfig } = {}) -> string | null` — returns `env.FANART_API_KEY` if non-empty, else `fanartApiKey` from `src/main/build-config.json` if present and non-empty, else `null`. `readBuildConfig` defaults to a function that `require`s `./build-config.json` inside try/catch and returns `{}` on failure.
- `scripts/write-build-config.js`: writes `src/main/build-config.json` as `{ "fanartApiKey": process.env.FANART_API_KEY || "" }`; prints `build-config: fanart key present` or `build-config: no fanart key (Deezer only)` — never the key.

- [ ] **Step 1: Write the failing tests**

```js
test('env var wins', () => {
  assert.equal(getFanartApiKey({ env: { FANART_API_KEY: 'abc' }, readBuildConfig: () => ({ fanartApiKey: 'zzz' }) }), 'abc');
});
test('falls back to build config', () => {
  assert.equal(getFanartApiKey({ env: {}, readBuildConfig: () => ({ fanartApiKey: 'zzz' }) }), 'zzz');
});
test('no key anywhere -> null', () => {
  assert.equal(getFanartApiKey({ env: {}, readBuildConfig: () => ({}) }), null);
  assert.equal(getFanartApiKey({ env: { FANART_API_KEY: '' }, readBuildConfig: () => ({ fanartApiKey: '' }) }), null);
});
```

- [ ] **Step 2: Run** `npm test` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `app-config.js` and the script.
- [ ] **Step 4: Add the CI step** to `build-mac`, `build-win`, `build-linux`, right after `Install dependencies`:

```yaml
      - name: Write build config
        run: node scripts/write-build-config.js
        env:
          FANART_API_KEY: ${{ secrets.FANART_API_KEY }}
```

- [ ] **Step 5: Run** `npm test` and `node scripts/write-build-config.js && git status --short src/main` — Expected: tests PASS; the script prints `no fanart key (Deezer only)`; `build-config.json` does **not** appear in git status (ignored). Delete the local file afterwards.
- [ ] **Step 6: Commit** `build: inject fanart.tv key at release build time`

---

### Task 4: Artist image sources and cache

**Files:**
- Modify: `src/main/musicbrainz.js` (add and export `searchArtists`; also export `fetchUnlimited` and add `fetchJsonUnlimited(url)` = `fetchUnlimited` + JSON parse, same User-Agent)
- Create: `src/main/artist-images.js`
- Test: `tests/artist-images.test.js`

**Interfaces:**
- Consumes: `normalizeArtistName`, `artistNamesMatch`, `primaryArtist` (Task 2); `getFanartApiKey` (Task 3).
- Produces (musicbrainz): `searchArtists(name: string) -> Promise<Array<{ mbid: string, name: string, score: number }>>` using `https://musicbrainz.org/ws/2/artist/?query=artist:"<name>"&limit=5&fmt=json` via `rateLimitedFetch`.
- Produces (artist-images):
  - `class ArtistImages { constructor(userDataPath, { searchArtists, fetchJson, fetchBinary, getApiKey, now = Date.now }) }` — all network functions injected so tests use fakes. Production wiring passes `musicbrainz.searchArtists`, `musicbrainz.fetchJsonUnlimited`, `musicbrainz.fetchUnlimited`, `getFanartApiKey`.
  - `get(name) -> Promise<ImageResult | null>` — cache only, never network.
  - `find(name) -> Promise<ImageResult | null>` — cache, else network lookup.
  - `next(name) -> Promise<ImageResult | null>` — switches to the next candidate (wraps around), downloads it if needed.
  - `remove(name) -> Promise<void>` — marks removed; `get`/`find` return `null` with no network until `restore`.
  - `restore(name) -> Promise<ImageResult | null>` — clears removed, then behaves like `find`.
  - `clear() -> Promise<void>` — deletes `artist-images/` contents and the index.
  - `ImageResult = { url: string /* file:// URL with ?v=<fetchedAt> */, source: 'fanart' | 'deezer', candidateCount: number }`
- Storage: `<userData>/artist-images/index.json` keyed by `normalizeArtistName(primaryArtist(name))` →
  `{ file, source, mbid, fetchedAt, candidates: [{ source, url }], index }` or `{ miss: true, checkedAt }` or `{ removed: true, ... }` (removed keeps the other fields). Image filename: `sha1(key)-<index>.<jpg|png|webp>` from the response `content-type`. Never use the artist name in a path.

Lookup order inside `find`: (1) if `getApiKey()` is non-null: `searchArtists(primary)` → first result with `score >= 90` and `artistNamesMatch`; then `fetchJson(fanart url)` → candidates from `artistbackground` then `artistthumb`, each sorted by `likes` descending (fanart returns 404 for an unknown MBID: treat as no candidates, not an error). (2) Always append Deezer candidates: `fetchJson(deezer url)` → `data` entries whose `name` matches, mapped to `picture_xl`. (3) If no candidates → store a miss. Download candidate 0 with `fetchBinary`.

Misses are retried after 14 days (my call). A thrown network/HTTP error (other than fanart 404) aborts the lookup with **no** index change and resolves `null`. Concurrent `find`/`next` calls for the same key share one in-flight promise.

- [ ] **Step 1: Write the failing tests** (fakes record calls; `tmpDir` per test like `preferences.test.js`)

```js
test('find: fanart background preferred, saved, then served from cache', async () => {
  // fakes: searchArtists -> [{mbid:'m1', name:'Tom Petty & The Heartbreakers', score:100}]
  // fetchJson(fanart) -> { artistbackground:[{url:'https://f/b1.jpg',likes:'2'},{url:'https://f/b2.jpg',likes:'9'}], artistthumb:[{url:'https://f/t.jpg',likes:'1'}] }
  // fetchJson(deezer) -> { data:[{name:'Tom Petty and the Heartbreakers', picture_xl:'https://d/x.jpg'}] }
  const r = await store.find('Tom Petty & The Heartbreakers');
  assert.equal(r.source, 'fanart');
  assert.equal(r.candidateCount, 4);
  assert.deepEqual(downloaded, ['https://f/b2.jpg']);           // most liked background first
  assert.match(r.url, /^file:\/\/.+\?v=\d+$/);
  const again = await store.find('tom petty and the heartbreakers');
  assert.equal(again.url, r.url);
  assert.equal(networkCalls(), 3);                              // no new calls
});
test('find: no api key -> Deezer only, no MusicBrainz call', async () => { /* getApiKey: () => null */ assert.equal(r.source, 'deezer'); assert.equal(searchCalls, 0); });
test('find: wrong-name results are rejected -> miss', async () => { /* MB returns "Tom Petty", Deezer returns "Tom Petty" for "Tom Petty & The Heartbreakers" */ assert.equal(r, null); assert.equal(index[key].miss, true); });
test('find: MusicBrainz score below 90 is ignored', async () => { /* score 80 -> no fanart call */ });
test('find: fanart 404 falls through to Deezer', async () => { /* fetchJson(fanart) rejects with Error('HTTP 404: ...') */ assert.equal(r.source, 'deezer'); });
test('find: network error is not cached as a miss', async () => { /* fetchJson(deezer) rejects ECONNRESET */ assert.equal(r, null); assert.equal(index[key], undefined); });
test('find: miss is not re-queried within 14 days, is after', async () => { /* now = t0 + 13d -> 0 calls; now = t0 + 15d -> calls */ });
test('find: concurrent calls share one fetch', async () => { const [a, b] = await Promise.all([store.find('X'), store.find('x')]); assert.equal(a.url, b.url); assert.equal(downloadCalls, 1); });
test('next: cycles candidates and wraps', async () => { /* 2 candidates: next -> index 1, next -> index 0 */ });
test('remove/restore: removed returns null without network; restore brings it back', async () => {});
test('get: never touches the network', async () => { assert.equal(await store.get('Unknown'), null); assert.equal(networkCalls(), 0); });
test('clear: empties the directory and index', async () => {});
test('primary artist used for lookup', async () => { await store.find('Calvin Harris feat. Rihanna'); assert.equal(searchedFor, 'Calvin Harris'); });
```

- [ ] **Step 2: Run** `npm test` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `searchArtists`, `fetchJsonUnlimited` (export `fetchUnlimited` too) and `ArtistImages`. Write the index atomically (tmp + rename, like `preferences.writeNow`).
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: artist image lookup (fanart.tv, Deezer) with disk cache`

---

### Task 5: IPC, preload and settings

**Files:**
- Modify: `src/main/main.js` (construct `artistImages` next to `metadataCache` at ~99; IPC handlers next to `metadata-*` at ~940; `clear-artist-images` next to `clear-metadata-cache`)
- Modify: `src/main/preload.js`, `src/assets/js/settings-view.js`

**Interfaces:**
- Consumes: `ArtistImages` (Task 4), `preferences.get('artistImages.enabled')`.
- Produces (renderer `window.electronAPI`):
  - `artistImageGet(name) -> Promise<ImageResult | null>` (cache only)
  - `artistImageFind(name)`, `artistImageNext(name)`, `artistImageRemove(name)`, `artistImageRestore(name)` → same shapes as Task 4; every handler returns `null` / no-op when `artistImages.enabled` is false. The guard lives in main so no renderer path can cause a download while off.
  - `clearArtistImages() -> Promise<{ success: boolean }>`
- Settings (all lowercase):
  - library page: toggle `download artist images` bound to `artistImages.enabled`; below it an `info` row `artist images` / `from fanart.tv and deezer, saved on this computer`.
  - root: new nav `screensaver` between `podcasts` and `data` with: toggle `start automatically` (`screensaver.autoStart`); nav `start after` whose value page lists `1 minute`, `2 minutes`, `5 minutes`, `10 minutes` as `action` rows, the current one prefixed `• `, clicking sets `screensaver.idleMinutes` and pops.
  - data page: action `clear artist images` with the same confirm + toast pattern as `clear metadata cache`.
  - about page: info `artist images` / `fanart.tv · deezer`.

- [ ] **Step 1: Implement** handlers, preload bridges and settings items. Handlers catch and log errors and resolve `null` (renderer never sees a rejection).
- [ ] **Step 2: Run** `npm test` — Expected: PASS (no regressions).
- [ ] **Step 3: Manual check** with `npm run dev`: Settings → library shows the toggle **off**; screensaver section shows `start automatically` on and `start after` 2 minutes; changing to 5 persists across restart (`preferences.json`). In DevTools: `await electronAPI.artistImageFind('Radiohead')` returns `null` while off and the Network/main log shows no request; toggle on → returns an `ImageResult`.
- [ ] **Step 4: Commit** `feat: artist image IPC and settings`

---

### Task 6: Artist and album page backdrops

**Files:**
- Modify: `src/assets/js/renderer.js` (`renderArtistDetail` ~5006, `renderAlbumDetail` ~4885, new helper methods near `resolveArtistKey`)
- Modify: `src/assets/css/styles.css` (new rules at the end of the Artist Detail / Album Detail blocks)
- Modify: `src/renderer/index.html` (add `<script src="../shared/artist-name.js"></script>` after `path-utils.js`)

**Interfaces:**
- Consumes: `electronAPI.artistImageFind/Next/Remove/Restore` (Task 5).
- Produces: `ZuneExplorer.attachArtistBackdrop(detailEl: HTMLElement, artistName: string, variant: 'artist' | 'album') -> void`; `ZuneExplorer.artistPhotoMenuItems(artistName: string) -> Array<{label, action}>`.

Behaviour:
- `attachArtistBackdrop` returns immediately if `this.preferences.artistImages?.enabled` is false. Otherwise it calls `artistImageFind(artistName)` without awaiting the render. When it resolves with a result **and** `detailEl.isConnected` (stale-page guard — the page was re-rendered or left), it prepends `<div class="artist-backdrop">` with `background-image: url(…)` and adds `has-artist-photo` + `artist-backdrop-<variant>` to `detailEl`.
- `.artist-backdrop`: `position: fixed; inset: 0; z-index: -1; background-size: cover; background-position: center top; pointer-events: none;` — `#content-panel` has a `transform`, so `fixed` is relative to the content panel and the photo stays put while the album grid scrolls. Gradient via `::after`: artist variant top→bottom `rgba(0,0,0,.25)` → `rgba(0,0,0,.85)`; album variant left→right `rgba(0,0,0,.85)` → `rgba(0,0,0,.35)`. Tune for readability; no colour filters.
- Artist page uses `artist.name`; album page uses `album.artist`.
- Right-click on the artist page header and on the album page header adds (via the existing `showDynamicContextMenu`/`showMusicItemContextMenu` extras) `artistPhotoMenuItems(name)`: `next artist photo` (only when `candidateCount > 1`), `remove artist photo`, or `use artist photo` if it was removed. Each action re-renders the current view (`this.renderMusicView()`). The menu items appear only when artist images are enabled. (This is the minimal "change photo" UI the spec allows; my call.)
- When the toggle changes to on/off while an artist/album page is open, re-render it (`_onPreferenceChanged` → if `evt.path === 'artistImages.enabled'` and `this.musicDrillDown?.type` is `artist`/`album`, `this.renderMusicView()`).

- [ ] **Step 1: Implement** the helpers, wire both detail renderers, CSS, script tag, preference re-render.
- [ ] **Step 2: Run** `npm test` — Expected: PASS.
- [ ] **Step 3: Manual check** (`npm run dev`, artist images on): open an artist → photo fills the panel behind the name and grid in colour, grid scrolls over a fixed photo; open one of its albums → same photo, cover and tracks readable; right-click → next/remove/use work; open an artist, immediately press back → no photo appears on the list page; toggle off → pages look exactly as before; artist with no match → page as today, no error.
- [ ] **Step 4: Commit** `feat: artist photo backdrops on artist and album pages`

---

### Task 7: Screensaver motion model (pure)

**Files:**
- Create: `src/shared/screensaver-motion.js` (dual export as `window.screensaverMotion`)
- Test: `tests/screensaver-motion.test.js`

**Interfaces:**
- Produces:
  - `ANGLES = [0, 90, -45, 45]`
  - `stackLanes(heights: number[], viewportH: number, rand: () => number, { solid = [] } = {}) -> number[]` — lane centre offsets (px, rotor-local y, relative to the stage centre) in input order. Gap after each row = `viewportH * lerp(-0.03, 0.06, rand())`, except gaps touching an index in `solid` (the cover row) are at least `viewportH * 0.02` so the cover never overlaps text; each row occupies `height * 0.9`; whole stack centred then shifted by `viewportH * lerp(-0.08, 0.08, rand())`.
  - `planRows({ rows, angle, viewport, setDuration }) -> PlannedRow[]` where `rows = [{ width, height, laneOffset, reverse, speedFactor, delay }]` and `PlannedRow = { ...row, angle, from, to, speed, duration }`. With `halfSpan = (w*|cos| + h*|sin|) / 2`: left-edge travel `from = halfSpan`, `to = -halfSpan - width` (swapped when `reverse`); `speed = |to-from| / (setDuration * speedFactor)`; `duration = |to-from| / speed`.
  - `rowRectAt(row: PlannedRow, t: number, viewport) -> { cx, cy, hw, hh, angle }` — `t` is seconds since the row's animation started (including `delay`; clamp active time to `[0, duration]`). Local centre `x = from + (to-from)*progress + width/2`, `y = laneOffset`; screen centre = viewport centre + `x·u + y·n`, `u = (cos, sin)`, `n = (-sin, cos)`.
  - `rectsOverlap(a, b) -> boolean` — separating-axis test for two oriented rectangles.
  - `isClear({ outgoing, incoming, viewport, step = 0.25 }) -> boolean` — `outgoing = [{ row: PlannedRow, elapsed: number }]` (elapsed from each row's own Animation `currentTime`), `incoming: PlannedRow[]` starting at t=0. Simulate τ from 0 until every outgoing row has finished, in `step` increments; return false if any outgoing/incoming pair overlaps while **both** rects also overlap the viewport rect.
  - `chooseNextAngle({ previous, buildIncoming, outgoing, viewport, rand }) -> number | null` — candidates `ANGLES` minus `previous`, shuffled with `rand`; returns the first whose `buildIncoming(angle)` passes `isClear`; if `outgoing` is empty returns the first candidate; else `null` (caller retries later).
  - `pickReversals(count: number, eligible: number[], rand) -> boolean[]` — with probability 0.4 exactly one index from `eligible` is reversed, otherwise none (my call: "occasionally", fewer than v4).

- [ ] **Step 1: Write the failing tests**

```js
const vp = { w: 1600, h: 1000 };
test('planRows: horizontal row enters right edge, exits left edge', () => {
  const [r] = planRows({ rows: [{ width: 400, height: 100, laneOffset: 0, reverse: false, speedFactor: 1, delay: 0 }], angle: 0, viewport: vp, setDuration: 40 });
  assert.equal(r.from, 800); assert.equal(r.to, -1200); assert.equal(r.duration, 40);
});
test('rowRectAt: off-screen right at t=0, centred mid-way, off-screen left at end', () => {
  assert.ok(rowRectAt(r, 0, vp).cx - 200 >= 1600);
  assert.equal(Math.round(rowRectAt(r, 20, vp).cx), 800);
  assert.ok(rowRectAt(r, 40, vp).cx + 200 <= 0);
});
test('rowRectAt: vertical (90) moves along screen y', () => { /* cx constant at 800, cy decreases over time */ });
test('rectsOverlap: crossing diagonals overlap; parallel separated lanes do not', () => {});
test('isClear: new horizontal set right behind a leaving horizontal set is clear', () => {});
test('isClear: vertical set entering while a horizontal giant row spans the screen is not clear', () => {});
test('isClear: overlap only off-screen is ignored', () => {});
test('isClear: uses each outgoing row\'s own elapsed time', () => { /* same rows, elapsed near end -> clear; elapsed early -> not */ });
test('chooseNextAngle: never returns previous angle', () => { for (let i = 0; i < 50; i++) assert.notEqual(chooseNextAngle({ previous: 0, buildIncoming, outgoing: [], viewport: vp, rand: Math.random }), 0); });
test('chooseNextAngle: null when every candidate collides', () => {});
test('stackLanes: preserves order and stays near centre', () => { /* offsets increasing; |mean| <= 0.08*h + max height */ });
test('stackLanes: solid lane never overlaps neighbours', () => { /* 200 runs with solid:[2]: lane 2 band [c-0.45h, c+0.45h] disjoint from lanes 1 and 3 */ });
test('pickReversals: at most one, only from eligible', () => { /* 200 runs */ });
```

- [ ] **Step 2: Run** `npm test` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the module.
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: screensaver motion and collision model`

---

### Task 8: Idle timer (pure)

**Files:**
- Create: `src/shared/idle-timer.js` (dual export as `window.IdleTimer`)
- Test: `tests/idle-timer.test.js`

**Interfaces:**
- Produces: `class IdleTimer { constructor({ timeoutMs, onIdle, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout }); poke(); setTimeoutMs(ms); stop(); }` — `poke` (re)arms a single timer; `onIdle` fires once per idle period (no re-arm until the next `poke`); `setTimeoutMs` re-arms with the new value; `stop` disarms until next `poke`.

- [ ] **Step 1: Write the failing tests** with a fake clock (`setTimeout`/`clearTimeout` fakes that store callbacks and an `advance(ms)` helper): fires after timeout; pokes postpone it; fires only once without a poke; `setTimeoutMs(5000)` applies on next arm; `stop` prevents firing.
- [ ] **Step 2: Run** `npm test` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: idle timer`

---

### Task 9: Screensaver view

**Files:**
- Create: `src/assets/js/screensaver.js` (`class Screensaver`, `window.Screensaver`)
- Modify: `src/assets/css/styles.css` (new `Screensaver` section at the end), `src/renderer/index.html` (script tags for `../shared/screensaver-motion.js`, `../shared/idle-timer.js`, `../assets/js/screensaver.js` before `renderer.js`)

**Interfaces:**
- Consumes: `screensaverMotion` (Task 7); `explorer.audioPlayer` (`currentMetadata`, `getCurrentFile()`, `audio.currentTime`, `formatTime`, events `trackchange`/`timeupdate`); `explorer.musicLibrary.tracks`; `electronAPI.artistImageFind` (Task 5).
- Produces: `new Screensaver(explorer, { onClose })`; `open()`; `close()`; `isOpen: boolean`.

Behaviour:
- **Track info** (`_currentInfo()`), read at the start of every set: `title`, `album`, `artist` from `currentMetadata`; `isPodcast = !!file.isPodcast`; `cover = metadata.albumArt || (file.artworkPath ? 'file://' + encoded path : null)`; photo artist = `musicLibrary.tracks.get(file.path)?.albumArtist || metadata.artist`, never for podcasts. Podcast rows: episode title in the title slot, show name in both album and artist slots.
- **Background**, resolved at each set start (instant swap, no transition): artist photo (`artistImageFind`, only when enabled and not a podcast) → cover scaled to cover and darkened → black. Light darkening overlay `rgba(0,0,0,.25)` over a photo, `.55` over an enlarged cover. Original colours.
- **Rows** per set, all upper-case, Segoe stack, `white-space: nowrap; line-height: .9`: giant album (size `.55`, weight 100, `rgba(255,255,255,.92)`); small title + **bold elapsed time** repeated 3× (`.06`, weight 300 / time 700); bold album (`.13`, 800); mid artist (`.10`, 300); giant artist (`.60`, 100); cover square (`.38`, `width:1em;height:1em;overflow:hidden`, `<img>` object-fit cover, or a dark square with the album title when no cover) inserted at a random index 1..5. Sizes are fractions of viewport height × jitter `0.85–1.2`. Reversal eligibility: small, bold-album and mid-artist rows (`pickReversals`). `speedFactor` per row `0.75–1.1`, `delay` `0–2.5 s`, set duration `35–50 s`.
- **Building a set**: create a rotor (`position:absolute; left:50%; top:50%; width/height = stage diagonal; transform: translate(-50%,-50%) rotate(angle)`) with `visibility:hidden`, append rows, measure `offsetWidth`/`offsetHeight` of each track, compute lanes (`stackLanes`) — these measurements are angle-independent, so one built set is re-planned per candidate angle via `planRows`. Launch: set the rotor angle, `visibility:visible`, `track.animate([{transform: translateX(from)}, {transform: translateX(to)}], { duration, delay, easing: 'linear', fill: 'both' })` (from/to converted from centre-relative to rotor-left coordinates by adding `diagonal/2`). Remove the rotor when all its animations finish.
- **Scheduling**: the first set launches immediately at a random angle. Starting at 50 % of the newest set's duration, every 500 ms build the next set (once; reuse until launched) and call `chooseNextAngle` with `outgoing` = every row of every live set and `elapsed = animation.currentTime / 1000`. Launch on a non-null angle. If all outgoing sets have finished, launch regardless (empty-screen fallback).
- **Clock**: subscribe to `timeupdate`; when `Math.floor(currentTime)` changes, update the `<b>` time spans of live small rows. Paused playback → no events → time frozen.
- **Hidden window**: on `visibilitychange` to hidden, `pause()` every live Animation and stop the scheduler interval; on visible, `play()` them and restart the scheduler.
- **Exit**: capture-phase listeners on `window` for `keydown`, `mousedown`, `wheel`, `touchstart`, and `mousemove` (ignored for the first 500 ms after open and until the pointer has moved > 4 px from its first observed position — Chromium sends synthetic moves when the overlay appears). Each calls `preventDefault()` + `stopPropagation()`, then `close()`. After closing, swallow `click`, `mouseup`, `keyup`, `contextmenu` in capture phase for 400 ms.
- **close()**: cancel all animations, clear intervals/listeners, remove the overlay, call `onClose()`. Nothing keeps running.
- Overlay: `position: fixed; inset: 0; z-index: 10000; background: #000; overflow: hidden; cursor: none`.

- [ ] **Step 1: Implement** the class, CSS and script tags.
- [ ] **Step 2: Run** `npm test` — Expected: PASS.
- [ ] **Step 3: Manual check** (DevTools, while a track plays: `const ss = new Screensaver(window.__zuneExplorer, { onClose() {} }); ss.open()`): rows scroll in all four directions over ~5 minutes; no fades; never two sets crossing; next set comes in while the old one leaves; cover always square and in its own lane; time ticks and freezes on pause (media key); minimize 30 s and restore → resumes without a collision; mouse move/key/click closes and the click doesn't activate the tile underneath; track change applies on the next set; podcast shows its artwork; no photo/cover → black.
- [ ] **Step 4: Commit** `feat: Zune HD screensaver view`

---

### Task 10: Starting the screensaver

**Files:**
- Modify: `src/assets/js/renderer.js` (new `setupScreensaver()` called right after `this.setupPlayer()` in `init`; `setupKeyboardNavigation`; `_onPreferenceChanged`)
- Modify: `src/renderer/index.html` (player-bar button), `src/assets/css/styles.css`

**Interfaces:**
- Consumes: `Screensaver` (Task 9), `IdleTimer` (Task 8), prefs (Task 1).
- Produces: `ZuneExplorer.startScreensaver() -> void` (no-op when `!audioPlayer.getCurrentFile()` or already open); `ZuneExplorer.maybeAutoStartScreensaver() -> void`.

Behaviour:
- `setupScreensaver`: `this.screensaver = new Screensaver(this, { onClose: () => this.idleTimer.poke() })`; `this.idleTimer = new IdleTimer({ timeoutMs: (prefs.screensaver?.idleMinutes ?? 2) * 60000, onIdle: () => this.maybeAutoStartScreensaver() })`; `document` capture listeners (`passive: true`) on `mousemove`, `mousedown`, `keydown`, `wheel`, `touchstart` → `idleTimer.poke()`; also poke on audio `play` and on `visibilitychange` to visible; initial `poke()`.
- `maybeAutoStartScreensaver`: start only if `preferences.screensaver.autoStart !== false && audioPlayer.isPlaying && document.visibilityState === 'visible' && !screensaver.isOpen`. Focus is **not** checked.
- Hotkey: `z` / `Z` with no Ctrl/Meta/Alt, when `document.activeElement` is not an `input`, `textarea`, `select` or contentEditable, handled at the top of the existing `keydown` listener (before the alpha-jump/Escape checks) → `startScreensaver()`, `preventDefault`.
- Player-bar button: `<button class="player-btn player-bar-screensaver" id="player-bar-screensaver" title="Screensaver (Z)">` with a small inline SVG (my call: a rounded rectangle with three diagonal lines), placed after `player-bar-next` inside `.player-bar-controls` so the existing bar click handler ignores it; click → `e.stopPropagation(); this.startScreensaver()`.
- `_onPreferenceChanged`: `screensaver.idleMinutes` → `idleTimer.setTimeoutMs(newValue * 60000)`.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Run** `npm test` — Expected: PASS.
- [ ] **Step 3: Manual check:** set `start after` to 1 minute; play a track, don't touch the app → starts after ~60 s; repeat with focus in another app (window visible on screen) → still starts, and typing in the other app neither prevents nor closes it; paused → never starts; minimized → doesn't start; `auto-start` off → never auto-starts but `Z` and the button work; `Z` while typing in a search/prompt input does nothing; nothing loaded → `Z` does nothing.
- [ ] **Step 4: Commit** `feat: auto-start, hotkey and button for the screensaver`

---

### Task 11: Wrap-up

**Files:**
- Modify: `CLAUDE.md` (Testing Checklist: add artist-image and screensaver lines), `docs/ROADMAP.md` (add both under "Music Experience Enhancements" as `~~…~~ (Done)` entries in the file's style)

- [ ] **Step 1:** Add checklist lines: `Artist images off by default; on → photo backdrop on artist and album pages`, `Screensaver auto-starts after idle while playing, including when unfocused; any input exits`, `Screensaver directions alternate with no fades or collisions`.
- [ ] **Step 2: Run** `npm test` — Expected: all PASS. Run `npm start` once for a smoke test of both features end to end.
- [ ] **Step 3: Commit** `docs: testing checklist for artist images and screensaver`
