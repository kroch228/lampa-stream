// ── TorrServer renderer client: thin async wrapper over the IPC bridge ──────
// All main-process calls go through window.electron.torr*. Returns null-ish /
// error objects on failure so callers can render messages without try/catch.

const e = () => window.electron;

export const torrPing = () => e()?.torrPing?.();
export const torrList = () => e()?.torrList?.();
export const torrGet = (hash) => e()?.torrGet?.({ hash });
export const torrAdd = (args) => e()?.torrAdd?.(args);
export const torrAddFile = (filePath, title) =>
  e()?.torrAddFile?.({ filePath, title });
export const torrRem = (hash) => e()?.torrRem?.({ hash });
export const torrStream = (args) => e()?.torrStream?.(args);
export const torrExternal = (url, seconds = 0) =>
  e()?.torrExternal?.({ url, seconds });
export const torrSearch = (query, category) =>
  e()?.torrSearch?.({ query, category });
export const pickTorrentFile = () => e()?.pickTorrentFile?.();

export const torrGetCfg = () => e()?.torrGetCfg?.();
export const torrSetCfg = (partial) => e()?.torrSetCfg?.(partial);

// ── Helpers ───────────────────────────────────────────────────────────────────

// Pick the default audio track index from hls.js audioTracks, preferring Russian.
export function preferredAudioTrackIndex(audioTracks, prefer = "ru") {
  if (!audioTracks || audioTracks.length === 0) return -1;
  const prefs = [
    (t) =>
      /рус|русск/i.test(t.name || "") ||
      /^(ru|rus|rus-RU|ru-RU)$/i.test(t.lang || ""),
    (t) => (t.lang || "").toLowerCase().startsWith("ru"),
    (t) => /ru\b|рус/i.test(t.name || ""),
  ];
  for (const test of prefs) {
    const idx = audioTracks.findIndex(test);
    if (idx >= 0) return idx;
  }
  return 0;
}

// A torrent file's index inside a multi-file torrent. TorrServer file_stats entries
// are usually {Name/path, Path, Size, Idx/index}. Normalize to a uniform shape.
export function normalizeFiles(torrent) {
  const fileStats = torrent?.file_stats || torrent?.FileStats || [];
  return (fileStats || [])
    .map((f, i) => ({
      index: f.Idx ?? f.index ?? f.Index ?? i,
      name: f.Name || f.name || f.Path || f.path || `file ${i}`,
      path: f.Path || f.path || f.Name || f.name || "",
      size: f.Size ?? f.size ?? 0,
    }))
    .sort((a, b) => a.index - b.index);
}

// For TV episodes we want to pick the file whose name matches the chosen episode.
export function guessEpisodeFileIndex(files, { season, episode, title }) {
  if (!files || !files.length) return 0;
  const s = String(season ?? "").padStart(2, "0");
  const ep = String(episode ?? "").padStart(2, "0");
  const patterns = [
    new RegExp(`s0?${season ?? "\\d+"}e0?${episode ?? "\\d+"}`, "i"),
    new RegExp(`\\b${ep}\\b`),
    new RegExp(`сезон\\s*${season}|season\\s*${season}`, "i"),
  ];
  for (const re of patterns) {
    const idx = files.findIndex((f) => re.test(f.name) || re.test(f.path));
    if (idx >= 0) return files[idx].index;
  }
  // Single-video torrents: pick the largest file
  if (files.length <= 3) {
    let best = files[0];
    for (const f of files) if ((f.size || 0) > (best.size || 0)) best = f;
    return best.index;
  }
  return files[0].index;
}

export function bestFileName(files, index) {
  const f = files.find((x) => x.index === index) || files[0];
  return f?.name || "";
}

// Extract a magnet hash if the add returned one, otherwise derive from magnet.
export function hashFromResult(result) {
  const m = (result?.magnet || "").match(/urn:btih:([A-Fa-f0-9]{40}|[A-Za-z2-7]{32})/);
  return m ? m[1].toLowerCase() : "";
}