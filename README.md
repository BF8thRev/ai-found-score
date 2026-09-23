# AI Found Score — website

One Cloudflare Worker serving the static site plus two API routes. Single deployable unit, free-tier only.

## What’s here

| Path | What it is |
|---|---|
| `/` | Landing page: what the free report is, the two questions, how it works, pricing, FAQ |
| `/report/sample-001` | Sample report page (fictional plumbing business, mock data) |
| `/report/[id]` | Report page for any id — reads from `GET /api/report/[id]` |
| `/success` | Post-payment page ("payment received, report on its way") |
| `GET /api/report/[id]` | Report JSON — mock data now, Supabase read later |
| `POST /api/stripe-webhook` | Stripe webhook: verifies signature, writes payment to Supabase (stubbed until wired) |

`public/js/config.js` holds `STRIPE_LINKS` — the one file where real Stripe Payment Links get dropped in later.

## Local dev

Requires Node 18+ and a free Cloudflare account (only needed for actual deploy, not for building).

```bash
cd ai-found-score-site
npm install
npm run dev        # serves at http://localhost:8787
```

`npm run dev` reads `.dev.vars` for env vars if present (see below). It is git-ignored — never commit secrets.

## Env vars (all via Worker env — never in code)

| Var | Used by | Status |
|---|---|---|
| `SUPABASE_URL` | `src/lib/db.js` | Set to `https://piaaovvnuejbawpudhbp.supabase.co` at deploy |
| `SUPABASE_ANON_KEY` | `src/lib/db.js` | **Not yet available — add at deploy time** |
| `STRIPE_WEBHOOK_SECRET` | `POST /api/stripe-webhook` | **Not yet available — add when the Stripe webhook is created** |

For local dev, create `.dev.vars` (git-ignored):

```
SUPABASE_URL=https://piaaovvnuejbawpudhbp.supabase.co
SUPABASE_ANON_KEY=
STRIPE_WEBHOOK_SECRET=
```

## Deploy to Cloudflare

Two ways: manual (`npm run deploy`) or auto-deploy from GitHub (recommended — every push goes live).

### Push to GitHub

The project is already a git repo with an initial commit. Nothing has been pushed.

```bash
cd ai-found-score-site
# 1. Create an empty repo on github.com (e.g. ai-found-score-site) — do NOT add a README/license there
# 2. Then:
git remote add origin https://github.com/<your-username>/ai-found-score-site.git
git branch -M main
git push -u origin main
```

### Connect Cloudflare for auto-deploys

1. In the Cloudflare dashboard, go to **Workers & Pages** → **Create** → **Connect to Git**.
2. Authorize the GitHub account and select the repo.
3. Project name: `ai-found-score`. Framework preset: **None**.
4. Build command: leave empty (no build step). Deploy command: `npx wrangler deploy`.
5. Root directory: the repo root (this folder is the repo root).
6. Under **Settings → Variables and Secrets**, add the secrets from the env var table above (`SUPABASE_ANON_KEY`, `STRIPE_WEBHOOK_SECRET`) and the plain var `SUPABASE_URL`. Secrets set here are available to every deployment.
7. Save — Cloudflare deploys on every push to `main` from now on.

Manual deploy still works anytime: `npm run deploy` (needs `npx wrangler login` first).

### After the first deploy

1. In the Cloudflare dashboard, add a custom domain (e.g. `aifoundscore.com`) to the Worker.
2. In Stripe dashboard → Developers → Webhooks, create an endpoint pointing at `https://<your-domain>/api/stripe-webhook`, subscribe to `checkout.session.completed`, and copy the signing secret into the `STRIPE_WEBHOOK_SECRET` secret.
3. Replace the `#` placeholders in `public/js/config.js` with the real Stripe Payment Links and push (or redeploy).

## Wiring checklist (the three things filled in later)

1. **Supabase anon key + confirmed schema.** Add `SUPABASE_ANON_KEY` as a Worker secret. Open `src/lib/db.js`, confirm every table/column name in `TABLES`/`COLS` against the live schema, then set `READY = true`. Nothing else needs changing — the Worker calls only `recordPayment()` and `getReport()`.
2. **Stripe payment links.** Paste the four real links into `STRIPE_LINKS` in `public/js/config.js` (keys: `snapshot`, `before_after`, `full_year`, `listing_fix`). Add `success_url=https://<domain>/success` to each Payment Link in the Stripe dashboard.
3. **Stripe webhook secret.** Create the webhook endpoint (see deploy step 6) and store the signing secret as `STRIPE_WEBHOOK_SECRET`. Include `business_id`, `report_id`, and `tier` in each Payment Link’s metadata so the webhook can attribute the payment.

## Notes

- Report pages are data-driven: `public/js/report.js` renders whatever `GET /api/report/[id]` returns. The shape is documented in `DATA_MODEL.md`.
- `GET /api/report/[id]` returns 404 JSON for unknown ids; the page shows a friendly "report not found" message.
- The webhook returns 400 on bad signatures (Stripe won’t retry) and 500 on payment-write failures (Stripe will retry).
- Cloudflare Web Analytics is a placeholder comment in each page’s `<head>` — paste the real beacon snippet when the token exists.
- Contact email used in footers: `hello@aifoundscore.com` — confirm/create this mailbox before launch.
