# Podcast Device Sync — Implementation Plan

**Date:** 2026-10-28
**Branch:** `feat/podcast-device-sync` (fresh from `main`; `feat/podcast-sync` stays parked as reference)
**Supersedes:** device-protocol sections (1–3, 8) of `specs/2026-03-11-podcast-sync-design.md`. Its UI, diff, and position-sync design (sections 4–7) still stand.

## What changed since March

`scripts/probe-podcast-push.js` got real podcast episodes onto a Zune HD. They appear under Podcasts, play, and resume. The recipe follows XuneSyncLibrary's pcap-derived sequence, plus two fixes:

1. **SendObjectPropList size params go high word first, then low word.** The parked branch sent `[lo, hi]`, so the device saw size × 2^32 and returned StoreFull.
2. **AUINT16 strings (SourceURL, Description) must be NUL-terminated.** Without the NUL, the firmware appends stale bytes ("…mp31"). Xune omits it. Corrupted URLs defeat matching by URL and produce duplicate shows.

Device layout: `Series/<title>.ser` (format 0xBA0B, schema 0x0f) is the show. Each episode lives in `Podcasts/<title>/` (MP3/WMA, schema 0x10) and points to its show through the **SeriesHandle (0xDA9E)** property, not through object references. `.ser` objects can't be found with `GetObjectHandles`, so shows come from ZMDB, where the atom ID equals the MTP handle.

Resume position is **TimeBookmark (0xDD62)**, u32 ms. It's writable, and ZMDB mirrors it at episode record offset +0x0c.

## Tasks

1. **ZMDB parser.** Fix the backwards-varint 3-byte bug (gate on `& 0x80`; the current check mis-sizes every field from 128 bytes up). Parse podcast shows (descriptor 20) and audio episodes (descriptor 19) for both HD and Classic layouts. Add `library.podcastShows` / `library.podcastEpisodes`. Test against real record bytes captured from a device.
2. **MTP protocol.** Add `sendObjectPropList` (size hi/lo), a property-list encoder (u8/u16/u32/string/AUINT16 with NUL), `getObjectPropDesc`, `getObjectPropList`, a generic vendor `call` (optional data phase), `syncDeviceDB`, `registerTrackContext`, and `disableTrustedFiles`. Add the constants. Unit-test the encoder and the command params with a fake transport.
3. **Matching helpers** (`src/main/zune/podcast-matching.js`, pure functions). URL prefix matching that tolerates garbage suffixes Xune left behind. Show lookup by feed URL. Episode lookup by enclosure URL, then title. Zune name sanitizing (`:` → space). DateAuthored formatting. "Furthest position wins" resolution. Unit tested.
4. **ZuneManager.** `browseContents()` returns `podcasts` (episodes with series name and handle, bookmark, URL, size) from ZMDB. Add `sendPodcastEpisodes(episodes)` with this sequence: pre-upload ops → ZMDB lookup → create show and folders only when missing → one SendObjectPropList per episode (real size, current position in TimeBookmark) → SendObject → verify, with rollback of objects created in a failed run. Add `setPodcastBookmark(handle, ms)`.
5. **Podcast manager + IPC.** `getAllDownloaded()` and `updatePositionFromSync()`. IPC/preload: `podcast-get-all-downloaded`, `podcast-update-position-from-sync`, `zune-send-podcast-episodes`, `zune-set-podcast-bookmark`.
6. **Renderer.** Add a PODCASTS diff category tab. `_computePodcastDiff()` matches by enclosure URL, then by title + show. Port position sync from the parked branch, with furthest position winning and played at ≥95%. Add podcast push and delete; add `podcasts` to every hard-coded category list and cache count.
7. **Pull from device** (device-only episodes → podcast download dir + subscription). Port from the parked branch if time allows; otherwise a follow-up.

## Status (2026-10-28)

Tasks 1–6 are done and verified on a Zune HD:
- Unit tests: 130 passing.
- Main-process integration run: repeat pushes are skipped, new episodes join the existing show, bookmarks are written both ways.
- Driving the app through CDP: the PODCASTS tab, a push from the UI, position sync on opening the tab, and group-by-show on Zune Desktop's 81 episodes.

Found during verification:
- **DisableTrustedFiles (0x9215) must not be sent mid-session.** After it, writes fail with AccessDenied (0x200F).
- **Fixed an existing bug:** the idle sync block was re-shown over the diff view after any transfer.

Task 7 (pull into subscriptions) is not done. Pull currently saves "<show> - <title>.mp3" to the chosen folder.

## Not in scope / follow-ups

- Video podcasts (schema 0x02 records with a show ref), Classic (Zune 30) device testing, show artwork upload in the UI.
- MTP-enumeration fallback for podcasts (ZMDB only; the fallback path returns `podcasts: []`).
- Writing the "played" flag (ZMDB +0x20 bit 0x200). There's no confirmed MTP property for it yet, so position is synced and "played" stays local.
