// ── IPC: Collaps (api.delivembd.ws) — Lampa's online multi-audio source ──────
// Extracted from Lampa's src/plugins/online.js (collaps balancer), verified live:
//   GET https://api.delivembd.ws/embed/imdb/<imdbId>   (or /kp/<kinopoiskId>)
//   → HTML containing `makePlayer({ ... })` — a JS object literal with:
//       movie:  { source: { hls, dash, audio:{names:[...]}, cc } }
//       tv:     { playlist: { seasons: [{ season, episodes: [{episode, hls, ...}] }] } }
//   The HLS master manifest carries #EXT-X-MEDIA audio renditions (rus0..rusN,
//   ukr, eng) which map positionally to the `names` array (Russian dubs first).
// CDN sends Access-Control-Allow-Origin: *  → hls.js in the renderer loads it
// directly. We only fetch the embed page here (no CORS in main process) and
// return the resolved HLS URL + friendly audio names.

const { ipcMain } = require("electron");
const https = require("https");
const { URL } = require("url");

const EMBED = "https://api.delivembd.ws/embed/";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function fetchText(rawUrl, { headers = {}, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (e) {
      return reject(new Error("bad url"));
    }
    const lib = parsed.protocol === "https:" ? https : require("http");
    const opts = {
      method: "GET",
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: { "User-Agent": UA, Accept: "*/*", "Accept-Language": "ru,en;q=0.8", ...headers },
    };
    const req = lib.request(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, rawUrl).toString();
        return resolve(fetchText(next, { headers, timeout }));
      }
      if (res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.setTimeout(timeout, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

// Balanced-brace extraction of the makePlayer({...}) body.
function extractMakePlayer(html) {
  const i = html.indexOf("makePlayer({");
  if (i < 0) return null;
  const body = html.slice(i + "makePlayer(".length);
  let depth = 0;
  let end = -1;
  let inStr = false;
  let strCh = "";
  for (let idx = 0; idx < body.length; idx++) {
    const ch = body[idx];
    if (inStr) {
      if (ch === "\\") {
        idx++;
        continue;
      }
      if (ch === strCh) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      strCh = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = idx;
        break;
      }
    }
  }
  if (end < 0) return null;
  return body.slice(0, end + 1);
}

// Extract the first `names` audio-label array (valid JSON) anywhere in the obj.
// Used for movies where `audio: {"names":[...]}` is a quoted JSON sub-object.
function extractNames(obj, from = 0) {
  const re = /"names"\s*:\s*(\[[^\]]*\])/g;
  re.lastIndex = from;
  const m = re.exec(obj);
  if (!m) return [];
  try {
    // m[1] contains escaped unicode like Р — JSON.parse decodes it.
    return JSON.parse(m[1]);
  } catch {
    return [];
  }
}

// Match a `hls: "..."` or `"hls": "..."` value (tolerant of quoted/unquoted keys).
function matchHls(chunk) {
  const m = chunk.match(/"?hls"?\s*:\s*"([^"]+\.m3u8[^"]*)"/);
  return m ? m[1] : null;
}

// Balanced extraction of a `[...]` JSON array starting at/before `key:`.
// The seasons array in TV embeds is a fully-quoted JSON array, so we can
// JSON.parse it directly (unlike the rest of makePlayer, which has unquoted keys).
function extractJsonArray(obj, key) {
  const keyRe = new RegExp('"?(' + key + ')"?\\s*:\\s*\\[');
  const m = keyRe.exec(obj);
  if (!m) return null;
  const start = m.index + m[0].length - 1; // position of '['
  let depth = 0;
  let inStr = false;
  let strCh = "";
  for (let idx = start; idx < obj.length; idx++) {
    const ch = obj[idx];
    if (inStr) {
      if (ch === "\\") {
        idx++;
        continue;
      }
      if (ch === strCh) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      strCh = ch;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return obj.slice(start, idx + 1);
    }
  }
  return null;
}

// Parse the makePlayer object for a movie or a specific TV episode.
// TV structure (fully-quoted JSON): playlist.seasons = [{ season, episodes: [{episode, hls, audio:{names}, ...}] }]
// Movie structure (mixed quoting):  source = { hls, dash, audio: {"names":[...]} }
function parseCollaps(html, { type, season, episode } = {}) {
  const obj = extractMakePlayer(html);
  if (!obj) return { ok: false, error: "makePlayer не найден на странице embed" };

  const isTv = type === "tv";
  let hls = null;
  let dash = null;
  let audioNames = [];
  let subtitles = [];
  let duration = 0;

  if (isTv) {
    // The `seasons:[...]` array is valid JSON — parse it directly. This avoids
    // the `current: { season:1 }` pointer that broke the old regex approach.
    const arr = extractJsonArray(obj, "seasons");
    let seasons = null;
    if (arr) {
      try {
        seasons = JSON.parse(arr);
      } catch {
        seasons = null;
      }
    }
    if (!seasons || !seasons.length) {
      return { ok: false, error: "Сезоны не найдены на Collaps" };
    }
    // Find the requested season (1-based), fall back to first.
    let seasonObj = seasons.find((s) => Number(s.season) === Number(season));
    if (!seasonObj) seasonObj = seasons[0];
    const episodes = seasonObj.episodes || [];
    // Find the requested episode (episode_number may be string or number).
    let ep = episodes.find((e) => Number(e.episode) === Number(episode));
    if (!ep) ep = episodes[0];
    if (!ep) {
      return { ok: false, error: `Серия ${season}x${episode} не найдена на Collaps` };
    }
    hls = ep.hls || null;
    dash = ep.dash || ep.dasha || null;
    audioNames = (ep.audio && ep.audio.names) || [];
    subtitles = Array.isArray(ep.cc) ? ep.cc.map((c, i) => ({ url: c.url, name: c.name || `Субтитры ${i + 1}` })) : [];
    duration = ep.duration || 0;
    if (!hls && !dash) {
      return { ok: false, error: `Поток не найден для серии ${season}x${episode}` };
    }
  } else {
    // Movie: hls/dash live inside `source: { ... }`. Find the source block.
    const srcIdx = obj.search(/"?source"?\s*:\s*\{/);
    const from = srcIdx >= 0 ? srcIdx : 0;
    const sourceBlock = srcIdx >= 0 ? obj.slice(from, from + 4000) : obj;
    hls = matchHls(sourceBlock) || matchHls(obj);
    // dash URL inside source block (tolerant of quoted/unquoted keys).
    const dashM = sourceBlock.match(/"?dash"?\s*:\s*"([^"]+\.mpd[^"]*)"/);
    dash = dashM ? dashM[1] : null;
    audioNames = extractNames(obj);
    // Movie subtitles: source.cc is a quoted JSON array (like audio.names).
    const ccArr = extractJsonArray(obj, "cc");
    if (ccArr) {
      try {
        const cc = JSON.parse(ccArr);
        subtitles = cc.map((c, i) => ({ url: c.url, name: c.name || `Субтитры ${i + 1}` }));
      } catch {}
    }
    if (!hls && !dash) return { ok: false, error: "Поток не найден в source Collaps" };
  }

  return { ok: true, hls, dash, audioNames, subtitles, duration };
}

function register() {
  // Resolve a Collaps stream for a movie/episode.
  // Args: { imdbId?, kinopoiskId?, type: 'movie'|'tv', season?, episode? }
  ipcMain.handle("collaps-resolve", async (_, args) => {
    const { imdbId, kinopoiskId, type, season, episode } = args || {};
    if (!imdbId && !kinopoiskId) {
      return { ok: false, error: "Нужен imdb_id или kinopoisk_id" };
    }
    const url = imdbId
      ? `${EMBED}imdb/${encodeURIComponent(imdbId)}`
      : `${EMBED}kp/${encodeURIComponent(kinopoiskId)}`;
    try {
      const html = await fetchText(url, {
        headers: { Referer: "https://api.delivembd.ws/" },
      });
      const parsed = parseCollaps(html, { type, season, episode });
      return parsed;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Map a title → kinopoisk_id via kinopoiskapiunofficial (fallback when a TMDB
  // movie has no imdb_id). Key from env COLLAPS_KP_API_KEY; falls back to the
  // community key shipped in Lampa so the feature works out of the box.
  const KP_API_KEY =
    process.env.COLLAPS_KP_API_KEY || "2d55adfd-019d-4567-bbf7-67d503f61b5a";
  ipcMain.handle("collaps-find-kp", async (_, { query, year }) => {
    try {
      const q = encodeURIComponent(query || "");
      const url = `https://kinopoiskapiunofficial.tech/api/v2.1/films/search-by-keyword?keyword=${q}`;
      const txt = await fetchText(url, {
        headers: { "X-API-KEY": KP_API_KEY },
      });
      const json = JSON.parse(txt);
      const films = json.films || [];
      // Prefer exact year match, else first result
      let best = null;
      if (year) {
        best = films.find((f) => String(f.year) === String(year));
      }
      if (!best && films.length) best = films[0];
      if (!best) return { ok: false, error: "Кинопоиск ID не найден" };
      return { ok: true, kinopoiskId: best.filmId, title: best.nameRu || best.nameEn, year: best.year };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

module.exports = { register, parseCollaps };