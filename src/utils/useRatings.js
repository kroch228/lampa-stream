import { useState, useEffect, useMemo } from "react";
import {
  fetchMovieRating,
  fetchTVRating,
  getAgeLimitSetting,
  getRatingCountry,
} from "./ageRating";
import { storage, getApiKey } from "./storage";

const CACHE_KEY = "ratingsCache";
const CACHE_TTL = 1000 * 60 * 60 * 24 * 7; // 7 days

// Read the whole cache once and return it, caller holds reference
function readCache() {
  try {
    return storage.get(CACHE_KEY) || {};
  } catch {
    return {};
  }
}

function writeCache(cache) {
  try {
    storage.set(CACHE_KEY, cache);
  } catch {}
}

// Evict entries older than TTL and return the cleaned cache
function evictStale(cache) {
  const now = Date.now();
  let changed = false;
  for (const key of Object.keys(cache)) {
    if (now - cache[key].ts > CACHE_TTL) {
      delete cache[key];
      changed = true;
    }
  }
  return cache; // mutated in-place; caller uses return value as signal via changed flag
}

/**
 * Hook that fetches + caches age ratings for an array of items.
 */
export function useRatings(items) {
  const [ratingsMap, setRatingsMap] = useState({});
  // Read stable settings once — these only change when user visits Settings,
  // which unmounts/remounts affected pages anyway, so useState(init) is correct.
  const [ageLimitSetting] = useState(() => getAgeLimitSetting(storage));
  const [ratingCountry] = useState(() => getRatingCountry(storage));
  const [apiKey] = useState(() => getApiKey());

  const itemsKey = useMemo(() => {
    if (!items?.length) return "";
    return items
      .map((i) => `${i.media_type === "tv" ? "tv" : "movie"}_${i.id}`)
      .sort()
      .join(",");
  }, [items]);

  useEffect(() => {
    if (!itemsKey || !apiKey) return;

    // Read cache once for the whole effect run
    const cache = evictStale(readCache());
    let cacheModified = false;

    // Seed from cache immediately (no flash)
    const initial = {};
    const missing = [];
    for (const item of items) {
      const type = item.media_type === "tv" ? "tv" : "movie";
      const cacheKey = `${type}_${item.id}_${ratingCountry}`;
      const entry = cache[cacheKey];
      const isValid = entry && Date.now() - entry.ts <= CACHE_TTL;
      if (isValid) {
        initial[`${type}_${item.id}`] = {
          cert: entry.cert,
          minAge: entry.minAge,
        };
      } else {
        missing.push(item);
      }
    }

    if (Object.keys(initial).length) {
      setRatingsMap((prev) => ({ ...prev, ...initial }));
    }

    if (!missing.length) return;

    let cancelled = false;
    (async () => {
      // Parallel: the tmdbFetch queue caps concurrency at 4, so this is 4-wide
      // not 20-wide. Dropping the 80ms sleep + sequential await turns ~3.6s
      // (20 × RTT+80ms) into ~5 batches × RTT ≈ 500ms. React 18 auto-batches
      // the setRatingsMap calls into one render instead of 20.
      await Promise.all(missing.map(async (item) => {
        if (cancelled) return;
        const type = item.media_type === "tv" ? "tv" : "movie";
        const mapKey = `${type}_${item.id}`;
        const cacheKey = `${type}_${item.id}_${ratingCountry}`;
        try {
          const result =
            type === "tv"
              ? await fetchTVRating(item.id, apiKey, ratingCountry)
              : await fetchMovieRating(item.id, apiKey, ratingCountry);
          if (!cancelled) {
            cache[cacheKey] = {
              cert: result.cert,
              minAge: result.minAge,
              ts: Date.now(),
            };
            cacheModified = true;
            setRatingsMap((prev) => ({ ...prev, [mapKey]: result }));
          }
        } catch {}
      }));
      // Write cache once at the end instead of after each item
      if (cacheModified && !cancelled) writeCache(cache);
    })();

    return () => {
      cancelled = true;
    };
  }, [itemsKey, apiKey, ratingCountry]);

  return { ratingsMap, ageLimitSetting, ratingCountry };
}

export function getRatingForItem(item, ratingsMap) {
  const type = item.media_type === "tv" ? "tv" : "movie";
  return ratingsMap[`${type}_${item.id}`] || { cert: null, minAge: null };
}
