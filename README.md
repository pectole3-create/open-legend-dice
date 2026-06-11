# Open Legend Dice — Owlbear Rodeo Extension

A dice roller for [Open Legend RPG](https://openlegendrpg.com/core-rules/actions-attributes) with exploding dice and advantage/disadvantage. Rolls are broadcast to every player in the room who has the panel open, plus shown as a notification toast.

## Features

- **Mixed dice pools** — click d4/d6/d8/d10/d12/d20 to build any pool (e.g. `d20 + 2d6 + d8`). Right-click a die button (or click a pool chip) to remove dice.
- **Attribute quick-select** — buttons 0–10 set the pool to `1d20 + attribute dice` per the Open Legend table (5 → `d20 + 2d6`, 8 → `d20 + 3d8`, etc.).
- **Exploding dice** — when a die rolls its maximum, it is rolled again and added; chains are allowed. Toggleable, on by default (Open Legend default).
- **Advantage / Disadvantage 1–9** — rolls that many extra attribute dice (the largest non-d20 die in your pool) and drops the lowest (advantage) or highest (disadvantage), keeping your normal dice count. With a bare d20 pool, it applies to the d20 itself.
- **Roll log** — shows every die, explosion chains in gold, dropped dice struck through, extra advantage dice tagged `adv`.

## Hosting

The extension is plain static files (no build step). Owlbear Rodeo loads it by URL, so it must be hosted somewhere:

**Option A — GitHub Pages (recommended, free, permanent):**
1. Create a GitHub repo and push this folder's contents to it.
2. Repo Settings → Pages → Source: `main` branch, root folder.
3. Your manifest URL is `https://<username>.github.io/<repo>/manifest.json`.

**Option B — local testing:**
```
npx http-server . -p 8087 -c-1
```
Manifest URL: `http://localhost:8087/manifest.json` (works in Chrome; only on your own machine).

## Installing in Owlbear Rodeo

1. Go to [owlbear.rodeo](https://www.owlbear.rodeo), open your profile, and click **Add Extension**.
2. Paste the manifest URL and add it.
3. In your room, click the **⋮ menu (bottom left) → Extensions** and enable **Open Legend Dice**.
4. A d20 icon appears in the top-left action bar — click it to open the roller.

Other players see your rolls in their log (if their panel is open) and as a notification.
