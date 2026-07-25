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
// rejected with 400. See ALLOWED_HOSTS below.

const ALLOWED_HOSTS = {
  /* exact match */ "api.delivembd.ws": true,
  /* suffix match — *.interkh.com hosts */
  suffixes: [".interkh.com"],
};

function isHostAllowed(host) {
  if (ALLOWED_HOSTS[host]) return true;
  if (ALLOWED_HOSTS.suffixes) {
    for (const suffix of ALLOWED_HOSTS.suffixes) {
      if (host.endsWith(suffix)) return true;
    }
  }
  return false;
}

function extractHostAndPath(url) {
  // /api/collaps/h/<host>/<path...>
  // or legacy /api/collaps/embed/... → host = api.delivembd.ws
  const u = new URL(url, "https://n"); // base is irrelevant, we just need the pathname
  const parts = u.pathname.split("/").filter(Boolean); // ["api", "collaps", "h"?, host?, ...]
  // parts[0] = api, parts[1] = collaps, parts[2] = h or embed
  if (parts[2] === "embed") {
    // /api/collaps/embed/imdb/... -> api.delivembd.ws
    return { host: "api.delivembd.ws", path: "/" + parts.slice(2).join("/") + u.search };
  }
  if (parts[2] !== "h" || parts.length < 4) return null;
  return { host: parts[3], path: "/" + parts.slice(4).join("/") + u.search };
}

export default async function handler(req, res) {
  // Only GET (and HEAD — Vercel sends HEAD for OPTIONS/CORS preflight)
  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const parsed = extractHostAndPath(req.url);
  if (!parsed) {
    return res.status(400).json({ error: "Invalid proxy URL. Use /api/collaps/h/<host>/<path>" });
  }

  if (!isHostAllowed(parsed.host)) {
    return res.status(400).json({ error: `Host not allowed: ${parsed.host}` });
  }

  const targetUrl = `https://${parsed.host}${parsed.path}`;

  // Mirror the response from the upstream, preserving streaming binary content
  // (video segments), CORS headers, and Range/Content-Range for byte-range
  // serving which dash.js/hls.js use for seeking.
  const headers = {};
  // Forward only safe hop-by-hop headers + Range (critical for video)
  for (const h of ["accept", "accept-encoding", "user-agent", "range", "if-none-match", "if-modified-since"]) {
    const v = req.headers[h];
    if (v) headers[h] = v;
  }
  // Set a safe user-agent for the upstream (some CDNs block curl/node)
  headers["user-agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

  try {
    const upstream = await fetch(targetUrl, { headers });
    // Set CORS headers (browsers need these when fetched from a different origin)
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, HEAD");
    // Forward relevant response headers
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "cache-control", "etag", "last-modified", "transfer-encoding"]) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.statusCode = upstream.status;
    // Pipe the body as text/buffer to avoid streaming issues
    const body = await upstream.arrayBuffer();
    res.end(Buffer.from(body));
  } catch (err) {
    return res.status(502).json({ error: `Upstream fetch failed: ${err.message}` });
  }
}
