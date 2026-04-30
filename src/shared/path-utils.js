function normalize(p) {
  if (!p) return p;
  return p.endsWith('/') || p.endsWith('\\') ? p.slice(0, -1) : p;
}

function isUnderPrefix(p, prefix) {
  const np = normalize(p);
  const npr = normalize(prefix);
  if (np === npr) return true;
  return np.startsWith(npr + '/') || np.startsWith(npr + '\\');
}

function isUnderAnyPrefix(p, prefixes) {
  return prefixes.some((pref) => isUnderPrefix(p, pref));
}

function computeAddedPaths(oldList, newList) {
  const oldSet = new Set(oldList.map(normalize));
  return newList.filter((p) => !oldSet.has(normalize(p)));
}

function computeRemovedPaths(oldList, newList) {
  const newSet = new Set(newList.map(normalize));
  return oldList.filter((p) => !newSet.has(normalize(p)));
}

const pathUtils = {
  isUnderPrefix,
  isUnderAnyPrefix,
  computeAddedPaths,
  computeRemovedPaths,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = pathUtils;
}
if (typeof window !== 'undefined') {
  window.pathUtils = pathUtils;
}
