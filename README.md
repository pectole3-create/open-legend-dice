# Open Legend Dice — Owlbear Rodeo Extension

A dice roller for [Open Legend RPG](https://openlegendrpg.com/core-rules/actions-attributes) with exploding dice, advantage/disadvantage, and a **shared server-side roll log** that every player sees and that auto-deletes after 24 hours.

## Features

- **Mixed dice pools** — click d4/d6/d8/d10/d12/d20 to build any pool (e.g. `d20 + 2d6 + d8`). Right-click a die button (or click a pool chip) to remove dice.
- **Attribute quick-select (0–10)** — sets the pool to `1d20 + attribute dice` per the Open Legend table.
- **Exploding dice** — a die that rolls its maximum is rolled again and added (chains allowed). Toggleable, on by default.
- **Advantage / Disadvantage 1–9** — rolls that many extra attribute dice and drops the lowest (advantage) or highest (disadvantage). A bare d20 pool adds at most **one** extra d20 (never 3d20).
- **Shared log** — rolls are stored on a server (Cloudflare Worker + KV), keyed per Owlbear room, so everyone sees the same log, including late joiners. Instant updates come over Owlbear's broadcast channel; a 20s reconcile keeps everyone in sync.
- **Per-player clear** — "Clear my rolls" removes only your entries from the shared log.
- **24h retention + export** — the server keeps the last 100 rolls and prunes anything older than a day automatically. "Export 24h" downloads the log (server-authoritative, with a local backup) as a text file for verification.
- **Orange totals** and a status footer showing the version and connection state.

## Architecture

```
public/        static extension files (index.html, main.js, icon.svg)
src/worker.js  Cloudflare Worker: dynamic manifest + /api log endpoints + serves public/
wrangler.toml  Worker config (assets dir + KV binding)
```

The Worker generates `/manifest.json` dynamically from its own URL, so the same code works on any deployment URL or custom domain — no hardcoded host.

## Deploying to Cloudflare (free)

From this folder:

```bash
# 1. Log in (opens a browser; creates/links a free Cloudflare account)
npx wrangler login

# 2. Create the KV namespace for the shared log
npx wrangler kv namespace create LOG
#    -> copy the printed id into wrangler.toml under [[kv_namespaces]] id = "..."

# 3. Deploy
npx wrangler deploy
#    -> prints your URL, e.g. https://open-legend-dice.<subdomain>.workers.dev
```

Local development (no login needed — uses a local simulator):

```bash
npx wrangler dev
```

## Installing in Owlbear Rodeo

1. Your manifest URL is `https://open-legend-dice.<subdomain>.workers.dev/manifest.json`.
2. In Owlbear: profile → **Add Extension** → paste the manifest URL.
3. In your room: **⋮ menu (bottom-left) → Extensions** → enable **Open Legend Dice**.
4. Click the d20 icon in the top-left action bar.

## Notes

- The shared log uses a per-room id stored in Owlbear room metadata, so different games keep separate logs.
- KV read-modify-write isn't atomic; two perfectly-simultaneous rolls could rarely race. The broadcast channel and each client's local copy mitigate this, and the next reconcile converges. For a tabletop group this is a non-issue; a Durable Object would make it strictly atomic if ever needed.
