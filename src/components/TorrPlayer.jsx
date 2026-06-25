// ── TorrPlayer: in-app player for the TorrServer "Торренты" source ──────────
// Owns the whole flow for this source: pick a torrent (search via Jackett /
// existing TorrServer DB / add a magnet) → resolve to a TorrServer stream URL →
// play with hls.js (multi-audio HLS) selecting the RU dub by default, with a
// raw-stream + external-player fallback. Reports progress back to the page.
//
// The Russian-audio ability comes from the torrent content itself (RU dub
// tracks in the mkv), surfaced through the local TorrServer — the browser
// `<video>`/hls.js engine only gets multi-audio when TorrServer serves HLS
// (#EXT-X-MEDIA audio renditions). When HLS isn't available we fall back to
// the raw stream and offer launching mpv/VLC (which always works with any
// container + any audio track).

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Hls from "hls.js";
import {
  torrPing,
  torrList,
  torrAdd,
  torrAddFile,
  torrGet,
  torrStream,
  torrExternal,
  torrSearch,
  torrGetCfg,
  torrSetCfg,
  torrRem,
  pickTorrentFile,
  normalizeFiles,
  preferredAudioTrackIndex,
  guessEpisodeFileIndex,
  bestFileName,
  hashFromResult,
} from "../utils/torrserver-client";
import { storage, formatBytes } from "../utils/storage";
import { CloseIcon, ExternalLinkIcon, SourceIcon } from "./Icons";

const fmt = (s) => {
  if (!s || !isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${ss < 10 ? "0" : ""}${ss}`;
};

// Small inline icons
const PauseI = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22">
    <rect x="6" y="4" width="4" height="16" />
    <rect x="14" y="4" width="4" height="16" />
  </svg>
);
const FullscreenI = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
    <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3" />
  </svg>
);
const VolumeI = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" />
  </svg>
);
const MuteI = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none" />
    <line x1="23" y1="9" x2="17" y2="15" />
    <line x1="17" y1="9" x2="23" y2="15" />
  </svg>
);
const AudioI = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
    <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
    <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
  </svg>
);
const SearchI = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.35-4.35" />
  </svg>
);
const PlusI = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

export default function TorrPlayer({
  queryTitle,
  isTv = false,
  season = null,
  episode = null,
  title,
  progressKey,
  saveProgress,
  onMarkWatched,
  watchedThreshold = 20,
  torrentHint = null, // optional magnet/hash to pre-add
}) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const containerRef = useRef(null);
  const progressTimerRef = useRef(null);
  const saveRef = useRef(saveProgress);
  saveRef.current = saveProgress;
  const markWatchedRef = useRef(onMarkWatched);
  markWatchedRef.current = onMarkWatched;

  const [cfg, setCfg] = useState(null);
  const [tab, setTab] = useState("search"); // search | db | add
  const [searchQuery, setSearchQuery] = useState(queryTitle || "");
  const [results, setResults] = useState([]);
  const [dbTorrents, setDbTorrents] = useState([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  // Chosen torrent + file
  const [activeHash, setActiveHash] = useState(null);
  const [files, setFiles] = useState([]);
  const [fileIndex, setFileIndex] = useState(null);

  // Playback
  const [stream, setStream] = useState(null); // {raw, hls}
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [audioTracks, setAudioTracks] = useState([]);
  const [audioId, setAudioId] = useState(-1);
  const [showTracks, setShowTracks] = useState(false);

  // Load config + initial listing + (optionally) auto-search
  useEffect(() => {
    (async () => {
      const c = (await torrGetCfg()) || {};
      setCfg(c);
      const list = await torrList();
      if (list?.ok) setDbTorrents(list.list || []);
      if (torrentHint) {
        await handleAdd(torrentHint, "Из источника", c);
      } else if (c.jackettUrl) {
        runSearch(queryTitle, c);
      } else {
        setTab("db");
      }
    })();
    return () => {
      destroyHls();
      clearInterval(progressTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const destroyHls = useCallback(() => {
    if (hlsRef.current) {
      try {
        hlsRef.current.destroy();
      } catch {}
      hlsRef.current = null;
    }
  }, []);

  // ── Search via Jackett ───────────────────────────────────────────────────────
  const runSearch = useCallback(async (q, c = cfg) => {
    if (!q) return;
    setBusy("search");
    setError("");
    setResults([]);
    const res = await torrSearch(q);
    setBusy("");
    if (!res?.ok) {
      setError(res?.error || "Поиск не удался");
      return;
    }
    setResults(res.results || []);
    if (!(res.results || []).length) setError("Ничего не найдено. Настройте Jackett или добавьте magnet вручную.");
  }, [cfg]);

  // ── Add a magnet/hash/torrent and resolve files ─────────────────────────────
  const handleAdd = useCallback(
    async (link, displayTitle, c = cfg) => {
      setBusy("add");
      setError("");
      const res = await torrAdd({ link, title: `[Lampa-Stream] ${displayTitle || ""}` });
      setBusy("");
      if (!res?.ok) {
        setError(res?.error || "Не удалось добавить торрент");
        return false;
      }
      const t = res.torrent || {};
      const hash = (t.hash || t.Hash || hashFromResult({ magnet: link }) || "").toLowerCase();
      if (!hash) {
        setError("TorrServer не вернул hash торрент-файла");
        return false;
      }
      setActiveHash(hash);
      const fl = normalizeFiles(t);
      setFiles(fl);
      return pickFileAndPlay(hash, fl, c);
    },
    [cfg],
  );

  // ── Choose file index (TV episode guess / movie largest) then build stream ──
  const pickFileAndPlay = useCallback(
    async (hash, fl, c = cfg) => {
      let idx;
      if (isTv) idx = guessEpisodeFileIndex(fl, { season, episode });
      else {
        let best = fl[0];
        for (const f of fl) if ((f.size || 0) > (best.size || 0)) best = f;
        idx = best?.index ?? 0;
      }
      setFileIndex(idx);
      const fileName = bestFileName(fl, idx);
      setBusy("stream");
      setError("");
      const s = await torrStream({ hash, index: idx, fileName });
      setBusy("");
      if (!s?.ok) {
        setError(s?.error || "TorrServer недоступен. Проверьте адрес в Настройках.");
        return;
      }
      setStream({ raw: s.raw, hls: s.hls });
    },
    [cfg, isTv, season, episode],
  );

  // ── When stream URL changes, attach hls.js or raw src ──────────────────────
  useEffect(() => {
    if (!stream) return;
    const v = videoRef.current;
    if (!v) return;
    destroyHls();
    setCurrent(0);
    setDuration(0);
    setAudioTracks([]);
    setAudioId(-1);

    const tryExternalOnly = () => {
      // TorrServer reachable but no HLS → raw may still play mp4. Set raw src.
      v.src = stream.raw;
      v.play().catch(() => {});
    };

    if (stream.hls) {
      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 30,
        });
        hlsRef.current = hls;
        hls.loadSource(stream.hls);
        hls.attachMedia(v);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          v.play().catch(() => {});
        });
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
          const tracks = hls.audioTracks || [];
          setAudioTracks(tracks.map((t, i) => ({ id: i, name: t.name || t.lang || `Аудио ${i + 1}`, lang: t.lang || "" })));
          const pref = preferredAudioTrackIndex(tracks, cfg?.preferAudio);
          if (pref >= 0) {
            try {
              hls.audioTrack = pref;
              setAudioId(pref);
            } catch {}
          }
        });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data?.fatal) {
            // Fall back to raw stream (works for mp4) — HLS unavailable on this build
            destroyHls();
            tryExternalOnly();
          }
        });
      } else {
        // No hls.js support (unlikely in Electron) — try native HLS, else raw
        v.src = stream.hls;
        v.play().catch(() => tryExternalOnly());
      }
    } else {
      tryExternalOnly();
    }

    return () => destroyHls();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream]);

  // ── Video element events ────────────────────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => setCurrent(v.currentTime || 0);
    const onDur = () => setDuration(v.duration || 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("durationchange", onDur);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("durationchange", onDur);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
    };
  }, [stream]);

  // ── Progress reporting + watched threshold ──────────────────────────────────
  useEffect(() => {
    if (!stream) return;
    clearInterval(progressTimerRef.current);
    progressTimerRef.current = setInterval(() => {
      const v = videoRef.current;
      if (!v || !v.duration) return;
      const pct = Math.min(100, Math.round((v.currentTime / v.duration) * 100));
      // saveProgress(progressKey, pct) — 2-arg signature used by both pages
      saveRef.current?.(progressKey, pct);
      if (pct >= watchedThreshold) markWatchedRef.current?.(progressKey);
    }, 5000);
    return () => clearInterval(progressTimerRef.current);
  }, [stream, watchedThreshold]);

  // ── Controls ────────────────────────────────────────────────────────────────
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };
  const seek = (e) => {
    const v = videoRef.current;
    if (!v || !v.duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    v.currentTime = ratio * v.duration;
  };
  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  };
  const changeVol = (e) => {
    const v = videoRef.current;
    if (!v) return;
    const vol = Math.min(1, Math.max(0, Number(e.target.value)));
    v.volume = vol;
    v.muted = vol === 0;
    setVolume(vol);
    setMuted(vol === 0);
  };
  const toggleFullscreen = () => {
    if (!fullscreen) containerRef.current?.requestFullscreen?.();
    else document.exitFullscreen?.();
  };
  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  const selectAudio = (id) => {
    const hls = hlsRef.current;
    if (!hls) return;
    try {
      hls.audioTrack = id;
      setAudioId(id);
    } catch {}
    setShowTracks(false);
  };
  const openExternal = () => {
    const url = stream?.raw || stream?.hls;
    if (!url) return;
    torrExternal(url, Math.floor(videoRef.current?.currentTime || 0));
  };
  const pickFileManually = async (idx) => {
    setFileIndex(idx);
    setBusy("stream");
    const fileName = bestFileName(files, idx);
    const s = await torrStream({ hash: activeHash, index: idx, fileName });
    setBusy("");
    if (s?.ok) setStream({ raw: s.raw, hls: s.hls });
    else setError(s?.error || "Не удалось получить поток");
  };

  // ── pick an existing DB torrent ────────────────────────────────────────────
  const playDb = async (t) => {
    const hash = (t.hash || t.Hash || "").toLowerCase();
    if (!hash) return;
    setBusy("get");
    const got = await torrGet(hash);
    setBusy("");
    const torrent = got?.ok ? got.torrent : t;
    setActiveHash(hash);
    const fl = normalizeFiles(torrent);
    setFiles(fl);
    pickFileAndPlay(hash, fl);
  };

  const removeDb = async (t) => {
    const hash = (t.hash || t.Hash || "").toLowerCase();
    if (!hash) return;
    await torrRem(hash);
    const list = await torrList();
    if (list?.ok) setDbTorrents(list.list || []);
  };

  const onPickTorrentFile = async () => {
    const picked = await pickTorrentFile();
    if (!picked?.ok) return;
    setBusy("add");
    const res = await torrAddFile(picked.path, queryTitle || activeHash || "");
    setBusy("");
    if (!res?.ok) {
      setError(res?.error || "Не удалось добавить .torrent");
      return;
    }
    const t = res.torrent || {};
    const hash = (t.hash || t.Hash || "").toLowerCase();
    setActiveHash(hash);
    const fl = normalizeFiles(t);
    setFiles(fl);
    pickFileAndPlay(hash, fl);
  };

  const [magnetInput, setMagnetInput] = useState("");

  // ────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ────────────────────────────────────────────────────────────────────────────
  if (stream) {
    return (
      <div className="torrplayer" ref={containerRef}>
        <video
          ref={videoRef}
          className="torrplayer-video"
          playsInline
          crossOrigin="anonymous"
          poster=""
        />
        {/* File selector for multi-file torrents */}
        {files.length > 1 && (
          <div className="torrplayer-filebar">
            <span className="torrplayer-filebar-label">Файл:</span>
            <select
              value={fileIndex ?? ""}
              onChange={(e) => pickFileManually(Number(e.target.value))}
            >
              {files.map((f) => (
                <option key={f.index} value={f.index}>
                  {f.name}
                  {f.size ? ` (${formatBytes(f.size)})` : ""}
                </option>
              ))}
            </select>
            <button
              className="player-overlay-btn"
              onClick={() => {
                setStream(null);
                destroyHls();
                setActiveHash(null);
              }}
              title="Выбрать другой торрент"
            >
              <SourceIcon /> Другой
            </button>
          </div>
        )}
        {/* Controls */}
        <div className="torrplayer-controls">
          <button className="torrplayer-btn" onClick={togglePlay} title={playing ? "Пауза" : "Смотреть"}>
            {playing ? <PauseI /> : (
              <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
            )}
          </button>
          <button className="torrplayer-btn" onClick={toggleMute} title={muted ? "Включить звук" : "Выключить звук"}>
            {muted ? <MuteI /> : <VolumeI />}
          </button>
          <input
            className="torrplayer-volume"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={changeVol}
            title="Громкость"
          />
          <span className="torrplayer-time">
            {fmt(current)} / {fmt(duration)}
          </span>
          <div className="torrplayer-seek" onClick={seek}>
            <div
              className="torrplayer-seek-fill"
              style={{ width: `${duration ? (current / duration) * 100 : 0}%` }}
            />
          </div>
          {audioTracks.length > 1 && (
            <div className="torrplayer-audio">
              <button
                className="torrplayer-btn"
                onClick={() => setShowTracks((v) => !v)}
                title="Аудиодорожка"
              >
                <AudioI />
                <span className="torrplayer-audio-label">
                  {audioTracks[audioId]?.name || `Аудио ${(audioId ?? -1) + 1}`}
                </span>
              </button>
              {showTracks && (
                <div className="torrplayer-audio-menu">
                  {audioTracks.map((t) => (
                    <button
                      key={t.id}
                      className={"torrplayer-audio-item" + (t.id === audioId ? " active" : "")}
                      onClick={() => selectAudio(t.id)}
                    >
                      {t.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button className="torrplayer-btn" onClick={openExternal} title="Открыть в mpv/VLC">
            <ExternalLinkIcon size={18} />
          </button>
          <button className="torrplayer-btn" onClick={toggleFullscreen} title="Полный экран">
            <FullscreenI />
          </button>
        </div>
        {busy && <div className="torrplayer-busy">{busy === "stream" ? "Подключение к TorrServer…" : busy}</div>}
      </div>
    );
  }

  // ── Picker UI (no stream yet) ───────────────────────────────────────────────
  return (
    <div className="torrpicker">
      <div className="torrpicker-head">
        <div className="torrpicker-title">Торренты (TorrServer) — русская озвучка</div>
        <div className="torrpicker-status">
          {busy && <span className="torrpicker-busy">{busyLabel(busy)}…</span>}
          {error && <span className="torrpicker-error">{error}</span>}
        </div>
      </div>

      <div className="torrpicker-tabs">
        <button className={tab === "search" ? "active" : ""} onClick={() => setTab("search")}>
          <SearchI /> Поиск
        </button>
        <button className={tab === "db" ? "active" : ""} onClick={() => setTab("db")}>
          <SourceIcon /> Мои торренты ({dbTorrents.length})
        </button>
        <button className={tab === "add" ? "active" : ""} onClick={() => setTab("add")}>
          <PlusI /> Добавить
        </button>
      </div>

      {tab === "search" && (
        <div className="torrpicker-search">
          <div className="torrpicker-searchbar">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={queryTitle || "Название + год"}
              onKeyDown={(e) => e.key === "Enter" && runSearch(searchQuery)}
            />
            <button className="torrpicker-go" onClick={() => runSearch(searchQuery)}>
              Найти
            </button>
          </div>
          {!cfg?.jackettUrl && (
            <div className="torrpicker-hint">
              Поиск через Jackett не настроен. Укажите адрес Jackett + API-ключ в
              Настройках → TorrServer, либо откройте вкладку «Добавить» и вставьте magnet.
            </div>
          )}
          <div className="torrpicker-list">
            {results.map((r, i) => (
              <div className="torrpicker-item" key={i}>
                <div className="torrpicker-item-main">
                  <div className="torrpicker-item-title">{r.title}</div>
                  <div className="torrpicker-item-meta">
                    {r.tracker && <span>{r.tracker}</span>}
                    {r.size > 0 && <span>{formatBytes(r.size)}</span>}
                    {r.seeders != null && <span>↑{r.seeders}</span>}
                    {r.categoryDesc && <span>{r.categoryDesc}</span>}
                  </div>
                </div>
                <button
                  className="torrpicker-item-go"
                  disabled={!!busy}
                  onClick={() => handleAdd(r.magnet || r.link, queryTitle)}
                >
                  Смотреть
                </button>
              </div>
            ))}
            {!busy && !results.length && !error && (
              <div className="torrpicker-empty">Введите название и нажмите «Найти».</div>
            )}
          </div>
        </div>
      )}

      {tab === "db" && (
        <div className="torrpicker-list">
          {!dbTorrents.length && (
            <div className="torrpicker-empty">
              В TorrServer нет торрентов. Найдите через Поиск или добавьте magnet.
            </div>
          )}
          {dbTorrents.map((t, i) => (
            <div className="torrpicker-item" key={i}>
              <div className="torrpicker-item-main">
                <div className="torrpicker-item-title">{t.title || t.name || "Торрент"}</div>
                <div className="torrpicker-item-meta">
                  <span>{(t.hash || t.Hash || "").slice(0, 12)}…</span>
                  {t.size > 0 && <span>{formatBytes(t.size)}</span>}
                </div>
              </div>
              <button className="torrpicker-item-go" disabled={!!busy} onClick={() => playDb(t)}>
                Смотреть
              </button>
              <button className="torrpicker-item-del" disabled={!!busy} onClick={() => removeDb(t)}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {tab === "add" && (
        <div className="torrpicker-add">
          <label className="torrpicker-label">Magnet-ссылка или хеш</label>
          <textarea
            className="torrpicker-textarea"
            rows={3}
            value={magnetInput}
            onChange={(e) => setMagnetInput(e.target.value)}
            placeholder="magnet:?xt=urn:btih:…  или  40-значный хеш"
          />
          <button
            className="torrpicker-go"
            disabled={!magnetInput.trim() || !!busy}
            onClick={() => handleAdd(magnetInput.trim(), queryTitle)}
          >
            Добавить и смотреть
          </button>
          <div className="torrpicker-or">— или —</div>
          <button className="torrpicker-go" disabled={!!busy} onClick={onPickTorrentFile}>
            Выбрать .torrent файл
          </button>
        </div>
      )}
    </div>
  );
}

function busyLabel(b) {
  return { search: "Поиск", add: "Добавление", get: "Получение", stream: "Подключение" }[b] || "Работа";
}