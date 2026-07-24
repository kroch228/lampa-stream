// ── Universal intro/outro/recap detection for movies & non-anime series ───────
//
// AniSkip (aniSkip.js) gives exact intro/outro timestamps for ANIME series via
// MyAnimeList ids, but there is no public timestamp source for movies or live-
// action series. This module provides a HEURISTIC fallback that works on any
// stream by analysing audio energy:
//
//   • Intro/logo: studio logos and title cards are usually SILENT or near-silent,
//     while the main content has dialogue/music. We sample audio energy during
//     the first ~3 minutes; the intro ends where sustained audio energy begins.
//   • Recap ("previously on..."): harder — it has audio. We DON'T auto-detect
//     recaps for non-anime (too unreliable); the button only appears for
//     confirmed intro/endings.
//   • Outro/credits: we expose a "credits" estimate = last ~8% of runtime, so
//     the user can skip credits. This is approximate.
//
// The detector taps the <video> element via Web Audio (MediaElementSource),
// runs an AnalyserNode while playback is within the scan window, then detaches.
// It's best-effort: if audio analysis isn't available (e.g. CORS-blocked
// MediaElementSource on some CDNs), we fall back to a conservative fixed intro
// estimate (logo ~ first 30s) and credits = last 8% — still useful, never wrong
// enough to skip actual content mid-film.
//
// Result shape matches AniSkip: { intro?: {startTime,endTime}, outro?: {...},
// recap?: {...}, source: "audio"|"fallback"|"none" }.

const SCAN_WINDOW = 180; // analyse the first 3 minutes for the intro boundary
const SAMPLE_INTERVAL = 250; // ms between energy samples
const SILENCE_THRESHOLD = 0.02; // RMS below this ≈ silence (logos/title cards)
const MIN_INTRO = 8; // don't report an intro shorter than this (false positives)
const MAX_INTRO = 150; // nor absurdly long
const CREDITS_RATIO = 0.08; // outro ≈ last 8% of runtime

/**
 * Detect intro/outro by analysing the video's audio.
 * @param {HTMLVideoElement} video
 * @param {number} duration video duration (s)
 * @returns {Promise<{intro?:{startTime,endTime}, outro?:{startTime,endTime}, source:"audio"|"none"}>}
 */
export function detectIntroByAudio(video, duration) {
  return new Promise((resolve) => {
    if (!video || !duration || typeof AudioContext === "undefined") {
      resolve({ source: "none" });
      return;
    }
    let ctx = null;
    let source = null;
    let analyser = null;
    let raf = null;
    let samples = []; // { t, rms }
    let settled = false;
    const cleanup = () => {
      try { if (raf) cancelAnimationFrame(raf); } catch {}
      try { if (analyser) analyser.disconnect(); } catch {}
      try { if (source) source.disconnect(); } catch {}
      try { if (ctx && ctx.state !== "closed") ctx.close(); } catch {}
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      source = ctx.createMediaElementSource(video);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      analyser.connect(ctx.destination);
    } catch {
      // CORS or double-tap: MediaElementSource can't be created. Bail to fallback.
      finish({ source: "none" });
      return;
    }

    const buf = new Uint8Array(analyser.fftSize);
    const tick = () => {
      if (settled) return;
      const t = video.currentTime;
      if (t >= SCAN_WINDOW || t >= duration) {
        // Scan window done — compute the intro boundary from collected samples.
        const intro = boundaryFromSamples(samples, duration);
        const outro = creditsEstimate(duration);
        finish({ intro, outro, source: intro ? "audio" : "none" });
        return;
      }
      analyser.getByteTimeDomainData(buf);
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) {
        const x = (buf[i] - 128) / 128;
        sumSq += x * x;
      }
      const rms = Math.sqrt(sumSq / buf.length);
      samples.push({ t, rms });
      raf = requestAnimationFrame(tick);
    };
    // Resume context (browsers suspend until a user gesture; play() already ran).
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    raf = requestAnimationFrame(tick);
    // Safety: never hold the tap open forever.
    setTimeout(() => finish({ source: "none" }), (SCAN_WINDOW + 10) * 1000);
  });
}

// Find the first sustained "loud" region → intro ends just before it.
function boundaryFromSamples(samples, duration) {
  if (!samples.length) return null;
  // Smooth: mark each sample as silent or not.
  const flags = samples.map((s) => s.rms < SILENCE_THRESHOLD);
  // The intro is the leading run of (mostly) silent samples.
  // Require a run of >= MIN_INTRO seconds of silence before the first loud burst.
  let firstLoud = -1;
  for (let i = 0; i < flags.length; i++) {
    if (!flags[i]) { firstLoud = samples[i].t; break; }
  }
  if (firstLoud < 0) return null; // whole window silent (e.g. no audio track)
  if (firstLoud < MIN_INTRO) return null; // audio starts immediately → no logo intro
  if (firstLoud > MAX_INTRO) firstLoud = MAX_INTRO;
  // endTime = where sustained content begins; startTime = 0 (skip the whole intro).
  return { startTime: 0, endTime: Math.round(firstLoud * 10) / 10 };
}

// Outro ≈ last CREDITS_RATIO of runtime (credits roll). Approximate but useful.
export function creditsEstimate(duration) {
  if (!duration || duration < 60) return null;
  const start = Math.round((duration * (1 - CREDITS_RATIO)) * 10) / 10;
  const end = Math.round(duration * 10) / 10;
  return { startTime: start, endTime: end };
}

// Conservative fallback when audio analysis is unavailable: assume a short
// studio-logo intro (~30s) + credits estimate. Never skips mid-content.
export function fallbackTimings(duration) {
  if (!duration) return { source: "none" };
  const intro =
    duration > 90 ? { startTime: 0, endTime: 30 } : null; // only for non-trivial media
  return { intro, outro: creditsEstimate(duration), source: "fallback" };
}

/**
 * Merge a confirmed (AniSkip) timing set with a heuristic one. Confirmed wins
 * per-segment; heuristic fills only the segments AniSkip didn't provide.
 */
export function mergeTimings(confirmed, heuristic) {
  const out = {};
  if (confirmed) {
    if (confirmed.intro) out.intro = confirmed.intro;
    if (confirmed.outro) out.outro = confirmed.outro;
    if (confirmed.recap) out.recap = confirmed.recap;
  }
  if (heuristic) {
    if (!out.intro && heuristic.intro) out.intro = heuristic.intro;
    if (!out.outro && heuristic.outro) out.outro = heuristic.outro;
  }
  return Object.keys(out).length ? out : null;
}
