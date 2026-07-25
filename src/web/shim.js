// Web shim: defines window.electron.* via fetch() to the server API.
// Only runs when there is NO window.electron already (i.e. not in Electron,
// where preload.js sets it via contextBridge). Safe to always import.
//
// This makes the desktop renderer work unchanged as a web app: the same
// components call window.electron.collapsResolve(...), secureGet("apikey"),
// tmdbProxyGet(), etc., and here they map to /api/* on the server.

if (!window.electron) {
  // Vercel/web mode: no server-side session. The site password is checked
  // client-side, and each visitor enters their OWN TMDB Read Access Token,
  // stored in localStorage. TMDB calls go through the /api/tmdb serverless
  // proxy. Collaps streams are resolved client-side (IP-bound tokens).
  // Mark this as the web shim so other modules can detect it synchronously.
  window.__webShim = true;

  const LS_SITE_PWD = "lampa_stream_site_pwd";
  const LS_TMDB = "lampa_stream_tmdb_token";

  // ── Collaps browser-side resolver (inlined, no separate module needed) ──────
  // The browser fetches the embed HTML, parses makePlayer, returns the
  // stream URL.
  //
  // Russia/no-VPN: api.delivembd.ws and *.interkh.com (the Collaps embed +
  // CDN hosts) are blocked/throttled for many Russian ISPs, even though
  // there's no such block on Vercel's own network. So — unlike the comment
  // that used to be here — we do NOT hit these hosts directly from the
  // browser anymore. Instead every request (embed HTML, the DASH/HLS
  // manifest, and its segments) is routed through the /api/collaps
  // serverless proxy (see api/collaps.js), which runs on Vercel's
  // infrastructure and forwards to the real host. Because the proxy (not
  // the browser) is what ultimately talks to the Collaps CDN, "the same IP
  // must resolve the embed AND fetch the segments" is still satisfied —
  // it's just Vercel's IP throughout instead of the browser's.
  const COLLAPS_HOSTS = { EMBED: "api.delivembd.ws" };
  const collapsProxyUrl = (host, pathAndQuery) =>
    `/api/collaps/h/${encodeURIComponent(host)}${pathAndQuery.startsWith("/") ? "" : "/"}${pathAndQuery}`;
  // Rewrite an absolute Collaps CDN URL (api.delivembd.ws or *.interkh.com)
  // to go through our proxy instead. Non-Collaps / relative URLs are
  // returned unchanged (dash.js/hls.js resolve relative URLs against the
  // manifest's own — already proxied — URL, so they end up proxied too).
  function collapsifyUrl(u) {
    if (!u) return u;
    try {
      const parsed = new URL(u, location.origin);
      const host = parsed.hostname.toLowerCase();
      const isCollaps = host === COLLAPS_HOSTS.EMBED || host.endsWith(".interkh.com");
      if (!isCollaps) return u;
      return collapsProxyUrl(host, parsed.pathname + parsed.search);
    } catch {
      return u;
    }
  }
  const COLLAPS_EMBED = collapsProxyUrl(COLLAPS_HOSTS.EMBED, "/embed/");

  function extractMakePlayer(html) {
    const i = html.indexOf("makePlayer({");
    if (i < 0) return null;
    const body = html.slice(i + 11);
    let depth = 0, end = -1, inStr = false, strCh = "";
    for (let idx = 0; idx < body.length; idx++) {
      const ch = body[idx];
      if (inStr) { if (ch === "\\") { idx++; continue; } if (ch === strCh) inStr = false; continue; }
      if (ch === '"' || ch === "'") { inStr = true; strCh = ch; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { end = idx; break; } }
    }
    if (end < 0) return null;
    return body.slice(0, end + 1);
  }

  function extractJsonArray(obj, key) {
    const re = new RegExp('"?(' + key + ')"?\\s*:\\s*\\[');
    const m = re.exec(obj);
    if (!m) return null;
    const start = m.index + m[0].length - 1;
    let depth = 0, inStr = false, strCh = "";
    for (let idx = start; idx < obj.length; idx++) {
      const ch = obj[idx];
      if (inStr) { if (ch === "\\") { idx++; continue; } if (ch === strCh) inStr = false; continue; }
      if (ch === '"' || ch === "'") { inStr = true; strCh = ch; continue; }
      if (ch === "[") depth++;
      else if (ch === "]") { depth--; if (depth === 0) return obj.slice(start, idx + 1); }
    }
    return null;
  }

  function extractNames(obj) {
    const m = /"names"\s*:\s*(\[[^\]]*\])/.exec(obj);
    if (!m) return [];
    try { return JSON.parse(m[1]); } catch { return []; }
  }

  function matchHls(chunk) {
    const m = chunk.match(/"?hls"?\s*:\s*"([^"]+\.m3u8[^"]*)"/);
    return m ? m[1] : null;
  }

  function parseCollapsHtml(html, type, season, episode) {
    const obj = extractMakePlayer(html);
    if (!obj) return { ok: false, error: "makePlayer not found" };
    let hls = null, dash = null, audioNames = [], subtitles = [], duration = 0;
    if (type === "tv") {
      const arr = extractJsonArray(obj, "seasons");
      let seasons = null;
      if (arr) { try { seasons = JSON.parse(arr); } catch {} }
      if (!seasons || !seasons.length) return { ok: false, error: "No seasons" };
      let sObj = seasons.find((s) => Number(s.season) === Number(season)) || seasons[0];
      const eps = sObj.episodes || [];
      let ep = eps.find((e) => Number(e.episode) === Number(episode)) || eps[0];
      if (!ep) return { ok: false, error: "Episode not found" };
      hls = ep.hls || null;
      dash = ep.dash || ep.dasha || null;
      audioNames = (ep.audio && ep.audio.names) || [];
      subtitles = Array.isArray(ep.cc) ? ep.cc.map((c, i) => ({ url: c.url, name: c.name || "Sub " + (i + 1) })) : [];
      duration = ep.duration || 0;
    } else {
      const srcIdx = obj.search(/"?source"?\s*:\s*\{/);
      const from = srcIdx >= 0 ? srcIdx : 0;
      const block = srcIdx >= 0 ? obj.slice(from, from + 4000) : obj;
      hls = matchHls(block) || matchHls(obj);
      const dm = block.match(/"?dash"?\s*:\s*"([^"]+\.mpd[^"]*)"/);
      dash = dm ? dm[1] : null;
      audioNames = extractNames(obj);
      const ccArr = extractJsonArray(obj, "cc");
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
    return { ok: true, hls, dash, audioNames, subtitles, duration };
  }

  // ── Collaps embed cache (session) ──────────────────────────────────────────
  // The embed URL (keyed by imdbId / kinopoiskId) returns the SAME HTML for
  // every season/episode of a show — it contains the full makePlayer object
  // with all seasons. Re-fetching on every episode switch is wasteful (a full
  // HTTP round-trip + parse). Cache the raw HTML for 10 min and re-parse with
  // the new season/episode on a hit. Keyed by id so different shows don't
  // collide.
  const _collapsCache = new Map(); // key → { html, expiresAt }
  const COLLAPS_CACHE_TTL = 10 * 60 * 1000;

  async function collapsResolveWeb(args) {
    const { imdbId, kinopoiskId, type, season, episode } = args;
    if (!imdbId && !kinopoiskId) return { ok: false, error: "Need imdb or kp id" };
    const cacheKey = imdbId ? `imdb:${imdbId}` : `kp:${kinopoiskId}`;
    const now = Date.now();
    const cached = _collapsCache.get(cacheKey);
    if (cached && now < cached.expiresAt) {
      // Re-parse the cached HTML for the requested season/episode — no fetch.
      try {
        return parseCollapsHtml(cached.html, type, Number(season), Number(episode));
      } catch {
        _collapsCache.delete(cacheKey); // corrupt — re-fetch below
      }
    }
    const url = imdbId
      ? COLLAPS_EMBED + "imdb/" + encodeURIComponent(imdbId)
      : COLLAPS_EMBED + "kp/" + encodeURIComponent(kinopoiskId);
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(t);
      if (!res.ok) return { ok: false, error: "HTTP " + res.status };
      const html = await res.text();
      _collapsCache.set(cacheKey, { html, expiresAt: now + COLLAPS_CACHE_TTL });
      return parseCollapsHtml(html, type, Number(season), Number(episode));
    } catch (e) {
      return { ok: false, error: e.name === "AbortError" ? "timeout" : e.message };
    }
  }

  // ── Server config (Express only): shared TMDB token + auth check ──────────
  // On the Express server (server/index.js), GET /api/config returns the shared
  // TMDB Read Access Token behind the session cookie, so visitors don't each
  // need their own token. On Vercel there is no /api/config (404) → we fall
  // back to the per-visitor token in localStorage (SetupScreen). Cached after
  // the first call.
  let _config = null;
  let _configTried = false;
  async function getConfig() {
    if (_configTried) return _config;
    _configTried = true;
    try {
      const r = await fetch("/api/config", { cache: "no-store" });
      if (r.status === 401) {
        // Express: not logged in → send to the server-rendered login page.
        if (location.pathname !== "/login") location.href = "/login";
        return null;
      }
      if (!r.ok) return null; // 404 on Vercel → no shared token
      _config = await r.json();
      return _config;
    } catch {
      return null;
    }
  }

  window.electron = {
    // ── TMDB token: a per-visitor token (localStorage) wins; otherwise fall
    // back to the Express server's shared token via /api/config. null → the
    // SetupScreen (Vercel per-visitor flow).
    secureGet: async (key) => {
      if (key === "apikey") {
        try { const local = localStorage.getItem(LS_TMDB); if (local) return local; } catch {}
        const c = await getConfig();
        return c ? c.tmdbToken : null;
      }
      return null;
    },
    secureSet: async (key, value) => {
      if (key === "apikey") {
        try {
          if (value) localStorage.setItem(LS_TMDB, value);
          else localStorage.removeItem(LS_TMDB);
        } catch {}
      }
    },

    // ── TMDB proxy: signal "web mode" so api.js uses /api/tmdb + /api/img ──
    tmdbProxyGet: async () => ({ on: true, web: true }),
    tmdbProxySet: async () => ({ on: true, web: true }),

    // ── Collaps online source: resolved IN the browser (IP-bound tokens) ───
    collapsResolve: async (args) => collapsResolveWeb(args),
    collapsFindKp: async (args) => {
      // kinopoisk-id-by-title: not IP-bound, can go direct from the browser.
      const qs = new URLSearchParams({ ...args }).toString();
      try {
        const r = await fetch(
          "https://kinopoiskapiunofficial.tech/api/v2.1/films/search-by-keyword?" +
            qs.replace("query=", "keyword="),
          { headers: { "X-API-KEY": "2d55adfd-019d-4567-bbf7-67d503f61b5a" } },
        );
        const json = await r.json();
        const films = json.films || [];
        let best = null;
        if (args.year) best = films.find((f) => String(f.year) === String(args.year));
        if (!best && films.length) best = films[0];
        if (!best) return { ok: false, error: "Кинопоиск ID не найден" };
        return { ok: true, kinopoiskId: best.filmId, title: best.nameRu || best.nameEn, year: best.year };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    // ── App info ───────────────────────────────────────────────────────────
    getAppVersion: async () => "web",
    getPlatform: async () => "web",

    // ── Browser-native fallbacks ───────────────────────────────────────────
    openExternal: (url) => {
      try {
        window.open(url, "_blank", "noopener");
      } catch {}
      return Promise.resolve(true);
    },
    showNotification: async (title, body) => {
      try {
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification(title, { body });
        }
      } catch {}
    },

    // ── TorrServer source: not available on web (online-only) ──────────────
    torrPing: async () => ({ ok: false, error: "TorrServer source is desktop-only" }),
    torrList: async () => ({ ok: false, list: [] }),
    torrAdd: async () => ({ ok: false, error: "desktop-only" }),
    torrAddFile: async () => ({ ok: false, error: "desktop-only" }),
    torrGet: async () => ({ ok: false }),
    torrRem: async () => ({ ok: false }),
    torrStream: async () => ({ ok: false }),
    torrExternal: async () => ({ ok: false }),
    torrSearch: async () => ({ ok: false, results: [] }),
    torrGetCfg: async () => ({}),
    torrSetCfg: async () => ({}),
    pickTorrentFile: async () => ({ ok: false }),

    // ── Desktop-only IPC stubs (no-ops; the web app uses the Онлайн source) ─
    // Window controls, downloads, updates, PiP, webview VidSrc, backups, etc.
    // — not applicable in a browser. Returning benign values keeps components
    // that call them from crashing.
    windowMinimize: () => {}, windowToggleMaximize: () => {}, windowClose: () => {},
    windowIsMaximized: async () => false, quitApp: () => {}, setZoomFactor: () => {},
    getInstallPath: async () => null, getAppVersion: async () => "web",
    getCacheSize: async () => 0, getDownloadsSize: async () => 0,
    clearAppCache: async () => ({}), clearWatchData: async () => ({}),
    resetApp: async () => ({}),
    getDownloads: async () => [], runDownload: async () => ({}),
    deleteDownload: async () => ({}), deleteAllDownloads: async () => ({}),
    scanDirectory: async () => ({ files: [] }), pickFolder: async () => ({ ok: false }),
    fileExists: async () => false, openPath: async () => {},
    openPathAtTime: async () => {}, showInFolder: async () => {},
    getVideoDuration: async () => ({ ok: false }),
    searchSubtitles: async () => ({ ok: false }),
    downloadSubtitlesForFile: async () => ({ ok: false }),
    getSubtitleUrl: async () => null, deleteSubtitleFile: async () => {},
    pruneSubtitlePaths: async () => ({}),
    checkDownloader: async () => ({ ok: false }),
    getBlockStats: async () => ({}), fetchReleaseImage: async () => null,
    detectUpdateFormat: async () => null, downloadAndInstallUpdate: async () => ({}),
    cancelUpdate: () => {}, offBlockedUpdate: () => {}, onBlockedUpdate: () => {},
    onUpdateProgress: () => {}, offUpdateProgress: () => {},
    onConfirmClose: () => {}, offConfirmClose: () => {},
    onScheduledBackupRequested: () => {}, offScheduledBackupRequested: () => {},
    onSubtitleFound: () => {}, offSubtitleFound: () => {},
    onWindowMaximize: () => {}, offWindowMaximize: () => {},
    onWebviewEnterFullscreen: () => {}, offWebviewEnterFullscreen: () => {},
    onWebviewLeaveFullscreen: () => {}, offWebviewLeaveFullscreen: () => {},
    onM3u8Found: () => {}, offM3u8Found: () => {},
    onPipOpened: () => {}, offPipOpened: () => {}, onPipClosed: () => {}, offPipClosed: () => {},
    openPipWindow: async () => {}, closePipWindow: async () => {},
    getPipWebContentsId: async () => null, queryVideoProgress: async () => null,
    playerStopped: () => {},
    performScheduledBackup: async () => ({}),
    getScheduledBackupSettings: async () => ({}),
    setScheduledBackupSettings: async () => ({}),
    wyzieOpenRedeem: async () => ({}), wyzieValidateKey: async () => ({ ok: false }),
    onDownloadProgress: () => {}, offDownloadProgress: () => {},
  };
}
