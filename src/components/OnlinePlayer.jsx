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
// hls.js (~150KB) is loaded lazily ONLY when an HLS stream actually attaches,
// so it stays out of the initial movie-page bundle. dash.js is likewise lazy
// (desktop-only vendor bundle). Both keep the movie chunk small for fast nav.
let _HlsPromise = null;
function loadHls() {
  if (!_HlsPromise) _HlsPromise = import("hls.js").then((m) => m.default);
  return _HlsPromise;
}
// dash.js is loaded lazily (only on desktop) to avoid shipping its 779KB
// bundle to mobile, where HLS (ABR) is preferred for faster startup.
import {
  tmdbFetch,
  fetchAnilistData,
  isAnimeContent,
  imgUrl,
} from "../utils/api";
import { fetchAniSkipTimings } from "../utils/aniSkip";
import { fallbackTimings, mergeTimings } from "../utils/introDetect";
import { applySync as applyWatchSync } from "../utils/watchParty";
import { storage, STORAGE_KEYS } from "../utils/storage";
import {
  collapsResolve,
  collapsFindKp,
  labelAudioTracks,
  preferredRuTrackIndex,
} from "../utils/collaps-client";
import { PiPIcon } from "./Icons";

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
  // ── Next episode (TV only): called once when the ending/outro starts (or when
  // only `watchedThreshold` seconds remain, as a fallback when no outro timing
  // is known). The parent (TVPage) turns this into the autoplay-next countdown.
  onNext = null,
  // ── Watch Together (optional; no-op when absent — normal MoviePage/TVPage) ──
  syncRole = null, // "host" | "follower" | null
  syncState = null, // follower: { playing, position, updatedAt } from the room
  onPlaybackState = null, // host: cb({ playing, position }) on local control changes
}) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const dashRef = useRef(null);
  const engineRef = useRef(null); // "dash" | "hls"
  const containerRef = useRef(null);
  const progressTimerRef = useRef(null);
  const skipTimerRef = useRef(null);
  // Resume-seek guard: while set, the progress interval must NOT save (the seek
  // is still settling and currentTime can momentarily read 0, which would
  // overwrite the real saved position). Cleared on `seeked` (or after 5s safety).
  const resumeTargetRef = useRef(null);
  const hideTimerRef = useRef(null);
  const subsAddedRef = useRef(false);
  const errCountRef = useRef(0);
  const resumeDoneRef = useRef(false); // seek to saved timecode once per stream
  const hoverRafRef = useRef(null); // rAF throttle for seek-hover tooltip
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

  // ── Cast-on-pause (Kinopoisk-style): real name + character + photo ──────────
  const [cast, setCast] = useState([]); // [{ id, name, character, profile }]

  const [skipTimings, setSkipTimings] = useState(null);
  const [skipPrompt, setSkipPrompt] = useState(null);
  const [introSkipMode] = useState(() => storage.get(STORAGE_KEYS.INTRO_SKIP_MODE) || "manual");
  // Heuristic skip for movies & non-anime series (separate setting). Anime
  // series use introSkipMode + AniSkip (exact); everything else uses this.
  // Defaults to "manual" so the skip-intro / skip-ending buttons appear out of
  // the box. Uses safe fallback timings (no audio tap → no mute risk).
  const [heuristicSkipMode] = useState(
    () => storage.get(STORAGE_KEYS.SKIP_HEURISTIC_MODE) || "manual",
  );
  // Next-episode: fire onNext once when the outro starts (or remaining ≤
  // threshold). Reset on every stream change so each episode gets one trigger.
  const onNextRef = useRef(onNext);
  onNextRef.current = onNext;
  const nextFiredRef = useRef(false);

  const [controlsVisible, setControlsVisible] = useState(true);
  const [hoverTime, setHoverTime] = useState(null);

  // Fullscreen mirror (ref) so the mobile landscape auto-fullscreen effect can
  // read the current fullscreen state inside async/orientation handlers without
  // going stale (same ref-mirror pattern used for saveRef/markWatchedRef above).
  const fullscreenRef = useRef(false); fullscreenRef.current = fullscreen;
  // Picture-in-Picture (mobile only).
  const [pipActive, setPipActive] = useState(false);
  // True ONLY while the current fullscreen was auto-triggered by us (landscape
  // rotation). Prevents fighting the user's manual toggle.
  const _autoFsRef = useRef(false);
  // Mobile detection — render-gates the PiP button and gates the landscape
  // auto-fullscreen effect. Same pattern as the engine-selection effect above.
  const isMobile = typeof window !== "undefined" && (
    window.matchMedia?.("(max-width: 768px)")?.matches ||
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "")
  );

  const destroyAll = useCallback(() => {
    if (dashRef.current) { try { dashRef.current.reset(); } catch {} dashRef.current = null; }
    if (hlsRef.current) { try { hlsRef.current.destroy(); } catch {} hlsRef.current = null; }
    engineRef.current = null;
  }, []);

  // ── Precise resume timecodes (seconds) ───────────────────────────────────────
  // progress (percentage) drives the UI bar + "watched" threshold + sync; this
  // parallel map stores the EXACT second the viewer reached, so a reload resumes
  // to the right moment instead of a rounded percentage (off by up to ~1% of the
  // duration). Falls back to the percentage if no timecode is stored yet (e.g.
  // data saved by an older build), so existing users keep working.
  const saveResumeTime = useCallback((t) => {
    try {
      const map = storage.get(STORAGE_KEYS.RESUME_TIME) || {};
      map[progressKey] = Math.max(0, Math.round(t * 10) / 10); // 0.1s precision
      storage.set(STORAGE_KEYS.RESUME_TIME, map);
    } catch {}
  }, [progressKey]);

  const resumeAt = useCallback((v) => {
    if (resumeDoneRef.current) return;
    const dur = v.duration;
    if (!dur || !isFinite(dur)) return; // not ready yet (HLS can fire early)
    try {
      const tMap = storage.get(STORAGE_KEYS.RESUME_TIME) || {};
      const pMap = storage.get(STORAGE_KEYS.WATCH_PROGRESS) || {};
      let t = tMap[progressKey];
      if (typeof t !== "number") {
        const pct = pMap[progressKey];
        t = typeof pct === "number" ? (pct / 100) * dur : null; // legacy fallback
      }
      if (typeof t !== "number" || t < 5 || t > dur - 10) return; // too early / basically finished
      // Mark a resume-seek in flight so the progress interval doesn't overwrite
      // the saved position with a stale 0 while the seek settles. Cleared on
      // `seeked` (see the video-events effect) or after 5s as a safety net.
      resumeTargetRef.current = t;
      setTimeout(() => { if (resumeTargetRef.current === t) resumeTargetRef.current = null; }, 5000);
      v.currentTime = t;
      resumeDoneRef.current = true;
    } catch {}
  }, [progressKey]);

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
        const timings = await fetchAniSkipTimings(
          data.idMal,
          Number(episode),
          duration || 0,
        );
        if (cancelled) return;
        // Merge with any heuristic timings already collected (credits estimate
        // fills in if AniSkip only has the intro). Confirmed (AniSkip) wins.
        setSkipTimings((prev) => mergeTimings(timings, prev) || timings);
      } catch {}
    })();
    return () => { cancelled = true; };
    // duration is a dep so we re-fetch with the real episodeLength once the
    // stream metadata loads — AniSkip returns better-aligned OP/ED timings for
    // the matching episode length (fixes OP/ED skew on dub/encode versions).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, episode, introSkipMode, type, details, duration]);

  // ── Fetch cast (real name + character + photo) for the pause overlay ────────
  // Movies: /movie/{id}/credits. TV: /tv/{id}/credits (series main cast). Top
  // ~10 billed, with a profile photo. Shown when the user pauses — like the
  // Kinopoisk player's cast panel (this is the full cast, not frame-recognized).
  useEffect(() => {
    if (!apiKey || !item?.id) { setCast([]); return; }
    let cancelled = false;
    const path = type === "tv" ? `/tv/${item.id}/credits` : `/movie/${item.id}/credits`;
    tmdbFetch(path, apiKey)
      .then((d) => {
        if (cancelled) return;
        const list = (d.cast || [])
          .slice(0, 12)
          .map((c) => ({ id: c.id, name: c.name, character: c.character, profile: c.profile_path }))
          .filter((c) => c.name);
        if (!cancelled) setCast(list);
      })
      .catch(() => { if (!cancelled) setCast([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, type, apiKey]);

  // ── Heuristic intro/outro for movies & non-anime series ─────────────────────
  // AniSkip only covers anime series. For everything else (and for anime
  // movies, which AniSkip doesn't timestamp), use safe fallback timings: a
  // conservative ~30s intro skip (studio logos) + a credits estimate (last
  // ~8% of runtime) for the outro. No audio tap is used, so there's no risk of
  // muting cross-origin streams. The outro also drives the "next episode when
  // the ending starts" trigger. Runs only when the user enabled it.
  useEffect(() => {
    if (heuristicSkipMode === "off") return;
    // Skip for anime series — AniSkip handles those exactly.
    if (type === "tv" && episode && isAnimeContent(item, details)) return;
    let cancelled = false;
    const run = async () => {
      const v = videoRef.current;
      if (!v) return;
      // Wait until we have a real duration.
      if (!v.duration || !isFinite(v.duration)) {
        if (!cancelled) setTimeout(run, 500);
        return;
      }
      const heuristic = fallbackTimings(v.duration);
      if (cancelled || !heuristic) return;
      setSkipTimings((prev) => mergeTimings(prev, heuristic) || heuristic);
    };
    // Small delay so the engine has attached and playback has started.
    const t = setTimeout(run, 1200);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, heuristicSkipMode, type, episode, item?.id, details]);

  // ── Attach engine when stream is ready (DASH preferred → 4K) ────────────────
  useEffect(() => {
    if (!stream) return;
    const v = videoRef.current;
    if (!v) return;
    destroyAll();
    resumeDoneRef.current = false; // allow one resume seek for this stream
    setCurrent(0); setDuration(0); setBuffered(0);
    setAudioTracks([]); setAudioId(-1);
    setLevels([]); setCurrentLevel(-1);
    setSkipTimings(null); setSkipPrompt(null);
    nextFiredRef.current = false; // new episode → allow one next-episode trigger
    errCountRef.current = 0;
    // Guard so an async attachHls (which awaits the dynamic hls.js import) bails
    // out if the effect cleaned up (stream change / unmount) before Hls loaded —
    // otherwise we'd attach a new Hls to a gone video and leak it.
    let disposed = false;

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
          resumeAt(v);
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

    const attachHls = async () => {
      if (!stream.hls) { setState("error"); setError("Поток недоступен (нет DASH/HLS)"); return; }
      const Hls = await loadHls();
      if (disposed) return; // effect cleaned up while hls.js was loading
      if (!Hls.isSupported()) { v.src = stream.hls; v.play().catch(() => {}); return; }
      // On mobile, cap to player size + use ABR (Auto) so cellular users don't
      // pull 4K segments into a 480px player. Desktop keeps best-quality default.
      const isMobile = typeof window !== "undefined" && (
        window.matchMedia?.("(max-width: 768px)")?.matches ||
        /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "")
      );
      const hls = new Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 30, capLevelToPlayerSize: isMobile });
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
        if (isMobile) {
          // ABR: let hls.js adapt to bandwidth + player size (faster start, less
          // buffering on cellular). currentLevel=-1 = Auto.
          hls.currentLevel = -1; setCurrentLevel(-1);
        } else if (lvls.length) {
          // Desktop: default to best quality
          const bestHlsLevel = lvls[0]._hlsLevel;
          const origIdx = (hls.levels || []).findIndex((l) => l.height === bestHlsLevel);
          if (origIdx >= 0) { hls.currentLevel = origIdx; setCurrentLevel(0); }
        }
        resumeAt(v);
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

    // Engine selection (priority: DASH on desktop → HLS everywhere).
    //   Desktop (wide screen): try DASH first (up to 4K + multi-audio), fall
    //     back to HLS if DASH fails or is absent.
    //   Mobile: skip DASH entirely — dash.js is a 779KB bundle that slows
    //     startup, HLS ABR is faster on cellular, and 4K is wasted on a small
    //     screen. Go straight to HLS.
    //   When stream.dash is null (e.g. Kuroko no Basket — HLS-only, 720p max),
    //     skip attachDash() entirely to save an async call. The guard inside
    //     attachDash still catches this, but routing it here makes the intent
    //     explicit and avoids the await overhead.
    const isMobile = typeof window !== "undefined" && (
      window.matchMedia?.("(max-width: 768px)")?.matches ||
      /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "")
    );
    (async () => {
      if (stream.dash && !isMobile) {
        const ok = await attachDash();
        if (!ok) attachHls();
      } else if (stream.hls) {
        attachHls();
      } else {
        setState("error"); setError("Поток недоступен (нет DASH/HLS)");
      }
    })();
    return () => { disposed = true; destroyAll(); };
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
    const onPause = () => { setPlaying(false); if (v.currentTime > 0 && resumeTargetRef.current == null) saveResumeTime(v.currentTime); };
    const onSeeked = () => { resumeTargetRef.current = null; }; // resume-seek settled → safe to save again
    const onRate = () => setRate(v.playbackRate || 1);
    const onVol = () => { setVolume(v.volume); setMuted(v.muted); };
    const onWaiting = () => setWaiting(true);
    const onPlaying = () => setWaiting(false);
    const onCanPlay = () => setWaiting(false);
    const onProgress = () => { try { if (v.buffered?.length) setBuffered(v.buffered.end(v.buffered.length - 1) || 0); } catch {} };
    const onLoadedMeta = () => {
      setDuration(v.duration || 0);
      resumeAt(v);
    };
    v.addEventListener("timeupdate", onTime); v.addEventListener("durationchange", onDur);
    v.addEventListener("play", onPlay); v.addEventListener("pause", onPause);
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("ratechange", onRate); v.addEventListener("volumechange", onVol);
    v.addEventListener("waiting", onWaiting); v.addEventListener("playing", onPlaying);
    v.addEventListener("canplay", onCanPlay); v.addEventListener("progress", onProgress);
    v.addEventListener("loadedmetadata", onLoadedMeta);
    return () => {
      v.removeEventListener("timeupdate", onTime); v.removeEventListener("durationchange", onDur);
      v.removeEventListener("play", onPlay); v.removeEventListener("pause", onPause);
      v.removeEventListener("seeked", onSeeked);
      v.removeEventListener("ratechange", onRate); v.removeEventListener("volumechange", onVol);
      v.removeEventListener("waiting", onWaiting); v.removeEventListener("playing", onPlaying);
      v.removeEventListener("canplay", onCanPlay); v.removeEventListener("progress", onProgress);
      v.removeEventListener("loadedmetadata", onLoadedMeta);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, progressKey]);

  // ── Watch Together sync ─────────────────────────────────────────────────────
  // Follower: enforce the host's playback state (drift-correct + play/pause)
  // immediately on every syncState change AND on a 500ms tick (expected
  // position advances with time, so we keep correcting between polls).
  //
  // syncState is a NEW object reference every poll (JSON.parse of the room
  // snapshot). We stash it in a ref so the 500ms tick reads the latest, and we
  // ALSO re-apply immediately whenever syncState changes (the [syncState] dep)
  // — this is the low-latency path: the moment a poll delivers a host
  // play/pause/seek, we apply it without waiting for the next tick.
  const syncStateRef = useRef(syncState);
  syncStateRef.current = syncState;
  useEffect(() => {
    if (syncRole !== "follower" || !syncState) return;
    const v = videoRef.current;
    if (!v) return;
    applyWatchSync(v, syncState);
  }, [syncRole, syncState]);
  useEffect(() => {
    if (syncRole !== "follower") return;
    const v = videoRef.current;
    if (!v) return;
    const apply = () => { if (syncStateRef.current) applyWatchSync(v, syncStateRef.current); };
    const tick = setInterval(apply, 500);
    return () => clearInterval(tick);
  }, [syncRole, stream]);

  useEffect(() => {
    if (syncRole !== "host" || !onPlaybackState) return;
    const v = videoRef.current;
    if (!v) return;
    const report = () => onPlaybackState({ playing: !v.paused, position: v.currentTime || 0 });
    const onPlay = () => report();
    const onPause = () => report();
    const onSeeked = () => report();
    const onRate = () => report();
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("ratechange", onRate);
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("seeked", onSeeked);
      v.removeEventListener("ratechange", onRate);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncRole, onPlaybackState, stream]);

  // ── Progress reporting ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!stream) return;
    clearInterval(progressTimerRef.current);
    progressTimerRef.current = setInterval(() => {
      const v = videoRef.current;
      if (!v || !v.duration || !isFinite(v.duration)) return;
      // Don't save while a resume-seek is settling — currentTime can read 0 and
      // wipe the real saved position. The `seeked` event clears this guard.
      if (resumeTargetRef.current != null) return;
      const pct = Math.min(100, Math.round((v.currentTime / v.duration) * 100));
      saveRef.current?.(progressKey, pct);
      saveResumeTime(v.currentTime);
      // Auto-mark watched when only `watchedThreshold` seconds remain (matches
      // the desktop player's semantics — NOT a percentage, so reopening at 80%
      // doesn't instantly mark it watched). Default 20s before the end.
      const remaining = v.duration - v.currentTime;
      if (remaining >= 0 && remaining <= watchedThreshold) {
        markWatchedRef.current?.(progressKey);
      }
    }, 5000);
    return () => clearInterval(progressTimerRef.current);
  }, [stream, watchedThreshold, progressKey]);

  // ── Persist the exact resume timecode on hide / unmount ─────────────────────
  // The 5s timer + pause save cover normal playback; this captures the precise
  // stop point right before a reload / tab-switch / unmount, so reopening the
  // same movie or episode resumes to the exact second (not up to 5s stale).
  useEffect(() => {
    if (!stream) return;
    const flush = () => {
      const v = videoRef.current;
      if (v && v.duration && v.currentTime > 0) saveResumeTime(v.currentTime);
    };
    const onVis = () => { if (document.visibilityState === "hidden") flush(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", flush);
    return () => {
      flush();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", flush);
    };
  }, [stream, saveResumeTime]);

  // ── Skip intro/outro/recap + next-episode-when-ending detection ───────────────
  // The active mode depends on the content: anime series use introSkipMode
  // (AniSkip, exact); everything else uses heuristicSkipMode. Resolve once per
  // content/timing change so the interval uses a stable mode.
  const isAnimeSeries = type === "tv" && episode && isAnimeContent(item, details);
  const activeSkipMode = isAnimeSeries ? introSkipMode : heuristicSkipMode;
  useEffect(() => {
    const skipActive = skipTimings && activeSkipMode !== "off";
    // Run the 1s tick if either skip is active OR a next-episode callback is
    // wired (so we can switch episodes when the ending starts even with skip off).
    if (!skipActive && !onNext) { setSkipPrompt(null); return; }
    clearInterval(skipTimerRef.current);
    skipTimerRef.current = setInterval(() => {
      const v = videoRef.current; if (!v || !v.duration) return;
      const ct = v.currentTime;

      // ── Skip prompt / auto-skip (intro / outro / recap) ──
      if (skipActive) {
        const { intro, outro, recap } = skipTimings;
        const inRecap = recap && ct >= recap.startTime && ct < recap.endTime - 1;
        const inIntro = intro && ct >= intro.startTime && ct < intro.endTime - 1;
        const inOutro = outro && ct >= outro.startTime && ct < outro.endTime - 1;
        const seg = inRecap ? "recap" : inIntro ? "intro" : inOutro ? "outro" : null;
        if (!seg) {
          setSkipPrompt(null);
        } else {
          setSkipPrompt(seg);
          if (activeSkipMode === "auto") {
            v.currentTime = Number(skipTimings[seg].endTime);
            setSkipPrompt(null);
          }
        }
      }

      // ── Next episode when the ending starts ──
      // If we have an outro timing, fire as soon as the ending begins (so the
      // countdown overlay plays over the credits). Otherwise fall back to the
      // watched-threshold (last N seconds). Fires once per stream.
      if (onNextRef.current && !nextFiredRef.current) {
        const outro = skipTimings?.outro;
        const remaining = v.duration - ct;
        const outroStarted = !!outro && ct >= outro.startTime;
        const nearEnd = remaining >= 0 && remaining <= watchedThreshold;
        if (outroStarted || nearEnd) {
          nextFiredRef.current = true;
          onNextRef.current();
        }
      }
    }, 1000);
    return () => clearInterval(skipTimerRef.current);
  }, [skipTimings, activeSkipMode, onNext, watchedThreshold]);

  // ── Fullscreen state ────────────────────────────────────────────────────────
  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    const onWebkitFs = () => setFullscreen(!!document.webkitFullscreenElement);
    // iOS Safari fires these on the <video> element, not on document.
    const onBegin = () => setFullscreen(true);
    const onEnd = () => setFullscreen(false);
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("webkitfullscreenchange", onWebkitFs);
    const v = videoRef.current;
    if (v) {
      v.addEventListener("webkitbeginfullscreen", onBegin);
      v.addEventListener("webkitendfullscreen", onEnd);
      v.addEventListener("enterfullscreen", onBegin);
      v.addEventListener("leavefullscreen", onEnd);
    }
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      document.removeEventListener("webkitfullscreenchange", onWebkitFs);
      if (v) {
        v.removeEventListener("webkitbeginfullscreen", onBegin);
        v.removeEventListener("webkitendfullscreen", onEnd);
        v.removeEventListener("enterfullscreen", onBegin);
        v.removeEventListener("leavefullscreen", onEnd);
      }
    };
  }, [stream]);

  // ── Picture-in-Picture state (mobile) ───────────────────────────────────────
  // Mirrors the PiP DOM state into React so the button can show active state.
  // Kept separate from the fullscreen effect above to avoid touching it.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onEnter = () => setPipActive(true);
    const onLeave = () => setPipActive(false);
    v.addEventListener("enterpictureinpicture", onEnter);
    v.addEventListener("leavepictureinpicture", onLeave);
    return () => {
      v.removeEventListener("enterpictureinpicture", onEnter);
      v.removeEventListener("leavepictureinpicture", onLeave);
    };
  }, [stream]);

  // ── Mobile: auto-fullscreen on landscape rotation ───────────────────────────
  // When the phone rotates to landscape → enter fullscreen; back to portrait →
  // exit. `_autoFsRef` is true ONLY while the current fullscreen was auto-
  // triggered by us, so we never fight the user's manual toggle: if they
  // manually exit while still in landscape, we clear the flag and do NOT
  // re-enter until they rotate away and back. Applies to all viewers
  // (incl. followers) — landscape fullscreen is a viewing affordance, not a
  // playback control. Every orientation/fullscreen call is wrapped in try/catch.
  useEffect(() => {
    if (!isMobile) return;
    const v = videoRef.current;
    const el = containerRef.current;

    const isLandscape = () => {
      try {
        if (screen.orientation?.type?.startsWith("landscape")) return true;
      } catch {}
      try {
        const mql = window.matchMedia?.("(orientation: landscape)");
        if (mql) return !!mql.matches;
      } catch {}
      return false;
    };

    // Enter fullscreen — reuses the toggleFullscreen enter-branch logic
    // (container.requestFullscreen() / iOS video.webkitEnterFullscreen()).
    // No orientation.lock here: the user already physically rotated to
    // landscape, locking would fight the device's physical orientation.
    const enterFs = async () => {
      try {
        const reqFS =
          el?.requestFullscreen?.() ||
          el?.webkitRequestFullscreen?.() ||
          el?.webkitRequestFullScreen?.();
        if (reqFS && typeof reqFS.then === "function") {
          try { await reqFS; } catch {}
        }
        if (!document.fullscreenElement && v?.webkitEnterFullscreen) {
          try { v.webkitEnterFullscreen(); } catch {}
        }
      } catch {}
    };

    const exitFs = async () => {
      if (document.exitFullscreen) {
        try { await document.exitFullscreen(); } catch {}
      }
      if (v?.webkitExitFullscreen) {
        try { v.webkitExitFullscreen(); } catch {}
      }
    };

    const onOrientationChange = () => {
      const landscape = isLandscape();
      // fullscreenRef.current is up-to-date here (orientation events fire
      // asynchronously, well after any fullscreen state change has settled).
      if (landscape && !fullscreenRef.current) {
        _autoFsRef.current = true;
        enterFs();
      } else if (!landscape && _autoFsRef.current) {
        _autoFsRef.current = false;
        exitFs();
      }
    };

    // Initial check (may mount already in landscape).
    try { onOrientationChange(); } catch {}

    // Preferred: screen.orientation change event.
    try { screen.orientation?.addEventListener?.("change", onOrientationChange); } catch {}
    // Fallback: matchMedia change + legacy orientationchange.
    const mql = window.matchMedia?.("(orientation: landscape)");
    try { mql?.addEventListener?.("change", onOrientationChange); } catch {}
    try { window.addEventListener?.("orientationchange", onOrientationChange); } catch {}

    // If the user MANUALLY exits fullscreen while still in landscape, clear the
    // auto flag so we don't re-enter until they rotate away and back. Reads the
    // live DOM state (fullscreenchange fires after the change is applied), so
    // it's correct even though fullscreenRef may not have flushed yet.
    const onFsChange = () => {
      const inFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
      if (!inFs && _autoFsRef.current && isLandscape()) {
        _autoFsRef.current = false;
      }
    };
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    if (v) v.addEventListener("webkitendfullscreen", onFsChange);

    return () => {
      try { screen.orientation?.removeEventListener?.("change", onOrientationChange); } catch {}
      try { mql?.removeEventListener?.("change", onOrientationChange); } catch {}
      try { window.removeEventListener?.("orientationchange", onOrientationChange); } catch {}
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
      if (v) v.removeEventListener("webkitendfullscreen", onFsChange);
    };
  }, [isMobile, stream]);

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
  // rAF-throttled: mousemove fires 60+×/sec; only one setHoverTime per frame.
  const onSeekMove = (e) => {
    const v = videoRef.current;
    if (!v || !v.duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    if (hoverRafRef.current) return;
    hoverRafRef.current = requestAnimationFrame(() => {
      hoverRafRef.current = null;
      setHoverTime(ratio * v.duration);
    });
  };
  const onSeekLeave = () => {
    if (hoverRafRef.current) { cancelAnimationFrame(hoverRafRef.current); hoverRafRef.current = null; }
    setHoverTime(null);
  };
  const toggleMute = () => { const v = videoRef.current; if (!v) return; v.muted = !v.muted; setMuted(v.muted); };
  const changeVol = (val) => { const v = videoRef.current; if (!v) return; const vol = Math.min(1, Math.max(0, Number(val))); v.volume = vol; v.muted = vol === 0; setVolume(vol); setMuted(vol === 0); };
  const setSpeed = (r) => { const v = videoRef.current; if (v) v.playbackRate = r; setRate(r); setShowSpeed(false); };
  const toggleFullscreen = async () => {
    const v = videoRef.current;
    if (!fullscreen) {
      // Try standard Fullscreen API on the container (works on desktop + Android Chrome).
      const el = containerRef.current;
      const reqFS =
        el?.requestFullscreen?.() ||
        el?.webkitRequestFullscreen?.() ||
        el?.webkitRequestFullScreen?.();
      if (reqFS && typeof reqFS.then === "function") {
        try { await reqFS; } catch {}
      }
      // iOS Safari: requestFullscreen on a div doesn't work — use the video
      // element's native fullscreen instead (webkitEnterFullscreen).
      if (!document.fullscreenElement && v?.webkitEnterFullscreen) {
        try { v.webkitEnterFullscreen(); } catch {}
      }
      // On mobile, lock to landscape for a proper fullscreen experience.
      try { await screen.orientation?.lock?.("landscape"); } catch {}
    } else {
      try { await screen.orientation?.unlock?.(); } catch {}
      if (document.exitFullscreen) {
        try { await document.exitFullscreen(); } catch {}
      }
      // iOS: exit via the video element.
      if (v?.webkitExitFullscreen) {
        try { v.webkitExitFullscreen(); } catch {}
      }
    }
  };

  // Picture-in-Picture toggle (mobile only; button is render-gated by isMobile).
  const togglePiP = async () => {
    if (document.pictureInPictureElement) {
      try { await document.exitPictureInPicture(); } catch {}
    } else if (document.pictureInPictureEnabled && videoRef.current) {
      try { await videoRef.current.requestPictureInPicture(); } catch {}
    }
  };

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
  // In Watch Together, a follower must NOT control playback — the host's
  // play/pause/seek is authoritative and applied via sync. We hide the control
  // bar / big play / skip prompt (CSS via .torrplayer--follower), disable
  // click-to-play, and block playback keyboard shortcuts. Local viewing keys
  // (fullscreen, mute, volume) stay enabled since they don't affect sync.
  const isFollower = syncRole === "follower";
  const kbStateRef = useRef({});
  kbStateRef.current = {
    volume, rate, subId, audioId, audioTracks, levels, currentLevel, subtitles,
    togglePlay, seekBy, seekTo, changeVol, toggleMute, toggleFullscreen,
    setSpeed, selectSub, selectAudio, selectQuality, showControls, isFollower,
  };
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || e.target?.isContentEditable) return;
      const v = videoRef.current; if (!v) return;
      const s = kbStateRef.current;
      // Followers: only local viewing keys (fullscreen / mute / volume).
      if (s.isFollower && !["f", "m", "ArrowUp", "ArrowDown"].includes(e.key)) return;
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
      className={"torrplayer" + (isFollower ? " torrplayer--follower" : "") + (controlsVisible ? "" : " torrplayer--hidden-cursor")}
      ref={containerRef}
      onMouseMove={showControls}
      onMouseLeave={() => { if (videoRef.current && !videoRef.current.paused) setControlsVisible(false); }}
    >
      <video ref={videoRef} className="torrplayer-video" playsInline crossOrigin="anonymous" onClick={isFollower ? undefined : togglePlay} onDoubleClick={toggleFullscreen} />
      {waiting && <div className="torrplayer-spinner" />}
      {skipPrompt && (
        <button className="torrplayer-skip" onClick={doSkip}>
          <span className="torrplayer-skip-title">ПРОПУСТИТЬ</span>
          <span className="torrplayer-skip-sub">
            {skipPrompt === "intro" ? "ИНТРО" : skipPrompt === "outro" ? "ЭНДИНГ" : "РЕКАП"}
          </span>
        </button>
      )}
      {/* Host: show when paused. Follower: show ONLY as a "tap to start"
          fallback when the browser blocked autoplay (host is playing but our
          local video is still paused) — one tap unblocks play(), then sync owns
          it. When the host is the one paused, no button (follower just waits). */}
      {!playing && !waiting && (!isFollower || !!syncState?.playing) && (
        <button className="torrplayer-bigplay" onClick={togglePlay} title="Смотреть"><PlayI /></button>
      )}
      {/* Cast-on-pause (Kinopoisk-style): real name + character + photo */}
      {!playing && !waiting && cast.length > 0 && (
        <div className="torrplayer-cast">
          <div className="torrplayer-cast-title">В ролях</div>
          <div className="torrplayer-cast-row">
            {cast.map((c) => (
              <div className="torrplayer-cast-card" key={c.id}>
                {c.profile ? (
                  <img className="torrplayer-cast-photo" src={imgUrl(c.profile, "w185")} alt={c.name} loading="lazy" />
                ) : (
                  <div className="torrplayer-cast-photo torrplayer-cast-photo--empty">👤</div>
                )}
                <div className="torrplayer-cast-name">{c.name}</div>
                {c.character && <div className="torrplayer-cast-char">{c.character}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className={"torrplayer-controls" + (controlsVisible ? "" : " torrplayer-controls--hidden")}>
        <button className="torrplayer-btn torrplayer-btn--seekback" onClick={() => seekBy(-10)} title="Назад 10с (← / J)"><Back10I /></button>
        <button className="torrplayer-btn torrplayer-btn--play" onClick={togglePlay} title={playing ? "Пауза (Space / K)" : "Смотреть (Space / K)"}>{playing ? <PauseI /> : <PlayI />}</button>
        <button className="torrplayer-btn torrplayer-btn--seekfwd" onClick={() => seekBy(10)} title="Вперёд 10с (→ / L)"><Fwd10I /></button>
        <button className="torrplayer-btn torrplayer-btn--mute" onClick={toggleMute} title={muted ? "Включить звук (M)" : "Выключить звук (M)"}>{muted || volume === 0 ? <MuteI /> : <VolumeI />}</button>
        <input className="torrplayer-volume" type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} onChange={(e) => changeVol(e.target.value)} title="Громкость (↑ / ↓)" />
        <span className="torrplayer-time">{fmt(current)} / {fmt(duration)}</span>
        <div className="torrplayer-seek" onClick={onSeekClick} onMouseMove={onSeekMove} onMouseLeave={onSeekLeave} title="Перемотка (0–9)">
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

        {isMobile && typeof document !== "undefined" && document.pictureInPictureEnabled && (<button className={"torrplayer-btn torrplayer-btn--pip" + (pipActive ? " torrplayer-btn--active" : "")} onClick={togglePiP} title="Картинка в картинке"><PiPIcon /></button>)}
        <button className="torrplayer-btn torrplayer-btn--fs" onClick={toggleFullscreen} title="Полный экран (F)"><FullscreenI /></button>
      </div>
    </div>
  );
}
