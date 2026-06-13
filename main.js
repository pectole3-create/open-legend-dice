// Open Legend Dice — dice roller extension for Owlbear Rodeo
// Open Legend rules: https://openlegendrpg.com/core-rules/actions-attributes
//  - Every die explodes: rolling the max value rolls that die again and adds (can chain).
//  - Advantage X: roll X extra attribute dice, keep the normal amount (drop the X lowest).
//  - Disadvantage X: same, but drop the X highest.
//  - With no attribute dice (bare d20), adv/dis adds at most ONE extra d20 — you never
//    roll more than 2d20, no matter how many advantages/disadvantages stack.
//
// Shared log: stored in Owlbear ROOM METADATA, which Owlbear persists and syncs to every
// player — so everyone sees the same log, including people who join late or reload the
// page. The log keeps the last 50 rolls. (Ephemeral broadcasts, used in early versions,
// were the reason logs used to vanish on reload; metadata fixes that.)

const VERSION = "1.4.0";
const LOG_KEY = "com.vladi.open-legend-dice/log";
const AUDIT_KEY = "open-legend-dice-audit";
const AUDIT_TTL_MS = 24 * 60 * 60 * 1000;
const DIE_SIZES = [4, 6, 8, 10, 12, 20];
const MAX_DICE_PER_TYPE = 20;
const MAX_EXPLOSIONS = 50;
const MAX_HISTORY = 50;
const MAX_META_BYTES = 14000; // room metadata is capped ~16KB; stay safely under

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
let OBR = null;
let obrReady = false;
let localLog = []; // fallback when opened outside Owlbear (standalone testing)

const $ = (id) => document.getElementById(id);
const attrGrid = $("attrGrid");
const diceRow = $("diceRow");
const poolEl = $("pool");
const advLabel = $("advLabel");
const explodeToggle = $("explodeToggle");
const rollBtn = $("rollBtn");
const historyEl = $("history");
const statusEl = $("status");

function setStatus(text, isError = false) {
  statusEl.textContent = `v${VERSION} · ${text}`;
  statusEl.classList.toggle("error", isError);
}

// ---------- Owlbear Rodeo SDK ----------

async function initOBR() {
  setStatus("connecting…");
  try {
    // SDK is bundled and served from the same origin (owlbear-sdk.js) so it loads for
    // everyone — no third-party CDN that an ad-blocker/proxy might block. Timeout guards
    // against a stuck load.
    const mod = await Promise.race([
      import("./owlbear-sdk.js"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("SDK load timed out")), 8000)),
    ]);
    const sdk = mod.default;
    OBR = sdk;
    if (!sdk.isAvailable) {
      setStatus("open inside an Owlbear Rodeo room to share rolls (local-only here)");
      renderLog(localLog);
      return;
    }
    OBR.onReady(async () => {
      try {
        obrReady = true;
        playerName = (await OBR.player.getName()) || "Player";
        const md = await OBR.room.getMetadata();
        renderLog(getLog(md));
        OBR.room.onMetadataChange((m) => renderLog(getLog(m)));
        setStatus(`connected as ${playerName} — shared log live`);
      } catch (err) {
        setStatus(`Owlbear error: ${err.message || err}`, true);
      }
    });
  } catch (err) {
    console.warn("Owlbear SDK unavailable:", err);
    setStatus("standalone (SDK failed to load) — local-only", true);
    renderLog(localLog);
  }
}

function getLog(metadata) {
  const log = metadata[LOG_KEY];
  return Array.isArray(log) ? log : [];
}

// Append a roll to the shared metadata log, keeping the last 50 and staying under
// the metadata size cap. The resulting onMetadataChange re-renders for everyone.
async function appendToSharedLog(entry) {
  const md = await OBR.room.getMetadata();
  let log = getLog(md);
  log.push(entry);
  if (log.length > MAX_HISTORY) log = log.slice(-MAX_HISTORY);
  while (log.length > 1 && JSON.stringify({ [LOG_KEY]: log }).length > MAX_META_BYTES) log.shift();
  await OBR.room.setMetadata({ [LOG_KEY]: log });
}

function notify(entry) {
  if (!obrReady) return;
  OBR.notification.show(`${entry.name} rolled ${entry.formula}: ${entry.total}`, "INFO").catch(() => {});
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
    if (!audit.some((e) => e.id === entry.id)) audit.push(entry);
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
    `Open Legend Dice — your roll log (last 24h, exported ${new Date().toLocaleString()})\n\n` +
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

function rollDie(size) {
  return Math.floor(Math.random() * size) + 1;
}

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
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: playerName,
    formula: formulaString(),
    advantage,
    exploding,
    dice: dice.map(({ size, rolls, total, dropped, extra }) => ({ size, rolls, total, dropped, extra })),
    total,
    time: Date.now(),
  };

  appendAudit(entry);
  if (obrReady) {
    notify(entry);
    try {
      await appendToSharedLog(entry); // metadata change re-renders for everyone, incl. us
    } catch (err) {
      setStatus(`roll not saved to shared log (${err.message})`, true);
    }
  } else {
    localLog.push(entry);
    if (localLog.length > MAX_HISTORY) localLog = localLog.slice(-MAX_HISTORY);
    renderLog(localLog);
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
  rollBtn.disabled = pool.size === 0;
  rollBtn.textContent = pool.size === 0 ? "Roll" : `Roll ${formulaString()}`;
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

function renderLog(log) {
  historyEl.innerHTML = "";
  for (let i = log.length - 1; i >= 0; i--) {
    appendAudit(log[i]); // mirror observed rolls into the local 24h backup
    historyEl.appendChild(buildEntryElement(log[i]));
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
  $("clearBtn").addEventListener("click", () => {
    pool.clear();
    renderPool();
  });
  $("exportBtn").addEventListener("click", exportLog);
  rollBtn.addEventListener("click", doRoll);
}

buildControls();
renderPool();
renderAdvLabel();
initOBR();
