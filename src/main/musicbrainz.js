const https = require('https');
const http = require('http');

function getClient(url) {
  return url.startsWith('http://') ? http : https;
}

const USER_AGENT = 'ZuneExplorer/1.1.0 (https://github.com/NiceBeard/zune-explorer)';
let lastRequestTime = 0;

function rateLimitedFetch(url) {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    const wait = Math.max(0, 1100 - (now - lastRequestTime));

    setTimeout(() => {
      lastRequestTime = Date.now();
      const req = getClient(url).get(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          rateLimitedFetch(res.headers.location).then(resolve, reject);
          return;
        }
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error('Invalid JSON response')); }
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timeout')); });
    }, wait);
  });
}

function fetchBinary(url) {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    const wait = Math.max(0, 1100 - (now - lastRequestTime));

    setTimeout(() => {
      lastRequestTime = Date.now();
      const req = getClient(url).get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchBinary(res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ data: Buffer.concat(chunks), contentType: res.headers['content-type'] }));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
    }, wait);
  });
}

async function searchReleases(album, artist) {
  const query = encodeURIComponent(`release:"${album}" AND artist:"${artist}"`);
  const url = `https://musicbrainz.org/ws/2/release/?query=${query}&limit=5&fmt=json`;
  const data = await rateLimitedFetch(url);
  return (data.releases || []).map(r => ({
    mbid: r.id,
    title: r.title,
    artist: (r['artist-credit'] || []).map(a => a.name).join(', '),
    year: r.date ? r.date.slice(0, 4) : '',
    label: (r['label-info'] || []).map(l => l.label?.name).filter(Boolean).join(', '),
    country: r.country || '',
    trackCount: (r['track-count'] || r.media?.reduce((sum, m) => sum + (m['track-count'] || 0), 0)) || 0,
  }));
}

async function getRelease(mbid) {
  const url = `https://musicbrainz.org/ws/2/release/${mbid}?inc=recordings+artist-credits+genres&fmt=json`;
  const data = await rateLimitedFetch(url);

  const tracks = [];
  for (const medium of (data.media || [])) {
    for (const track of (medium.tracks || [])) {
      tracks.push({
        position: track.position,
        title: track.title,
        duration: track.length || 0, // milliseconds
        artist: (track['artist-credit'] || data['artist-credit'] || []).map(a => a.name).join(', '),
      });
    }
  }

  const genres = (data.genres || []).map(g => g.name);

  return {
    mbid: data.id,
    title: data.title,
    artist: (data['artist-credit'] || []).map(a => a.name).join(', '),
    date: data.date || '',
    year: data.date ? parseInt(data.date.slice(0, 4), 10) : 0,
    genres,
    genre: genres[0] || '',
    tracks,
  };
}

async function getCoverArt(mbid) {
  try {
    const url = `https://coverartarchive.org/release/${mbid}`;
    const data = await rateLimitedFetch(url);
    const front = (data.images || []).find(img => img.front);
    const imageUrl = front ? (front.thumbnails?.large || front.thumbnails?.small || front.image) : null;
    if (!imageUrl) return null;

    const { data: imgData, contentType } = await fetchBinary(imageUrl);
    const base64 = imgData.toString('base64');
    return `data:${contentType};base64,${base64}`;
  } catch {
    return null; // No cover art available
  }
}

// Fetch a small thumbnail without MusicBrainz rate limiting (CAA is a separate service)
function fetchUnlimited(url) {
  return new Promise((resolve, reject) => {
    const req = getClient(url).get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUnlimited(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ data: Buffer.concat(chunks), contentType: res.headers['content-type'] }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

async function getThumbnail(mbid) {
  try {
    const url = `https://coverartarchive.org/release/${mbid}/front-250`;
    const { data, contentType } = await fetchUnlimited(url);
    return `data:${contentType};base64,${data.toString('base64')}`;
  } catch {
    return null;
  }
}

module.exports = { searchReleases, getRelease, getCoverArt, getThumbnail };
