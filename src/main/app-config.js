// Build-time configuration. Release CI writes build-config.json (git-ignored)
// via scripts/write-build-config.js; local builds usually have none.

function readBuildConfigFile() {
  try {
    return require('./build-config.json');
  } catch {
    return {};
  }
}

function getFanartApiKey({ env = process.env, readBuildConfig = readBuildConfigFile } = {}) {
  if (env.FANART_API_KEY) return env.FANART_API_KEY;
  const config = readBuildConfig() || {};
  return config.fanartApiKey || null;
}

module.exports = { getFanartApiKey };
