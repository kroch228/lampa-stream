// Vercel serverless fn: Watch Together (watch-party rooms), Rave-style.
// Stores rooms in Upstash Redis; the Express server (server/index.js /api/room)
// mirrors this so home + public share rooms. One JSON snapshot per room = 1 GET
// per poll (quota-friendly); presence via heartbeats; chat appended on send.
//
// Auth = the visitor's TMDB token (Authorization: Bearer, same model as
// /api/tmdb). peerId = sha256(bearer) — the token is both secret and identity
// and is never stored. Room `code` is the shareable secret (6-char).
// Host-only writes (play/media/delete) verify peerId === room.hostId, with
// auto-promotion of the longest-present follower when the host's heartbeat is
// stale (>30s) so playback can continue after the host leaves.
//
// Env:
//   UPSTASH_REDIS_REST_URL    (or KV_REST_API_URL, the Vercel-marketplace name)
//   UPSTASH_REDIS_REST_TOKEN  (or KV_REST_API_TOKEN)
//
// Contract:
//   POST   /api/room                 {name, media?}            → {code, room}
//   GET    /api/room?code=CODE                                 → {room} | {room:null}
//   PUT    /api/room?code=CODE&op=play   {playing, position}    (host) → {ok}
//   PUT    /api/room?code=CODE&op=media  {media}                (host) → {ok}
//   POST   /api/room?code=CODE&op=chat      {text}                       → {ok}
//   POST   /api/room?code=CODE&op=heartbeat {name}                       → {ok}
//   POST   /api/room?code=CODE&op=signal    { target, msg }              → {ok}   (voice signaling; msg opaque SDP/ICE)
//   GET    /api/room?code=CODE&op=signal-poll                            → { signals: [{ from, msg }] }
//   DELETE /api/room?code=CODE                                        (host) → {ok}

import crypto from "node:crypto";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};
const ROOM_TTL = 86400; // 24h
const PRESENCE_TTL_MS = 30000; // a peer is "online" if heartbeat < 30s ago
const CHAT_MAX = 50;

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

// Base36 room code (uppercase + digits). The UI uppercases codes for
// display/entry, so codes MUST be uppercase-only to match on lookup — a
// mixed-case code would be uppercased and miss the stored key. Site-password is
// layer 1; 36^6 ≈ 2.2B is plenty for casual room codes.
function genCode(len = 6) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) s += A[bytes[i] % A.length];
  return s;
}

async function upstash(cmd) {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("Upstash not configured");
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error(`Upstash ${r.status}`);
  const json = await r.json();
  return json.result;
}

function pruneWho(who, now) {
  const out = {};
  for (const [pid, v] of Object.entries(who || {})) {
    if (v && typeof v.lastSeen === "number" && now - v.lastSeen < PRESENCE_TTL_MS)
      out[pid] = v;
  }
  return out;
}

export default async function handler(req, res) {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  if (req.method === "OPTIONS") return res.status(204).end();

  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer) return res.status(401).json({ error: "missing token" });
  const peerId = sha256Hex(bearer);
  const code = (req.query && req.query.code) || "";
  const op = (req.query && req.query.op) || "";
  const now = Date.now();

  // GET/PUT/DELETE require ?code=; 400 (not 405) when it's missing.
  if (req.method !== "POST" && !code)
    return res.status(400).json({ error: "missing code" });

  try {
    // ── POST: create room, or room action (chat/heartbeat) ──────────────────
    if (req.method === "POST" && !code) {
      const { name, media } = req.body || {};
      const roomCode = genCode();
      const room = {
        code: roomCode,
        hostId: peerId,
        hostName: name || "Host",
        media: media || null,
        play: { playing: false, position: 0, updatedAt: now, seq: 0 },
        chat: [],
        who: { [peerId]: { name: name || "Host", lastSeen: now } },
        createdAt: now,
        expireAt: now + ROOM_TTL * 1000,
      };
      await upstash(["SET", `room:${roomCode}`, JSON.stringify(room), "EX", ROOM_TTL]);
      return res.status(200).json({ code: roomCode, room });
    }

    if (req.method === "POST" && code) {
      const raw = await upstash(["GET", `room:${code}`]);
      if (!raw) return res.status(404).json({ error: "room not found" });
      const room = JSON.parse(raw);
      if (op === "heartbeat" || op === "join") {
        const name = (req.body && req.body.name) || "Viewer";
        room.who = pruneWho(room.who, now);
        room.who[peerId] = { name, lastSeen: now };
        await upstash(["SET", `room:${code}`, JSON.stringify(room), "EX", ROOM_TTL]);
        return res.status(200).json({ ok: true });
      }
      if (op === "chat") {
        const text = ((req.body && req.body.text) || "").toString().slice(0, 500);
        if (!text.trim()) return res.status(400).json({ error: "empty" });
        const name = (room.who?.[peerId]?.name) || "Viewer";
        room.chat = [...(room.chat || []), { id: peerId.slice(0, 8) + now.toString(36), name, text, ts: now }].slice(-CHAT_MAX);
        await upstash(["SET", `room:${code}`, JSON.stringify(room), "EX", ROOM_TTL]);
        return res.status(200).json({ ok: true });
      }
      if (op === "signal") {
        // Voice-chat signaling. `msg` is an OPAQUE WebRTC payload (SDP offer/
        // answer or ICE candidate) — the server never inspects it, only routes
        // by `target` (the recipient peerId). Mailbox = per-target Redis LIST
        // sig:{code}:{target}, TTL 60s, drained by signal-poll. Pipelining
        // RPUSH + EXPIRE = one Upstash round trip. RPUSH appends to the tail
        // so LRANGE 0 -1 returns oldest-first (FIFO): the recipient processes
        // the SDP offer BEFORE its associated ICE candidates, which is required
        // for addIceCandidate() to succeed (it throws InvalidStateError before
        // setRemoteDescription).
        const target = String((req.body && req.body.target) || "");
        const msg = req.body && req.body.msg;
        if (!target) return res.status(400).json({ error: "missing target" });
        await upstash([
          ["RPUSH", `sig:${code}:${target}`, JSON.stringify({ from: peerId, msg })],
          ["EXPIRE", `sig:${code}:${target}`, 60],
        ]);
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ error: "bad op" });
    }

    // ── GET: snapshot (the poll), or voice signal-poll ────────────────────────
    if (req.method === "GET" && code) {
      if (op === "signal-poll") {
        // Drain THIS peer's signal mailbox atomically: RENAME the mailbox to
        // a unique drain key, LRANGE the drain key, DEL it. After the RENAME
        // the original key is GONE — any concurrent sender's RPUSH creates it
        // again from scratch and lands safely in the NEXT poll, so no signal
        // can be lost in the drain window. The older LRANGE+DEL approach was
        // not atomic (Redis pipelines aren't MULTI/EXEC): an interleaved RPUSH
        // between LRANGE and DEL got DEL'd without ever being delivered.
        const mailbox = `sig:${code}:${peerId}`;
        const drain = `sig:${code}:${peerId}:drain:${Math.random().toString(36).slice(2, 10)}`;
        let items = [];
        try {
          const res = await upstash([
            ["RENAME", mailbox, drain],
            ["LRANGE", drain, 0, -1],
            ["DEL", drain],
          ]);
          // Pipeline: result[1] is the LRANGE array (result[0] is the RENAME
          // "OK", result[2] is the DEL count). Fall back to [] for empty.
          if (Array.isArray(res) && Array.isArray(res[1])) items = res[1];
        } catch {
          // RENAME throws if the source key doesn't exist — treat as empty
          // poll. The outer handler's try/catch covers real Upstash outages.
        }
        const signals = [];
        for (const s of items) {
          try { signals.push(JSON.parse(s)); } catch {} // skip malformed
        }
        return res.status(200).json({ signals });
      }
      const raw = await upstash(["GET", `room:${code}`]);
      if (!raw) return res.status(200).json({ room: null });
      const room = JSON.parse(raw);
      room.who = pruneWho(room.who, now);
      return res.status(200).json({ room });
    }

    // ── PUT: host play/media (with auto-promotion if host stale) ─────────────
    if (req.method === "PUT" && code) {
      const raw = await upstash(["GET", `room:${code}`]);
      if (!raw) return res.status(404).json({ error: "room not found" });
      const room = JSON.parse(raw);
      room.who = pruneWho(room.who, now);
      const hostOnline = room.hostId === peerId ||
        (room.who[room.hostId] && now - room.who[room.hostId].lastSeen < PRESENCE_TTL_MS);
      if (room.hostId !== peerId) {
        if (hostOnline) return res.status(403).json({ error: "not host" });
        // Host gone → promote the longest-present follower present in who.
        const followers = Object.entries(room.who)
          .filter(([pid]) => pid !== room.hostId)
          .sort((a, b) => (a[1].lastSeen || 0) - (b[1].lastSeen || 0));
        const promote = followers[followers.length - 1];
        if (!promote || promote[0] !== peerId)
          return res.status(403).json({ error: "not host" });
        room.hostId = peerId;
        room.hostName = promote[1].name || "Host";
      }
      // Refresh the host's own presence on every host PUT so pruneRoomWho
      // doesn't drop them while they're actively controlling playback (which
      // would let a follower self-promote and hijack the room).
      if (room.hostId === peerId) {
        room.who[peerId] = { name: room.hostName, lastSeen: now };
      }
      if (op === "play") {
        const { playing, position } = req.body || {};
        room.play = {
          playing: !!playing,
          position: Number(position) || 0,
          updatedAt: now,
          seq: (room.play?.seq || 0) + 1,
        };
      } else if (op === "media") {
        room.media = req.body?.media || null;
        room.play = { playing: false, position: 0, updatedAt: now, seq: (room.play?.seq || 0) + 1 };
      } else {
        return res.status(400).json({ error: "bad op" });
      }
      await upstash(["SET", `room:${code}`, JSON.stringify(room), "EX", ROOM_TTL]);
      return res.status(200).json({ ok: true });
    }

    // ── DELETE: host closes the room ─────────────────────────────────────────
    if (req.method === "DELETE" && code) {
      const raw = await upstash(["GET", `room:${code}`]);
      if (!raw) return res.status(200).json({ ok: true });
      const room = JSON.parse(raw);
      if (room.hostId !== peerId) return res.status(403).json({ error: "not host" });
      await upstash(["DEL", `room:${code}`]);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    return res.status(502).json({ error: "room error", message: e.message });
  }
}