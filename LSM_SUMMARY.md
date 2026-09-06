# LSM — Latitude Speedmapping Medals — Project Summary
Paste this at the start of a new chat so Claude knows the full context.

---

## What this is
An author medal tracker for the **Latitude** Trackmania mapping studio's
speedmapping folder. Club ID 97497, folder ID 866418.
Branding uses Latitude's own logo/wordmark assets (red #E03333 / black #1A1A1A
sphere mark), styled after latitude.rip (dark, minimal, coordinate-style labels).

Sibling project: Illan Cup Medals (same architecture, different club/branding) —
see its own PROJECT_SUMMARY.md.

## Architecture (identical pattern to Illan Cup Medals)
- **GitHub Pages** hosts `index.html` (pure static, no server)
- **Cloudflare Worker** (`worker.js`) proxies Nadeo API calls (CORS + auth), KV binding name `LSM`
- **Cloudflare KV** namespace `LSM` (separate from ICM's `ICM` namespace) stores map data + leaderboard
- **seed.js** runs locally or via GitHub Actions nightly at 01:00 Finnish time
- Reuses the same Nadeo service account as Illan Cup Medals (`TM_SERVICE_LOGIN` /
  `TM_SERVICE_PASSWORD`) — it's just a login, not tied to one club.
- Reuses the same Cloudflare account, but a brand-new KV namespace + Worker
  (`lsm`) so the ICM site is untouched.

## Key difference from Illan Cup Medals
Illan Cup pulled every campaign in a club. LSM instead pulls only the
activities inside **one folder** via
`GET /api/token/club/{clubId}/activity?folderId={folderId}&active=true`.
Folder contents can be campaigns, rooms, or plain map-upload "buckets" —
seed.js handles all three, logging each activity's type as it goes so any
parsing gaps are easy to spot from the console output.

## Status (verified 2026-09-07)
**Live and seeded.** The Worker at `https://lsm.kurrankuuselatony98.workers.dev`
responds on all endpoints, and KV holds a full dataset:

- 515 maps tracked, by 42 distinct authors
- 499 maps with at least one AT holder, 16 still unclaimed
- 3,262 author medals total; 100 leaderboard entries, all display names resolved
- last seed run: 2026-09-06 16:39 UTC

So `getFolderMaps()` parses the folder correctly — the earlier "not yet run,
may need a parsing tweak" note is obsolete.

## File structure
```
LSM/
├── .github/workflows/seed.yml   # nightly seed run
├── index.html                   # frontend (LSM/Latitude branding)
├── worker.js                    # Cloudflare Worker
├── seed.js                      # leaderboard generator (folder-based)
├── package.json
├── .env.example
├── .gitignore
├── .nojekyll
├── DEPLOY.md                    # step-by-step Cloudflare/GitHub setup
└── assets/                      # Latitude logo mark + lockup PNGs
```

## Known issues / things to remember
- `WORKER_URL` is hardcoded near the bottom of `index.html`. It currently
  points at `lsm.kurrankuuselatony98.workers.dev`, which is confirmed live —
  only change it if the Worker is ever renamed.
- There is no player-lookup panel in the UI at all. The Worker exposes
  `/api/search`, `/api/resolvename` and `/api/top100`, but `index.html`
  never calls them — Illan Cup's "scan all maps for a player's ATs"
  feature is unbuilt on both the frontend and the wiring.
- After any seed.js change: delete the `maps` key from the `LSM` KV
  namespace, then re-run seed locally.
- GitHub Actions needs all 7 secrets set in the new repo's
  Settings → Secrets (see DEPLOY.md).
