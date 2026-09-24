# AI Found Score — website

One Cloudflare Worker serving the static site, the report API, and the admin scanner routes. The scanner (`scanner/`) and the shared report checks (`shared/report-v2.js`) are bundled into the same Worker. Single deployable unit.

## What’s here

| Path | What it is |
|---|---|
| `/` | Landing page: what the free report is (five AI assistants, five questions, 25 searches), how it works, pricing, FAQ, and the free-report form (shows the owner their 5 questions first, then asks for an optional email) |
| `/report/sample-001` | Sample v2 report (fictional plumbing business, fictional competitors, made-up answers). Also `sample-edge-failed` (one engine didn't respond), `sample-recheck` (before/after strip) and `sample-v1` (legacy renderer) |
| `/report/[id]` | Report page for any id — reads from `GET /api/report/[id]` |
| `/r/[code]` | Postcard short code (e.g. `/r/K7M2QX`, case/dash-insensitive) → 302 to that recipient's `/report/[token]`. Unknown code → friendly not-found page |
| `/success` | Post-payment page. If checkout started on a report page, waits for the webhook and links back to the unlocked report |
| `/about`, `/privacy`, `/contact`, `/terms`, `/refunds` | Static info pages. Footer on every page carries the mailing address (120 Terminal Drive, Plainview, NY 11803) |
| `/unsubscribe`, `/stop` | Opt-out. `GET ?t=<token>` from email links, `POST` with `List-Unsubscribe=One-Click` (RFC 8058) from mail clients, the on-page email form, or the postcard code (`/stop` form, or `GET /stop?c=CODE`). Writes to the `unsubscribes` table; a token row suppresses that business for mail and email |
| `/robots.txt` | Disallows `/report/`, `/r/`, `/success`, `/unsubscribe`, `/stop`, `/api/`; points at `/sitemap.xml` |
| `POST /api/request` | Landing-page form (JSON or form post). Step 1 writes a `report_requests` row with no email and returns its `id`; step 2 sends `{request_id, email}` and the email is attached through the `attach_report_request_email()` RPC (falls back to a fresh row with the email) |
| `GET /api/questions` | `?trade=&town=&zip=&state=` → the exact 5 questions the scanner would ask, the 5 assistants, and the search count. No DB, no keys |
| `GET /api/health` | Config check: yes/no per setting and key, never a value |
| `/admin` | Business dashboard (money in/out, scans, engine value, funnel, MVP gates, activity, add expense, run scan). Sign in with `ADMIN_TOKEN`; `noindex`, blocked in robots.txt. See "Admin dashboard" below |
| `GET /api/admin/ping`, `POST /api/admin/scan`, `GET /api/admin/scan/:id` | Scanner admin API: session cookie or `Authorization: Bearer <ADMIN_TOKEN>`; 404 when `ADMIN_TOKEN` is unset. `scan` starts a background Workflow and returns `{ scanId, instanceId, statusUrl }` at once; `scan/:id` returns status + progress (calls done/total, cost so far, errors). `?sync=1` runs a tiny inline test only (one engine, `questions` ≤ 2) |
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

## Admin dashboard and background scans

- **Sign in:** `/admin`, paste `ADMIN_TOKEN`. Sets an HttpOnly, Secure, SameSite=Strict session cookie (HMAC-signed with a key derived from `ADMIN_TOKEN`, 12 h). Rotating `ADMIN_TOKEN` signs everyone out. Every POST needs a same-origin `Origin` header. Code: `src/admin/`.
- **Scans run as a Cloudflare Workflow** (`src/scan-workflow.js`, binding `SCAN_WORKFLOW`): setup → one step per engine × question × run (each writes its `scan_raw` row with cost right away) → one step per extractor call (writes a `scan_usage` row with tokens and cost) → build + validate + save the report (saved only if valid) → finalize (totals into `scans`). A failed call that cost nothing (429 / 5xx / network) is retried by the Workflow; a billed call is never repeated.
- **Workers Paid ($5/mo) is required** for real scans: the Free plan allows 10 ms CPU per step and 50 subrequests per invocation, and a full scan makes 60–110 subrequests.
- **Data:** run [`supabase/admin_v3.sql`](supabase/admin_v3.sql) after `scan_v2.sql`. It adds `scans`, `scan_usage`, `expenses` and the views `v_scan_costs`, `v_engine_value`, `v_money`, `v_kpis`, `v_funnel`, `v_mvp_gates`, all service-key only (RLS on, no anon/authenticated grants). The dashboard reads them with `SUPABASE_SERVICE_KEY`, server-side only.
- **Money rules:** spent = metered API cost (`scan_raw` + `scan_usage`) + expenses except `api_topup`; earned = `payments` where `livemode`; API credit top-ups are shown as cash out but not added to spent (the metered cost already counts what they paid for).
- **Local dry run:** put `ADMIN_TOKEN=<anything>` and `SCANNER_DRY_RUN=1` in `.dev.vars`, run `npm run dev`, sign in at `http://localhost:8787/admin` and start a scan. Engine answers come from `scanner/test/fixtures/engines/`, the extractor is canned, nothing is stored and nothing costs money. The flag is ignored unless the request comes from localhost; never set it on Cloudflare.

## Local dev

Requires Node 18+ and a free Cloudflare account (only needed for actual deploy, not for building).

```bash
cd ai-found-score-site
npm install
npm run dev        # serves at http://localhost:8787
npm run check      # syntax check + sample-report guardrail lint
npm test           # scanner, extractor and outreach tests (node --test) + sample lint
```

`npm run dev` reads `.dev.vars` for env vars if present (see below). It is git-ignored — never commit secrets.

## Env vars (all via Worker env — never in code)

| Var | Used by | Status |
|---|---|---|
| `SUPABASE_URL` | `src/lib/db.js` | In `wrangler.jsonc` `vars` (not secret). Don't set it in the dashboard: `wrangler deploy` replaces dashboard Text vars with the config file |
| `SUPABASE_ANON_KEY` | `src/lib/db.js` | The project's **publishable** key (`sb_publishable_...`, Supabase → Project Settings → API Keys). Add as a Worker secret |
| `STRIPE_WEBHOOK_SECRET` | `POST /api/stripe-webhook` | **Not yet available — add when the Stripe webhook is created** |
| `ADMIN_TOKEN` | `/api/admin/*` | Long random string, Worker secret. Unset = admin routes return 404 |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` | Scanner engines + extractor (`scanner/config.js`, which also accepts common alternate names) | Worker secrets |
| `SUPABASE_SERVICE_KEY` | Scanner writes (`scan_raw`, `scan_results`, `scans`, `scan_usage`) and every `/admin` read | Worker secret. Never sent to the browser |
| `SCANNER_DRY_RUN` | Local testing only: `1` answers scans from recorded fixtures (localhost requests only) | Never set on Cloudflare |
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
2. In Stripe dashboard → Developers → Webhooks, create an endpoint pointing at `https://<your-domain>/api/stripe-webhook`, subscribe to `checkout.session.completed` and `checkout.session.async_payment_succeeded`, and copy the signing secret into the `STRIPE_WEBHOOK_SECRET` secret.
3. Replace the `#` placeholders in `public/js/config.js` with the real Stripe Payment Links and push (or redeploy).

## Wiring checklist (the things filled in later)

1. **Supabase.** Run `supabase/setup.sql`, then `supabase/scan_v2.sql`, then `supabase/admin_v3.sql`. Add `SUPABASE_ANON_KEY` as a Worker secret.
2. **Stripe payment links.** Paste the four real links into `STRIPE_LINKS` in `public/js/config.js` (keys: `snapshot`, `before_after`, `full_year`, `listing_fix`). On each Payment Link in the Stripe dashboard, set the after-payment redirect to `https://aifoundscore.com/success?tier=<key>&session_id={CHECKOUT_SESSION_ID}`. No metadata is needed: the webhook takes the tier from the amount paid (`TIER_BY_CENTS` in `src/worker.js`; update it if prices change). Business and arm come from the report token: the report page appends `client_reference_id=<report token>` and the webhook looks the rest up. Report tokens must be letters, digits, `-` or `_` (Stripe's rule for `client_reference_id`).
3. **Stripe webhook.** Endpoint `https://aifoundscore.com/api/stripe-webhook`, events `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Store its signing secret (`whsec_...`) as the runtime secret `STRIPE_WEBHOOK_SECRET`. Only paid checkouts are recorded.
4. **Postcards.** QR code and printed URL both point at `https://aifoundscore.com/r/<short_code>`; opt-out line: `aifoundscore.com/stop` + the same code.

## Notes

- Report pages are data-driven: `public/js/report.js` renders whatever `GET /api/report/[id]` returns. The shape is documented in `DATA_MODEL.md`.
- `GET /api/report/[id]` returns 404 JSON for unknown ids; the page shows a friendly "report not found" message. Real reports are `Cache-Control: private, no-store` because they change the moment they're paid for.
- The webhook returns 400 on bad signatures (Stripe won’t retry) and 500 on payment-write failures (Stripe will retry).
- Contact email used in footers: `hello@aifoundscore.com` — confirm/create this mailbox before launch.
