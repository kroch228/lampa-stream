// Vercel serverless function: forward TMDB API + image requests.
// Vercel's network is outside Russia, so it reaches api.themoviedb.org /
// image.tmdb.org directly — no DoH needed (that was only for the in-Russia PC).
// The visitor's Bearer token (their own TMDB Read Access Token) is passed
// through from the Authorization header, so each user uses their own token.
// CORS is open (the visitor's browser is the only client).

// Upstream fetch deadline. TMDB occasionally stalls on some endpoints (trending
// week, /popular/*) — without a deadline the function hangs until Vercel's
// platform timeout, which surfaces to the visitor as a client-side "Request
// timed out" instead of a fast 502. 8s is well under Vercel's hobby maxDuration.
const UPSTREAM_TIMEOUT_MS = 8000;

// Vercel function execution limit. Keep above UPSTREAM_TIMEOUT_MS so the
// timeout-abort produces a 502 response instead of Vercel killing the fn.
export const maxDuration = 12;
// Never cache the proxy at the edge — tokens are per-visitor and responses are
// user-scoped (Authorization is passed through).
export const dynamic = "force-dynamic";

export default async function handler(req, res) {
  // CORS preflight
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  // Route: /api/tmdb/3/movie/550  →  https://api.themoviedb.org/3/movie/550
  // Route: /api/tmdb/img/t/p/w500/x.jpg  →  https://image.tmdb.org/t/p/w500/x.jpg
  // (images are served through the same proxy to avoid mixed-content/CORS issues)
  const url = new URL(req.url, "http://x");
  const path = url.pathname.replace(/^\/api\/tmdb/, "");
  const isImage = path.startsWith("/img/");
  const target =
    (isImage ? "https://image.tmdb.org" : "https://api.themoviedb.org") +
    (isImage ? path.replace(/^\/img/, "") : path) +
    (url.search || "");

  try {
    const upstream = await fetch(target, {
      headers: req.headers.authorization ? { Authorization: req.headers.authorization } : {},
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    res.status(upstream.status);
    // Pass through content-type; images need their real type.
    const ct = upstream.headers.get("content-type");
    if (ct) res.setHeader("Content-Type", ct);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (e) {
    const isTimeout = e && (e.name === "TimeoutError" || e.name === "AbortError");
    res
      .status(isTimeout ? 504 : 502)
      .json({ error: isTimeout ? "TMDB upstream timeout" : "TMDB upstream error", message: e.message });
  }
}
