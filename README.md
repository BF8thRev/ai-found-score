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

## Free-report requests: automatic scans (AUTO_SCAN)

Code: `src/lib/auto-scan.js` (called from `src/lib/report-request.js`). Needs [`supabase/v4_ladder.sql`](supabase/v4_ladder.sql) applied first, and `SUPABASE_SERVICE_KEY`.

- Every new request that passes Turnstile gets a report link at once: `POST /api/request` returns `{ ok, id, report_url: "/report/<token>" }` (token: 22 random characters, `[A-Za-z0-9_-]`), and a `scans` row (`trigger` `request`) is written for it. `report_url` is `null` when no link could be made (bot check not configured, no service key, a database error); the request is saved either way. A no-JS form post is redirected to the link.
- **`AUTO_SCAN=on`**: the Worker starts a `ScanWorkflow` for it right away (every engine with a key, 1 run, 5 questions). Anything else (unset, `off`): the row is `queued` and waits for **Run now** in `/admin` (section "Free-report requests waiting").
- **Brakes** (a request that trips one is queued, never dropped; the owner keeps the link): same business name + ZIP within 7 days → nothing new runs, and the request gets its OWN new link (never the earlier one: anyone can type a business name and ZIP, and that link may be paid for): a locked copy of the finished report, or a queued "duplicate" row while it is not ready; per-IP `REQUEST_LIMITER` (bucket `autoscan`); daily caps over today's (UTC) automatic scans, `AUTO_SCAN_DAILY_MAX` (default 25) and `AUTO_SCAN_DAILY_USD` (default 20). The caps use reserve-then-verify (the row is written with its estimated cost first, then today's rows are re-read), so racing requests can't overshoot.
- **The report page while it's being made:** `GET /api/report/<token>` answers `202 {"status":"running"|"queued"}` until the report is saved; `/report/<token>` shows "We're asking the AI assistants now…" (or the queued wording) and re-checks every 30 seconds. A failed scan or a report that didn't pass the guardrails shows as queued: it waits for a person (Run now makes a fresh scan under the same link).
- **Local test:** `npx wrangler dev --var SCANNER_DRY_RUN:1 --var AUTO_SCAN:on --var TURNSTILE_SITE_KEY:1x00000000000000000000AA --var TURNSTILE_SECRET_KEY:1x0000000000000000000000000000000AA`, then POST the form with `cf-turnstile-response: XXXX.DUMMY.TOKEN.XXXX`. The scan answers from the fixtures, nothing is stored, and the link shows "in progress" until the workflow finishes (then "isn't ready yet", since a dry run stores no report).

## Refund requests

`refund_requests` (`supabase/v4_ladder.sql`; id, report_token, email, reason, created_at, status open | refunded | declined; service key only) backs the X-Ray promise "If we can't show you 3 things to fix, it's free." There is no public form yet. `/admin` lists the rows with a "Find in Stripe" link (dashboard search by email, else report token). Refunds are made by a person in Stripe; then set the row's status in Supabase.

## Homepage real AI answer card (showcase)

The hero shows one real, dated AI answer to "What's the best <trade> in <town>, <ST>?" for the visitor's town (else Massapequa) and trade (`?trade=roofer` from an ad or link, else plumber). The card has a picker for the other trades. Code: `src/lib/showcase.js` (Worker, renders the card into `<div data-showcase>`, cached 1 h) and `scanner/showcase.js` (asks the questions from this PC). Until rows exist the static Mega Wash & Dry card in `public/index.html` stays.

1. Apply [`supabase/showcase_v5.sql`](supabase/showcase_v5.sql) once.
2. Weekly: `node scanner/showcase.js --towns "Massapequa,NY,11758;Hicksville,NY,11801"` (default: Massapequa, all 8 trades, the first of ChatGPT/Claude/Gemini with a key; about 3-4 cents per answer, logged to `scan_usage` so /admin shows it). `--estimate` prints the cost; `--dry-run` uses the fixtures and stores nothing.
3. It prints each excerpt. The excerpt is the start of the answer word for word (markdown links removed), cut at a sentence end, ~60 words, and stopped before any phone number or street address. An answer that names no business is skipped.
4. Takedown ("remove my business"): set that row's `active` to false in Supabase. The weekly refresh never turns it back on.

## Running scans from your PC (Free plan)

On the Workers Free plan a full scan can't run on Cloudflare (10 ms CPU, 50 subrequests per invocation). Until that changes, run scans from Node on your own PC: `scanner/run.js` does exactly what the Workflow does (same `scans` / `scan_raw` / `scan_usage` / `scan_results` rows, same row ids, same report gate), so `/admin` and `/report/<token>` show the results as if the Workflow had run. No hosting cost; you pay only the API calls.

1. In the repo root, create `.dev.vars` (git-ignored; same `KEY=value` file `wrangler dev` reads). Environment variables override it.
   ```
   SUPABASE_URL=https://bahmemiydzpotfrxmlzw.supabase.co
   SUPABASE_SERVICE_KEY=        # service/secret key: the runner writes the scan tables
   ANTHROPIC_API_KEY=           # Claude engine AND the extractor (required)
   OPENAI_API_KEY=              # ChatGPT
   GEMINI_API_KEY=              # Gemini
   ```
   An engine without a key is dropped before the scan starts (not called, not charged); its column is left off the report, which names it as not answering.
2. Write the business as JSON (`name`, `trade`, `address`, `town`, `state`, `zip`, `phone`, `website`, optional `nearbyTown`, `id`). See `scanner/examples/sample-business.json`.
3. Run:
   ```bash
   npm run scan -- --business biz.json --estimate    # keys found/missing + cost estimate, spends nothing
   npm run scan -- --business biz.json               # asks "Proceed? [y/N]", then scans and stores
   npm run scan -- --business biz.json --dry-run --yes   # fixtures + in-memory store: no network, no cost
   ```
   Options: `--engines chatgpt,claude,gemini` (default: `ACTIVE_ENGINES` in `scanner/config.js`), `--runs 1`, `--token <reportToken>` (default: a fresh random token), `--notes "..."`, `--yes`.
   It prints each call as it lands, then answers / named / named first, cost per engine, extraction cost, total, and the report URL (`https://aifoundscore.com/report/<token>`, saved only if the report passes validation; otherwise the validation errors).
4. If a run dies part way (closed laptop, network), resume it: `npm run scan -- --business biz.json --resume <scanId>`. Calls already stored ok are reused and not paid again; every answer is extracted again (those extractor calls are billed again and recorded as new `scan_usage` rows).

**Upgrade path:** when scans must start from the web (the `/admin` Run-scan form, customer requests), switch to Workers Paid ($5/mo) and use the Workflow (`src/scan-workflow.js`). Both paths share their helpers (`src/admin/scan-core.js`), so their rows stay identical.

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
| `AUTO_SCAN` | `on` starts a scan for every verified free-report request (`src/lib/auto-scan.js`) | Plain var. Unset/`off` = requests are queued for Run now in `/admin`. Apply `supabase/v4_ladder.sql` first |
| `AUTO_SCAN_DAILY_MAX`, `AUTO_SCAN_DAILY_USD` | Daily caps on automatic scans (count, dollars; UTC day) | Optional plain vars; defaults 25 and 20 |
| `STRIPE_WEBHOOK_SECRET_TEST` | `POST /api/stripe-webhook` | Optional. Signing secret of the Stripe **sandbox** webhook; accepted only for `livemode: false` events. Sandbox payments are stored with `payments.livemode = false` and excluded from `channel_funnel`. Delete once live testing is done |
| `TURNSTILE_SITE_KEY` | Free-report form bot check (`src/lib/turnstile.js`) | Public. In `wrangler.jsonc` `vars`; the Worker writes it into the homepage. See **Bot protection** |
| `TURNSTILE_SECRET_KEY` | `POST /api/request` Siteverify | Worker secret: `npx wrangler secret put TURNSTILE_SECRET_KEY`. See **Bot protection** |

For local dev, create `.dev.vars` (git-ignored):

```
SUPABASE_URL=https://bahmemiydzpotfrxmlzw.supabase.co
SUPABASE_ANON_KEY=
STRIPE_WEBHOOK_SECRET=
```

## Bot protection

The free-report form (`POST /api/request`) is checked with Cloudflare Turnstile (invisible unless Cloudflare wants a click). The Worker verifies each new request with Siteverify (action `free_report`, hostname must be the site's own) before saving it; attaching an email to an already-verified request needs no second check. `POST /api/request` and `GET /api/questions` are also limited to 20 calls a minute per IP (the `REQUEST_LIMITER` rate-limit binding in `wrangler.jsonc`); over that the page shows "Too many tries…".

**Until both keys below are set, the check is off**: the page shows no widget, the Worker saves requests as before and logs one warning. `GET /api/health` shows `"turnstile": true` once it is on.

Owner steps:

1. Cloudflare dashboard → **Turnstile** → **Add widget**. Hostnames `aifoundscore.com` and `www.aifoundscore.com` (add `localhost` only if you want to test the real widget locally). Widget mode **Managed**.
2. Copy the **site key** into `TURNSTILE_SITE_KEY` in `wrangler.jsonc` `vars` (or send it to whoever deploys). It is public.
3. Store the **secret key** as a Worker secret (it never goes in a file): `npx wrangler secret put TURNSTILE_SECRET_KEY`
4. Deploy, then check `https://aifoundscore.com/api/health` shows `"turnstile": true`.

Local dev uses Cloudflare's test keys (always pass), without touching `.dev.vars`:

```bash
npx wrangler dev --var TURNSTILE_SITE_KEY:1x00000000000000000000AA --var TURNSTILE_SECRET_KEY:1x0000000000000000000000000000000AA
```

Without JavaScript the widget can't run, so once the check is on, the no-JS form fallback lands on the "email us" notice.

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

1. **Supabase.** Run `supabase/setup.sql`, then `supabase/scan_v2.sql`, then `supabase/admin_v3.sql`, then `supabase/v4_ladder.sql`, then `supabase/showcase_v5.sql`. Add `SUPABASE_ANON_KEY` as a Worker secret.
2. **Stripe payment links.** Paste the four real links into `STRIPE_LINKS` in `public/js/config.js` (keys: `snapshot`, `before_after`, `full_year`, `listing_fix`). On each Payment Link in the Stripe dashboard, set the after-payment redirect to `https://aifoundscore.com/success?tier=<key>&session_id={CHECKOUT_SESSION_ID}`. No metadata is needed: the webhook takes the tier from the amount paid (`TIER_BY_CENTS` in `src/lib/stripe.js`: 4900 → `xray`, the $49 AI Visibility X-Ray; the retired $29/$59/$69/$199 keys stay so an old payment still records; update it if prices change). Any recorded payment for a report token unlocks that whole report, X-Ray sections included. Business and arm come from the report token: the report page appends `client_reference_id=<report token>` and the webhook looks the rest up. Report tokens must be letters, digits, `-` or `_` (Stripe's rule for `client_reference_id`).
3. **Stripe webhook.** Endpoint `https://aifoundscore.com/api/stripe-webhook`, events `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Store its signing secret (`whsec_...`) as the runtime secret `STRIPE_WEBHOOK_SECRET`. Only paid checkouts are recorded.
4. **Postcards.** QR code and printed URL both point at `https://aifoundscore.com/r/<short_code>`; opt-out line: `aifoundscore.com/stop` + the same code.

## Notes

- Report pages are data-driven: `public/js/report.js` renders whatever `GET /api/report/[id]` returns. The shape is documented in `DATA_MODEL.md`.
- `GET /api/report/[id]` returns 404 JSON for unknown ids; the page shows a friendly "report not found" message. Real reports are `Cache-Control: private, no-store` because they change the moment they're paid for.
- The webhook returns 400 on bad signatures (Stripe won’t retry) and 500 on payment-write failures (Stripe will retry).
- Contact email used in footers: `hello@aifoundscore.com` — confirm/create this mailbox before launch.
