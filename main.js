// Open Legend Dice — dice roller extension for Owlbear Rodeo
// Open Legend rules: https://openlegendrpg.com/core-rules/actions-attributes
//  - Every die explodes: rolling the max value rolls that die again and adds (can chain).
//  - Advantage X: roll X extra attribute dice, keep the normal amount (drop the X lowest).
//  - Disadvantage X: same, but drop the X highest.
//  - The d20 itself only gains adv/dis when there are no attribute dice in the pool.
//
// The roll log lives in room metadata, so every player sees the same shared log
// (including rolls made while their panel was closed). Anyone can remove their
// own rolls from it with "Clear my rolls".

const LOG_KEY = "com.vladi.open-legend-dice/log";
const DIE_SIZES = [4, 6, 8, 10, 12, 20];
const MAX_DICE_PER_TYPE = 20;
const MAX_EXPLOSIONS = 50;
const MAX_HISTORY = 50;

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
let localLog = []; // fallback log when running outside Owlbear Rodeo
let lastSeenTime = Date.now(); // for notifying about other players' new rolls

const $ = (id) => document.getElementById(id);
const attrGrid = $("attrGrid");
const diceRow = $("diceRow");
const poolEl = $("pool");
const advLabel = $("advLabel");
const explodeToggle = $("explodeToggle");
const rollBtn = $("rollBtn");
const historyEl = $("history");

// ---------- Owlbear Rodeo SDK ----------

async function initOBR() {
  try {
    const mod = await import("https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk@3/+esm");
    const sdk = mod.default;
    if (!sdk.isAvailable) return; // running outside Owlbear Rodeo: stay local-only
    OBR = sdk;
    OBR.onReady(async () => {
      obrReady = true;
      playerName = (await OBR.player.getName()) || "Player";
      const metadata = await OBR.room.getMetadata();
      renderLog(getLog(metadata));
      OBR.room.onMetadataChange((md) => {
        const log = getLog(md);
        renderLog(log);
        notifyNewRemoteRolls(log);
      });
    });
  } catch (err) {
    console.warn("Owlbear Rodeo SDK unavailable, running standalone:", err);
  }
}

function getLog(metadata) {
  const log = metadata[LOG_KEY];
  return Array.isArray(log) ? log : [];
}

async function appendToLog(entry) {
  if (obrReady) {
    const metadata = await OBR.room.getMetadata();
    const log = getLog(metadata);
    log.push(entry);
    while (log.length > MAX_HISTORY) log.shift();
    await OBR.room.setMetadata({ [LOG_KEY]: log });
  } else {
    localLog.push(entry);
    if (localLog.length > MAX_HISTORY) localLog = localLog.slice(-MAX_HISTORY);
    renderLog(localLog);
  }
}

async function clearMyRolls() {
  if (obrReady) {
    const metadata = await OBR.room.getMetadata();
    const log = getLog(metadata).filter((e) => e.name !== playerName);
    await OBR.room.setMetadata({ [LOG_KEY]: log });
  } else {
    localLog = [];
    renderLog(localLog);
  }
}

function notify(entry) {
  if (!obrReady) return;
  OBR.notification
    .show(`${entry.name} rolled ${entry.formula}: ${entry.total}`, "INFO")
    .catch(() => {});
}

function notifyNewRemoteRolls(log) {
  for (const entry of log) {
    if (entry.time > lastSeenTime && entry.name !== playerName) notify(entry);
    if (entry.time > lastSeenTime) lastSeenTime = entry.time;
  }
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
  const parts = sortedPoolSizes().map((size) => {
    const n = pool.get(size);
    return (n > 1 ? n : "") + "d" + size;
  });
  return parts.join(" + ");
}

async function doRoll() {
  if (pool.size === 0) return;
  const exploding = explodeToggle.checked;
  const dice = [];
  for (const size of sortedPoolSizes()) {
    for (let i = 0; i < pool.get(size); i++) {
      dice.push(rollExploding(size, exploding));
    }
  }

  if (advantage !== 0) {
    // Extra dice match the attribute die: the largest non-d20 die in the pool.
    // With a bare d20 pool, adv/dis applies to the d20 instead.
    const sizes = [...new Set(dice.map((d) => d.size))];
    const nonD20 = sizes.filter((s) => s !== 20);
    const target = nonD20.length ? Math.max(...nonD20) : Math.max(...sizes);
    const n = Math.abs(advantage);
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
    name: playerName,
    formula: formulaString(),
    advantage,
    exploding,
    dice: dice.map(({ size, rolls, total, dropped, extra }) => ({ size, rolls, total, dropped, extra })),
    total,
    time: Date.now(),
  };

  lastSeenTime = entry.time;
  notify(entry);
  await appendToLog(entry); // metadata change re-renders the log for everyone, including us
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
      const rollsText = d.rolls.length > 1
        ? `${d.rolls.join("+")} = <span class="sum">${d.total}</span>`
        : `${d.total}`;
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
    historyEl.appendChild(buildEntryElement(log[i]));
  }
}

function buildControls() {
  for (let score = 0; score <= 10; score++) {
    const btn = document.createElement("button");
    btn.textContent = score;
    btn.title = score === 0
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
  $("advPlus").addEventListener("click", () => { advantage = Math.min(advantage + 1, 9); renderAdvLabel(); });
  $("advMinus").addEventListener("click", () => { advantage = Math.max(advantage - 1, -9); renderAdvLabel(); });
  $("clearBtn").addEventListener("click", () => { pool.clear(); renderPool(); });
  $("clearLogBtn").addEventListener("click", clearMyRolls);
  rollBtn.addEventListener("click", doRoll);
}

buildControls();
renderPool();
renderAdvLabel();
initOBR();
