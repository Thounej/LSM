# Deploying LSM without touching the Illan Cup site

Everything below creates *new* resources. Nothing here edits or deletes the
existing ICM namespace, `illancupmedals` Worker, or ICMEDALS repo.

## 1. Cloudflare KV — new namespace

Dashboard → **Workers & Pages → KV** → **Create a namespace**.
Name it `LSM` (anything distinct from `ICM` works). Copy the **Namespace ID**
it gives you — that's your new `CF_KV_NAMESPACE_ID`.

(CLI equivalent, if you use wrangler: `wrangler kv namespace create LSM`)

## 2. Cloudflare Worker — new Worker

Dashboard → **Workers & Pages** → **Create** → **Worker**.
Name it `lsm` (this becomes part of the URL:
`lsm.<your-subdomain>.workers.dev`).

Paste in `worker.js`. Then:
- **Settings → Bindings → Add binding → KV Namespace**
  - Variable name: `LSM`
  - Namespace: the `LSM` one from step 1
- **Settings → Variables and Secrets → Add** two **secrets** (not plaintext vars):
  - `TM_SERVICE_LOGIN` = same value as the ICM one
  - `TM_SERVICE_PASSWORD` = same value as the ICM one

Deploy. Your Worker URL will be `https://lsm.<your-subdomain>.workers.dev`
— it'll be the same subdomain your `illancupmedals` Worker uses, since that
subdomain belongs to the Cloudflare account, not the individual Worker.

If your Worker ends up with a different name than `lsm`, update the
`WORKER_URL` constant near the bottom of `index.html` before publishing.

## 3. Nadeo service account

No new setup needed — `service_ICMEDALS2` is just a login, reused as-is in
`.env` (for local seeding) and as the two Worker secrets above.

## 4. Run seed.js locally

```
cd LSM
cp .env.example .env
# fill in .env: same TM_SERVICE_LOGIN/PASSWORD, CLUB_ID=97497, FOLDER_ID=866418,
# your Cloudflare account id + API token, and the new CF_KV_NAMESPACE_ID from step 1
npm install
node seed.js
```

Watch the console output — it logs every activity found in the folder
(name + type), so any parsing gap in `getFolderMaps()` shows up there.
A healthy run currently finds ~515 maps.

Once it finishes successfully, check the KV namespace in the dashboard —
you should see `maps`, `leaderboard`, and `lastUpdated` keys.

## 5. GitHub repo + Pages

Create a new repo (e.g. `LSM`) and push everything in this folder. `.env` is
listed in `.gitignore` — keep it out of the repo and set the seven Actions
secrets below instead, so the credentials never land in git history.

- **Settings → Secrets and variables → Actions**, add:
  `TM_SERVICE_LOGIN`, `TM_SERVICE_PASSWORD`, `CLUB_ID`, `FOLDER_ID`,
  `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `CF_KV_NAMESPACE_ID`
- **Settings → Pages** → Source: `main` branch, `/ (root)`.

Your site will be live at `https://<your-username>.github.io/LSM/`.

## 6. Sanity check

Open the Pages URL. If `WORKER_URL` and the KV binding are both correct,
the hero stats and maps table should populate within a couple seconds.
If you see "Couldn't load data" — check the Worker URL in `index.html`
matches what Cloudflare actually gave your Worker.
