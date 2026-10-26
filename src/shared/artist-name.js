// Artist name matching for photo lookups: better no photo than the wrong person,
// so only names that are identical after normalising count as a match.

function normalizeArtistName(name, { keepInitials = false } = {}) {
  if (!name) return '';
  let text = String(name);
  // Cache keys keep initialisms apart from words (M.I.A. vs Mia); matching against
  // sources stays loose so a library "A.F.I." still finds Deezer's "AFI".
  if (keepInitials) text = text.replace(/\./g, ' ');
  return text
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

// Cache key for an artist's photo: one entry per distinct library artist.
function artistCacheKey(name) {
  const primary = primaryArtist(name);
  return isPlaceholderArtist(primary) ? '' : normalizeArtistName(primary, { keepInitials: true });
}

const artistName = { normalizeArtistName, artistNamesMatch, primaryArtist, isPlaceholderArtist, artistCacheKey };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = artistName;
}
if (typeof window !== 'undefined') {
  window.artistName = artistName;
}
