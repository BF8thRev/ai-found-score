# AI Found Score — website

One Cloudflare Worker serving the static site plus two API routes. Single deployable unit, free-tier only.

## What’s here

| Path | What it is |
|---|---|
| `/` | Landing page: what the free report is, the two questions, how it works, pricing, FAQ |
| `/report/sample-001` | Sample report page (fictional plumbing business, mock data) |
| `/report/[id]` | Report page for any id — reads from `GET /api/report/[id]` |
| `/r/[code]` | Postcard short code (e.g. `/r/K7M2QX`, case/dash-insensitive) → 302 to that recipient's `/report/[token]`. Unknown code → friendly not-found page |
| `/success` | Post-payment page. If checkout started on a report page, waits for the webhook and links back to the unlocked report |
| `/about`, `/privacy`, `/contact` | Static info pages. Footer on every page carries the mailing address (120 Terminal Drive, Plainview, NY 11803) |
| `/unsubscribe`, `/stop` | Opt-out. `GET ?t=<token>` from email links, `POST` with `List-Unsubscribe=One-Click` (RFC 8058) from mail clients, the on-page email form, or the postcard code (`/stop` form, or `GET /stop?c=CODE`). Writes to the `unsubscribes` table; a token row suppresses that business for mail and email |
| `/robots.txt` | Disallows `/report/`, `/r/`, `/success`, `/unsubscribe`, `/stop`, `/api/`; points at `/sitemap.xml` |
| `POST /api/request` | Landing-page form: writes a `report_requests` row (JSON or form post) |
| `www.` | 301 to the bare domain, path and query preserved |
| `GET /api/report/[id]` | Report JSON. Until a payment exists for the token, returns `locked: true` with fix details stripped server-side (the page blurs stand-ins). `?preview=locked` shows the sample locked |
| `POST /api/visit` | Report-page view beacon, sent after render. Arm looked up from the token; link-scanner user agents ignored. Writes `page_visits` |
| `POST /api/lead` | "Email me this report". Writes `leads` (status `new`) with the arm from the token |
| `POST /api/stripe-webhook` | Stripe webhook: verifies signature, reads `client_reference_id` (report token), looks up business + arm in `report_links`, writes `payments` |

`public/js/config.js` holds `STRIPE_LINKS` — the one file where real Stripe Payment Links get dropped in later.

## Supabase setup

Run [`supabase/setup.sql`](supabase/setup.sql) once in the Supabase SQL editor (safe to re-run). It adds:

- `report_links` — one row per test recipient: `report_token`, printed `short_code` (auto-generated, no look-alike characters), `business_id`, `arm` (`mail` | `email_a` | `email_b`), `town`. **The randomize job writes this before any send**; the site never trusts `?arm=` from a URL.
- `leads` — "Email me this report" captures. The sender picks up `status = 'new'` rows and emails the report link.
- `page_visits.arm` and `payments.report_token` columns.
- `report_unlocked(token)` — lets the Worker check for a payment without read access to `payments`.
- `unsubscribes` and `report_requests` (if not already made).
- `channel_funnel` view — recipients / visited / leads / paying / revenue per arm (distinct tokens). Readable only with the service key.

The sender (email and Lob jobs) must check `unsubscribes` by email and by `report_token` before every send.

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
| `SUPABASE_URL` | `src/lib/db.js` | In `wrangler.jsonc` `vars` (not secret). Don't set it in the dashboard: `wrangler deploy` replaces dashboard Text vars with the config file |
| `SUPABASE_ANON_KEY` | `src/lib/db.js` | The project's **publishable** key (`sb_publishable_...`, Supabase → Project Settings → API Keys). Add as a Worker secret |
| `STRIPE_WEBHOOK_SECRET` | `POST /api/stripe-webhook` | **Not yet available — add when the Stripe webhook is created** |
| `STRIPE_WEBHOOK_SECRET_TEST` | `POST /api/stripe-webhook` | Optional. Signing secret of the Stripe **sandbox** webhook; accepted only for `livemode: false` events. Sandbox payments are stored with `payments.livemode = false` and excluded from `channel_funnel`. Delete once live testing is done |

For local dev, create `.dev.vars` (git-ignored):

```
SUPABASE_URL=https://bahmemiydzpotfrxmlzw.supabase.co
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
git branch -M master
git push -u origin master
```

### Connect Cloudflare for auto-deploys

1. In the Cloudflare dashboard, go to **Workers & Pages** → **Create** → **Connect to Git**.
2. Authorize the GitHub account and select the repo.
3. Project name: `ai-found-score`. Framework preset: **None**.
4. Build command: leave empty (no build step). Deploy command: `npx wrangler deploy`.
5. Root directory: the repo root (this folder is the repo root).
6. Under **Settings → Variables and Secrets**, add the secrets from the env var table above (`SUPABASE_ANON_KEY`, `STRIPE_WEBHOOK_SECRET`). `SUPABASE_URL` lives in `wrangler.jsonc`. Secrets set here are available to every deployment.
7. Save — Cloudflare deploys on every push to `master` from now on.

Manual deploy still works anytime: `npm run deploy` (needs `npx wrangler login` first).

### After the first deploy

1. In the Cloudflare dashboard, add a custom domain (e.g. `aifoundscore.com`) to the Worker.
2. In Stripe dashboard → Developers → Webhooks, create an endpoint pointing at `https://<your-domain>/api/stripe-webhook`, subscribe to `checkout.session.completed`, and copy the signing secret into the `STRIPE_WEBHOOK_SECRET` secret.
3. Replace the `#` placeholders in `public/js/config.js` with the real Stripe Payment Links and push (or redeploy).

## Wiring checklist (the things filled in later)

1. **Supabase.** Run `supabase/setup.sql`. Add `SUPABASE_ANON_KEY` as a Worker secret.
2. **Stripe payment links.** Paste the four real links into `STRIPE_LINKS` in `public/js/config.js` (keys: `snapshot`, `before_after`, `full_year`, `listing_fix`). On each Payment Link in the Stripe dashboard, set the after-payment redirect to `https://aifoundscore.com/success?tier=<key>&session_id={CHECKOUT_SESSION_ID}`. No metadata is needed: the webhook takes the tier from the amount paid (`TIER_BY_CENTS` in `src/worker.js`; update it if prices change). Business and arm come from the report token: the report page appends `client_reference_id=<report token>` and the webhook looks the rest up. Report tokens must be letters, digits, `-` or `_` (Stripe's rule for `client_reference_id`).
3. **Stripe webhook.** Endpoint `https://aifoundscore.com/api/stripe-webhook`, events `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Store its signing secret (`whsec_...`) as the runtime secret `STRIPE_WEBHOOK_SECRET`. Only paid checkouts are recorded.
4. **Postcards.** QR code and printed URL both point at `https://aifoundscore.com/r/<short_code>`; opt-out line: `aifoundscore.com/stop` + the same code.

## Notes

- Report pages are data-driven: `public/js/report.js` renders whatever `GET /api/report/[id]` returns. The shape is documented in `DATA_MODEL.md`.
- `GET /api/report/[id]` returns 404 JSON for unknown ids; the page shows a friendly "report not found" message. Real reports are `Cache-Control: private, no-store` because they change the moment they're paid for.
- The webhook returns 400 on bad signatures (Stripe won’t retry) and 500 on payment-write failures (Stripe will retry).
- Cloudflare Web Analytics is a placeholder comment in each page’s `<head>` — paste the real beacon snippet when the token exists.
- Contact email used in footers: `hello@aifoundscore.com` — confirm/create this mailbox before launch.
