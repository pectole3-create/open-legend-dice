// Open Legend Dice — dice roller extension for Owlbear Rodeo
// Open Legend rules: https://openlegendrpg.com/core-rules/actions-attributes
//  - Every die explodes: rolling the max value rolls that die again and adds (can chain).
//  - Advantage X: roll X extra attribute dice, keep the normal amount (drop the X lowest).
//  - Disadvantage X: same, but drop the X highest.
//  - With no attribute dice (bare d20), adv/dis adds at most ONE extra d20 — you never
//    roll more than 2d20, no matter how many advantages/disadvantages stack.
//
// Randomness: crypto.getRandomValues with rejection sampling (see randomInt), not
// Math.random. Same fairness in practice, but it is a real CSPRNG seeded by the OS, so
// nobody at the table can argue the luck is an artifact of a weak generator.
//
// Sync (v1.5.0 — rewritten; see README "How sharing works"):
//  1. The SDK is imported STATICALLY, at the top of this module. It must be, because the
//     SDK's only way of connecting is a passive window "message" listener installed when
//     it evaluates — Owlbear posts OBR_READY exactly once, on iframe load. v1.4.0 loaded
//     the SDK with a lazy dynamic import(), so on any client where that extra 56KB fetch
//     finished after OBR_READY had already been posted, the message was missed and the
//     panel sat on "connecting…" forever. A static import evaluates before the load
//     event, which closes the race; index.html also buffers early messages and replays
//     them below as a second line of defence.
//  2. Each player writes ONLY their own room-metadata key (…/log/<playerId>) and the view
//     is the merge of everyone's keys. v1.4.0 had every client read-modify-write ONE
//     shared array, so two players rolling at the same moment meant one roll was silently
//     overwritten.
//  3. Broadcast delivers rolls instantly; metadata makes them survive reloads and late
//     joins; a 20s reconcile re-reads metadata in case an event was missed.

import OBR from "./owlbear-sdk.js";

// Replay any window messages that landed before the SDK's listener existed. The buffer is
// installed by an inline script in the <head> of index.html, so it is listening from the
// first moment the document can receive anything at all.
(function replayEarlyMessages() {
  const buffered = window.__obrEarlyMessages;
  const handler = window.__obrEarlyHandler;
  if (!buffered || !handler) return;
  window.removeEventListener("message", handler);
  delete window.__obrEarlyMessages;
  delete window.__obrEarlyHandler;
  for (const e of buffered) {
    try {
      window.dispatchEvent(new MessageEvent("message", { data: e.data, origin: e.origin }));
    } catch (err) {
      console.warn("message replay failed:", err);
    }
  }
})();

const VERSION = "1.5.1";
const NS = "com.vladi.open-legend-dice";
const LOG_PREFIX = `${NS}/log/`; // + playerId — each player owns exactly one key
const CHANNEL = `${NS}/roll`;
const AUDIT_KEY = "open-legend-dice-audit";
const AUDIT_TTL_MS = 24 * 60 * 60 * 1000;
const DIE_SIZES = [4, 6, 8, 10, 12, 20];
const MAX_DICE_PER_TYPE = 20;
const MAX_EXPLOSIONS = 50;
const MAX_HISTORY = 50; // rolls shown in the merged log
const MY_MAX = 15; // rolls kept in my own metadata slot
const MY_MAX_BYTES = 2200; // room metadata is ~16KB TOTAL and shared with other extensions
const RECONCILE_MS = 20000;
const READY_TIMEOUT_MS = 12000;

// Attribute score -> attribute dice (always paired with 1d20), per Open Legend.
const ATTRIBUTE_DICE = {
  0: null,
  1: { size: 4, count: 1 },
  2: { size: 6, count: 1 },
  3: { size: 8, count: 1 },
  4: { size: 10, count: 1 },
  5: { size: 6, count: 2 },
  6: { size: 8, count: 2 },
  7: { size: 10, count: 2 },
  8: { size: 8, count: 3 },
  9: { size: 10, count: 3 },
  10: { size: 8, count: 4 },
};

const pool = new Map(); // die size -> count
let advantage = 0; // positive = advantage, negative = disadvantage
let playerName = "You";
let obrReady = false;
let myKey = null;
let myLog = []; // my own slot; only this client ever writes it
const entries = new Map(); // id -> entry, the merged view of everyone's slots

const $ = (id) => document.getElementById(id);
const attrGrid = $("attrGrid");
const diceRow = $("diceRow");
const poolEl = $("pool");
const advLabel = $("advLabel");
const explodeToggle = $("explodeToggle");
const rollBtn = $("rollBtn");
const historyEl = $("history");
const statusEl = $("status");

// A player can hold a cached copy of an older index.html while the browser fetches this
// file fresh, so never assume newer markup exists — build what is missing instead of
// throwing and taking the whole panel down with it.
const retryBtn = $("retryBtn") || createRetryBtn();

function createRetryBtn() {
  const btn = document.createElement("button");
  btn.id = "retryBtn";
  btn.textContent = "Reconnect";
  btn.hidden = true;
  // Injected as a rule, not inline style: an inline `display:block` would beat the
  // [hidden] attribute and leave the button permanently on screen.
  const css = document.createElement("style");
  css.textContent =
    "#retryBtn{display:block;margin:4px auto 0;background:#343a52;border:1px solid #444a66;" +
    "border-radius:5px;color:#e9e9f2;font-size:11px;padding:3px 10px;cursor:pointer}" +
    "#retryBtn[hidden]{display:none}";
  document.head.appendChild(css);
  (statusEl.parentNode || document.body).appendChild(btn);
  return btn;
}

function setStatus(text, isError = false, showRetry = false) {
  statusEl.textContent = `v${VERSION} · ${text}`;
  statusEl.classList.toggle("error", isError);
  retryBtn.hidden = !showRetry;
}

// ---------- randomness ----------

// Uniform integer in [0, max) from the OS CSPRNG. The rejection loop discards values in
// the final partial block of 2^32 so no residue class is favoured — a plain `% max`
// would very slightly over-weight the low faces.
const cryptoOk = typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function";
const randBuf = cryptoOk ? new Uint32Array(1) : null;

function randomInt(max) {
  if (!cryptoOk) return Math.floor(Math.random() * max); // ancient-browser fallback
  const limit = Math.floor(0x100000000 / max) * max;
  let x;
  do {
    crypto.getRandomValues(randBuf);
    x = randBuf[0];
  } while (x >= limit);
  return x % max;
}

function rollDie(size) {
  return randomInt(size) + 1;
}

// ---------- Owlbear Rodeo SDK ----------

function initOBR() {
  setStatus("connecting…");

  if (!OBR.isAvailable) {
    // No ?obrref= in the URL: we are not inside an Owlbear iframe at all.
    setStatus("open inside an Owlbear Rodeo room to share rolls (local-only here)");
    renderMerged();
    return;
  }

  // Watchdog: never leave the user staring at "connecting…" with no explanation.
  setTimeout(() => {
    if (!obrReady) {
      setStatus("Owlbear never finished the handshake — rolls are local-only", true, true);
    }
  }, READY_TIMEOUT_MS);

  OBR.onReady(async () => {
    try {
      obrReady = true;
      const [name, id] = await Promise.all([OBR.player.getName(), OBR.player.getId()]);
      playerName = name || "Player";
      myKey = LOG_PREFIX + id;

      const md = await OBR.room.getMetadata();
      absorbMetadata(md);
      myLog = (Array.isArray(md[myKey]) ? md[myKey] : []).map(unpackEntry).filter(Boolean);
      renderMerged();

      OBR.room.onMetadataChange((m) => {
        absorbMetadata(m);
        renderMerged();
      });

      OBR.broadcast.onMessage(CHANNEL, (event) => {
        const entry = unpackEntry(event.data);
        if (!entry) return;
        entries.set(entry.id, entry);
        appendAudit(entry);
        renderMerged();
      });

      // Belt-and-braces: a missed metadata event self-heals within 20 seconds.
      setInterval(reconcile, RECONCILE_MS);
      pruneStaleSlots(md).catch(() => {});

      setStatus(`connected as ${playerName} — shared log live`);
    } catch (err) {
      console.error(err);
      setStatus(`Owlbear error: ${err.message || err}`, true, true);
    }
  });
}

async function reconcile() {
  if (!obrReady) return;
  try {
    absorbMetadata(await OBR.room.getMetadata());
    renderMerged();
  } catch (err) {
    console.warn("reconcile failed:", err);
  }
}

// Pull every player's slot out of room metadata into the merged view.
function absorbMetadata(metadata) {
  for (const [key, value] of Object.entries(metadata || {})) {
    if (!key.startsWith(LOG_PREFIX) || !Array.isArray(value)) continue;
    for (const raw of value) {
      const entry = unpackEntry(raw);
      if (entry) entries.set(entry.id, entry);
    }
  }
}

// Drop slots belonging to players whose rolls are all older than a day, so the room's
// shared ~16KB metadata budget does not fill with people who left weeks ago.
async function pruneStaleSlots(metadata) {
  const cutoff = Date.now() - AUDIT_TTL_MS;
  const dead = {};
  for (const [key, value] of Object.entries(metadata || {})) {
    if (!key.startsWith(LOG_PREFIX) || key === myKey || !Array.isArray(value)) continue;
    const times = value.map((r) => (r && (r.m || r.time)) || 0);
    if (times.length && Math.max(...times) < cutoff) dead[key] = undefined;
  }
  if (Object.keys(dead).length) await OBR.room.setMetadata(dead);
}

// Write my own slot. No other client writes this key, so there is no lost-update race.
async function publishMyLog() {
  myLog = myLog.slice(-MY_MAX);
  let packed = myLog.map(packEntry);
  while (packed.length > 1 && JSON.stringify(packed).length > MY_MAX_BYTES) {
    myLog = myLog.slice(1);
    packed = myLog.map(packEntry);
  }
  await OBR.room.setMetadata({ [myKey]: packed });
}

function notify(entry) {
  if (!obrReady) return;
  OBR.notification.show(`${entry.name} rolled ${entry.formula}: ${entry.total}`, "INFO").catch(() => {});
}

// ---------- entry packing (room metadata is a tight budget) ----------

function packEntry(e) {
  return {
    i: e.id,
    n: e.name,
    f: e.formula,
    a: e.advantage,
    x: e.exploding ? 1 : 0,
    t: e.total,
    m: e.time,
    d: e.dice.map((d) => {
      const o = { s: d.size, r: d.rolls };
      if (d.dropped) o.p = 1;
      if (d.extra) o.e = 1;
      return o;
    }),
  };
}

function unpackEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.id && Array.isArray(raw.dice)) return raw; // v1.4.0 format, still readable
  if (!raw.i || !Array.isArray(raw.d)) return null;
  return {
    id: raw.i,
    name: raw.n,
    formula: raw.f,
    advantage: raw.a || 0,
    exploding: !!raw.x,
    total: raw.t,
    time: raw.m,
    dice: raw.d.map((d) => ({
      size: d.s,
      rolls: d.r,
      total: d.r.reduce((a, b) => a + b, 0),
      dropped: !!d.p,
      extra: !!d.e,
    })),
  };
}

// ---------- 24h audit log (localStorage, per-client backup) ----------

function loadAudit() {
  try {
    const raw = localStorage.getItem(AUDIT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    const cutoff = Date.now() - AUDIT_TTL_MS;
    return Array.isArray(list) ? list.filter((e) => e.time >= cutoff) : [];
  } catch {
    return [];
  }
}

function appendAudit(entry) {
  try {
    const audit = loadAudit();
    if (audit.some((e) => e.id === entry.id)) return;
    audit.push(entry);
    audit.sort((a, b) => a.time - b.time);
    localStorage.setItem(AUDIT_KEY, JSON.stringify(audit));
  } catch (err) {
    console.warn("audit write failed:", err);
  }
}

function describeEntry(entry) {
  const adv =
    entry.advantage > 0 ? ` (Advantage ${entry.advantage})`
    : entry.advantage < 0 ? ` (Disadvantage ${-entry.advantage})` : "";
  const explode = entry.exploding ? "" : " (no explosions)";
  const dice = entry.dice
    .map((d) => `d${d.size}:${d.rolls.join("+")}${d.dropped ? " dropped" : ""}${d.extra ? " extra" : ""}`)
    .join(", ");
  return `${entry.name} rolled ${entry.formula}${adv}${explode}: ${dice} => ${entry.total}`;
}

function exportLog() {
  const audit = loadAudit();
  const lines = audit.map((e) => `${new Date(e.time).toLocaleString()}  ${describeEntry(e)}`);
  const text =
    `Open Legend Dice — roll log (last 24h, exported ${new Date().toLocaleString()})\n\n` +
    (lines.length ? lines.join("\n") : "No rolls recorded in the last 24 hours.") +
    "\n\n--- raw data ---\n" +
    JSON.stringify(audit, null, 2) +
    "\n";
  const blob = new Blob([text], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `open-legend-dice-log-${new Date().toISOString().slice(0, 10)}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- dice logic ----------

function rollExploding(size, exploding) {
  const rolls = [rollDie(size)];
  while (exploding && rolls[rolls.length - 1] === size && rolls.length < MAX_EXPLOSIONS) {
    rolls.push(rollDie(size));
  }
  return { size, rolls, total: rolls.reduce((a, b) => a + b, 0), dropped: false, extra: false };
}

function sortedPoolSizes() {
  return [...pool.keys()].sort((a, b) => b - a);
}

function formulaString() {
  return sortedPoolSizes()
    .map((size) => {
      const n = pool.get(size);
      return (n > 1 ? n : "") + "d" + size;
    })
    .join(" + ");
}

async function doRoll() {
  if (pool.size === 0) return;
  const exploding = explodeToggle.checked;
  const dice = [];
  for (const size of sortedPoolSizes()) {
    for (let i = 0; i < pool.get(size); i++) dice.push(rollExploding(size, exploding));
  }

  if (advantage !== 0) {
    // Extra dice match the attribute die: the largest non-d20 die in the pool.
    // With a bare d20 pool, adv/dis applies to the d20 — and you never roll more than
    // ONE extra d20, no matter how many advantages/disadvantages stack.
    const sizes = [...new Set(dice.map((d) => d.size))];
    const nonD20 = sizes.filter((s) => s !== 20);
    const target = nonD20.length ? Math.max(...nonD20) : Math.max(...sizes);
    let n = Math.abs(advantage);
    if (target === 20) n = Math.min(n, 1);
    for (let i = 0; i < n; i++) {
      const extraDie = rollExploding(target, exploding);
      extraDie.extra = true;
      dice.push(extraDie);
    }
    const group = dice.filter((d) => d.size === target).sort((a, b) => a.total - b.total);
    const toDrop = advantage > 0 ? group.slice(0, n) : group.slice(-n);
    for (const d of toDrop) d.dropped = true;
  }

  const total = dice.filter((d) => !d.dropped).reduce((a, d) => a + d.total, 0);
  const entry = {
    id: `${Date.now()}-${randomInt(0xffffff).toString(36)}`,
    name: playerName,
    formula: formulaString(),
    advantage,
    exploding,
    dice: dice.map(({ size, rolls, total, dropped, extra }) => ({ size, rolls, total, dropped, extra })),
    total,
    time: Date.now(),
  };

  // Show it locally first — the log never waits on the network.
  entries.set(entry.id, entry);
  appendAudit(entry);
  renderMerged();

  if (!obrReady) return;
  notify(entry);
  OBR.broadcast.sendMessage(CHANNEL, packEntry(entry), { destination: "REMOTE" }).catch((err) => {
    console.warn("broadcast failed:", err);
  });
  myLog.push(entry);
  try {
    await publishMyLog();
  } catch (err) {
    setStatus(`roll not saved to shared log (${err.message || err})`, true, true);
  }
}

// ---------- UI ----------

function setPoolFromAttribute(score) {
  pool.clear();
  pool.set(20, 1);
  const attr = ATTRIBUTE_DICE[score];
  if (attr) pool.set(attr.size, attr.count);
  renderPool();
}

function addDie(size, delta) {
  const next = (pool.get(size) || 0) + delta;
  if (next <= 0) pool.delete(size);
  else pool.set(size, Math.min(next, MAX_DICE_PER_TYPE));
  renderPool();
}

function renderPool() {
  poolEl.innerHTML = "";
  if (pool.size === 0) {
    poolEl.innerHTML = '<span class="empty">No dice selected</span>';
  } else {
    for (const size of sortedPoolSizes()) {
      const chip = document.createElement("button");
      chip.className = "chip";
      chip.innerHTML = `${pool.get(size)}d${size}<span>&times;</span>`;
      chip.title = `Remove one d${size}`;
      chip.addEventListener("click", () => addDie(size, -1));
      poolEl.appendChild(chip);
    }
  }
  renderRollBtn();
}

// Advantage/disadvantage is sticky — it stays set until you change it. That is useful for
// a run of rolls and a trap for everything after, so the state is spelled out on the
// button you are about to press, not just in the small label above it.
function renderRollBtn() {
  rollBtn.disabled = pool.size === 0;
  rollBtn.classList.remove("adv", "dis");
  if (pool.size === 0) {
    rollBtn.textContent = "Roll";
    return;
  }
  let suffix = "";
  if (advantage > 0) {
    suffix = ` · Advantage ${advantage}`;
    rollBtn.classList.add("adv");
  } else if (advantage < 0) {
    suffix = ` · Disadvantage ${-advantage}`;
    rollBtn.classList.add("dis");
  }
  rollBtn.textContent = `Roll ${formulaString()}${suffix}`;
}

function renderAdvLabel() {
  advLabel.classList.remove("adv", "dis");
  if (advantage > 0) {
    advLabel.textContent = `Advantage ${advantage}`;
    advLabel.classList.add("adv");
  } else if (advantage < 0) {
    advLabel.textContent = `Disadvantage ${-advantage}`;
    advLabel.classList.add("dis");
  } else {
    advLabel.textContent = "Normal";
  }
  renderRollBtn();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function buildEntryElement(entry) {
  const div = document.createElement("div");
  div.className = "entry";

  let advTag = "";
  if (entry.advantage > 0) advTag = ` <span class="adv">(Advantage ${entry.advantage})</span>`;
  else if (entry.advantage < 0) advTag = ` <span class="dis">(Disadvantage ${-entry.advantage})</span>`;
  const explodeTag = entry.exploding ? "" : " (no explosions)";

  const diceHtml = entry.dice
    .map((d) => {
      const classes = ["die"];
      if (d.rolls.length > 1) classes.push("exploded");
      if (d.dropped) classes.push("dropped");
      const rollsText =
        d.rolls.length > 1 ? `${d.rolls.join("+")} = <span class="sum">${d.total}</span>` : `${d.total}`;
      const extraMark = d.extra ? '<span class="extra-mark">adv</span>' : "";
      return `<span class="${classes.join(" ")}"><span class="dtype">d${d.size}</span>${rollsText}${extraMark}</span>`;
    })
    .join("");

  const time = new Date(entry.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  div.innerHTML = `
    <div class="entry-head">
      <span class="entry-name">${escapeHtml(entry.name)} <span style="color:var(--text-dim);font-weight:400;font-size:11px">${time}</span></span>
      <span class="entry-total">${entry.total}</span>
    </div>
    <div class="entry-formula">${escapeHtml(entry.formula)}${advTag}${explodeTag}</div>
    <div class="die-results">${diceHtml}</div>`;
  return div;
}

// Newest first, capped at MAX_HISTORY. Dedupe by id happens in the Map, so a roll that
// arrives by broadcast and again by metadata is only ever shown once.
function renderMerged() {
  // Tie-break on id so two rolls in the same millisecond land in the same order on every
  // client — otherwise the log looks subtly different from seat to seat.
  const list = [...entries.values()].sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const shown = list.slice(-MAX_HISTORY);
  for (const e of list.slice(0, -MAX_HISTORY)) entries.delete(e.id);

  historyEl.innerHTML = "";
  for (let i = shown.length - 1; i >= 0; i--) {
    appendAudit(shown[i]); // mirror observed rolls into the local 24h backup
    historyEl.appendChild(buildEntryElement(shown[i]));
  }
}

function buildControls() {
  for (let score = 0; score <= 10; score++) {
    const btn = document.createElement("button");
    btn.textContent = score;
    btn.title =
      score === 0
        ? "Attribute 0: 1d20 only"
        : `Attribute ${score}: 1d20 + ${ATTRIBUTE_DICE[score].count}d${ATTRIBUTE_DICE[score].size}`;
    btn.addEventListener("click", () => setPoolFromAttribute(score));
    attrGrid.appendChild(btn);
  }
  for (const size of DIE_SIZES) {
    const btn = document.createElement("button");
    btn.textContent = "d" + size;
    btn.addEventListener("click", () => addDie(size, 1));
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      addDie(size, -1);
    });
    diceRow.appendChild(btn);
  }
  $("advPlus").addEventListener("click", () => {
    advantage = Math.min(advantage + 1, 9);
    renderAdvLabel();
  });
  $("advMinus").addEventListener("click", () => {
    advantage = Math.max(advantage - 1, -9);
    renderAdvLabel();
  });
  advLabel.addEventListener("click", () => {
    advantage = 0; // click the label to snap back to Normal
    renderAdvLabel();
  });
  $("clearBtn").addEventListener("click", () => {
    pool.clear();
    renderPool();
  });
  $("exportBtn").addEventListener("click", exportLog);
  retryBtn.addEventListener("click", () => location.reload());
  rollBtn.addEventListener("click", doRoll);
}

buildControls();
renderPool();
renderAdvLabel();
initOBR();
