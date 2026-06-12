# 🏆 WC2026 Fantasy League — Cloudflare Pages Setup

Full setup is **4 steps, ~10 minutes, completely free**. Once it's done,
scores update themselves for everyone — there is nothing to run, click,
or keep open during the tournament.

## What's in this repo

```
index.html                  ← The whole app (one file)
functions/
  api/
    matches.js              ← Auto-syncs live scores from football-data.org
    league-data.js          ← Stores league scores/settings in Cloudflare KV
wrangler.toml               ← Only for local dev, ignore otherwise
SETUP.md                    ← You are here
```

---

## Step 1 — Get a free football-data.org API key (2 min)!

1. Go to https://www.football-data.org/client/register
2. Enter your email — no card, no phone number
3. The key arrives by email in under a minute. Copy it, you'll need it in Step 3.

The free tier is all we need — the server caches everything so we never
get near its rate limit.

---

## Step 2 — Create the Pages project (3 min)

1. Sign up / log in at https://dash.cloudflare.com (free plan is fine)
2. Go to **Workers & Pages → Create → Pages → Connect to Git**
3. Pick this GitHub repo
4. Build settings — leave EVERYTHING blank/default:
   - Framework preset: **None**
   - Build command: *(blank)*
   - Build output directory: *(blank)*
5. Click **Save and Deploy**

Your site is now live at `https://<project-name>.pages.dev`, but scores
won't work until Steps 3 and 4 are done.

---

## Step 3 — Add your two secrets (2 min)

In your Pages project: **Settings → Environment variables → Add**

| Variable name       | Value                                  |
|---------------------|----------------------------------------|
| `FOOTBALL_DATA_KEY` | the API key from Step 1                |
| `ADMIN_PASSWORD`    | any password you like (don't reuse one) |

Add both to **Production** (and Preview too if you're offered the choice).

`ADMIN_PASSWORD` is what you type into the gear menu on the site to
unlock admin mode (manually overriding a score if the API ever gets one
wrong). Normal visitors never need it.

---

## Step 4 — Create the shared database (KV) and connect it (3 min)

This is one shared store so every visitor sees the same scores.

1. Cloudflare Dashboard → **Storage & Databases → KV** (or Workers & Pages → KV)
2. **Create a namespace**, name it `WC_LEAGUE`
3. Back in your Pages project: **Settings → Bindings** (older dashboards:
   Settings → Functions → KV namespace bindings) → **Add → KV namespace**:
   - Variable name: `WC_LEAGUE`
   - KV namespace: `WC_LEAGUE` (the one you just made)
4. Save, then redeploy so the binding takes effect:
   **Deployments → ⋯ on the latest deployment → Retry deployment**

---

## Check it works (1 min)

Open these in a browser (replace with your real site URL):

- `https://yoursite.pages.dev/` — the app loads
- `https://yoursite.pages.dev/api/matches` — JSON starting with
  `{"syncedAt":...` and containing `"results"` and `"matches"`
- `https://yoursite.pages.dev/api/league-data?league=work` — JSON
  containing `"results"`, `"autosync":true`, `"theme"`

If both API URLs return JSON, you're done. Share the site link with the
league and forget about it — scores flow in automatically.

---

## That's the whole setup. How it runs itself

- The server checks football-data.org **at most ~once a minute during
  live matches** and every 5 minutes otherwise — no matter how many
  people are on the site (Cloudflare's edge cache absorbs the traffic).
  That's well inside the free tier's 10 requests/min.
- Results are matched to fixtures **on the server** (including knockout
  bracket slots and penalty shootouts) and saved to KV, so all three
  leagues (Work, The Boys, Gogi Gang) update from one sync.
- Browsers poll every minute during live play, every 5 minutes when idle.
  There are no manual sync buttons — nobody can flood the API.
- Heads-up: the free football-data tier lags **~5 minutes behind real
  time**, so don't panic when a goal takes a few minutes to appear.
- Admin mode (gear icon → your `ADMIN_PASSWORD`) is only for fixing a
  wrong score: pencil ✎ overrides the API for your league, ✕ removes the
  override and goes back to automatic.

---

## Troubleshooting

**`/api/matches` returns 502 with "FOOTBALL_DATA_KEY env var not set"**
→ Step 3 not done, or the variable name is misspelled. Add it and retry
the deployment.

**`/api/matches` returns 502 with "Upstream HTTP 4xx"**
→ The API key is wrong. Re-copy it from the football-data email.

**`/api/league-data` returns a 500 error**
→ The KV binding is missing (Step 4). Bind it and retry the deployment.

**Admin login says "Could not verify"**
→ `ADMIN_PASSWORD` env var not set, or the functions aren't deployed —
make sure the `functions/` folder is at the repo root.

**Scores seem stuck**
→ Remember the ~5 min feed delay. If it's been longer, open
`/api/matches` directly — if it shows `"source":"stale"`, football-data
is having an outage and the site is serving the last good data; it
recovers on its own.

**Changed an env var or binding but nothing happened**
→ Env vars and bindings only apply to new deployments. Go to
Deployments → Retry deployment.
