# Artist Images & Screensaver — Design

Date: 2026-10-24
Status: approved

## Why

Users have been asking for artist imagery. On a Zune HD, opening an artist (or one of their albums) shows a photo of the artist filling the background with the album art on top, and when the device sits idle while playing, it goes into a screensaver where the song title, album, artist and play time scroll across that photo in huge, mixed-weight type, horizontally, vertically and diagonally. That screensaver is one of the details that made the Zune feel special and nothing else on the desktop does it. Zune Explorer should have both.

Reference photos of the real device: `~/Downloads/IMG_0321.jpg`–`IMG_0349.jpg` (horizontal sequence), `IMG_0358.HEIC` (diagonal). The approved motion prototype is `.superpowers/brainstorm/2219-1792862263/content/screensaver-spike-v4.html` (git-ignored; throwaway code, but its behaviour is the reference for the feel).

## Goals

1. Fetch and cache a photo for each artist and use it as the background of the artist page and that artist's album pages.
2. A full-window screensaver that animates the current track's text and album cover over the artist photo, with the Zune HD's look and motion.

## Non-goals

- Changing the Now Playing panel, player bar, or any page other than the artist and album detail pages.
- Artist bios, discographies or other artist metadata.
- Artist photos on the Zune device itself (sync).
- An OS-level screensaver; this only runs inside the app window.

## Anti-goals (would be a failure even if it works)

- Downloading anything from the internet without the user having turned artist images on.
- A screensaver that looks tidy and grid-aligned. The real one is deliberately irregular.
- Fade transitions between directions, or rows of one set colliding with rows of another.
- Album text or photos that look washed out or recoloured; photos keep their original colours.

---

## Part 1 — Artist images

### Opt-in

- New preference, **off by default**: `artistImages.enabled` (add an `artistImages` section to `defaultPrefs` in `src/main/preferences.js`).
- Toggle in Settings (e.g. under a new or existing section in `settings-view.js`), labelled something like "download artist images", with a one-line note that images are downloaded from fanart.tv and Deezer and stored on this computer.
- When off: no network requests for artist images, pages look exactly as today.
- Turning it off does not need to delete the cache; a "clear artist images" action in the data section is a nice-to-have (builder's call).

### Sources

Primary **fanart.tv**, fallback **Deezer**. A fanart.tv API key ships in release builds (the user is fine with this; they will register the key).

- The repo is public, so the key is **not committed**. The GitHub Actions release workflow injects it at build time from a repository secret (e.g. `FANART_API_KEY`), for example by writing a small generated config file that is git-ignored. Local `npm start` / dev builds have no key and use **Deezer only**; that must work without errors or warnings to the user.
- A developer can optionally supply their own key locally via an environment variable (my call; convenient for testing fanart.tv).

- **fanart.tv**: `https://webservice.fanart.tv/v3/music/{artistMbid}?api_key=…`. Needs the artist's MusicBrainz ID, so first resolve it via MusicBrainz artist search (`/ws/2/artist/?query=…`), reusing the existing rate-limited client in `src/main/musicbrainz.js` (1 req/s, same User-Agent). Prefer `artistbackground` (wide, ~1920×1080); if absent, `artistthumb`.
- **Deezer**: `https://api.deezer.com/search/artist?q={name}` → first good name match → `picture_xl`. No key. Square, ~1000px.
- Name matching: normalise case/whitespace; accept the top result only if its name matches the library artist name closely (exact after normalising, or very close). Better no photo than the wrong person.
- All fetching happens in the main process (new module, e.g. `src/main/artist-images.js`), exposed to the renderer over IPC in the same style as the existing `metadata-*` handlers.

### Cache

- Image files stored on disk under userData (e.g. `artist-images/`), plus a small JSON index keyed by normalised artist name → `{ file, source, mbid, fetchedAt }` or a "not found" marker with a timestamp so misses aren't re-queried every launch (retry after some days — builder's call on the interval).
- Served to the renderer as a file URL or data URL (builder's call; keep the existing security path-prefix rules in mind).
- Once cached, works offline.

### When images are fetched

- On demand: the first time an artist page or album page is opened for that artist, or when the screensaver needs the current track's artist. No bulk prefetch of the whole library.
- Fetching must not block rendering; the page renders as today and the background appears when ready.

### Where they show

- **Artist page** (`renderArtistDetail`, `src/assets/js/renderer.js`): the photo fills the whole page behind the giant hero name and album grid (approved mockup option A). Darkened with a top-to-bottom gradient (lighter at top, darker toward the bottom) so the tiles and text stay readable. Photo keeps its original colours — no greyscale.
- **Album page** (`renderAlbumDetail`): same artist photo as the full-page background, album cover in front, track list over the darker side (darken left-to-right or as needed for readability).
- Use the album's artist; resolve through `resolveArtistKey` the same way navigation does, so albumArtist vs track-artist mismatches still find the photo.
- Never look up a photo for a podcast (podcasts set artist/album to the podcast name; searching for it would find the wrong thing).
- No photo (disabled, not found, offline with no cache): page looks exactly as today.

### Picking a different photo (assumed, not discussed in detail)

- Right-click the artist page header → "change artist photo" (choose among the candidates found from both sources) and "remove artist photo". A removed photo should stay removed (stored in the index) until the user picks one again. Builder may keep this minimal.

---

## Part 2 — Screensaver

### Starting

- **Automatic**: when audio is **playing** and there has been no mouse or keyboard input **in the app window** for the idle timeout. Default **2 minutes**, adjustable in Settings, with an option to turn auto-start off. Paused/stopped playback never auto-starts it.
  - It must start even when the window is **not focused**: users keep the app on one screen while working in other apps on another and want to see the screensaver there. So idle means "no input to this app", measured in the renderer, not system-wide idle (working elsewhere must not prevent it).
  - Don't start while the window is minimized or fully hidden; nobody would see it (my call). If the window is minimized while the screensaver is showing, stop animating until it's visible again.
- **Manual**: a hotkey and a small button in the player bar. Exact key and icon are the builder's call (suggest a key that doesn't clash with existing handlers in `setupKeyboardNavigation`, e.g. `Z` when no text input is focused).
- Works whether or not artist images are enabled (see Background).

### Stopping

- Any mouse movement over the window, click, or key press to the app exits and returns to exactly the page that was showing. Input in other apps does not exit it. The exiting input should not also trigger an action underneath (e.g. a click shouldn't click a tile).
- Playback is unaffected by entering/exiting.

### Layout

- Full-window overlay above everything, including the custom title bar area.
- **Background**: the current artist's photo, full-bleed, original colours, lightly darkened. If artist images are off or no photo exists: the album cover scaled up to fill and darkened; if no cover either: plain black.
- **Podcasts**: the screensaver runs for podcasts too. The background is the podcast's artwork (scaled and darkened, as the cover fallback above); no artist-photo lookup. Rows use episode title, show name, and elapsed time in the same slots (episode title where the song title goes, show name for both album and artist rows; my call).
- **Text rows** (a "set"), stacked with **uneven, random gaps** (rows may slightly overlap), sizes jittered per set:
  1. Giant, thin (weight ~100): album title. Much taller than a third of the screen; letters run off the edges.
  2. Small, light: song title followed by the **elapsed time in bold**, repeated a few times along the row. Time counts up live.
  3. Bold (weight ~800): album title.
  4. Medium, light: artist name.
  5. Giant, thin: artist name, running off the edges.
  - All upper-case except where the source photos show otherwise; font is the app's existing Segoe-style stack.
- **Album cover** is its own row in the stack (random slot each set), a true square, moving with its own speed like the text. It never slides over the text rows.

### Motion

- Each set picks a direction: **horizontal, vertical, diagonal ↗, diagonal ↘**, never the same as the previous set.
- Every row scrolls through **once** (enters at one edge, exits at the other). Most rows travel the same way; a row occasionally runs the opposite way (fewer reversed rows than the v4 prototype's ~2 per set, so sets clear the screen in one consistent direction).
- Each set lasts roughly **35–50 seconds**; each row's speed is derived from its length so all rows finish around the same time, ±. Long giant rows therefore move faster than short ones. This was the approved v4 feel.
- **No fades, never crossing, screen stays full.** The next set starts while the previous one is still leaving. The user confirmed this is how the Zune itself behaves: the new set comes in **from the edges the old set has already vacated**. So the next direction is chosen (from the three that aren't the current one) by which entry edge is already clear of outgoing rows, based on their screen-space positions, rather than picked blindly and then delayed. Rows from two sets must never visibly cross.
- If no direction's entry region is clear yet, wait until one is. A brief moment with no text on screen is acceptable only as a last resort, not the normal rhythm.
- Small rows still drift slowly; overall speed should feel calm (the user asked for half the first prototype's speed and approved v4).
- Use GPU-friendly transforms (Web Animations / CSS transforms), and stop all animation work when the screensaver closes.

### Following playback

- On track change, the set currently on screen finishes; the next set uses the new track's title, album, artist, cover and photo.
- When paused while the screensaver is showing, it stays on with the time frozen; resuming continues counting.
- When the queue ends, keep showing the last track (builder's call whether to exit).

### Settings

Under a new "screensaver" settings section (or similar):

- auto-start on/off (default on)
- idle timeout (e.g. 1, 2, 5, 10 minutes; default 2)

---

## Constraints

- Electron app on macOS, Windows, Linux; nothing platform-specific is expected here.
- Match existing patterns: vanilla JS in `renderer.js`/`settings-view.js`, IPC via `preload.js` `electronAPI`, styles in `src/assets/css/styles.css`, preferences through `preferences.update`.
- MusicBrainz rate limit (1 req/s) and User-Agent must be respected; the MBID lookup shares the existing queue.
- fanart.tv's terms ask for attribution; add a credit line in Settings → about (and/or next to the artist-images toggle).
- The User-Agent version string in `musicbrainz.js` must keep matching `package.json` (existing rule).

## Left to the builder

- Module/function names, cache file format details, retry interval for misses.
- Exact hotkey, player-bar icon, settings section placement and wording.
- Exact gradient values and darkening amounts (readability first).
- The exact clear-edge test for picking the next direction, as long as there are no visible collisions, no fades, and empty screens are rare.
- How the generated key config is written in CI and loaded at runtime.
- Whether to add a "clear artist images" action.
- Testing approach consistent with the repo.

## Open item for the user

- Register a fanart.tv API key and add it as a GitHub Actions repository secret before release.
