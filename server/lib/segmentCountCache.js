const { segmentCounts } = require("./customerSegments");

const cache = new Map();
const TTL_MS = 45000;

function getSegmentCountsCached(db, today, companyId) {
  const key = companyId + ":" + today;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.counts;
  const counts = segmentCounts(db, today, companyId);
  cache.set(key, { counts, at: Date.now() });
  return counts;
}

function invalidateSegmentCounts(companyId) {
  if (!companyId) {
    cache.clear();
    return;
  }
  for (const key of [...cache.keys()]) {
    if (key.startsWith(companyId + ":")) cache.delete(key);
  }
}

module.exports = { getSegmentCountsCached, invalidateSegmentCounts };
