# Zune Device Search — Design

## Scope
Contextual search in the diff view only, filtering the active tab (local-only, device-only, or matched).

## Search Behavior
- Real-time filtering as the user types (debounced ~150ms)
- Matches against title, artist, and album fields (case-insensitive substring)
- Respects current grouping mode:
  - **"all"** — filters the flat track list, hiding non-matching rows
  - **"by album"** — hides albums with zero matching tracks; within visible albums, shows only matching tracks
  - **"by artist"** — same logic: hides artists with zero matches, filters tracks within visible artists
- A track matches if the query appears in any of its three fields (title OR artist OR album)
- When a group header matches (e.g., searching "Beatles" matches the artist group name), all tracks in that group remain visible
- Clearing the search restores the full list
- Empty results show a "No results" message

## UI Placement
- Inline input placed between the group-by bar and the diff list
- Styled to match the Zune HD dark aesthetic: dark background (#1a1a1a), light placeholder text, subtle border, orange focus ring
- Placeholder text: "Filter..."
- Small clear (x) button appears when text is present
- Escape key clears the search

## Selection Interaction
- Checkboxes on filtered items still work normally
- Group "select all" checkbox only selects visible (filtered) items
- Bulk action bar operates on whatever is checked, whether or not those items are currently visible

## Performance
- All filtering happens client-side against in-memory browseData arrays — no IPC calls needed
- Simple `includes()` substring matching is sufficient for typical Zune library sizes

## Out of Scope
- No fuzzy matching or ranked results
- No separate search results view — filters in place
- No search history or suggestions
- No cross-tab search
