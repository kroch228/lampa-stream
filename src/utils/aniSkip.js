// AniSkip API v2 https://api.aniskip.com/api-docs
// Uses MyAnimeList IDs (not AniList IDs).
// Response: { found, results: [{ interval: { startTime, endTime }, skipType: "op"|"ed"|... }] }

const ANISKIP_API = "https://api.aniskip.com/v2";
const CACHE_KEY = "streambert_aniskipCache";
const CACHE_TTL = 1000 * 60 * 60 * 24 * 7; // 7 days

function getCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}

function setCache(cache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {}
}

export function clearAniSkipCache() {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {}
}

/**
 * Fetch intro/outro/recap timings for an episode, with 7-day localStorage cache.
 * @param {number} malId  MyAnimeList ID (anilistData.idMal)
 * @param {number} episodeNumber
 * @param {number} episodeLength  Episode duration in SECONDS. Passing the real
 *   duration lets AniSkip return the skip-time submission whose episode length
 *   matches this stream — important when a dub/encode shifts the OP/ED relative
 *   to the original Japanese air. 0 = unknown (returns any submission, may be
 *   misaligned). Cached per (malId, episode, length).
 * @returns {{ intro?: { startTime, endTime }, outro?: { startTime, endTime }, recap?: { startTime, endTime } } | null}
 */
export async function fetchAniSkipTimings(malId, episodeNumber, episodeLength = 0) {
  if (!malId || !episodeNumber) return null;

  const len = Math.round(episodeLength || 0);
  const cacheKey = `${malId}_${episodeNumber}_${len}`;
  const cache = getCache();
  const hit = cache[cacheKey];
  if (hit && Date.now() < hit.expiresAt) return hit.data;

  try {
    const res = await fetch(
      `${ANISKIP_API}/skip-times/${malId}/${episodeNumber}` +
        `?types[]=op&types[]=ed&types[]=mixed-op&types[]=mixed-ed&types[]=recap&episodeLength=${len}`,
    );

    // 404 = no data for this episode, cache as null
    if (res.status === 404) {
      cache[cacheKey] = { data: null, expiresAt: Date.now() + CACHE_TTL };
      setCache(cache);
      return null;
    }
    if (!res.ok) return null;

    const data = await res.json();
    if (!data.found || !data.results?.length) {
      cache[cacheKey] = { data: null, expiresAt: Date.now() + CACHE_TTL };
      setCache(cache);
      return null;
    }

    const result = {};
    for (const entry of data.results) {
      const { skipType, interval } = entry;
      // op / mixed-op → intro,  ed / mixed-ed → outro,  recap → recap
      if (skipType === "op" || skipType === "mixed-op") {
        result.intro = {
          startTime: interval.startTime,
          endTime: interval.endTime,
        };
      } else if (skipType === "ed" || skipType === "mixed-ed") {
        result.outro = {
          startTime: interval.startTime,
          endTime: interval.endTime,
        };
      } else if (skipType === "recap") {
        result.recap = {
          startTime: interval.startTime,
          endTime: interval.endTime,
        };
      }
    }

    const timings = Object.keys(result).length > 0 ? result : null;
    cache[cacheKey] = { data: timings, expiresAt: Date.now() + CACHE_TTL };
    setCache(cache);
    return timings;
  } catch {
    return null;
  }
}
