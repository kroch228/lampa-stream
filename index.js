// -- Streambert main process entry point ---------------------------------------
// Responsible for: window creation, session setup, ad-blocking, scheduled
// backup trigger, and app lifecycle. All heavy IPC logic lives in src/ipc/.

const {
  app,
  BrowserWindow,
  ipcMain,
  session,
  webContents,
  Notification,
} = require("electron");
const path = require("path");

// -- RAM / performance flags ---------------------------------------------------
app.commandLine.appendSwitch(
  "js-flags",
  "--max-old-space-size=256 --expose-gc",
);
app.commandLine.appendSwitch(
  "disable-features",
  "HardwareMediaKeyHandling,MediaSessionService,UseSandboxedXdgPortal",
);
// Run the network stack in the browser process → one less utility process
app.commandLine.appendSwitch("enable-features", "NetworkServiceInProcess2");
// NOTE: enable-low-end-device-mode removed, it cuts the GPU texture tile budget
// and causes visible seams/stripes/dots on large images.

// Cap disk cache and limit renderer processes (prevents RAM growth on multi-page navigation)
app.commandLine.appendSwitch("disk-cache-size", String(80 * 1024 * 1024));
app.commandLine.appendSwitch("renderer-process-limit", "3");

// -- Startup benchmark ---------------------------------------------------------
const _t0 = Date.now();
const _bench = (label) =>
  console.log(`[boot] ${label}: +${Date.now() - _t0}ms`);

// -- Sub-modules ---------------------------------------------------------------
const blockStats = require("./src/ipc/blockStats");
const storageIpc = require("./src/ipc/storage");
const downloadsIpc = require("./src/ipc/downloads");
const subtitlesIpc = require("./src/ipc/subtitles");
const allmangaIpc = require("./src/ipc/allmanga");
const playerIpc = require("./src/ipc/player");
const torrIpc = require("./src/ipc/torrserver");
const collapsIpc = require("./src/ipc/collaps");

// ── TorrServer/Jackett config (persisted in userData) ────────────────────────
// NOTE: app.getPath("userData") is only valid after app.whenReady(), so the
// config file path is resolved lazily inside load/save, not at module load.
const fs = require("fs");
const TORR_CFG_NAME = "lampa-stream-torrserver.json";
function torrCfgPath() {
  try {
    return path.join(app.getPath("userData"), TORR_CFG_NAME);
  } catch {
    // app not ready yet (or no userData) → fall back to the project dir
    return path.join(__dirname, TORR_CFG_NAME);
  }
}
function loadTorrCfg() {
  try {
    const raw = fs.readFileSync(torrCfgPath(), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
const torrCfgRef = {
  cfg: {
    torrserverUrl: "http://127.0.0.1:8090",
    jackettUrl: "",
    jackettKey: "",
    preferAudio: "ru",
    externalPlayer: "auto",
  },
};
// Pull in any persisted config once the IPC module needs it (lazy on first get).
function saveTorrCfg(cfg) {
  try {
    fs.writeFileSync(torrCfgPath(), JSON.stringify(cfg, null, 2));
  } catch {}
}

// -- Ad/tracker block list -----------------------------------------------------
const BLOCKED_HOSTS = [
  "*://www.google-analytics.com/*",
  "*://analytics.google.com/*",
  "*://googletagmanager.com/*",
  "*://www.googletagmanager.com/*",
  "*://googletagservices.com/*",
  "*://doubleclick.net/*",
  "*://*.doubleclick.net/*",
  "*://adservice.google.com/*",
  "*://adservice.google.de/*",
  "*://pagead2.googlesyndication.com/*",
  "*://stats.g.doubleclick.net/*",
  "*://yt3.ggpht.com/ytc/*",
  "*://fonts.googleapis.com/*",
  "*://fonts.gstatic.com/*",
  "*://googleapis.com/*",
  "*://gstatic.com/*",
  "*://cdn.adx1.com/*",
  "*://intelligenceadx.com/*",
  "*://adsco.re/*",
  "*://mc.yandex.com/*",
  "*://mc.yandex.ru/*",
  "*://bvtpk.com/*",
  "*://my.rtmark.net/*",
  "*://bvtpk.com/*",
  "*://b7510.com/*",
  "*://gt.unbrownunflat.com/*",
  "*://im.malocacomals.com/*",
  "*://users.videasy.net/*",
  "*://nf.sixmossin.com/*",
  "*://realizationnewestfangs.com/*",
  "*://acscdn.com/*",
  "*://lt.taloseempest.com/*",
  "*://pl26708123.profitableratecpm.com/*",
  "*://preferencenail.com/*",
  "*://protrafficinspector.com/*",
  "*://s10.histats.com/*",
  "*://weirdopt.com/*",
  "*://static.cloudflareinsights.com/*",
  "*://kettledroopingcontinuation.com/*",
  "*://wayfarerorthodox.com/*",
  "*://woxaglasuy.net/*",
  "*://adeptspiritual.com/*",
  "*://www.calculating-laugh.com/*",
  "*://amavhxdlofklxjg.xyz/*",
  "*://7jtjubf8p5kq7x3z2.u3qleufcm6vure326ktfpbj.cfd/*",
  "*://5mq.get64t9vqg8pnbex1y463o.rest/*",
  "*://usrpubtrk.com/*",
  "*://adexchangeclear.com/*",
  "*://rzjzjnavztycv.online/*",
  "*://tmstr4.cloudnestra.com/*",
  "*://tmstr4.neonhorizonworkshops.com/*",
];

// -- Module-level state --------------------------------------------------------
let mainWindow = null;
const getMainWindow = () => mainWindow;

const playerWcIds = new Set();
let sessionsConfigured = false;

function setupSession(playerSession, trailerSession) {
  const stripHeaders = (details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase();
      if (lower === "x-frame-options" || lower === "content-security-policy")
        delete headers[key];
    }
    callback({ responseHeaders: headers });
  };

  const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  playerSession.setUserAgent(UA);
  trailerSession.setUserAgent(UA);

  playerSession.webRequest.onHeadersReceived(
    { urls: ["*://*/*"] },
    stripHeaders,
  );
  trailerSession.webRequest.onHeadersReceived(
    { urls: ["*://*/*"] },
    stripHeaders,
  );

  // Trailer: block ads only (no media intercept needed)
  trailerSession.webRequest.onBeforeRequest({ urls: BLOCKED_HOSTS }, (_, cb) =>
    cb({ cancel: true }),
  );

  // Player session: block ads + intercept m3u8/vtt URLs for renderer
  const MEDIA_URLS = [
    "*://*/*.m3u8*",
    "*://*/*.m3u8",
    "*://*/*.vtt*",
    "*://*/*.vtt",
  ];
  playerSession.webRequest.onBeforeRequest(
    { urls: [...BLOCKED_HOSTS, ...MEDIA_URLS] },
    (details, callback) => {
      const { url } = details;
      const isMedia = url.includes(".m3u8") || url.includes(".vtt");
      if (!isMedia) {
        blockStats.recordBlockedRequest(url);
        callback({ cancel: true });
        return;
      }
      // Media URL: check if it also happens to be on a blocked domain
      try {
        const host = new URL(url).hostname;
        const blocked = BLOCKED_HOSTS.some((pat) => {
          const hostPat = pat.replace(/^\*:\/\//, "").split("/")[0];
          return hostPat.startsWith("*.")
            ? host.endsWith(hostPat.slice(1))
            : host === hostPat || host === hostPat.replace(/^\*\./, "");
        });
        if (blocked) {
          blockStats.recordBlockedRequest(url);
          callback({ cancel: true });
          return;
        }
      } catch {}
      // Pass through + notify renderer
      const mw = getMainWindow();
      if (mw && !mw.isDestroyed()) {
        if (url.includes(".m3u8")) {
          mw.webContents.send("m3u8-found", url);
        } else if (url.includes(".vtt")) {
          const { extractSubtitleLang } = require("./src/ipc/subtitles");
          mw.webContents.send("subtitle-found", {
            url,
            lang: extractSubtitleLang(url),
          });
        }
      }
      callback({});
    },
  );

  // YouTube consent cookie → suppress consent gate in both sessions
  const ytCookie = {
    url: "https://www.youtube.com",
    name: "SOCS",
    value: "CAI",
    path: "/",
    secure: true,
    httpOnly: false,
    sameSite: "no_restriction",
    expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365 * 2,
  };
  for (const domain of [".youtube.com", ".youtube-nocookie.com"]) {
    const cookie = { ...ytCookie, domain };
    trailerSession.cookies.set(cookie).catch(() => {});
    playerSession.cookies.set(cookie).catch(() => {});
  }
}

function createWindow() {
  storageIpc.applySecretMigrationIfNeeded();
  downloadsIpc.loadDownloads();
  blockStats.loadBlockStats();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0a0a0a",
    icon:
      process.platform === "linux"
        ? path.join(__dirname, "public/sized/256x256.png")
        : undefined,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    frame: process.platform !== "win32",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      backgroundThrottling: true,
      spellcheck: false,
      // Caps the renderer's V8 heap + exposes gc() for manual GC hints after navigation
      additionalArguments: ["--js-flags=--max-old-space-size=256 --expose-gc"],
    },
  });

  // Force long-lived disk caching for TMDB images in the default session.
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ["*://image.tmdb.org/*"] },
    (details, callback) => {
      const headers = { ...details.responseHeaders };
      headers["cache-control"] = ["public, max-age=604800, immutable"]; // 7 days
      delete headers["pragma"];
      delete headers["expires"];
      callback({ responseHeaders: headers });
    },
  );

  // ── CORS fix for the Collaps online source ──────────────────────────────────
  // The Collaps CDN (*.interkh.com, api.delivembd.ws) reflects the request Origin
  // in Access-Control-Allow-Origin. The renderer loads via file:// (loadFile),
  // whose origin the CDN doesn't echo back as a matching ACAO, so hls.js's
  // cross-origin segment fetches fail. Force ACAO:* on all CDN responses so
  // hls.js can load manifest + sub-playlists + .ts segments cleanly.
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ["*://*.interkh.com/*", "*://api.delivembd.ws/*"] },
    (details, callback) => {
      const headers = { ...details.responseHeaders };
      headers["access-control-allow-origin"] = ["*"];
      headers["access-control-allow-headers"] = ["*"];
      if (!headers["access-control-expose-headers"]) {
        headers["access-control-expose-headers"] = ["*"];
      }
      callback({ responseHeaders: headers });
    },
  );

  // ── User-Agent fix for the Collaps CDN ───────────────────────────────────────
  // The Collaps CDN returns HTTP 410 (Gone) for .ts segments when the request
  // carries an Electron User-Agent (it blocks "Electron/..." clients). hls.js in
  // the renderer inherits the session UA, which contains "Electron". Rewrite the
  // UA to a plain Chrome string for all Collaps CDN requests so segments load.
  const COLLAPS_UA =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ["*://*.interkh.com/*", "*://api.delivembd.ws/*"] },
    (details, callback) => {
      const headers = { ...details.requestHeaders };
      headers["User-Agent"] = COLLAPS_UA;
      callback({ requestHeaders: headers });
    },
  );

  // ── TMDB proxy (Russia / no-VPN, via DoH IPv4) ──────────────────────────────
  // A local HTTP proxy in the main process that forwards to the REAL
  // api.themoviedb.org / image.tmdb.org, preserving the user's Bearer token.
  // The renderer calls http://127.0.0.1:<port>/api/3/... (and /img/t/p/...);
  // main forwards over HTTPS to TMDB with the original headers + permissive CORS.
  // This works with the user's v4 Read Access Token (the public community v3
  // proxies only accept v3 api_key and reject Bearer JWTs with 401).
  //
  // DNS: in Russia the system resolver returns TMDB's IPv6 (CloudFront), which
  // ISPs block/throttle. We resolve via DNS-over-HTTPS (Cloudflare 1.1.1.1) to
  // a real IPv4 and connect with family:4. No VPN needed. Falls back to the
  // system resolver if DoH fails.
  let tmdbProxyOn = true;
  const httpServerLib = require("http");
  const httpsServerLib = require("https");
  const dnsLib = require("dns");
  const dohCache = new Map(); // host → { ips, expiresAt }
  const DOH_TTL = 60 * 1000;
  async function dohResolve(host) {
    const now = Date.now();
    const hit = dohCache.get(host);
    if (hit && hit.ips.length && now < hit.expiresAt) return hit.ips;
    const providers = [
      "https://1.1.1.1/dns-query?name=" + encodeURIComponent(host) + "&type=A",
      "https://8.8.8.8/resolve?name=" + encodeURIComponent(host) + "&type=A",
    ];
    for (const url of providers) {
      try {
        const body = await new Promise((resolve, reject) => {
          const u = new URL(url);
          const lib = u.protocol === "https:" ? httpsServerLib : httpServerLib;
          const r = lib.get(
            url,
            { headers: { accept: "application/dns-json" }, family: 4 },
            (res) => {
              let d = "";
              res.on("data", (c) => (d += c));
              res.on("end", () => resolve(d));
            },
          );
          r.on("error", reject);
          r.setTimeout(4000, () => r.destroy(new Error("doh timeout")));
        });
        const json = JSON.parse(body);
        const ips = (json.Answer || [])
          .filter((a) => a.type === 1)
          .map((a) => a.data)
          .filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d));
        if (ips.length) {
          dohCache.set(host, { ips, expiresAt: now + DOH_TTL });
          return ips;
        }
      } catch {}
    }
    // Fallback: system resolver, IPv4 only.
    try {
      const sys = await dnsLib.promises.lookup(host, { family: 4 });
      return [sys.address];
    } catch {
      return [];
    }
  }
  // Custom lookup for https.request: (hostname, options, callback)
  function dohLookup(hostname, _opts, cb) {
    dohResolve(hostname)
      .then((ips) => {
        if (!ips.length) return cb(new Error("DNS resolve failed for " + hostname));
        cb(null, ips[0], 4);
      })
      .catch((e) => cb(e));
  }
  function forwardTmdb(req, res, target) {
    const upstream = new URL(target);
    const opts = {
      method: req.method,
      hostname: upstream.hostname,
      port: upstream.port || 443,
      path: upstream.pathname + upstream.search,
      headers: { ...req.headers, host: upstream.host },
      servername: upstream.hostname, // SNI = real host (TLS cert match)
      lookup: dohLookup,
      family: 4,
    };
    delete opts.headers["origin"];
    delete opts.headers["referer"];
    const up = httpsServerLib.request(opts, (r) => {
      const headers = { ...r.headers };
      headers["access-control-allow-origin"] = "*";
      headers["access-control-allow-headers"] = "*";
      res.writeHead(r.statusCode, headers);
      r.pipe(res);
    });
    up.on("error", (e) => {
      res.writeHead(502, { "access-control-allow-origin": "*", "content-type": "application/json" });
      res.end(JSON.stringify({ error: "TMDB proxy upstream error", message: e.message }));
    });
    up.setTimeout(20000, () => up.destroy(new Error("timeout")));
    req.pipe(up);
  }
  const tmdbProxyServer = httpServerLib.createServer((req, res) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "access-control-allow-methods": "GET, OPTIONS",
      });
      return res.end();
    }
    if (req.url.startsWith("/api/")) {
      return forwardTmdb(req, res, "https://api.themoviedb.org" + req.url.slice(4));
    }
    if (req.url.startsWith("/img/")) {
      return forwardTmdb(req, res, "https://image.tmdb.org" + req.url.slice(4));
    }
    res.writeHead(404, { "access-control-allow-origin": "*" });
    res.end("not found");
  });
  let tmdbProxyPort = 0;
  tmdbProxyServer.listen(0, "127.0.0.1", () => {
    tmdbProxyPort = tmdbProxyServer.address().port;
  });
  ipcMain.handle("tmdb-proxy-get", () => ({ on: tmdbProxyOn, port: tmdbProxyPort }));
  ipcMain.handle("tmdb-proxy-set", (_, { on }) => {
    tmdbProxyOn = !!on;
    return { on: tmdbProxyOn, port: tmdbProxyPort };
  });

  // -- Lazy session setup ----------------------------------------------------
  // Player/trailer sessions are configured on the first webview attach or
  // when the pop-out window opens, whichever comes first.

  // Block popups from webviews, intercept fullscreen, lazy-init sessions
  mainWindow.webContents.on("did-attach-webview", (_, wc) => {
    if (!sessionsConfigured) {
      sessionsConfigured = true;
      const playerSession = session.fromPartition("persist:player");
      const trailerSession = session.fromPartition("persist:trailer");
      setupSession(playerSession, trailerSession);
    }

    // Track player webviews for cleanup on player-stopped
    try {
      if (wc.session === session.fromPartition("persist:player")) {
        playerWcIds.add(wc.id);
        wc.once("destroyed", () => playerWcIds.delete(wc.id));
      }
    } catch {}

    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.on("enter-html-full-screen", () =>
      mainWindow.webContents.send("webview-enter-fullscreen"),
    );
    wc.on("leave-html-full-screen", () =>
      mainWindow.webContents.send("webview-leave-fullscreen"),
    );
  });

  mainWindow.loadFile(path.join(__dirname, "dist/index.html"));

  // Trigger scheduled backup after load
  mainWindow.webContents.once("did-finish-load", () => {
    _bench("renderer loaded");
    const sbSettings = storageIpc.loadScheduledBackupSettings();
    if (storageIpc.shouldRunScheduledBackup(sbSettings)) {
      mainWindow.webContents.send("scheduled-backup-requested");
    }
  });

  // Intercept close if downloads are active
  let closeResponsePending = false;
  mainWindow.on("close", (e) => {
    const running = downloadsIpc
      .getDownloads()
      .filter((d) => d.status === "downloading");
    if (running.length === 0) return;
    e.preventDefault();
    if (closeResponsePending) return;
    closeResponsePending = true;
    mainWindow.webContents.send("confirm-close", { count: running.length });
  });

  ipcMain.on("close-response", (_, confirmed) => {
    closeResponsePending = false;
    if (confirmed) {
      downloadsIpc.killAllDownloads();
      mainWindow.destroy();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    app.quit();
  });
}

// -- Register all IPC modules --------------------------------------------------
storageIpc.register();
downloadsIpc.register(getMainWindow);
subtitlesIpc.register({
  getDownloads: downloadsIpc.getDownloads,
  saveDownloads: downloadsIpc.saveDownloads,
});
allmangaIpc.register();
playerIpc.register(getMainWindow, {
  writeSecretMigration: storageIpc.writeSecretMigration,
});
blockStats.init(getMainWindow);
torrIpc.register(getMainWindow, {
  getCfg: () => {
    // Hydrate from disk on first read (app is ready by the time IPC is invoked)
    if (!torrCfgRef._hydrated) {
      torrCfgRef._hydrated = true;
      const loaded = loadTorrCfg();
      if (loaded) torrCfgRef.cfg = { ...torrCfgRef.cfg, ...loaded };
    }
    return torrCfgRef.cfg;
  },
  setCfg: (c) => {
    torrCfgRef.cfg = c;
  },
  saveCfg: saveTorrCfg,
});
collapsIpc.register();

// get-block-stats lives with its data
ipcMain.handle("get-block-stats", () => blockStats.getBlockStats());

// ── Native file picker for .torrent files ─────────────────────────────────────
ipcMain.handle("torr-pick-file", async () => {
  const { dialog } = require("electron");
  const mw = getMainWindow();
  try {
    const res = await dialog.showOpenDialog(mw && !mw.isDestroyed() ? mw : undefined, {
      title: "Select a .torrent file",
      properties: ["openFile"],
      filters: [{ name: "Torrent", extensions: ["torrent"] }],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false };
    return { ok: true, path: res.filePaths[0] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// -- Player memory cleanup ---------------------------------------------
// Called by MoviePage / TVPage on component unmount.
// Destroys the player webview WebContents by tracked ID, then flushes caches and GCs.
ipcMain.on("player-stopped", () => {
  // Step 1: Mute + destroy all tracked player WebContents by ID.
  for (const id of playerWcIds) {
    try {
      const wc = webContents.fromId(id);
      if (wc && !wc.isDestroyed()) {
        try {
          wc.setAudioMuted(true);
        } catch {}
        wc.destroy();
      }
    } catch {}
  }
  playerWcIds.clear();

  // Step 2: Flush HTTP + shader caches from the player session.
  try {
    const ps = session.fromPartition("persist:player");
    ps.clearCache().catch(() => {});
    ps.clearStorageData({ storages: ["shadercache", "cachestorage"] }).catch(
      () => {},
    );
  } catch {}

  // Step 3: GC hints
  if (typeof global.gc === "function") global.gc();
  const mw = mainWindow;
  if (mw && !mw.isDestroyed()) {
    mw.webContents
      .executeJavaScript("if(typeof gc==='function') gc();")
      .catch(() => {});
  }
});

// -- Desktop notifications -----------------------------------------------------
// Called from the renderer whenever it wants a native OS notification.
ipcMain.handle(
  "show-notification",
  (_event, { title, body, silent = false }) => {
    try {
      if (!Notification.isSupported()) return;
      const n = new Notification({
        title: String(title),
        body: String(body),
        silent,
      });
      n.show();
    } catch {}
  },
);

// -- Picture-in-Picture / Pop-Out window --------------------------------------
// Opens the player URL in a small always-on-top BrowserWindow (full site UI,
// with subtitles and controls). The Main Window closes the stream to avoid duplication.
let pipWindow = null;
const getPipWindow = () => pipWindow;

ipcMain.handle("open-pip-window", (_, { url, title }) => {
  if (!url || url === "about:blank") return { ok: false, reason: "no-url" };

  // Guarantee tracker/ad blocking is active in persist:player before any load
  if (!sessionsConfigured) {
    sessionsConfigured = true;
    const playerSession = session.fromPartition("persist:player");
    const trailerSession = session.fromPartition("persist:trailer");
    setupSession(playerSession, trailerSession);
  }

  if (pipWindow && !pipWindow.isDestroyed()) {
    pipWindow.loadURL(url);
    pipWindow.focus();
    return { ok: true };
  }

  pipWindow = new BrowserWindow({
    width: 640,
    height: 360,
    minWidth: 320,
    minHeight: 180,
    alwaysOnTop: true,
    title: title ? `${title} - Pop-out` : "Pop-out Player",
    backgroundColor: "#000000",
    // Same custom title bar as the main window
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    frame: process.platform !== "win32",
    webPreferences: {
      partition: "persist:player",
      nodeIntegration: false,
      contextIsolation: true,
      // Injects the custom title bar and wires window-control IPC
      preload: path.join(__dirname, "popout-preload.js"),
    },
  });

  // Block all popup windows from the streaming site and any nested frames
  pipWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // If the site uses <webview> elements (unlikely but safe), block there too
  pipWindow.webContents.on("did-attach-webview", (_, wc) => {
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
  });

  pipWindow.loadURL(url);

  // Push maximize state into the popout renderer so the title bar icon updates
  pipWindow.on("maximize", () => {
    if (!pipWindow.isDestroyed())
      pipWindow.webContents.send("popout-window-maximized", true);
  });
  pipWindow.on("unmaximize", () => {
    if (!pipWindow.isDestroyed())
      pipWindow.webContents.send("popout-window-maximized", false);
  });

  const notifyMain = (channel) => {
    const mw = getMainWindow();
    if (mw && !mw.isDestroyed()) mw.webContents.send(channel);
  };

  pipWindow.on("closed", () => {
    pipWindow = null;
    notifyMain("pip-window-closed");
  });

  notifyMain("pip-window-opened");
  return { ok: true };
});

ipcMain.handle("close-pip-window", () => {
  if (pipWindow && !pipWindow.isDestroyed()) pipWindow.close();
});

ipcMain.handle("get-pip-webcontents-id", () => {
  if (pipWindow && !pipWindow.isDestroyed()) return pipWindow.webContents.id;
  return null;
});

// -- Popout window controls (used by popout-preload.js title bar buttons) -----
ipcMain.handle("popout-window-minimize", () => {
  if (pipWindow && !pipWindow.isDestroyed()) pipWindow.minimize();
});
ipcMain.handle("popout-window-toggle-maximize", () => {
  if (!pipWindow || pipWindow.isDestroyed()) return;
  if (pipWindow.isMaximized()) pipWindow.unmaximize();
  else pipWindow.maximize();
});
ipcMain.handle("popout-window-close", () => {
  if (pipWindow && !pipWindow.isDestroyed()) pipWindow.close();
});
ipcMain.handle("popout-window-is-maximized", () => {
  return pipWindow && !pipWindow.isDestroyed()
    ? pipWindow.isMaximized()
    : false;
});

// -- Single-instance lock ------------------------------------------------------
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    _bench("app ready");
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("activate", () => {
    if (mainWindow === null) createWindow();
  });
}
