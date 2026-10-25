// Artist name matching for photo lookups: better no photo than the wrong person,
// so only names that are identical after normalising count as a match.

function normalizeArtistName(name) {
  if (!name) return '';
  return String(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[&+]/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the /, '');
}

function artistNamesMatch(a, b) {
  const na = normalizeArtistName(a);
  return na !== '' && na === normalizeArtistName(b);
}

const FEATURING = /\s+(?:feat\.?|ft\.|featuring)\s+/i;

function primaryArtist(name) {
  if (!name) return '';
  return String(name).split(FEATURING)[0].trim();
}

// Tag placeholders, not real artists: never look these up.
const PLACEHOLDERS = new Set(['', 'various artists', 'various', 'va', 'unknown artist', 'unknown', 'artist']);

function isPlaceholderArtist(name) {
  return PLACEHOLDERS.has(normalizeArtistName(name));
}

const artistName = { normalizeArtistName, artistNamesMatch, primaryArtist, isPlaceholderArtist };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = artistName;
}
if (typeof window !== 'undefined') {
  window.artistName = artistName;
}
