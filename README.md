# Open Legend Dice — Owlbear Rodeo Extension

A dice roller for [Open Legend RPG](https://openlegendrpg.com/core-rules/actions-attributes) with
exploding dice, advantage/disadvantage, and a shared roll log every player in the room can see.

Hosted on GitHub Pages: <https://pectole3-create.github.io/open-legend-dice/>

Add it to a room with **Extensions → Add Extension** and this manifest URL:

```
https://pectole3-create.github.io/open-legend-dice/manifest.json
```

## Features

- **Mixed dice pools** — click d4/d6/d8/d10/d12/d20 to build any pool (e.g. `d20 + 2d6 + d8`).
  Right-click a die button (or click a pool chip) to remove dice.
- **Attribute quick-select (0–10)** — sets the pool to `1d20 + attribute dice` per the Open Legend table.
- **Exploding dice** — a die that rolls its maximum is rolled again and added (chains allowed).
  Toggleable, on by default.
- **Advantage / Disadvantage 1–9** — rolls that many extra attribute dice and drops the lowest
  (advantage) or highest (disadvantage). A bare d20 pool adds at most **one** extra d20, never 3d20.
  The setting is sticky, so the Roll button turns green/red and names it; click the label to reset.
- **Shared log** — every player's rolls, merged, surviving reloads and late joins. See below.
- **24h export** — "Export 24h" downloads every roll this client has seen in the last day as a text
  file, for when the table wants to audit its luck.

## Randomness

Rolls come from `crypto.getRandomValues` (the OS CSPRNG) with rejection sampling, not `Math.random`.
`Math.random` is statistically fine for dice, but it is a seeded userspace PRNG, and "is the roller
rigged" is a conversation worth ending permanently. The rejection loop discards values in the final
partial block of 2³², so no face is favoured by the modulo — see `randomInt` in `main.js`.

Verified with a 120k-roll χ² test in the browser: χ² = 15.6 on 19 df, mean 10.51 vs 10.5 expected.

## How sharing works

Two transports, because neither alone is enough:

| | purpose |
|---|---|
| `OBR.broadcast` | instant delivery to everyone currently connected |
| room metadata | durability — survives reloads and catches up late joiners |
| 20s reconcile | re-reads metadata, so a dropped event self-heals |

**Each player writes only their own metadata key** (`com.vladi.open-legend-dice/log/<playerId>`) and
the view is the merge of everyone's keys, deduped by roll id. This matters: room metadata has no
compare-and-swap, so the older design — one shared array that every client read, appended to, and
wrote back — silently lost a roll whenever two players rolled at the same moment. Nobody owns a key
but its player, so there is nothing to race over. Slots whose rolls are all older than 24h get pruned
to protect the room's shared ~16KB metadata budget.

### The "connecting…" bug (fixed in 1.5.0)

The Owlbear SDK connects by *listening*: the host posts `OBR_READY` into the extension iframe exactly
once, on the iframe's load event, and the SDK picks it up with a `window.addEventListener("message")`
installed when its module evaluates. Up to 1.4.0 the SDK was pulled in with a lazy
`await import("./owlbear-sdk.js")`, so that listener was not installed until a second 56KB network
fetch had finished. On any client where that fetch landed after `OBR_READY` had been posted, the
handshake was gone for good — the panel sat on "connecting…" forever, and because it is a timing
race it hit some players and not others, which is exactly what it looked like from the table.

Two fixes, belt and braces:

1. `main.js` imports the SDK **statically**, so the listener is installed during module evaluation,
   which is guaranteed to happen before the load event.
2. An inline script in `<head>` buffers any `message` events from the first moment of parsing, and
   `main.js` replays them into the SDK as soon as it is loaded.

There is also a 12-second watchdog: if the handshake somehow still does not complete, the status line
says so and offers a **Reconnect** button instead of lying about "connecting…".

## Testing

`obr-harness.html` is a stand-in for the Owlbear host: it embeds two extension iframes as two players
in one fake room and implements enough of the postMessage protocol to exercise the handshake, the
broadcast path, and room metadata.

```bash
npx http-server . -p 8087 -c-1
```

Then open <http://localhost:8087/obr-harness.html>. From the console:

```js
harness.pick(0, 5); harness.pick(1, 7);  // Alice attribute 5, Bob attribute 7
harness.rollBoth();                      // both roll in the same tick
harness.entriesOf(0); harness.entriesOf(1);  // both should list all rolls
harness.roomMeta();                      // one key per player
```

`?delay=N` on the harness URL controls how long the fake host waits before posting `OBR_READY`;
`delay=0` is the aggressive case that broke 1.4.0.

## Files

```
index.html      UI, styles, and the early-message buffer
main.js         dice logic, randomness, Owlbear sync
owlbear-sdk.js  the Owlbear SDK, bundled and self-hosted (no third-party CDN at runtime)
src/sdk-entry.js  bundle entry point — rebuild with: npm run build:sdk
manifest.json   extension manifest
obr-harness.html  two-player test harness (dev only)
```

Self-hosting the SDK is deliberate: a CDN fetch is one more thing an ad-blocker or a school/office
proxy can quietly break, and when it breaks it breaks the handshake.

## Deploying

GitHub Pages serves `main` from the repo root, so a push deploys:

```bash
git push
```

Bump `VERSION` in `main.js`, `"version"` in `manifest.json` and `package.json`, and the `?v=` on the
`main.js` script tag in `index.html` together — the query string is what stops players from running a
cached copy of the old build.
