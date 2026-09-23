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

1. `npx wrangler login` (needs the Cloudflare account — not set up yet)
2. `npx wrangler secret put SUPABASE_ANON_KEY`
3. `npx wrangler secret put STRIPE_WEBHOOK_SECRET`
4. `npm run deploy`
5. In the Cloudflare dashboard, add a custom domain (e.g. `aifoundscore.com`) to the Worker.
6. In Stripe dashboard → Developers → Webhooks, create an endpoint pointing at `https://<your-domain>/api/stripe-webhook`, subscribe to `checkout.session.completed`, and copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
7. Replace the `#` placeholders in `public/js/config.js` with the real Stripe Payment Links and redeploy.

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
