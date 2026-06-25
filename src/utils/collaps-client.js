// ── Collaps renderer client: thin wrapper over the IPC bridge ───────────────
const e = () => window.electron;

export const collapsResolve = (args) => e()?.collapsResolve?.(args);
export const collapsFindKp = (args) => e()?.collapsFindKp?.(args);

// Relabel hls.js audioTracks with the friendly names from makePlayer (`names`).
// hls.js exposes tracks as {id, name (e.g. "rus0"), lang ("ru"|"uk"|"en")}.
// The `names` array maps positionally → audioTracks index.
export function labelAudioTracks(audioTracks, names) {
  if (!audioTracks || !names || names.length === 0) return audioTracks || [];
  return audioTracks.map((t, i) => ({
    ...t,
    name: names[i] || t.name || `Аудио ${i + 1}`,
    _friendly: names[i] || null,
  }));
}

// Pick the best default audio track: prefer "Рус. Дублированный" / "Рус.",
// then any ru-lang track. Returns the hls.js audioTrack index.
export function preferredRuTrackIndex(audioTracks, names) {
  if (!audioTracks || !audioTracks.length) return -1;
  const labels = names && names.length ? names : audioTracks.map((t) => t.name || "");
  // 1) exact Russian dub labels
  for (let i = 0; i < labels.length; i++) {
    const l = (labels[i] || "").toLowerCase();
    if (/рус.*дубл|русск.*дубл|^рус\b|рус\. дублированный/.test(l)) return i;
  }
  // 2) any "Рус" label
  for (let i = 0; i < labels.length; i++) {
    if (/рус|русск/.test((labels[i] || "").toLowerCase())) return i;
  }
  // 3) hls.js lang "ru" with DEFAULT, else first ru
  const def = audioTracks.findIndex((t) => t.default && (t.lang || "").toLowerCase().startsWith("ru"));
  if (def >= 0) return def;
  const ru = audioTracks.findIndex((t) => (t.lang || "").toLowerCase().startsWith("ru"));
  return ru >= 0 ? ru : 0;
}