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

const FEATURING = /\s+(?:feat\.?|ft\.|featuring|with)\s+/i;

function primaryArtist(name) {
  if (!name) return '';
  return String(name).split(FEATURING)[0].trim();
}

const artistName = { normalizeArtistName, artistNamesMatch, primaryArtist };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = artistName;
}
if (typeof window !== 'undefined') {
  window.artistName = artistName;
}
