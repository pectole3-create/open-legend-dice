// Open Legend Dice — Cloudflare Worker
// Serves the extension's static files, a dynamically-generated manifest, and a
// shared server-side roll log stored in KV.
//
// Endpoints:
//   GET  /manifest.json        -> manifest with absolute URLs from this origin
//   GET  /api/log?room=<id>     -> { entries }   (rolls from the last 24h)
//   POST /api/roll  {room,entry}-> append a roll, returns canonical { entries }
//   POST /api/clear {room,name} -> remove a player's rolls (or all if no name)
//   everything else             -> static asset from the project (./)
//
// Each room's log lives under KV key `log:<room>`. Entries older than 24h are
// pruned on every read/write, and the KV value carries a 2-day TTL as a janitor
// backstop, so rolls are kept for a day and then disappear automatically.

const VERSION = "1.3.1";
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY = 100;
const KV_TTL_SECONDS = 2 * 24 * 60 * 60; // backstop; precise 24h pruning is by timestamp

function manifest(origin) {
  return {
    name: "Open Legend Dice",
    version: VERSION,
    manifest_version: 1,
    author: "VladiSlave",
    description:
      "Open Legend dice roller with exploding dice, advantage/disadvantage, and a shared roll log.",
    icon: `${origin}/icon.svg`,
    action: {
      title: "Open Legend Dice",
      icon: `${origin}/icon.svg`,
      popover: `${origin}/`,
      height: 620,
      width: 340,
    },
  };
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function sanitizeRoom(room) {
  if (typeof room !== "string") return null;
  const r = room.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return r || null;
}

function pruneLog(log) {
  const cutoff = Date.now() - DAY_MS;
  let out = (Array.isArray(log) ? log : []).filter(
    (e) => e && typeof e.time === "number" && e.time >= cutoff
  );
  out.sort((a, b) => a.time - b.time);
  if (out.length > MAX_HISTORY) out = out.slice(-MAX_HISTORY);
  return out;
}

function validEntry(e) {
  return (
    e &&
    typeof e === "object" &&
    typeof e.id === "string" &&
    typeof e.name === "string" &&
    typeof e.total === "number" &&
    typeof e.time === "number" &&
    Array.isArray(e.dice)
  );
}

// Keep only known fields and bound sizes so a client can't bloat the log.
function sanitizeEntry(e) {
  return {
    id: String(e.id).slice(0, 64),
    name: String(e.name).slice(0, 64),
    formula: String(e.formula || "").slice(0, 120),
    advantage: Number(e.advantage) || 0,
    exploding: !!e.exploding,
    total: Number(e.total) || 0,
    time: Number(e.time) || Date.now(),
    dice: e.dice.slice(0, 60).map((d) => ({
      size: Number(d.size) || 0,
      rolls: Array.isArray(d.rolls) ? d.rolls.slice(0, 60).map((n) => Number(n) || 0) : [],
      total: Number(d.total) || 0,
      dropped: !!d.dropped,
      extra: !!d.extra,
    })),
  };
}

async function readLog(env, room) {
  const raw = await env.LOG.get(`log:${room}`);
  let log = [];
  if (raw) {
    try {
      log = JSON.parse(raw);
    } catch {
      log = [];
    }
  }
  return pruneLog(log);
}

async function writeLog(env, room, log) {
  const pruned = pruneLog(log);
  await env.LOG.put(`log:${room}`, JSON.stringify(pruned), { expirationTtl: KV_TTL_SECONDS });
  return pruned;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    if (path === "/manifest.json") {
      return json(manifest(url.origin));
    }

    if (path === "/api/log" && request.method === "GET") {
      const room = sanitizeRoom(url.searchParams.get("room"));
      if (!room) return json({ error: "missing room" }, 400);
      return json({ entries: await readLog(env, room) });
    }

    if (path === "/api/roll" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "bad json" }, 400);
      }
      const room = sanitizeRoom(body.room);
      if (!room) return json({ error: "missing room" }, 400);
      if (!validEntry(body.entry)) return json({ error: "bad entry" }, 400);
      const log = await readLog(env, room);
      if (!log.some((e) => e.id === body.entry.id)) log.push(sanitizeEntry(body.entry));
      return json({ entries: await writeLog(env, room, log) });
    }

    if (path === "/api/clear" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "bad json" }, 400);
      }
      const room = sanitizeRoom(body.room);
      if (!room) return json({ error: "missing room" }, 400);
      const name = typeof body.name === "string" ? body.name : null;
      const log = await readLog(env, room);
      const next = name ? log.filter((e) => e.name !== name) : [];
      return json({ entries: await writeLog(env, room, next) });
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};
