// Writes src/main/build-config.json for release builds. Run in CI with the
// FANART_API_KEY secret in the environment; never prints the key.
const fs = require('node:fs');
const path = require('node:path');

const key = process.env.FANART_API_KEY || '';
const out = path.join(__dirname, '..', 'src', 'main', 'build-config.json');
fs.writeFileSync(out, JSON.stringify({ fanartApiKey: key }, null, 2) + '\n');
console.log(key ? 'build-config: fanart key present' : 'build-config: no fanart key (Deezer only)');
