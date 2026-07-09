# Deploying Strategy Combat for worldwide play

Your code is already on GitHub:
**https://github.com/ARYAN-KUMAR-22/strategy-combat**

To let real online players (not just your WiFi) join, the server must run on a host.
Below is the easiest free path (Render), plus alternatives.

---

## Option A — Render.com (recommended, free, no card)

### One-click (uses the included `render.yaml`)
1. Open this link:
   **https://render.com/deploy?repo=https://github.com/ARYAN-KUMAR-22/strategy-combat**
2. Sign in with GitHub (first time: click "Authorize Render").
3. Render reads `render.yaml` and fills everything in. Click **Apply / Create**.
4. Wait ~2–3 minutes for the build. You'll get a public URL like:
   `https://strategy-combat.onrender.com`
5. Share that URL. Anyone opens it, clicks **Find Match**, and gets paired.

### Manual (if you prefer clicking through)
1. Render Dashboard → **New** → **Web Service**.
2. Connect the `strategy-combat` repo.
3. Settings: **Build Command** `npm install`, **Start Command** `npm start`,
   **Instance Type** Free. Click **Create Web Service**.

> Free tier note: after ~15 min idle the service "sleeps," so the first visit after a
> quiet period takes ~30 s to wake. Fine for testing; upgrade for always-on.

---

## Option B — Railway.app

1. railway.app → **New Project** → **Deploy from GitHub repo** → pick `strategy-combat`.
2. Railway auto-detects Node and runs `npm start`. It gives you a public domain.
   (Railway may ask for a card for the free trial.)

## Option C — Fly.io (uses the included Dockerfile)

```
npm i -g flyctl
fly launch          # detects Dockerfile, pick a name/region
fly deploy
```
Gives you `https://your-app.fly.dev`.

---

## Persistent accounts with Postgres (recommended for real deploys)

By default the server stores accounts in a local `users.json` file. On hosts with an
**ephemeral filesystem (Render free tier)** that resets on every redeploy. To make
accounts and leaderboard **survive redeploys**, point the server at Postgres — the code
auto-detects it and creates its table on first boot. No file changes needed.

### On Render
1. Dashboard → **New** → **PostgreSQL** → create a free instance.
2. Copy its **Internal Database URL**.
3. On your web service → **Environment** → add:
   - `DATABASE_URL` = the URL you copied
   - `JWT_SECRET` = any long random string (so logins survive restarts)
4. Redeploy. Logs will show `[store] Postgres connected`.

### Anywhere else (Neon, Supabase, Railway, a VPS)
Just set the same `DATABASE_URL` env var. If your provider doesn't use SSL, also set
`PGSSL=disable`. Local dev with no `DATABASE_URL` keeps using the JSON file automatically.

### Verify which backend is live
`GET /status` returns `"storage": "pg"` or `"storage": "file"`.

## After deploying

- The client connects with `io()` (same origin), so **no code change is needed** —
  it automatically talks to whatever host it's served from.
- Test: open the public URL in two tabs, Find Match in both.
- Real test: send the URL to a friend anywhere; you both Find Match and fight.

## Updating the live game later

Any change you push to GitHub redeploys automatically:
```
git add .
git commit -m "tweak balance"
git push
```

---

## Honest status / what's still missing for a "real" game

This prototype pairs the next two people who click Find Match. Before a public launch
you'd want (see `../STEP_BY_STEP_PLAN.md`): accounts + login, a rating/leaderboard,
reconnection handling, and basic abuse protection. The deployment above is the
foundation those build on.
