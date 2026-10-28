// Podcast matching between the app's subscriptions and a Zune's ZMDB. Shared by
// the main process (push de-duplication) and the sync panel (diff + positions).
//
// Shows are matched by feed URL, episodes by enclosure URL; names and titles are
// the fallback. URLs compare as prefixes because AUINT16 strings written without a
// NUL terminator (e.g. by XuneSyncLibrary) are stored with stale bytes appended.

function normalizeUrl(url) {
  return String(url || '').trim().toLowerCase().replace(/^https?:\/\//, '');
}

function normalizeTitle(title) {
  return String(title || '').trim().toLowerCase();
}

// `stored` comes from the device, `ours` from the app
function urlsMatch(stored, ours) {
  const s = normalizeUrl(stored);
  const o = normalizeUrl(ours);
  if (!s || !o) return false;
  return s === o || s.startsWith(o);
}

/**
 * Find the device show for a subscription. Returns { show, matchedBy, duplicates }:
 * `duplicates` are other shows with the same feed URL (left by earlier tools).
 */
function findDeviceShow(shows, episodes, { feedUrl, title }) {
  const episodeCount = (show) => episodes.filter(e => e.showAtomId === show.atomId).length;

  // Exact URL matches first, then stale-suffix (prefix) matches; most episodes first
  const exact = (s) => normalizeUrl(s.feedUrl) === normalizeUrl(feedUrl) ? 1 : 0;
  const byUrl = shows
    .filter(s => urlsMatch(s.feedUrl, feedUrl))
    .sort((a, b) => (exact(b) - exact(a)) || (episodeCount(b) - episodeCount(a)));
  if (byUrl.length) {
    return { show: byUrl[0], matchedBy: 'feedUrl', duplicates: byUrl.slice(1) };
  }

  const name = normalizeTitle(title);
  const byName = name ? shows.filter(s => normalizeTitle(s.name) === name) : [];
  if (byName.length) {
    byName.sort((a, b) => episodeCount(b) - episodeCount(a));
    return { show: byName[0], matchedBy: 'name', duplicates: byName.slice(1) };
  }

  return { show: null, matchedBy: null, duplicates: [] };
}

/** Find an episode among one show's device episodes by enclosure URL, then title. */
function findDeviceEpisode(showEpisodes, { url, title }) {
  const exact = showEpisodes.find(e => url && normalizeUrl(e.url) === normalizeUrl(url));
  if (exact) return exact;
  const byUrl = showEpisodes.find(e => urlsMatch(e.url, url));
  if (byUrl) return byUrl;
  const t = normalizeTitle(title);
  return (t && showEpisodes.find(e => normalizeTitle(e.title) === t)) || null;
}

// Zune Desktop replaces illegal filename characters with a space
// ("APM: The Story" -> "APM  The Story" for both the .ser and the folder).
function zuneSafeName(name) {
  const safe = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 120);
  return safe || 'Untitled';
}

// MTP DateAuthored: "YYYYMMDDTHHMMSS.0"
function formatDateAuthored(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.0`;
}

const PLAYED_FRACTION = 0.95;
const POSITION_TOLERANCE_MS = 1000;

/**
 * Furthest position wins. Returns { direction: 'none' | 'to-local' | 'to-device',
 * positionMs, played } where `played` means the winning position is >= 95%.
 */
function resolvePositionSync({ localMs, deviceMs, durationMs }) {
  const local = Math.max(0, Math.round(localMs || 0));
  const device = Math.max(0, Math.round(deviceMs || 0));
  const positionMs = Math.max(local, device);
  const played = durationMs > 0 && positionMs >= durationMs * PLAYED_FRACTION;

  if (Math.abs(local - device) < POSITION_TOLERANCE_MS) {
    return { direction: 'none', positionMs: local, played };
  }
  return { direction: device > local ? 'to-local' : 'to-device', positionMs, played };
}

/**
 * Pair downloaded episodes ({ episodeId, title, enclosureUrl, subscriptionTitle })
 * with device episodes ({ handle, title, url, seriesName }).
 */
function matchPodcastEpisodes(localEpisodes, deviceEpisodes) {
  const matched = [];
  const usedLocal = new Set();
  const usedDevice = new Set();

  // Pass 1: enclosure URL
  for (const local of localEpisodes) {
    const device = deviceEpisodes.find(d => !usedDevice.has(d.handle) && urlsMatch(d.url, local.enclosureUrl));
    if (device) {
      matched.push({ local, device });
      usedLocal.add(local);
      usedDevice.add(device.handle);
    }
  }

  // Pass 2: title within the same show
  for (const local of localEpisodes) {
    if (usedLocal.has(local)) continue;
    const title = normalizeTitle(local.title);
    const show = normalizeTitle(local.subscriptionTitle);
    const device = deviceEpisodes.find(d => !usedDevice.has(d.handle)
      && normalizeTitle(d.title) === title
      && normalizeTitle(d.seriesName) === show);
    if (device) {
      matched.push({ local, device });
      usedLocal.add(local);
      usedDevice.add(device.handle);
    }
  }

  return {
    matched,
    localOnly: localEpisodes.filter(e => !usedLocal.has(e)),
    deviceOnly: deviceEpisodes.filter(d => !usedDevice.has(d.handle)),
  };
}

const podcastMatching = {
  urlsMatch,
  findDeviceShow,
  findDeviceEpisode,
  zuneSafeName,
  formatDateAuthored,
  resolvePositionSync,
  matchPodcastEpisodes,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = podcastMatching;
}
if (typeof window !== 'undefined') {
  window.podcastMatching = podcastMatching;
}
