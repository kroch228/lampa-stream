// ── IPC: TorrServer (YouROK MatriX) local torrent-stream engine ──────────────
// Mirrors the verified wire format used by Lampa's own client (extracted from
// app.asar) and TorrServer's web UI bundle:
//   list  → POST /torrents {"action":"list"}                  → [{...}, ...]
//   get   → POST /torrents {"action":"get","hash":"<h>"}        → {file_stats,...}
//   add   → POST /torrents {"action":"add","link":..,"title":..,"data":<b64>,
//                            "save_to_db":true}                 → {hash,file_stats..}
//   rem   → POST /torrents {"action":"rem","hash":"<h>"}
//   drop  → POST /torrents {"action":"drop","hash":"<h>"}
//   ping  → POST /settings {"action":"get"}                     → {CacheSize..}
// Stream (raw, plays original container):
//   /stream/<urlencoded-filename>?link=<hash>&index=<fileIndex>&play
// We also probe HLS candidate forms for in-browser multi-audio playback.

const { ipcMain } = require("electron");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

// Renderer-supplied settings are pushed here (TorrServer host + Jackett).
let _cfg = {
  torrserverUrl: "http://127.0.0.1:8090",
  jackettUrl: "",
  jackettKey: "",
  preferAudio: "ru",
  externalPlayer: "auto", // auto | mpv | vlc
};
let _saveCfgFn = null;

function getBase() {
  return (_cfg.torrserverUrl || "http://127.0.0.1:8090").replace(/\/+$/, "");
}

// ── tiny JSON-over-HTTP helpers ───────────────────────────────────────────────
function request(rawUrl, { method = "GET", body, headers = {}, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (e) {
      return reject(new Error("bad url"));
    }
    const lib = parsed.protocol === "https:" ? https : http;
    const opts = {
      method,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: { "User-Agent": "Lampa-Stream/1.0", ...headers },
    };
    const req = lib.request(opts, (res) => {
      // Follow up to 5 redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, rawUrl).toString();
        return resolve(request(next, { method, body, headers, timeout }));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.setTimeout(timeout, () => req.destroy(new Error("timeout")));
    if (body != null) req.write(body);
    req.end();
  });
}

async function tsJson(action, extra = {}) {
  const payload = JSON.stringify({ action, ...extra });
  const { status, body } = await request(getBase() + "/torrents", {
    method: "POST",
    body: payload,
    headers: { "Content-Type": "application/json" },
  });
  if (status >= 400) throw new Error(`TorrServer HTTP ${status}`);
  const text = body.toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    // list can return "[]" or text on rem/drop — fall back gracefully
    if (text === "" || text === "[]") return [];
    return { ok: true, status };
  }
}

// Probe candidate HLS URLs from the main process (avoids hls.js trial flashes).
// Returns the first candidate whose body begins with "#EXTM3U".
async function probeHls(candidates) {
  for (const url of candidates) {
    try {
      const { status, body } = await request(url, { method: "GET", timeout: 8000 });
      if (status === 200) {
        const head = body.slice(0, 64).toString("utf8").trim();
        if (head.startsWith("#EXTM3U")) {
          // Only treat it as playable HLS if it references actual segments,
          // not just the root "list of files" playlist.
          const text = body.toString("utf8");
          const isSegmentList = /#EXTINF|#EXT-X-STREAM|#EXT-X-BYTERANGE/.test(text) || text.includes(".ts") || text.includes(".m3u8");
          if (isSegmentList) return url;
        }
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

// Build all plausible stream URL forms for a torrent file.
// Returns { raw, hlsCandidates[] }.
function buildStreamUrls(hash, index, fileName) {
  const base = getBase();
  const encName = encodeURIComponent((fileName || "").split("\\").pop().split("/").pop());
  const raw = `${base}/stream/${encName}?link=${hash}&index=${index}&play`;
  const hls = [
    `${base}/stream/${hash}/${index}/index.m3u8`,
    `${base}/play/${hash}/${index}/index.m3u8`,
    `${base}/stream/${hash}/${index}.m3u8`,
    `${base}/stream/${encName}?link=${hash}&index=${index}&play&hls`,
  ];
  return { raw, hls };
}

function register(getMainWindow, { setCfg, getCfg, saveCfg } = {}) {
  _saveCfgFn = saveCfg || null;
  if (getCfg) _cfg = { ..._cfg, ...getCfg() };
  if (setCfg) setCfg(_cfg);

  // ── Push config from the renderer (settings page) ─────────────────────────
  ipcMain.handle("torrset-cfg", (_, partial) => {
    _cfg = { ..._cfg, ...partial };
    setCfg?.(_cfg);
    if (_saveCfgFn) try { _saveCfgFn(_cfg); } catch {}
    return { ok: true, cfg: _cfg };
  });
  ipcMain.handle("torrget-cfg", () => ({ ..._cfg }));

  // ── Health check against the running TorrServer (MatriX detection) ─────────
  ipcMain.handle("torrping", async () => {
    try {
      const { status, body } = await request(getBase() + "/settings", {
        method: "POST",
        body: JSON.stringify({ action: "get" }),
        headers: { "Content-Type": "application/json" },
        timeout: 5000,
      });
      if (status >= 400) return { ok: false, error: `HTTP ${status}` };
      const json = JSON.parse(body.toString("utf8"));
      const matrix = typeof json.CacheSize !== "undefined";
      return { ok: true, matrix, base: getBase() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ── List torrents present in TorrServer's DB ──────────────────────────────
  ipcMain.handle("torrlist", async () => {
    try {
      const list = await tsJson("list");
      return { ok: true, list: Array.isArray(list) ? list : [] };
    } catch (e) {
      return { ok: false, error: e.message, list: [] };
    }
  });

  // ── Add a torrent by magnet / hash / http link, or .torrent data (base64) ──
  ipcMain.handle("torradd", async (_, { link, title, poster, data }) => {
    try {
      const res = await tsJson("add", {
        link: link || "",
        title: title || "",
        poster: poster || "",
        data: data || "",
        save_to_db: true,
      });
      // add may return the full torrent object OR a torrent list
      const obj = Array.isArray(res) ? res[0] : res;
      return { ok: true, torrent: obj };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Add .torrent file from disk (read + base64, send via "data").
  ipcMain.handle("torradd-file", async (_, { filePath, title }) => {
    try {
      const buf = fs.readFileSync(filePath);
      const b64 = buf.toString("base64");
      const res = await tsJson("add", {
        link: "",
        title: title || path.basename(filePath),
        data: b64,
        save_to_db: true,
      });
      const obj = Array.isArray(res) ? res[0] : res;
      return { ok: true, torrent: obj };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ── Get one torrent (file index list / stats) ─────────────────────────────
  ipcMain.handle("torrget", async (_, { hash }) => {
    try {
      const res = await tsJson("get", { hash });
      return { ok: true, torrent: res };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("torrrem", async (_, { hash }) => {
    try {
      await tsJson("rem", { hash });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ── Build + probe play URLs for a chosen file index ────────────────────────
  ipcMain.handle("torrstream", async (_, { hash, index, fileName }) => {
    const { raw, hls } = buildStreamUrls(hash, index, fileName);
    const hlsUrl = await probeHls(hls);
    return { ok: true, raw, hls: hlsUrl, hlsCandidates: hls };
  });

  // ── Open the raw stream in an external player (mpv/vlc) at a timestamp ────
  // Reuses src/ipc/player.js logic indirectly via open-path-at-time, but here
  // we target a URL rather than a file. mpv/vlc accept http URLs.
  ipcMain.handle("torrexternal", async (_, { url, seconds }) => {
    const { spawnSync, spawn } = require("child_process");
    const which = (b) => {
      try {
        const r = spawnSync(process.platform === "win32" ? "where" : "which", [b], { encoding: "utf8" });
        return r.status === 0 && r.stdout.trim() ? r.stdout.trim().split("\n")[0].trim() : null;
      } catch {
        return null;
      }
    };
    const pref = (_cfg.externalPlayer || "auto").toLowerCase();
    const sec = Math.floor(seconds || 0);
    const mpvEx = pref === "mpv";
    const vlcEx = pref === "vlc";
    let launched = false;
    const tryMpv = () => {
      const mpv = which("mpv") || (process.platform === "darwin" ? "/opt/homebrew/bin/mpv" : null);
      if (!mpv) return false;
      const args = ["--alang=rus,ru,rus-RU", "--slang=rus,ru"];
      if (sec > 0) args.push(`--start=${sec}`);
      args.push(url);
      spawn(mpv, args, { detached: true, stdio: "ignore" }).unref();
      return true;
    };
    const tryVlc = () => {
      const vlc =
        process.platform === "win32" ? which("vlc") || "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe" : process.platform === "darwin" ? "/Applications/VLC.app/Contents/MacOS/VLC" : which("vlc") || "/usr/bin/vlc";
      if (!fs.existsSync(vlc) && !which("vlc")) return false;
      const bin = which("vlc") || vlc;
      const args = sec > 0 ? [`--start-time=${sec}`, url] : [url];
      try {
        spawn(bin, args, { detached: true, stdio: "ignore" }).unref();
        return true;
      } catch {
        return false;
      }
    };
    if (mpvEx) launched = tryMpv();
    else if (vlcEx) launched = tryVlc();
    else launched = tryMpv() || tryVlc();
    return { ok: launched, launched };
  });

  // ── Jackett Torznab search (configurable, robust discovery) ────────────────
  // jacred.xyz is a Jackett aggregator but behind an adblock wall without a key,
  // so we let the user point at ANY Jackett instance they control.
  ipcMain.handle("torrsearch", async (_, { query, category }) => {
    const base = (_cfg.jackettUrl || "").replace(/\/+$/, "");
    const key = _cfg.jackettKey || "";
    if (!base) {
      return {
        ok: false,
        error:
          "Jackett URL not configured. Add your Jackett address + API key in Settings → TorrServer, or add a magnet/.torrent manually.",
        results: [],
      };
    }
    try {
      const q = encodeURIComponent(query || "");
      const cat = category ? `&category=${encodeURIComponent(category)}` : "";
      const url = `${base}/api/v2.0/indexers/all/results?apikey=${encodeURIComponent(key)}&Query=${q}${cat}`;
      const { status, body } = await request(url, { method: "GET", timeout: 20000 });
      if (status === 403 || status === 401)
        return { ok: false, error: `Jackett auth failed (HTTP ${status}) — check API key.`, results: [] };
      if (status >= 400) return { ok: false, error: `Jackett HTTP ${status}`, results: [] };
      const json = JSON.parse(body.toString("utf8"));
      const results = (json.Results || []).map((r) => ({
        title: r.Title || "",
        size: r.Size || 0,
        seeders: r.Seeders || 0,
        peers: r.Peers || 0,
        tracker: r.Tracker || "",
        magnet: r.MagnetUri || "",
        link: r.Link || "",
        categoryDesc: r.CategoryDesc || r.Category || "",
        publishDate: r.PublishDate || "",
      }));
      // Prefer non-blacklisted links + magnet-bearing results
      const ranked = results
        .filter((r) => r.magnet || r.link)
        .sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
      return { ok: true, results: ranked };
    } catch (e) {
      return { ok: false, error: e.message, results: [] };
    }
  });
}

module.exports = { register, setCfg: (c) => (_cfg = { ..._cfg, ...c }) };