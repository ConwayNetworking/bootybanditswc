# 🏆 WC2026 Fantasy League — Cloudflare Pages Setup Guide

## What's in this folder

```
index.html                  ← Your app (patched — no hardcoded secrets)
functions/
  api/
    matches.js              ← Proxies football-data.org (hides your API key)
    league-data.js          ← Reads/writes scores to Cloudflare KV
wrangler.toml               ← Only for local dev, ignore otherwise
SETUP.md                    ← You are here
```

---

## Step 1 — Get a football-data.org API key (2 min)

1. Go to https://www.football-data.org/client/register
2. Enter your email — no card, no phone
3. Key arrives by email in under a minute, copy it

---

## Step 2 — Connect your GitHub repo to Cloudflare Pages

Skip if already connected. Just make sure the root directory is correct.

1. Cloudflare Dashboard → Workers & Pages → Create → Pages
2. Connect to Git → select your repo
3. Build settings:
   - Framework preset: None
   - Build command: (leave blank)
   - Build output directory: (leave blank)
4. Save and Deploy

---

## Step 3 — Create a KV Namespace (the shared database)

1. Cloudflare Dashboard → Workers & Pages → KV
2. Click "Create a namespace"
3. Name it: WC_LEAGUE
4. Click Add

---

## Step 4 — Set Environment Variables (your secrets)

Pages project → Settings → Environment Variables → Production → Add variable:

  FOOTBALL_DATA_KEY  =  (your key from Step 1)
  ADMIN_PASSWORD     =  (pick any password you want)

Repeat for Preview environment too.

⚠️  The old password was "wc2026admin" sitting in plain HTML.
    It's now checked server-side. Pick something better!

---

## Step 5 — Bind KV to your Pages project

Pages project → Settings → Functions → KV namespace bindings → Add binding:

  Variable name: WC_LEAGUE
  KV namespace:  WC_LEAGUE

Save. Repeat for Preview tab.

---

## Step 6 — Push files and redeploy

Replace your repo contents with the files in this folder:

  your-repo/
  ├── index.html
  ├── functions/
  │   └── api/
  │       ├── matches.js
  │       └── league-data.js
  └── wrangler.toml

Then:
  git add .
  git commit -m "Add Cloudflare Functions + KV"
  git push

Cloudflare Pages auto-deploys in ~30 seconds.

---

## Step 7 — Verify it works

Open your site and check these URLs:

  https://yoursite.pages.dev/api/matches
  → should return JSON with World Cup fixtures

  https://yoursite.pages.dev/api/league-data?league=work
  → should return {"results":{},"autosync":true,"theme":"dark"}

If /api/matches errors the first time, wait 60s (rate limit) — caching kicks in after first successful call.

---

## What changed from the old version

  BEFORE                                    AFTER
  API key hardcoded in HTML source          Stored in Cloudflare env vars
  Admin password "wc2026admin" in HTML      Verified server-side only
  Scores in each visitor's localStorage     Shared in Cloudflare KV
  Direct calls to football-data.org         Proxied via /api/matches
  Scores lost on browser clear              Scores live in KV forever
  Everyone had to sync separately           One sync updates everyone
  Admin tab had to stay open to save        Fully automatic server-side sync

---

## How the automatic sync works

  /api/matches does everything server-side on each request:

  1. Edge cache (Cloudflare Cache API) absorbs all traffic for 55s while
     matches are live (or kicking off within 15 min), 5 min otherwise.
     football-data.org sees ~1 request/min worst case — well inside the
     free tier's 10 req/min.
  2. On refresh, the upstream payload is trimmed (~90% smaller) and every
     API match is mapped onto fixture IDs 1-104 — including knockout
     bracket slots (2A, W73, 3rd(A/B/C/D/F)...) resolved from standings,
     with penalty shootouts handled.
  3. Computed results are saved to KV (global:auto), shared by all three
     leagues (Work, The Boys, Gogi Gang). Nobody needs to be in admin
     mode — any visitor's poll keeps scores fresh for everyone.
     KV is only written when a score actually changes, so the free tier's
     1k writes/day is never threatened.

  The per-league league:<id>:results key now only stores manual admin
  overrides (pencil button in Match Centre). An override always wins over
  the API feed; remove it (✕) to fall back to automatic scores.

  Browsers poll /api/matches every 60s when matches are live or imminent
  and every 5 min otherwise. Note the free tier's live scores lag ~5 min
  behind real time.

---

## Troubleshooting

/api/matches returns 502
→ FOOTBALL_DATA_KEY env var missing or wrong. Check Step 4.

/api/league-data returns 500
→ KV binding missing. Check Step 5.

Admin login says "Could not verify"
→ Functions not deployed yet. Make sure functions/ folder is in repo root.

Scores not saving
→ Must be in Admin mode (gear icon → enter your ADMIN_PASSWORD).
