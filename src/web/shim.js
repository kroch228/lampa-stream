// ── Browser shim: stub Electron's `window.electron` API in web-mode ─────────
// When running on Vercel (no Electron), window.electron is undefined — so any
// code that calls window.electron.* would crash. This shim injects the same
// API surface the renderer expects, using browser-native fetches instead of
// Electron IPC.
//
// Detection: loaded by index.html via <script> tag with no guard — it only
// installs itself when !window.electron. The shim replaces the Electron IPC
// bridge with fetch-based calls to the Vercel serverless functions / raw
// upstream HTTP calls, keeping the same return shape.
//
// Added to this file (collapsifyUrl + parseCollapsHtml changes):
//   Route all Collaps URLs (embed HTML, DASH .mpd, HLS .m3u8, subtitle VTT)
//   through the /api/collaps proxy instead of hitting *.interkh.com /
//   api.delivembd.ws directly, so the Collaps source works for users in
//   regions where those hosts are blocked (notably Russia). See api/collaps.js.

const COLLAPS_EMBED_BY_ID =
  "https://api.delivembd.ws/embed/imdb/";
const COLLAPS_EMBED_BY_KP =
  "https://api.delivembd.ws/embed/kp/";
const COLLAPS_KP_SEARCH =
  "https://api.delivembd.ws/v1/kinopoisk/search/";

// Proxy-aware version of the embed URLs. In web-mode (which loads this shim),
// route through the Vercel serverless proxy so Collaps hosts that may be
// blocked from the user's browser are reached from Vercel's network instead.
// The proxy endpoint /api/collaps/h/<host>/<path> is matched by a rewrite
// rule in vercel.json.
const COLLAPS_EMBED_BY_ID_PROXY =
  "/api/collaps/h/api.delivembd.ws/embed/imdb/";
const COLLAPS_EMBED_BY_KP_PROXY =
  "/api/collaps/h/api.delivembd.ws/embed/kp/";
const COLLAPS_KP_SEARCH_PROXY =
  "/api/collaps/h/api.delivembd.ws/v1/kinopoisk/search/";

// Collaps hosts that should be rewritten through the proxy.
const COLLAPS_HOSTS = ["api.delivembd.ws", ".interkh.com"];

/** Rewrite absolute URLs whose host matches a known Collaps host through the
 *  /api/collaps/h/... proxy. Relative URLs and non-Collaps hosts pass through
 *  unchanged. This is applied to the manifest URL (so dash.js/hls.js load it
 *  from the proxy) — any RELATIVE segment/init URLs inside the manifest are
 *  then resolved against the already-proxied URL automatically. Absolute
 *  segment URLs baked into the manifest body are also rewritten if they point
 *  at a known Collaps host.
 */
function collapsifyUrl(url) {
  if (!url || typeof url !== "string") return url;
  try {
    const u = new URL(url);
    const host = u.host;
    if (COLLAPS_HOSTS.some((h) => host === h || host.endsWith(h))) {
      return `/api/collaps/h/${host}${u.pathname}${u.search}`;
    }
    return url; // not a collaps URL
  } catch {
    return url; // not parseable as URL (e.g. already relative)
  }
}

// ── parseCollapsHtml: extract dash/hls/subtitle URLs from Collaps embed page ──
function parseCollapsHtml(html) {
  if (!html || typeof html !== "string") return { ok: false, error: "No content" };
  const i = html.indexOf("makePlayer({");
  if (i < 0) return { ok: false, error: "No makePlayer" };
  let depth = 0, start = i + "makePlayer(".length - 1;
  for (let j = start; j < html.length; j++) {
    if (html[j] === "{") depth++;
    else if (html[j] === "}") { depth--; if (depth === 0) { start = i + "makePlayer(".length; try { return processPlayerObj(JSON.parse(html.slice(start, j + 1))); } catch (e) { return { ok: false, error: `makePlayer parse error: ${e.message}` }; } } }
  }
  return { ok: false, error: "Unclosed makePlayer" };
}

function processPlayerObj(obj) {
  let hls = obj.hls || obj.cf?.hls || obj.cf?.m3u8 || null;
  let dash = obj.dash || obj.cf?.dash || obj.cf?.mpd || null;
  if (Array.isArray(hls)) hls = hls[0];
  if (Array.isArray(dash)) dash = dash[0];
  let audioNames = [];
  try { const an = obj.audio || obj.cf?.audio || []; if (Array.isArray(an)) audioNames = an.filter(Boolean); } catch {}
  let subtitles = [];
  if (!dash && !hls) {
    // try alternative property names used by some embeds
    dash = obj.mpd || obj.url?.mpd || null;
    hls = obj.m3u8 || obj.url?.m3u8 || null;
  }
  // Collaps puts cc (subtitle) tracks inside the makePlayer object
  if (!subtitles.length) {
    const ccArr = obj.cc || obj.cf?.cc || obj.subtitles || null;
    if (ccArr) { try { const cc = JSON.parse(ccArr); subtitles = cc.map((c, i) => ({ url: c.url, name: c.name || "Sub " + (i + 1) })); } catch {} }
  }
  if (!hls && !dash) return { ok: false, error: "No stream URL" };
  // Route the manifest (and subtitle) URLs through the /api/collaps proxy
  // instead of hitting the CDN host (*.interkh.com / api.delivembd.ws)
  // directly from the browser — see collapsifyUrl() above. dash.js/hls.js
  // then resolve any RELATIVE segment/init URLs inside the manifest
  // against this (already-proxied) URL, so those go through the proxy
  // too automatically. Absolute segment URLs baked into the manifest are
  // rewritten too, IF they point at a known Collaps host.
  hls = collapsifyUrl(hls);
  dash = collapsifyUrl(dash);
  subtitles = subtitles.map((s) => ({ ...s, url: collapsifyUrl(s.url) }));
  return { ok: true, hls, dash, audioNames, subtitles, duration: obj.duration || 0 };
}

if (!window.electron) {
  // ── Browser-only shim ───────────────────────────────────────────────────
  const SEARCH_META = document.querySelector('meta[name="tmdb-proxy-base"]');
  const tmdbProxyBase = SEARCH_META ? SEARCH_META.getAttribute("content") || "" : "";

  const tmdbFetchOrig = globalThis.fetch.bind(globalThis);

  window.electron = {
    setTmdbProxyBase(base) {},
    setTorrserverSettings(s) {},
    getTorrserverSettings() { /* web-mode defaults */ return Promise.resolve({
      torrserverUrl: "http://127.0.0.1:8090", jackettUrl: "", jackettKey: "", torrserverType: "",
      preferredAudio: "RU", externalPlayer: "auto", tmdbProxy: true, forceTorrserverHls: false,
    }); },
    checkTorrserver() { return Promise.resolve({ ok: false, error: "No TorrServer in web-mode" }); },
    resolveTorrAddr() { return Promise.resolve(null); },
    addTorrByHash() { return Promise.resolve(null); },
    addTorrByLink() { return Promise.resolve(null); },
    getTorrStat() { return Promise.resolve(null); },
    getTorrFiles() { return Promise.resolve(null); },
    fetchTorrM3u8() { return Promise.resolve(null); },
    openExternalFile() { return Promise.resolve(null); },
    playExternalPlayer() {},
    toggleTorrserverHls() {},
    setIntroSkipMode() {},
    storeGet(key) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; } },
    storeSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} },
    storeDel(key) { try { localStorage.removeItem(key); } catch {} },
    ipcOn() {},
    ipcOff() {},
    ipcRemoveAll() {},

    // ── TMDB fetch: proxy-aware ───────────────────────────────────────────
    async tmdbFetch(path, apiKey) {
      const proxy = tmdbProxyBase || "";
      if (proxy && !path.startsWith("http")) {
        const url = `${proxy}${path}`;
        const r = await tmdbFetchOrig(url);
        if (r.ok) return r.json();
        // fallback: if proxy is up but its API token is wrong, try direct
        try {
          const fallback = `https://api.themoviedb.org/3${path}`;
          const fr = await tmdbFetchOrig(fallback);
          if (fr.ok) return fr.json();
        } catch {}
        throw new Error(`TMDB proxy error: ${r.status}`);
      }
      const direct = `https://api.themoviedb.org/3${path}`;
      const r = await tmdbFetchOrig(direct, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
      if (!r.ok) throw new Error(`TMDB error: ${r.status}`);
      return r.json();
    },

    // ── TMDB image proxy: rewrite URLs through the configured proxy base ──
    imageUrl(original) {
      if (!original) return "";
      const proxy = tmdbProxyBase || "";
      if (proxy) return original.replace(/^https?:\/\/image\.tmdb\.org\//, `${proxy.replace(/\/$/, "")}/`);
      return original;
    },

    // ── Collaps resolve: fetch embed from Collaps, parse, return stream ───
    async collapsResolve({ imdbId, kinopoiskId, type, season, episode }) {
      try {
        let url;
        if (kinopoiskId) {
          const q = kinopoiskId;
          // Use proxy URL for Collaps embed fetch
          url = COLLAPS_EMBED_BY_KP_PROXY + q + (type === "tv" && season ? `?s=${season}&e=${episode}` : "");
        } else if (imdbId) {
          const q = imdbId.replace("tt", "").replace(/\D/g, "");
          url = COLLAPS_EMBED_BY_ID_PROXY + q + (type === "tv" && season ? `?s=${season}&e=${episode}` : "");
        } else {
          return { ok: false, error: "No id" };
        }
        const r = await fetch(url);
        if (!r.ok) return { ok: false, error: `Collaps embed fetch failed: ${r.status}` };
        const html = await r.text();
        return parseCollapsHtml(html);
      } catch (e) {
        return { ok: false, error: e?.message || "Fetch error" };
      }
    },

    async collapsFindKp({ query, year }) {
      try {
        // Use proxy for KP search as well
        const url = COLLAPS_KP_SEARCH_PROXY + encodeURIComponent(query) + (year ? `?year=${year}` : "");
        const r = await fetch(url);
        if (!r.ok) return { ok: false, error: `Search failed: ${r.status}` };
        const data = await r.json();
        return (data && data.length) ? { ok: true, kinopoiskId: data[0].kp, title: data[0].title } : { ok: false, error: "No results" };
      } catch (e) {
        return { ok: false, error: e?.message || "Search error" };
      }
    },
  };
}
