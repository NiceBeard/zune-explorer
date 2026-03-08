# Sync Diff: Multi-Category Support & Delete Button

## Summary

Expand the sync diff view to support music, videos, and pictures (currently music-only). Add a "delete from device" button alongside the existing download button. Use Zune HD sub-tab styling for category selection.

## Layout (top to bottom)

1. **Category tabs**: `MUSIC` | `VIDEOS` | `PHOTOS` — Zune HD sub-tab style (uppercase, 14px, weight 600, letter-spacing 3px, orange underline on active, dim inactive at rgba(255,255,255,0.25))
2. **Diff summary**: "X matched · Y to sync · Z on device only" — scoped to selected category
3. **Diff tabs**: missing from device / missing from computer / on both
4. **Group bar, filter, select-all** — group bar hidden for videos/photos
5. **Diff list** — scoped to selected category + diff tab
6. **Action buttons**:
   - "sync to device" (local-only tab)
   - "copy to computer" (device-only tab)
   - "delete from device" (device-only tab, new)

## Category Tab Behavior

- Default to MUSIC on open (preserves current behavior)
- Switching category: clears selections (`diffSelectedPaths`, `diffSelectedHandles`), resets diff tab to "missing from device", recomputes diff for new category
- State tracked via `this.diffCategory` ('music', 'videos', 'pictures')

## Diff Computation Per Category

- **Music**: existing metadata-based matching (title + artist, handle match)
- **Videos/Pictures**: filename-based matching (compare basename only, case-insensitive)
- Local source for each category: `this.explorer.categorizedFiles[category]`
- Device source: `this.browseData[category]`

## Diff Item Display

- **Music**: album art thumbnail, title, artist — album (existing)
- **Videos**: filename, file size
- **Photos**: filename, file size

## Group Bar

- Music: show group bar (all tracks / by album / by artist) — existing behavior
- Videos/Photos: hide group bar (no meaningful grouping)

## Delete Button

- Styled with red color scheme matching existing browse delete button (#ff3333 border/text)
- Two-click confirmation: first click → "confirm: delete X files?", 3-second timeout to revert
- Uses existing `zuneDeleteObjects` IPC and `zuneManager.deleteObjects()`
- After deletion: remove handles from `browseData[category]`, recompute diff, re-render
- Shown only on "device-only" diff tab (same visibility as pull button)

## Pull Button Changes

- Already works for any file type (straight file copy, WMA→MP3 conversion for music)
- Videos/photos: no format conversion needed, just copy
- After pull: add files to `categorizedFiles[category]` (not just music)
- Skip metadata scan for non-music files

## No Backend Changes Required

- `zuneDeleteObjects` IPC works with any MTP handles
- `zunePullFile` IPC handles any file type
- `browseData` already populated with `videos` and `pictures` from device scan
