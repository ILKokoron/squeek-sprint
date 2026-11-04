# Squeek Sprint

<!-- ================================================================
     SQUEEKCHAIN VERIFICATION: REPOSITORY LINE
     When Squeekchain issues the repository line for the direct
     verification path (Genesis → Code), paste it on the line below,
     exactly as given. Do not edit or remove the surrounding comment.
     ================================================================ -->
<!-- SQUEEKCHAIN-REPO-LINE: paste the verification repository line here -->

**Race the ghost of Squeektoshi, replayed from his real wheel.**

Squeek Sprint is a playable browser game powered by [Squeekchain](https://squeekchain.com), the hamster-powered proof-of-work toychain on Ethereum (Sepolia testnet). You race head-to-head against a *ghost* of Squeektoshi the hamster: a replay of one of his real, recorded wheel runs. He accelerates, hesitates and pauses exactly when he did on the wheel, beat his actual recorded time and you win.

This is an independent fan project, not an official Squeekchain product.

## How it plays

- **Sprint Replay (main mode):** pick the daily ghost (or browse his other runs), tap / press Space to run, one tap is one step, and manage your stamina. Mashing drains stamina and shrinks your steps; a steady ~0.6 s rhythm is fastest. First to complete the ghost's step count wins.
- **Live Duel:** when Squeektoshi is genuinely on the wheel right now, race him live for 30 seconds; his distance is his real `distanceMm` as reported by the API. When he is asleep, the mode honestly disables itself.
- Medals per difficulty tier, personal bests, and unlockable pixel track themes, all stored locally in your browser. No wallet, no account, no tracking, nothing to sign.

## Where the data comes from (and what it is, honestly)

All data comes from Squeekchain's public, key-free API (`https://api.squeekchain.com/v1`):

| Game element | Source |
|---|---|
| The ghost's movement, step count and finish time | `GET /v1/measurement/runs`, run segments whose `passages[]` carry the exact time (`offsetNs`) of every wheel passage. The ghost advances one step at each recorded passage time; the API docs describe this endpoint as the one to *animate running sessions*. |
| Running / sleeping status, Live Duel distance, wheel RPM | `GET /v1/status`, `measurement.coreStatus`, `freshness`, `rpmMilli`, `speedMmPerSecond`, `distanceMm`. |
| Result-screen chain context | `GET /v1/status`, `builder.anchor.blockHeight` and `blockProgress` (settled Squeek block height and progress toward the next block). |

Important honesty notes, also shown in the game itself:

- Run segments are **device-signed wheel evidence** (`certifiedCoreWork: false` in the API response). They are *not* SqueekCore-certified work, and the game never claims they are.
- **Your race results are not recorded onchain.** They live in your browser's local storage only. What is real is the ghost.
- If the API is unreachable or has no playable segment, the game falls back to bundled **sample ghosts**: synthetic practice data, generated for this project, and always labelled "SAMPLE / PRACTICE GHOST" in the interface.
- An API answer of `"status": "unavailable"` is treated as *unknown*, never displayed as zero.

Technical care taken with the API: large numbers that arrive as decimal strings are parsed with `BigInt`; `/status` is polled no faster than its ~1 s cache (Live Duel polls every 1.2 s, the home screen every 15 s); HTTP 429/503 responses are retried with backoff honouring `Retry-After`; `schemaVersion` is checked on both endpoints used; the last good data is kept on transient failures instead of blanking the screen.

## Run it / deploy it

It is a plain static site, no build step, no backend, no environment variables, no API keys.

- **Locally:** any static server works, e.g. `python3 -m http.server 8000` in this folder, then open `http://localhost:8000`. (Opening `index.html` via `file://` also mostly works, but some browsers restrict `fetch` from `file://`, so a local server is recommended.)
- **Vercel (or any static host):** deploy this folder as-is, framework preset "Other", no build command, output directory = the folder root. `index.html`, `styles.css`, `app.js` and `samples.js` are the whole site.

## Files

- `index.html`, the page (home / race / result views)
- `styles.css`, pixel-art theme (limited retro palette, blocky track, chunky CSS type)
- `app.js`, game logic, API client, pixel-sprite renderer, share-card generator
- `samples.js`, bundled synthetic sample segments (offline fallback, clearly labelled)
- `test/run-tests.cjs`, Node tests for the game logic and a full simulated race (`node test/run-tests.cjs`)

## Pixel art

All visuals are pixel art drawn in code in this repository, the hamster sprites are 16×13 pixel grids rendered on canvas with `image-rendering: pixelated`, in a limited retro palette, with simple 2-frame leg cycles. No external images, fonts, or licensed assets are used.
