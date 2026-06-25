// ── OnlinePlayer: in-app player for the "Онлайн" (Collaps) source ───────────
// Lampa's online viewing, extracted. Resolves a TMDB movie/episode to a
// Collaps stream and plays it.
//
// Engine priority: DASH (dash.js) → HLS (hls.js) → error.
//   • DASH carries up to 4K + multi-audio (RU dubs) on Collaps; HLS is capped
//     at ~720p. So we prefer DASH when available.
//   • dash.js is loaded from a local vendor bundle (public/vendor/dash.all.min.js)
//     because the npm registry in this env ships a broken dash.js package.
//
// Features (both engines):
//   • Multi-audio with Russian dub default
//   • Quality selector (DASH representations / HLS levels: Auto + 4K/1080p/…)
//   • Playback speed (0.5×–2×)
//   • Subtitles (Collaps `cc` VTT tracks)
//   • Intro/outro skip for anime (AniSkip via AniList idMal) — auto + manual
//   • ±10s seek + full keyboard shortcuts
//   • Resume from last position, click-to-play, auto-hide controls, buffer bar

import { useState, useEffect, useRef, useCallback } from "react";
import Hls from "hls.js";
import {
  tmdbFetch,
  fetchAnilistData,
  isAnimeContent,
} from "../utils/api";
import { fetchAniSkipTimings } from "../utils/aniSkip";
import { storage, STORAGE_KEYS } from "../utils/storage";
import {
  collapsResolve,
  collapsFindKp,
  labelAudioTracks,
  preferredRuTrackIndex,
} from "../utils/collaps-client";

const fmt = (s) => {
  if (s == null || !isFinite(s)) return "0:00";
  s = Math.max(0, s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const pad = (n) => (n < 10 ? "0" : "") + n;
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
};

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

// ── Load dash.js once from the local vendor bundle ───────────────────────────
let _dashLoader = null;
function loadDashJs() {
  if (window.dashjs) return Promise.resolve(window.dashjs);
  if (_dashLoader) return _dashLoader;
  _dashLoader = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "./vendor/dash.all.min.js";
    s.onload = () => resolve(window.dashjs);
    s.onerror = () => reject(new Error("dash.js failed to load"));
    document.head.appendChild(s);
    setTimeout(() => !window.dashjs && reject(new Error("dash.js load timeout")), 8000);
  });
  return _dashLoader;
}

// ── Icons ────────────────────────────────────────────────────────────────────
const PauseI = () => (<svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>);
const PlayI = () => (<svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><polygon points="5 3 19 12 5 21 5 3" /></svg>);
const FullscreenI = () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3" /></svg>);
const VolumeI = () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none" /><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" /></svg>);
const MuteI = () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></svg>);
const AudioI = () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M3 18v-6a9 9 0 0 1 18 0v6" /><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" /></svg>);
const SubI = () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M7 15h4M15 15h2M7 11h2M13 11h4" /></svg>);
const GearI = () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>);
const Back10I = () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6" /><text x="12" y="17" fontSize="7" fill="currentColor" stroke="none" textAnchor="middle" fontWeight="700">10</text></svg>);
const Fwd10I = () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6" /><text x="12" y="17" fontSize="7" fill="currentColor" stroke="none" textAnchor="middle" fontWeight="700">10</text></svg>);

export default function OnlinePlayer({
  apiKey, item, details, type = "movie", season = null, episode = null,
  progressKey, saveProgress, onMarkWatched, watchedThreshold = 20,
}) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const dashRef = useRef(null);
  const engineRef = useRef(null); // "dash" | "hls"
  const containerRef = useRef(null);
  const progressTimerRef = useRef(null);
  const skipTimerRef = useRef(null);
  const hideTimerRef = useRef(null);
  const subsAddedRef = useRef(false);
  const errCountRef = useRef(0);
  const saveRef = useRef(saveProgress); saveRef.current = saveProgress;
  const markWatchedRef = useRef(onMarkWatched); markWatchedRef.current = onMarkWatched;

  const [state, setState] = useState("loading");
  const [error, setError] = useState("");
  const [stream, setStream] = useState(null); // {dash?, hls?}
  const [audioNames, setAudioNames] = useState([]);
  const [subtitles, setSubtitles] = useState([]);
  const [meta, setMeta] = useState("");

  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [waiting, setWaiting] = useState(false);

  const [audioTracks, setAudioTracks] = useState([]);
  const [audioId, setAudioId] = useState(-1);
  const [showTracks, setShowTracks] = useState(false);

  // Quality (engine-agnostic list of {id,label,height})
  const [levels, setLevels] = useState([]);
  const [currentLevel, setCurrentLevel] = useState(-1);
  const [showQuality, setShowQuality] = useState(false);

  const [rate, setRate] = useState(1);
  const [showSpeed, setShowSpeed] = useState(false);

  const [subId, setSubId] = useState(-1);
  const [showSubs, setShowSubs] = useState(false);

  const [skipTimings, setSkipTimings] = useState(null);
  const [skipPrompt, setSkipPrompt] = useState(null);
  const [introSkipMode] = useState(() => storage.get(STORAGE_KEYS.INTRO_SKIP_MODE) || "manual");

  const [controlsVisible, setControlsVisible] = useState(true);
  const [hoverTime, setHoverTime] = useState(null);

  const destroyAll = useCallback(() => {
    if (dashRef.current) { try { dashRef.current.reset(); } catch {} dashRef.current = null; }
    if (hlsRef.current) { try { hlsRef.current.destroy(); } catch {} hlsRef.current = null; }
    engineRef.current = null;
  }, []);

  // ── Resolve the Collaps stream ──────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setState("loading"); setError(""); setStream(null);
      setAudioNames([]); setSubtitles([]); subsAddedRef.current = false;
      try {
        let imdbId = null;
        if (apiKey && item?.id) {
          const extPath = type === "tv" ? `/tv/${item.id}/external_ids` : `/movie/${item.id}/external_ids`;
          try { const ext = await tmdbFetch(extPath, apiKey); imdbId = ext?.imdb_id || null; } catch {}
        }
        let res = null;
        if (imdbId) res = await collapsResolve({ imdbId, type, season, episode });
        if (!res?.ok) {
          const title = item?.title || item?.name || "";
          const year = (item?.release_date || item?.first_air_date || "").slice(0, 4) || null;
          if (title) {
            const kp = await collapsFindKp({ query: title, year });
            if (kp?.ok && kp.kinopoiskId) {
              res = await collapsResolve({ kinopoiskId: kp.kinopoiskId, type, season, episode });
              if (!cancelled) setMeta(`Кинопоиск: ${kp.title || ""}`);
            }
          }
        }
        if (cancelled) return;
        if (!res?.ok || (!res.hls && !res.dash)) {
          setState("error"); setError(res?.error || "Не удалось найти онлайн-источник на Collaps"); return;
        }
        setStream({ dash: res.dash, hls: res.hls });
        setAudioNames(res.audioNames || []);
        setSubtitles(res.subtitles || []);
        setState("ready");
      } catch (e) {
        if (!cancelled) { setState("error"); setError(e?.message || "Ошибка разрешения онлайн-источника"); }
      }
    })();
    return () => { cancelled = true; destroyAll(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, type, season, episode, apiKey]);

  // ── AniList + AniSkip (intro/outro) for anime ───────────────────────────────
  useEffect(() => {
    if (introSkipMode === "off" || type !== "tv" || !episode) return;
    let cancelled = false;
    (async () => {
      try {
        if (!isAnimeContent(item, details)) return;
        const title = item?.name || item?.title || "";
        const data = await fetchAnilistData(title, "ANIME", item?.id);
        if (cancelled || !data?.idMal) return;
        const timings = await fetchAniSkipTimings(data.idMal, Number(episode));
        if (cancelled) return;
        if (timings && (timings.intro || timings.outro)) setSkipTimings(timings);
      } catch {}
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, episode, introSkipMode, type, details]);

  // ── Attach engine when stream is ready (DASH preferred → 4K) ────────────────
  useEffect(() => {
    if (!stream) return;
    const v = videoRef.current;
    if (!v) return;
    destroyAll();
    setCurrent(0); setDuration(0); setBuffered(0);
    setAudioTracks([]); setAudioId(-1);
    setLevels([]); setCurrentLevel(-1);
    setSkipTimings(null); setSkipPrompt(null);
    errCountRef.current = 0;

    const attachDash = async () => {
      if (!stream.dash) return false;
      try {
        const dashjs = await loadDashJs();
        const EVENTS = dashjs.MediaPlayer.events;
        const player = dashjs.MediaPlayer().create();
        dashRef.current = player;
        engineRef.current = "dash";
        player.initialize(v, stream.dash, true);
        player.updateSettings({
          streaming: {
            abr: { autoSwitchBitrate: { video: false } }, // we manage quality (default = best/4K)
            cacheInitSegments: true,
          },
        });

        const buildDashQuality = () => {
          try {
            // dash.js 4.x API: getBitrateInfoListFor(type) → [{qualityIndex, bitrate, width, height}]
            const list = (player.getBitrateInfoListFor ? player.getBitrateInfoListFor("video") : []) || [];
            if (!list.length) return;
            // Dedup by height (Collaps failover can duplicate), keep highest bitrate
            const byHeight = new Map();
            for (const b of list) {
              const h = b.height || 0;
              if (!h) continue;
              const cur = byHeight.get(h);
              if (!cur || (b.bitrate || 0) > (cur.bitrate || 0)) byHeight.set(h, b);
            }
            const lvls = [...byHeight.values()]
              .sort((a, b) => (b.height || 0) - (a.height || 0))
              .map((b) => ({
                id: b.qualityIndex,
                height: b.height,
                label: b.height >= 2160 ? "4K" : `${b.height}p`,
                _qidx: b.qualityIndex,
              }));
            setLevels(lvls);
            // Default: BEST quality (4K if present) — "везде 4K"
            if (lvls.length) {
              const best = lvls[0];
              try { player.setQualityFor("video", best._qidx); } catch {}
              setCurrentLevel(0);
            }
          } catch {}
        };

        const buildDashAudio = () => {
          try {
            // dash.js 4.x: getTracksFor(type) → audio track objects
            const tracks = (player.getTracksFor ? player.getTracksFor("audio") : []) || [];
            const labeled = tracks.map((t, i) => ({
              id: i,
              name: audioNames[i] || t.labels?.lang || t.labels?.[0]?.text || t.lang || `Аудио ${i + 1}`,
              lang: t.lang || "",
              _track: t,
            }));
            setAudioTracks(labeled);
            const ruIdx = preferredRuTrackIndex(
              tracks.map((t, i) => ({ id: i, name: audioNames[i] || t.lang || "", lang: t.lang || "" })),
              audioNames,
            );
            if (ruIdx >= 0 && tracks[ruIdx]) {
              try { player.setCurrentTrack(tracks[ruIdx]); setAudioId(ruIdx); } catch {}
            }
          } catch {}
        };

        player.on(EVENTS.STREAM_INITIALIZED, () => {
          buildDashQuality();
          buildDashAudio();
          v.play().catch(() => {});
        });
        // Keep currentLevel in sync when ABR or user changes quality
        player.on(EVENTS.QUALITY_CHANGE_RENDERED, (e) => {
          if (e.mediaType === "video") {
            const idx = levels.findIndex((l) => l._qidx === e.newQuality);
            if (idx >= 0) setCurrentLevel(idx);
          }
        });
        player.on(EVENTS.ERROR, (e) => {
          errCountRef.current += 1;
          if (errCountRef.current <= 1 && stream.hls) {
            try { player.reset(); } catch {}
            dashRef.current = null; engineRef.current = null;
            attachHls();
          } else {
            setState("error");
            setError("Ошибка DASH: " + ((e && (e.error || e.message)) || "unknown"));
          }
        });
        return true;
      } catch {
        return false;
      }
    };

    const attachHls = () => {
      if (!stream.hls) { setState("error"); setError("Поток недоступен (нет DASH/HLS)"); return; }
      if (!Hls.isSupported()) { v.src = stream.hls; v.play().catch(() => {}); return; }
      const hls = new Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 30, capLevelToPlayerSize: false });
      hlsRef.current = hls; engineRef.current = "hls";
      hls.loadSource(stream.hls); hls.attachMedia(v);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        // Dedup HLS levels by height (Collaps has failover duplicates)
        const seen = new Map();
        for (const l of (hls.levels || [])) {
          if (!l.height) continue;
          const cur = seen.get(l.height);
          if (!cur || (l.bitrate || 0) > (cur.bitrate || 0)) seen.set(l.height, l);
        }
        const lvls = [...seen.values()]
          .sort((a, b) => (b.height || 0) - (a.height || 0))
          .map((l, i) => ({ id: i, height: l.height, label: l.height >= 2160 ? "4K" : `${l.height}p`, _hlsLevel: l.height }));
        setLevels(lvls);
        // Default: best quality
        if (lvls.length) {
          const bestHlsLevel = lvls[0]._hlsLevel;
          // find original hls level index for that height
          const origIdx = (hls.levels || []).findIndex((l) => l.height === bestHlsLevel);
          if (origIdx >= 0) { hls.currentLevel = origIdx; setCurrentLevel(0); }
        }
        v.play().catch(() => {});
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
        const h = hls.levels?.[data.level]?.height;
        const idx = levels.findIndex((l) => l.height === h);
        if (idx >= 0) setCurrentLevel(idx);
      });
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
        const tracks = hls.audioTracks || [];
        const labeled = labelAudioTracks(tracks, audioNames);
        setAudioTracks(labeled);
        const pref = preferredRuTrackIndex(tracks, audioNames);
        if (pref >= 0) { try { hls.audioTrack = pref; setAudioId(pref); } catch {} }
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data?.fatal) return;
        errCountRef.current += 1;
        const attempts = errCountRef.current;
        try {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && attempts <= 4) hls.startLoad();
          else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && attempts <= 4) hls.recoverMediaError();
          else {
            try { hls.destroy(); } catch {} hlsRef.current = null;
            setState("error"); setError("Поток прерван (CDN нестабилен). " + (data.details || data.type));
          }
        } catch {}
      });
    };

    (async () => {
      const ok = await attachDash();
      if (!ok) attachHls();
    })();
    return () => destroyAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, audioNames]);

  // ── Add Collaps `cc` subtitles as <track> elements once ────────────────────
  useEffect(() => {
    if (state !== "ready" || subsAddedRef.current) return;
    const v = videoRef.current;
    if (!v || subtitles.length === 0) return;
    Array.from(v.querySelectorAll("track[data-cc]")).forEach((t) => t.remove());
    subtitles.forEach((s, i) => {
      const t = document.createElement("track");
      t.kind = "subtitles"; t.label = s.name; t.srclang = `cc${i}`; t.src = s.url;
      t.default = false; t.setAttribute("data-cc", "1"); v.appendChild(t);
    });
    subsAddedRef.current = true;
    Array.from(v.textTracks).forEach((tt) => (tt.mode = "hidden"));
  }, [state, subtitles]);

  // ── Video element events ────────────────────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => setCurrent(v.currentTime || 0);
    const onDur = () => setDuration(v.duration || 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onRate = () => setRate(v.playbackRate || 1);
    const onVol = () => { setVolume(v.volume); setMuted(v.muted); };
    const onWaiting = () => setWaiting(true);
    const onPlaying = () => setWaiting(false);
    const onCanPlay = () => setWaiting(false);
    const onProgress = () => { try { if (v.buffered?.length) setBuffered(v.buffered.end(v.buffered.length - 1) || 0); } catch {} };
    const onLoadedMeta = () => {
      setDuration(v.duration || 0);
      try {
        const progMap = storage.get(STORAGE_KEYS.WATCH_PROGRESS) || {};
        const pct = progMap[progressKey];
        if (typeof pct === "number" && pct > 3 && pct < 95 && v.duration) v.currentTime = (pct / 100) * v.duration;
      } catch {}
    };
    v.addEventListener("timeupdate", onTime); v.addEventListener("durationchange", onDur);
    v.addEventListener("play", onPlay); v.addEventListener("pause", onPause);
    v.addEventListener("ratechange", onRate); v.addEventListener("volumechange", onVol);
    v.addEventListener("waiting", onWaiting); v.addEventListener("playing", onPlaying);
    v.addEventListener("canplay", onCanPlay); v.addEventListener("progress", onProgress);
    v.addEventListener("loadedmetadata", onLoadedMeta);
    return () => {
      v.removeEventListener("timeupdate", onTime); v.removeEventListener("durationchange", onDur);
      v.removeEventListener("play", onPlay); v.removeEventListener("pause", onPause);
      v.removeEventListener("ratechange", onRate); v.removeEventListener("volumechange", onVol);
      v.removeEventListener("waiting", onWaiting); v.removeEventListener("playing", onPlaying);
      v.removeEventListener("canplay", onCanPlay); v.removeEventListener("progress", onProgress);
      v.removeEventListener("loadedmetadata", onLoadedMeta);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, progressKey]);

  // ── Progress reporting ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!stream) return;
    clearInterval(progressTimerRef.current);
    progressTimerRef.current = setInterval(() => {
      const v = videoRef.current;
      if (!v || !v.duration) return;
      const pct = Math.min(100, Math.round((v.currentTime / v.duration) * 100));
      saveRef.current?.(progressKey, pct);
      if (pct >= watchedThreshold) markWatchedRef.current?.(progressKey);
    }, 5000);
    return () => clearInterval(progressTimerRef.current);
  }, [stream, watchedThreshold, progressKey]);

  // ── Skip intro/outro detection ──────────────────────────────────────────────
  useEffect(() => {
    if (!skipTimings || introSkipMode === "off") { setSkipPrompt(null); return; }
    clearInterval(skipTimerRef.current);
    skipTimerRef.current = setInterval(() => {
      const v = videoRef.current; if (!v || !v.duration) return;
      const ct = v.currentTime; const { intro, outro } = skipTimings;
      const inIntro = intro && ct >= intro.startTime && ct < intro.endTime - 1;
      const inOutro = outro && ct >= outro.startTime && ct < outro.endTime - 1;
      if (inIntro) { setSkipPrompt("intro"); if (introSkipMode === "auto") { v.currentTime = Number(intro.endTime); setSkipPrompt(null); } }
      else if (inOutro) { setSkipPrompt("outro"); if (introSkipMode === "auto") { v.currentTime = Number(outro.endTime); setSkipPrompt(null); } }
      else setSkipPrompt(null);
    }, 1000);
    return () => clearInterval(skipTimerRef.current);
  }, [skipTimings, introSkipMode]);

  // ── Fullscreen state ────────────────────────────────────────────────────────
  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // ── Controls auto-hide ──────────────────────────────────────────────────────
  const showControls = useCallback(() => {
    setControlsVisible(true);
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused && !showTracks && !showQuality && !showSpeed && !showSubs)
        setControlsVisible(false);
    }, 3000);
  }, [showTracks, showQuality, showSpeed, showSubs]);
  useEffect(() => { showControls(); return () => clearTimeout(hideTimerRef.current); }, [showControls, playing]);

  // ── Controls (engine-agnostic) ──────────────────────────────────────────────
  const togglePlay = () => { const v = videoRef.current; if (!v) return; if (v.paused) v.play().catch(() => {}); else v.pause(); };
  const seekBy = (delta) => { const v = videoRef.current; if (!v || !v.duration) return; v.currentTime = Math.min(v.duration, Math.max(0, v.currentTime + delta)); };
  const seekTo = (ratio) => { const v = videoRef.current; if (!v || !v.duration) return; v.currentTime = Math.min(v.duration, Math.max(0, ratio * v.duration)); };
  const onSeekClick = (e) => { const v = videoRef.current; if (!v || !v.duration) return; const r = e.currentTarget.getBoundingClientRect(); seekTo((e.clientX - r.left) / r.width); };
  const onSeekMove = (e) => { const v = videoRef.current; if (!v || !v.duration) return; const r = e.currentTarget.getBoundingClientRect(); setHoverTime(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * v.duration); };
  const toggleMute = () => { const v = videoRef.current; if (!v) return; v.muted = !v.muted; setMuted(v.muted); };
  const changeVol = (val) => { const v = videoRef.current; if (!v) return; const vol = Math.min(1, Math.max(0, Number(val))); v.volume = vol; v.muted = vol === 0; setVolume(vol); setMuted(vol === 0); };
  const setSpeed = (r) => { const v = videoRef.current; if (v) v.playbackRate = r; setRate(r); setShowSpeed(false); };
  const toggleFullscreen = () => { if (!fullscreen) containerRef.current?.requestFullscreen?.(); else document.exitFullscreen?.(); };

  const selectAudio = (idx) => {
    const track = audioTracks[idx];
    if (!track) { setShowTracks(false); return; }
    if (engineRef.current === "dash") {
      try { dashRef.current?.setCurrentTrack(track._track); } catch {}
    } else {
      try { if (hlsRef.current) hlsRef.current.audioTrack = track.id; } catch {}
    }
    setAudioId(idx); setShowTracks(false);
  };

  const selectQuality = (idx) => {
    // idx === -1 → Auto (ABR)
    if (engineRef.current === "dash") {
      const p = dashRef.current;
      if (!p) return;
      try {
        p.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: idx < 0 } } } });
        if (idx >= 0 && levels[idx]) p.setQualityFor("video", levels[idx]._qidx);
        setCurrentLevel(idx);
      } catch {}
    } else {
      const hls = hlsRef.current;
      if (!hls) return;
      if (idx < 0) { hls.currentLevel = -1; setCurrentLevel(-1); }
      else if (levels[idx]) {
        const origIdx = (hls.levels || []).findIndex((l) => l.height === levels[idx].height);
        if (origIdx >= 0) { hls.currentLevel = origIdx; setCurrentLevel(idx); }
      }
    }
    setShowQuality(false);
  };

  const selectSub = (id) => {
    const v = videoRef.current; if (!v) return;
    const tracks = v.textTracks;
    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i].label && subtitles.some((s) => s.name === tracks[i].label))
        tracks[i].mode = i === id ? "showing" : "hidden";
    }
    setSubId(id); setShowSubs(false);
  };
  const doSkip = () => { if (!skipPrompt || !skipTimings?.[skipPrompt]) return; const v = videoRef.current; if (!v) return; v.currentTime = Number(skipTimings[skipPrompt].endTime); setSkipPrompt(null); };

  // ── Keyboard shortcuts (ref pattern, one stable listener) ───────────────────
  const kbStateRef = useRef({});
  kbStateRef.current = {
    volume, rate, subId, audioId, audioTracks, levels, currentLevel, subtitles,
    togglePlay, seekBy, seekTo, changeVol, toggleMute, toggleFullscreen,
    setSpeed, selectSub, selectAudio, selectQuality, showControls,
  };
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || e.target?.isContentEditable) return;
      const v = videoRef.current; if (!v) return;
      const s = kbStateRef.current;
      switch (e.key) {
        case " ": case "k": e.preventDefault(); s.togglePlay(); break;
        case "ArrowLeft": case "j": e.preventDefault(); s.seekBy(-10); break;
        case "ArrowRight": case "l": e.preventDefault(); s.seekBy(10); break;
        case "ArrowUp": e.preventDefault(); s.changeVol(s.volume + 0.05); break;
        case "ArrowDown": e.preventDefault(); s.changeVol(s.volume - 0.05); break;
        case "f": s.toggleFullscreen(); break;
        case "m": s.toggleMute(); break;
        case "<": s.setSpeed(Math.max(0.5, +(s.rate - 0.25).toFixed(2))); break;
        case ">": s.setSpeed(Math.min(2, +(s.rate + 0.25).toFixed(2))); break;
        case "c": if (s.subtitles.length) { const next = s.subId < 0 ? 0 : s.subId + 1 < s.subtitles.length ? s.subId + 1 : -1; s.selectSub(next); } break;
        case "a": if (s.audioTracks.length > 1) { const next = (s.audioId + 1) % s.audioTracks.length; s.selectAudio(next); } break;
        case "q": if (s.levels.length) { const next = s.currentLevel < 0 ? 0 : s.currentLevel + 1 < s.levels.length ? s.currentLevel + 1 : -1; s.selectQuality(next); } break;
        default: if (/^[0-9]$/.test(e.key)) { e.preventDefault(); s.seekTo(Number(e.key) / 10); }
      }
      s.showControls();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── Close any open menu on outside click ────────────────────────────────────
  useEffect(() => {
    if (!showTracks && !showQuality && !showSpeed && !showSubs) return;
    const onDown = () => { setShowTracks(false); setShowQuality(false); setShowSpeed(false); setShowSubs(false); };
    const t = setTimeout(() => document.addEventListener("click", onDown), 0);
    return () => { clearTimeout(t); document.removeEventListener("click", onDown); };
  }, [showTracks, showQuality, showSpeed, showSubs]);

  // ── RENDER: loading ─────────────────────────────────────────────────────────
  if (state === "loading") {
    return (
      <div className="torrpicker">
        <div className="torrpicker-head">
          <div className="torrplayer-title">Онлайн (Collaps) — русская озвучка · до 4K</div>
          <div className="torrpicker-status"><span className="torrpicker-busy">Поиск источника{meta ? ` · ${meta}` : ""}…</span></div>
        </div>
        <div className="torrpicker-list"><div className="torrpicker-empty">Подключаемся к Collaps и ищем {type === "tv" ? `серию ${season}x${episode}` : "фильм"}…</div></div>
      </div>
    );
  }
  if (state === "error") {
    return (
      <div className="torrpicker">
        <div className="torrpicker-head">
          <div className="torrplayer-title">Онлайн (Collaps)</div>
          <div className="torrpicker-status"><span className="torrpicker-error">{error}</span></div>
        </div>
        <div className="torrpicker-list"><div className="torrpicker-empty">Не удалось найти онлайн-источник. Возможные причины: нет imdb_id у этого тайтла на TMDB, Collaps не имеет этой раздачи, или CDN временно недоступен. Попробуйте источник «Торренты» или другой.</div></div>
      </div>
    );
  }

  const menuClass = "torrplayer-audio-menu";
  const currentQualityLabel = currentLevel < 0 ? "Авто" : levels[currentLevel]?.label || "Авто";

  return (
    <div
      className={"torrplayer" + (controlsVisible ? "" : " torrplayer--hidden-cursor")}
      ref={containerRef}
      onMouseMove={showControls}
      onMouseLeave={() => { if (videoRef.current && !videoRef.current.paused) setControlsVisible(false); }}
    >
      <video ref={videoRef} className="torrplayer-video" playsInline crossOrigin="anonymous" onClick={togglePlay} onDoubleClick={toggleFullscreen} />
      {waiting && <div className="torrplayer-spinner" />}
      {skipPrompt && (
        <button className="torrplayer-skip" onClick={doSkip}>
          <span className="torrplayer-skip-title">ПРОПУСТИТЬ</span>
          <span className="torrplayer-skip-sub">{skipPrompt === "intro" ? "ИНТРО" : "ЭНДИНГ"}</span>
        </button>
      )}
      {!playing && !waiting && (
        <button className="torrplayer-bigplay" onClick={togglePlay} title="Смотреть"><PlayI /></button>
      )}
      <div className={"torrplayer-controls" + (controlsVisible ? "" : " torrplayer-controls--hidden")}>
        <button className="torrplayer-btn" onClick={() => seekBy(-10)} title="Назад 10с (← / J)"><Back10I /></button>
        <button className="torrplayer-btn" onClick={togglePlay} title={playing ? "Пауза (Space / K)" : "Смотреть (Space / K)"}>{playing ? <PauseI /> : <PlayI />}</button>
        <button className="torrplayer-btn" onClick={() => seekBy(10)} title="Вперёд 10с (→ / L)"><Fwd10I /></button>
        <button className="torrplayer-btn" onClick={toggleMute} title={muted ? "Включить звук (M)" : "Выключить звук (M)"}>{muted || volume === 0 ? <MuteI /> : <VolumeI />}</button>
        <input className="torrplayer-volume" type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} onChange={(e) => changeVol(e.target.value)} title="Громкость (↑ / ↓)" />
        <span className="torrplayer-time">{fmt(current)} / {fmt(duration)}</span>
        <div className="torrplayer-seek" onClick={onSeekClick} onMouseMove={onSeekMove} onMouseLeave={() => setHoverTime(null)} title="Перемотка (0–9)">
          {duration > 0 && buffered > 0 && <div className="torrplayer-seek-buffer" style={{ width: `${(buffered / duration) * 100}%` }} />}
          <div className="torrplayer-seek-fill" style={{ width: `${duration ? (current / duration) * 100 : 0}%` }} />
          {hoverTime != null && <div className="torrplayer-seek-hover" style={{ left: `${duration ? (hoverTime / duration) * 100 : 0}%` }}>{fmt(hoverTime)}</div>}
        </div>

        {/* Speed */}
        <div className="torrplayer-audio">
          <button className="torrplayer-btn" onClick={() => { setShowSpeed((v) => !v); setShowTracks(false); setShowQuality(false); setShowSubs(false); }} title="Скорость (< >)"><GearI /><span className="torrplayer-audio-label">{rate}×</span></button>
          {showSpeed && (
            <div className={menuClass}>
              {SPEEDS.map((s) => (<button key={s} className={"torrplayer-audio-item" + (s === rate ? " active" : "")} onClick={() => setSpeed(s)}>{s}×{s === 1 ? " (норма)" : ""}</button>))}
            </div>
          )}
        </div>

        {/* Subtitles */}
        {subtitles.length > 0 && (
          <div className="torrplayer-audio">
            <button className={"torrplayer-btn" + (subId >= 0 ? " torrplayer-btn--active" : "")} onClick={() => { setShowSubs((v) => !v); setShowTracks(false); setShowQuality(false); setShowSpeed(false); }} title="Субтитры (C)"><SubI /><span className="torrplayer-audio-label">{subId >= 0 ? "ON" : "OFF"}</span></button>
            {showSubs && (
              <div className={menuClass}>
                <button className={"torrplayer-audio-item" + (subId < 0 ? " active" : "")} onClick={() => selectSub(-1)}>Выключить</button>
                {subtitles.map((s, i) => (<button key={i} className={"torrplayer-audio-item" + (i === subId ? " active" : "")} onClick={() => selectSub(i)}>{s.name}</button>))}
              </div>
            )}
          </div>
        )}

        {/* Audio */}
        {audioTracks.length > 1 && (
          <div className="torrplayer-audio">
            <button className={"torrplayer-btn" + (audioId >= 0 ? " torrplayer-btn--active" : "")} onClick={() => { setShowTracks((v) => !v); setShowQuality(false); setShowSpeed(false); setShowSubs(false); }} title="Аудиодорожка (A)"><AudioI /><span className="torrplayer-audio-label">{audioTracks[audioId]?.name || `Аудио ${(audioId ?? -1) + 1}`}</span></button>
            {showTracks && (
              <div className={menuClass}>
                {audioTracks.map((t, i) => (<button key={i} className={"torrplayer-audio-item" + (i === audioId ? " active" : "")} onClick={() => selectAudio(i)}>{t.name}</button>))}
              </div>
            )}
          </div>
        )}

        {/* Quality */}
        {levels.length > 0 && (
          <div className="torrplayer-audio">
            <button className="torrplayer-btn" onClick={() => { setShowQuality((v) => !v); setShowTracks(false); setShowSpeed(false); setShowSubs(false); }} title="Качество (Q)"><span className="torrplayer-audio-label">{currentQualityLabel}</span></button>
            {showQuality && (
              <div className={menuClass}>
                <button className={"torrplayer-audio-item" + (currentLevel < 0 ? " active" : "")} onClick={() => selectQuality(-1)}>Авто (ABR)</button>
                {levels.map((l, i) => (<button key={i} className={"torrplayer-audio-item" + (i === currentLevel ? " active" : "")} onClick={() => selectQuality(i)}>{l.label}{l.height >= 2160 ? " ⭐" : ""}</button>))}
              </div>
            )}
          </div>
        )}

        <button className="torrplayer-btn" onClick={toggleFullscreen} title="Полный экран (F)"><FullscreenI /></button>
      </div>
    </div>
  );
}
