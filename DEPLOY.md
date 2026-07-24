# Deploy to Vercel (web version)

A public, password-protected website where visitors enter the site password,
then their own TMDB Read Access Token, and watch the online (4K, Russian dubs)
source. Works in Russia without a VPN: TMDB is proxied through Vercel's
serverless function (Vercel's network reaches TMDB).

## What you need

- A [Vercel](https://vercel.com) account (free).
- This repo on GitHub (or use the Vercel CLI directly).
- A **site password** (you pick it; visitors enter it).
- (Visitors bring their own TMDB token — you don't need one.)

## Build-time env

The site password is baked into the client bundle as a **SHA-256 hash** (so the
plain password isn't in the bundle). Generate the hash and set it as a Vercel
env var:

```bash
# Generate the SHA-256 of your chosen site password, e.g. "mypassword":
node -e "console.log(require('crypto').createHash('sha256').update('mypassword').digest('hex'))"
# → 928b9... (copy this)
```

In Vercel: **Project → Settings → Environment Variables → add**:
- `VITE_SITE_PWD_HASH` = the hash above (must be set BEFORE the first build, or
  redeploy after adding it).

> If `VITE_SITE_PWD_HASH` is empty, the site is open (no password gate) — handy
> for testing.

## Deploy (GitHub → Vercel, easiest)

1. Push this branch to GitHub.
2. Vercel → **Add New → Project → Import** your repo.
3. Framework preset: **Vite**. Build command `npm run build`, output dir `dist`.
4. Add the `VITE_SITE_PWD_HASH` env var (above).
5. **Deploy**. Vercel builds `dist/` (static) + the `api/tmdb.js` serverless fn.
6. Your site is at `https://<your-project>.vercel.app`.

## Deploy (Vercel CLI)

```bash
npm i -g vercel
cd lampa-stream
# set the password hash as an env var for the build:
export VITE_SITE_PWD_HASH=$(node -e "console.log(require('crypto').createHash('sha256').update('mypassword').digest('hex'))")
vercel          # follow prompts; link the project
vercel --prod   # production deploy
```

## How it works

| Piece | Where | Notes |
|-|-|-|
| React app (renderer) | `dist/` static | served by Vercel CDN |
| TMDB API + images | `api/tmdb.js` serverless | forwards to api.themoviedb.org from Vercel's network (no Russia block, no VPN), passes the visitor's Bearer token, adds CORS |
| Site password | client-side gate (`src/web/gate.js`) | SHA-256 hash check; light gate, not real security |
| TMDB token | visitor's browser, `localStorage` | each visitor enters their own in the SetupScreen |
| Collaps stream resolve | client-side (`src/utils/collaps-browser.js`) | browser fetches the embed + segments from its own IP (CDN tokens are IP-bound) |
| dash.js / hls.js | browser | loads segments directly from the Collaps CDN (CORS ok, normal browser UA → 200) |

## Visitor flow

1. Open `https://<site>.vercel.app` → **site password gate** (enter the password
   you set).
2. **SetupScreen** → enter their TMDB Read Access Token (get it free at
   themoviedb.org/settings/api — the long JWT). Stored in their browser only.
3. Catalog loads (TMDB via the proxy, no VPN).
4. Open a movie/series → Play → source **«Онлайн»** → 4K + Russian dubs.

## Watch Together (watch party)

The **Watch Together** tab lets you watch a movie/series in sync with a friend
(Rave-style): create a room, share the link, and playback + text chat stay
synchronized. It uses a shared **Upstash Redis** (no extra service) —
`api/room.js` (Vercel) and the `/api/room` Express route store one JSON snapshot
per room and clients poll it adaptively.

- Host (room creator) is the leader: their play/pause/seek is authoritative;
  followers sync to it (drift-corrected, ~1–2s). If the host leaves, the
  longest-present follower is auto-promoted.
- Share link: `https://<site>/?room=CODE` (6-char code) — opening it auto-joins.
- Each viewer resolves the Collaps stream from their own IP (so IP-bound CDN
  tokens still work per-viewer); only playback position/state is synced.
- Needs the Upstash env above. If it's not configured, the tab says so and the
  rest of the app is unaffected.

Quota: one Upstash GET per poll + a heartbeat every 15s + chat on send ≈ a few
thousand commands for a 2-person 2h session — within the free tier for personal
use. For many rooms/heavy use, upgrade Upstash (or swap the sync hot-path to a
WebRTC data-channel mesh later — the UI and player integration stay unchanged).

## Notes / limits

- The site-password gate is client-side (a SHA-256 hash in the bundle). It keeps
  out casual visitors but is NOT real security — anyone can read the hash from
  the bundle. For real auth, run the Express server (`server/index.js`) on a VPS.
- Vercel free tier: serverless functions have a size/time cap; the TMDB proxy is
  a thin forwarder, well within limits.
- Upstash free tier ≈ 10 000 commands/day. Sync uses ~3 commands per app start
  and ~2 per changed-state push (content-hash gated, so 0 when idle). That's
  plenty for personal multi-device use; heavy multi-user traffic may need a paid
  Upstash plan.
- Torrent source (TorrServer) is desktop-only on the web build (the Онлайн source
  is the one offered).
- The visitor's TMDB token never leaves their browser except as a Bearer header
  to the `/api/tmdb` and `/api/room` proxies; `/api/tmdb` forwards it to TMDB and
  discards it, `/api/room` only stores `sha256(token)` as the per-peer id.
