// Vercel serverless function: proxy for the Collaps online source.
//
// Why this exists: unlike TMDB (proxied via api/tmdb.js), Collaps requests
// were previously made directly from the visitor's BROWSER to
// api.delivembd.ws / *.interkh.com (see src/web/shim.js / src/utils/
// collaps-browser.js — segment tokens are IP-bound, so resolving client-side
// keeps the embed → manifest → segments all on the same IP). That works fine
// outside Russia, but api.delivembd.ws / *.interkh.com are blocked or heavily
// throttled for Russian ISPs without a VPN, so the Collaps source was
// unusable there even though TMDB (proxied) worked.
//
// This function runs on Vercel's infrastructure (not in Russia), so it
// reaches those hosts directly and re-serves the response to the browser —
// same trick as api/tmdb.js, just for a different upstream.
//
// IMPORTANT (segment-token IP binding): Collaps CDN segment URLs are bound to
// the IP that first resolved the manifest. If we only proxy the initial embed
// HTML fetch but the browser then hits the DASH/HLS manifest + segments
// DIRECTLY (still blocked), nothing is gained. So this proxy forwards ANY
// subpath under the known hosts — embed HTML, the manifest (.mpd/.m3u8), AND
// segment requests — as long as the caller routes them all through
// /api/collaps/<host>/<path>. See src/utils/collaps-client.js for how the
// manifest URL host is rewritten so dash.js/hls.js requests segments through
// this same proxy instead of hitting the upstream host directly.
//
// Route shape:
//   /api/collaps/h/<host>/<path...>?<query>
//     → https://<host>/<path...>?<query>
//   (also accepts the legacy /api/collaps/embed/... shorthand for
//    api.delivembd.ws, kept for convenience/back-compat with hand-built URLs)
//
// SECURITY: this is NOT a general-purpose open proxy. Only a small allowlist
// of exact/suffix-matched hosts is ever forwarded to — everything else is
// rejected with 400, so this can't be used as an SSRF pivot to internal
// Vercel infra or arbitrary third-party hosts.

const ALLOWED_EXACT_HOSTS = new Set(["api.delivembd.ws"]);
const ALLOWED_HOST_SUFFIXES = [".interkh.com"];

const UPSTREAM_TIMEOUT_MS = 20000; // manifests/segments can be larger than TMDB JSON
export const maxDuration = 25;
export const dynamic = "force-dynamic";

function isAllowedHost(host) {
  if (!host) return false;
  const h = host.toLowerCase();
  if (ALLOWED_EXACT_HOSTS.has(h)) return true;
  return ALLOWED_HOST_SUFFIXES.some((suf) => h.endsWith(suf));
}

// Headers that must NOT be blindly forwarded (either hop-by-hop, or would
// leak/mismatch when re-served from a different origin/host).
const STRIP_REQUEST_HEADERS = new Set([
  "host", "connection", "content-length", "accept-encoding",
  "cf-connecting-ip", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
  "x-vercel-id", "x-vercel-ip-country", "x-vercel-deployment-url",
]);
const STRIP_RESPONSE_HEADERS = new Set([
  "content-encoding", "content-length", "transfer-encoding", "connection",
  "set-cookie", "content-security-policy", "x-frame-options",
]);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(405).json({ error: "method not allowed" });
  }

  const url = new URL(req.url, "http://x");
  let path = url.pathname.replace(/^\/api\/collaps/, "");

  // Legacy shorthand: /api/collaps/embed/... → api.delivembd.ws/embed/...
  // (kept so a hand-built /api/collaps/embed/imdb/ttXXXX URL still works).
  let host;
  let upstreamPath;
  const hMatch = path.match(/^\/h\/([^/]+)(\/.*)?$/);
  if (hMatch) {
    host = decodeURIComponent(hMatch[1]);
    upstreamPath = hMatch[2] || "/";
  } else if (path.startsWith("/embed/") || path === "/embed") {
    host = "api.delivembd.ws";
    upstreamPath = path;
  } else {
    return res.status(400).json({ error: "bad path, expected /h/<host>/<path>" });
  }

  if (!isAllowedHost(host)) {
    return res.status(400).json({ error: "host not allowed" });
  }

  const target = `https://${host}${upstreamPath}${url.search || ""}`;

  try {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!v) continue;
      if (STRIP_REQUEST_HEADERS.has(k.toLowerCase())) continue;
      headers[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    // Range requests matter a lot for DASH/HLS segment fetching.
    if (req.headers.range) headers.range = req.headers.range;
    // Some Collaps hosts gate on Referer — mirror the header the old
    // client-side code sent directly (see collaps-browser.js).
    if (!headers.referer) headers.referer = `https://${host}/`;

    const upstream = await fetch(target, {
      method: req.method,
      headers,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    res.status(upstream.status);
    for (const [k, v] of upstream.headers.entries()) {
      if (STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) continue;
      try { res.setHeader(k, v); } catch {}
    }
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (req.method === "HEAD") return res.end();
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (e) {
    const isTimeout = e && (e.name === "TimeoutError" || e.name === "AbortError");
    res
      .status(isTimeout ? 504 : 502)
      .json({ error: isTimeout ? "Collaps upstream timeout" : "Collaps upstream error", message: e.message });
  }
}
