# Settings Page — Design Spec

**Date:** 2026-04-24
**Drivers:** GitHub issue #12 (user-selectable library folders); accumulated ad-hoc preferences need a proper home.
**Status:** Approved design, pre-implementation.

## Motivation

Preferences have been squeezed into the app one JSON file at a time (`pull-destination.json`, podcast download directory, etc.). Issue #12 — "Can't select where music is located" — exposes the bigger problem: there is no surface for users to control how the app behaves. This spec introduces a proper settings experience in keeping with the Zune HD aesthetic.

## Scope

### In scope (v1)

1. **Settings as the sixth panorama section** — hero-header-styled top-level category, right of `applications`. Inherits the existing horizontal slide animation between panorama sections; no bespoke animation code.
2. **Unified preferences store** — a single schema-versioned `preferences.json` in `userData/`, covering cross-cutting preferences only. User *content* (pins, playlists, now-playing, metadata cache, device cache) stays where it lives.
3. **Five settings sections** (see §4 for details):
   - Library
   - Sync
   - Podcasts
   - Data
   - About
4. **Issue #12 fix**: per-category library folder lists (Music / Videos / Pictures). Each pre-populated with the OS default, each fully user-controllable. Optional "also scan Desktop and Downloads" toggle, **off by default**.
5. **Boot/Update splash** — one-time-per-install/upgrade Zune-style vertical-bar animation with welcome/update message. Runs preferences migration behind it.
6. **Legacy-file migration** — one-shot import of existing preference files into `preferences.json` on first load after upgrade.
7. **Behavior-change toast** — existing installs see a one-time notice that Desktop/Downloads scanning is no longer default.

### Explicitly out of scope (parked)

- **Skins / accent-color themes** — user-deferred, "some day but not today."
- Per-folder recursive yes/no (all folders recursive, matches current).
- Folder exclude-patterns, max-depth, hidden-file toggle.
- Preferences export/import.
- Appearance section (panorama snap toggle, etc.).
- MusicBrainz enrichment toggle.
- Any deeper fix for issue #12's secondary complaint ("drag-from-documents doesn't sync") — separate bug.

## Visual design

### Panorama placement

Settings is the sixth hero-header section, to the right of `applications`. Hero header uses the existing `.hero-header` pattern: ~340px font, weight 100, lowercase, `rgba(255,255,255,0.55)`, `top: -160px`, `overflow: hidden` on the wrapper. Horizontal slide from/to this section uses the same transition the other five panorama sections use today.

### Internal drill-down

Each settings level is a full page with the same giant clipped hero header plus a left-aligned list of sub-items in white.

**Drill structure:**

```
settings                           (hero)
  library                          (hero, drill)
    music folders                  (hero, drill)
      /Users/aaron/Music           (hero, leaf — reveal / remove)
      /Users/aaron/iCloud/Music
      + add folder
    video folders                  (same)
    picture folders                (same)
    scan desktop and downloads     (toggle — flips in place)
  sync                             (hero, drill)
    pull destination               (leaf — shows path, tap to re-pick)
  podcasts                         (hero, drill)
    download directory             (leaf — shows path, tap to re-pick)
  data                             (hero, drill)
    clear metadata cache           (action)
    clear device cache             (action)
  about                            (hero, drill — info only)
    version, github link, credits
```

### Styling rules

- **Hero header:** giant clipped, same as other categories, at every drill level.
- **Sub-items:** left-aligned, white, moderate-size (~20–24px).
- **No orange section headers inside settings pages.** Orange is reserved for active/selection accents (consistent with the rest of the app).
- **No indent-based hierarchy.** The hero header and back button ARE the breadcrumb. Full commit to drill-down.
- **Toggles:** flip in place on tap (no drill needed for leaf booleans).
- **Folder rows:** tapping a folder drills to a leaf page showing `reveal in finder` and `remove from library`.
- **Back button:** existing SVG from memory (circle + angular arrow). Same position as hero-mode category views.

## Architecture

### Files added

- `src/main/preferences.js` — single source of truth for preferences. Module-level singleton, loaded at app boot.
- `src/main/preferences-migrations.js` — legacy-file → `preferences.json` migration.
- `src/renderer/components/boot-splash.js` (or inline in `renderer.js` — see §7 on split decisions) — the Zune-style boot/update animation.
- `userData/preferences.json` — persistent preferences (created on first run).

### Files modified

- `src/main/main.js` — boot-time preferences load + migration trigger; IPC handlers for preferences read/write/reset.
- `src/main/preload.js` — new `electronAPI.preferences*` surface.
- `src/main/podcast-manager.js` — read `downloadDirectory` from central preferences rather than its own store. Keep its own subscriptions/episodes storage separate (that's user content, not preferences).
- `src/assets/js/renderer.js` — new `SettingsView`; new scan entry-point reading library folders from preferences rather than hardcoded `~/Music` etc.; wires up boot splash on first-run signal from main.
- `src/renderer/index.html` — new `.settings-view` panorama section element.
- `src/assets/css/styles.css` — settings drill-page styles (largely reuses `.hero-header`, `.hero-mode`, back-button, drill-list patterns); boot-splash animation.

### Preferences module API

```js
// src/main/preferences.js
const preferences = {
  async load(),                     // reads preferences.json, runs migration if needed
  get(dotPath),                     // e.g. get('library.music') → string[]
  async update(patch),              // deep-merge patch, debounced write (200ms)
  async reset(section),             // reset a section or whole store to defaults
  subscribe(cb),                    // fires on update with { path, newValue }
  _migrate(oldData, targetVersion), // internal schema bumps
};
```

### Preferences schema v1

```json
{
  "version": 1,
  "library": {
    "music":    ["/Users/<user>/Music"],
    "videos":   ["/Users/<user>/Movies"],
    "pictures": ["/Users/<user>/Pictures"],
    "scanDesktopAndDownloads": false
  },
  "sync":     { "pullDestination":    null },
  "podcasts": { "downloadDirectory":  null },
  "meta": {
    "installedVersion": "1.5.0",
    "firstRunAt": "ISO-8601 timestamp"
  }
}
```

Schema rules on load:
- Unknown top-level or nested keys are dropped (forward-compat: older versions won't explode on newer fields, but also won't preserve them — acceptable for v1).
- Missing keys get defaults.
- Malformed JSON is preserved as `preferences.json.bad` and the store falls back to defaults.

### IPC surface

In `preload.js`:

```js
preferencesLoad:    () => ipcRenderer.invoke('preferences-load'),
preferencesUpdate:  (patch) => ipcRenderer.invoke('preferences-update', patch),
preferencesReset:   (section) => ipcRenderer.invoke('preferences-reset', section),
onPreferencesChanged: (cb) => { /* on 'preferences-changed' */ },
offPreferencesChanged: (handler) => { /* removeListener */ },
onFirstRun: (cb) => { /* on 'first-run', payload: { type: 'new' | 'upgrade', oldVersion, newVersion } */ },
pickFolder: (title) => ipcRenderer.invoke('pick-folder', title),  // generic picker (reused by library, sync, podcasts)
```

### Data flow — example: user adds a music folder

1. User taps "+ add folder" on `settings → library → music folders`.
2. Renderer calls `window.electronAPI.pickFolder('Choose a music folder')`.
3. Main opens native dialog, returns path or `null`.
4. Renderer calls `preferencesUpdate({ library: { music: [...existing, picked] } })`.
5. Main debounces, writes `preferences.json`, emits `preferences-changed` with `{ path: 'library.music', newValue: [...] }`.
6. Renderer listener on `library.music` triggers delta rescan:
   - New folder → scan just that folder, append to `categorizedFiles.music`
   - No existing folders dropped → no deletion step
7. Toast: *"rescanning music…"* during scan; toast dismisses on complete.

### Data flow — example: user removes a music folder

1. User taps folder → leaf page → `remove from library`.
2. Small confirm modal (existing `showConfirmModal`).
3. On confirm, renderer computes new list, calls `preferencesUpdate`.
4. `preferences-changed` fires. Renderer drops tracks from `musicLibrary.tracks` whose `path` starts with the removed folder's prefix. No rescan needed.
5. Toast: *"removed N tracks from library"*.

## Migration

### Existing-install detection

On main-process boot:

1. Try to read `preferences.json`. If present → skip migration.
2. If absent → check for any of:
   - `pins.json`
   - `playlists/` directory (non-empty)
   - `pull-destination.json`
   - `now-playing.json`
   - podcast-manager preferences file
3. If any exist → **existing install**. Otherwise → **new install**.
4. Write `preferences.json` with defaults, then apply legacy-file imports (see below).
5. Send `first-run` IPC to renderer with `{ type: 'new' | 'upgrade', oldVersion, newVersion }`.

### Legacy-file imports

All imports are best-effort and non-fatal. On success, delete the legacy file; on failure, log and leave it in place.

| Legacy source | Target in `preferences.json` |
|---|---|
| `pull-destination.json` → `{ path }` | `sync.pullDestination` |
| `podcast-manager`'s `downloadDirectory` preference | `podcasts.downloadDirectory` (podcast-manager is updated to read from central store going forward) |

No legacy source for `library.*` — this behavior was hardcoded. All existing installs get OS defaults.

### Desktop/Downloads behavior change

Previously `~/Desktop` and `~/Downloads` were scanned for any media unconditionally. Going forward, gated by `library.scanDesktopAndDownloads` (default `false`).

- **New install:** `false`. No notice.
- **Existing install:** `false` AND show one-time toast after boot splash: *"Desktop & Downloads are no longer scanned by default. Re-enable in settings → library."* Dismissible. Toast-shown flag is stored in `preferences.meta` so it doesn't repeat.

### Schema version bumps (future)

`preferences.version` is checked on load. If `loaded.version < current`, run ordered `_migrate(prev, next)` functions to transform the old shape, then write back. v1 has no predecessors — this is a hook for future versions.

## Boot/Update splash

A first-run-only animation overlay that plays on new install and on version upgrade.

### Behavior

- Shown **once per install/upgrade**, never on subsequent boots.
- Main process triggers it by emitting `first-run` IPC after migration completes (or starts, see below).
- Full-screen black overlay above everything else.
- Thin vertical bar, ~10% viewport width, centered horizontally, vertically growing from 0 to ~40% viewport height over ~2s.
- Bar color cycles through four stops (interpolated):
  1. Pink — `#EC008C`
  2. Orange — `#F58220`
  3. Teal — `#00ADA7`
  4. Deep blue — `#2B3990`
- Centered message below: `welcome to zune explorer` (new) or `updated to v1.5` (upgrade). Typography: large weight-100 lowercase, consistent with hero headers.
- Migration runs during the animation. If it finishes faster than 2s, splash holds until min duration. If it takes longer than ~5s, splash extends with a subtle fade on the bar — we should not have hitting this path under normal conditions.
- On dismiss, splash fades out (~300ms), app becomes interactive, behavior-change toast (if applicable) appears.

### Reusability

Implemented as a small standalone component so it can be reused for future Zune-themed "this is happening" moments (e.g., first device pair). For v1, only the boot/update trigger is wired.

## Rescan semantics

Adding or removing library folders must not re-scan unchanged folders.

- **Add folder:** scan only the new folder; append to existing `categorizedFiles[category]`.
- **Remove folder:** drop tracks/entries whose `path` is under the removed folder prefix **AND** not also under another currently-configured folder in the same category (guards against nested configurations, e.g., `/Music` and `/Music/rock` both listed). No disk read.
- **Toggle Desktop/Downloads on:** scan just `~/Desktop` and `~/Downloads` for media.
- **Toggle off:** drop tracks/entries whose `path` is under `~/Desktop` or `~/Downloads` **AND** not under any currently-configured library folder (guard against overlap if a user added Downloads explicitly).

These are additive/subtractive deltas against the in-memory `categorizedFiles` and `musicLibrary.tracks` structures. Metadata already scanned is retained.

## Testing

### Unit — preferences module (main)

- Load: missing file → defaults written
- Load: valid file → returned as-is
- Load: malformed JSON → `.bad` preserved, defaults used
- Update: deep-merge, debounced write, fires `preferences-changed`
- Subscribe: callback receives `{ path, newValue }` on update
- Reset: section-scoped and full-store
- Migrate: placeholder migration chain runs in order (test with a synthetic v0 → v1)

### Unit — legacy migration

- `pull-destination.json` → `sync.pullDestination`, file deleted on success
- Podcast directory → `podcasts.downloadDirectory`
- Migration failure → legacy file preserved, defaults used, no throw
- Existing-install detection: cover each signal (pins, playlists, pull-dest, now-playing, podcast prefs)

### Component — SettingsView

- Drill stack push/pop; back button pops; reaching root pops to category list
- Toggle: flips in place, `preferencesUpdate` called with correct path, state persists across remount
- Folder add: picker → update call → UI row appears
- Folder remove: confirm modal, update call, row disappears
- Last-folder-in-category: remove action disabled in UI AND rejected at main-process validation (defense in depth)
- Change in `preferences.json` from another source triggers re-render via `onPreferencesChanged`

### Component — BootSplash

- Animation resolves after min duration even if migration promise resolves early
- Migration rejection does NOT block dismissal — splash continues, error logged, defaults applied
- Does not render on second launch (feature-flagged off after first-run signal handled)

### Manual acceptance (issue #12)

- [ ] On a fresh machine, default-scan matches current behavior *except* Desktop/Downloads (off)
- [ ] Add a folder containing music → tracks appear after rescan toast
- [ ] Remove a folder → its tracks disappear, others remain
- [ ] Toggle Desktop/Downloads on → media there appears
- [ ] Toggle off → it disappears (unless overlapping with another configured folder)
- [ ] Upgrade path: existing installs see boot splash, behavior-change toast, and their pull-destination + podcast dir preserved

## Open implementation questions (deferred to plan, not design)

- Whether renderer code for `SettingsView` lives inline in `renderer.js` or gets split into its own file. `renderer.js` is already large — favor split if it cleanly separates, inline if it would create excessive coupling through shared state.
- Exact debounce window for `preferences-update` writes (200ms proposed; tune during implementation).
- Whether the boot splash message strings are i18n-ready (v1: no, hardcoded English).

## Acceptance criteria

- Settings panorama section renders with giant clipped hero at every drill level.
- All 5 sections are reachable and functional.
- Issue #12 primary ask (choose library folders) works end-to-end on a fresh install and on upgrade.
- `preferences.json` is the single source of truth for cross-cutting prefs; no other new preference JSON files are added to `userData/`.
- Boot splash shows exactly once per install/upgrade.
- Migration is non-fatal: even if every legacy file is corrupt, the app still boots with defaults.
- No regressions in existing music/video/picture scanning for users who never open Settings.
