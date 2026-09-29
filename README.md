# AI Found Score — website

One Cloudflare Worker serving the static site, the report API, and the admin scanner routes. The scanner (`scanner/`) and the shared report checks (`shared/report-v2.js`) are bundled into the same Worker. Single deployable unit.

## What’s here

| Path | What it is |
|---|---|
| `/` | Landing page (site copy v2): hero with the sample report's headline answer, what the report shows, how it works, the ladder (free Snapshot → $49 AI Visibility Audit with the Fix Kit included and a $25 Competitor Breakdown add-on → $499 Be the Answer, a scan every month for a year; nothing listed under it), FAQ, and the free-report form (shows the owner their 3 questions first, then asks for an optional email) |
| `/report/sample-001` | Sample v2 report (fictional plumbing business, fictional competitors, made-up answers). Also `sample-edge-failed` (one engine didn't respond), `sample-recheck` (before/after strip) and `sample-v1` (legacy renderer) |
| `/report/[id]` | Report page for any id — reads from `GET /api/report/[id]` |
| `/r/[code]` | Postcard short code (e.g. `/r/K7M2QX`, case/dash-insensitive) → 302 to that recipient's `/report/[token]`. Unknown code → friendly not-found page |
| `/fix-kit/[token]` | Fix Kit page (included with the $49 audit `xray` and $499 `be_the_answer`; the retired $149 `fix_kit` still opens it): the owner checks their prefilled details, ticks "I own or manage this business", confirms, then downloads a zip (robots.txt, llms.txt, LocalBusiness schema, FAQ page, Google Business Profile text, review QR code, README). API: `GET/POST /api/fix-kit/[token]`, `GET /api/fix-kit/[token].zip` (`src/lib/fix-kit-route.js`, files from `src/lib/fix-kit.js`). Needs `supabase/v6_fix_kit.sql` and `SUPABASE_SERVICE_KEY`. `/fix-kit/sample-001` is a working demo with no database |
| `/plan/[token]` | Be the Answer page ($499, `be_the_answer`): the plan's towns (up to 3; each extra town gets its own report token in `plan_towns` and a first scan right away), the directory checklist (30+ sites with the text to paste) and 12 Google posts, both built from the details confirmed on the Fix Kit page (`src/lib/plan.js`). API: `GET/POST /api/plan/[token]` (`src/lib/plan-route.js`). Needs `supabase/v8_be_the_answer.sql`. `/plan/sample-001` is a working demo with no database |
| `/success` | Post-payment page. If checkout started on a report page, waits for the webhook and links back to the unlocked report |
| `/about`, `/privacy`, `/contact`, `/terms`, `/refunds` | Static info pages. Footer on every page carries the mailing address (120 Terminal Drive, Plainview, NY 11803) |
| `/unsubscribe`, `/stop` | Opt-out. `GET ?t=<token>` from email links, `POST` with `List-Unsubscribe=One-Click` (RFC 8058) from mail clients, the on-page email form, or the postcard code (`/stop` form, or `GET /stop?c=CODE`). Writes to the `unsubscribes` table; a token row suppresses that business for mail and email |
| `/robots.txt` | Disallows `/report/`, `/r/`, `/success`, `/unsubscribe`, `/stop`, `/api/`; points at `/sitemap.xml` |
| `POST /api/request` | Landing-page form (JSON or form post). Step 1 writes a `report_requests` row with no email and returns its `id`; step 2 sends `{request_id, email}` and the email is attached through the `attach_report_request_email()` RPC (falls back to a fresh row with the email) |
| `GET /api/questions` | `?trade=&town=&zip=&state=` → the exact 3 questions the free scan asks (`freeQuestions`, `FREE_QUESTION_COUNT` in `scanner/questions.js`). No DB, no keys |
| `GET /api/health` | Config check: yes/no per setting and key, never a value |
| `/admin` | Business dashboard (money in/out, scans, engine value, funnel, MVP gates, activity, add expense, run scan). Sign in with `ADMIN_TOKEN`; `noindex`, blocked in robots.txt. See "Admin dashboard" below |
| `GET /api/admin/ping`, `POST /api/admin/scan`, `GET /api/admin/scan/:id` | Scanner admin API: session cookie or `Authorization: Bearer <ADMIN_TOKEN>`; 404 when `ADMIN_TOKEN` is unset. `scan` starts a background Workflow and returns `{ scanId, instanceId, statusUrl }` at once; `scan/:id` returns status + progress (calls done/total, cost so far, errors). `?sync=1` runs a tiny inline test only (one engine, `questions` ≤ 2) |
| `www.` | 301 to the bare domain, path and query preserved |
| `GET /api/report/[id]` | Report JSON. Until a payment exists for the token, returns `locked: true` with fix details stripped server-side (the page blurs stand-ins). `?preview=locked` shows the sample locked |
| `POST /api/visit` | Report-page view beacon, sent after render. Arm looked up from the token; link-scanner user agents ignored. Writes `page_visits` |
| `POST /api/lead` | "Email me this report". Writes `leads` (status `new`) with the arm from the token |
| `POST /api/stripe-webhook` | Stripe webhook: verifies signature, reads `client_reference_id` (report token), looks up business + arm in `report_links`, writes `payments` |

**Checkout** is our own (`src/lib/checkout.js`, `POST /api/checkout`): the report page sends `{ token, tier, addons }`, the Worker prices it for that report and creates a Stripe Checkout Session, and the buyer pays on Stripe's hosted page. On sale (`OFFERED_TIERS` in `public/js/config.js`): the $49 audit (`xray`, with an optional $25 Competitor Breakdown checkbox), the $25 Competitor Breakdown on its own after the audit, and Be the Answer at $499 minus what that report has already paid. Every session carries `metadata.tier` and `metadata.addons`; the webhook records both. Needs `STRIPE_SECRET_KEY`; without it the buttons say checkout opens soon.

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

## Credit alerts

So an engine never silently runs dry again (Gemini's prepaid credits ran out on Sep 27 2026 and nobody knew). Code: `src/lib/alerts.js`.

- **Out:** a billing/credits error (HTTP 402, "prepayment credits are depleted", `insufficient_quota`, "credit balance is too low", …) in the last 6 h in `scan_usage`, `scan_raw` or `scans.errors`, with no successful call from that engine since. A live answer or scan that hits one emails at once; the cron re-checks.
- **Low:** DataForSEO (Google AI Mode) from its real balance, under $5. OpenAI, Anthropic, Gemini and Perplexity have no balance API, so set a budget var when you load credits: `CREDIT_BUDGET_GEMINI="20@2026-09-27"` ($20 loaded that day; also `CREDIT_BUDGET_OPENAI`, `CREDIT_BUDGET_ANTHROPIC`, `CREDIT_BUDGET_PERPLEXITY`). Remaining = budget minus the metered cost we logged since that date; low under max($5, 25%). No var → "unknown", never emailed. Update the var each time you top up.
- **Who:** `ALERT_EMAILS` in `wrangler.jsonc` vars (comma-separated). Sent through Resend (`RESEND_API_KEY`), at most one email per engine, state and day.
- **/admin** shows the same check as a red (out) or amber (low) banner at the top.

## Two paths: free and paid

- **Free** (default, "Show me who's getting my calls"): business details → one live answer → the owner's report page (`/report/<token>`) as the main next step; email is optional ("Want the link by email too?") and gets a "we got it" email with the link at once (`requestReceivedEmail`), then "report ready".
- **Paid** ("Get my audit" / "Be the answer" on the pricing cards, or `/?plan=audit#request`, `/?plan=be_the_answer#request`): the same three fields, then straight to Stripe. `POST /api/request` with `intent: 'xray' | 'be_the_answer'` queues the free scan (reason `paid-intent`) instead of starting it; `POST /api/checkout { token, tier, prepay: true }` sells the audit or plan at full price before any report exists. The webhook starts the paid scan from the queued row's business, as usual. Stripe's cancel link is `/api/checkout/cancel?t=<token>`, which starts the free report (AUTO_SCAN on) and shows it; a checkout left open without paying gets its free report from the recovery cron after 60 minutes.

## Recovery cron (every 30 minutes)

`wrangler.jsonc` has two crons: the daily one (re-checks, monthly scans) and `*/30 * * * *`, which runs `retryFailedScans` (`src/lib/auto-scan.js`) then `sendCreditAlerts` (`src/lib/alerts.js`). A failed request scan (or one whose report failed the guardrails) is retried once when AUTO_SCAN is on; a failed paid scan is retried once always. After two tries the report page says something went wrong instead of "in line" forever.

## Free-report requests: automatic scans (AUTO_SCAN)

Code: `src/lib/auto-scan.js` (called from `src/lib/report-request.js`). Needs [`supabase/v4_ladder.sql`](supabase/v4_ladder.sql) applied first, and `SUPABASE_SERVICE_KEY`.

- Every new request that passes Turnstile gets a report link at once: `POST /api/request` returns `{ ok, id, report_url: "/report/<token>" }` (token: 22 random characters, `[A-Za-z0-9_-]`), and a `scans` row (`trigger` `request`) is written for it. `report_url` is `null` when no link could be made (bot check not configured, no service key, a database error); the request is saved either way. A no-JS form post is redirected to the link.
- **`AUTO_SCAN=on`**: the Worker starts a `ScanWorkflow` for it right away (every engine with a key, 1 run, 3 questions). Anything else (unset, `off`): the row is `queued` and waits for **Run now** in `/admin` (section "Free-report requests waiting").
- **Brakes** (a request that trips one is queued, never dropped; the owner keeps the link): same business name + ZIP within 7 days → nothing new runs, and the request gets its OWN new link (never the earlier one: anyone can type a business name and ZIP, and that link may be paid for): a locked copy of the finished report, or a queued "duplicate" row while it is not ready; per-IP `REQUEST_LIMITER` (bucket `autoscan`); daily caps over today's (UTC) automatic scans, `AUTO_SCAN_DAILY_MAX` (default 25) and `AUTO_SCAN_DAILY_USD` (default 20). The caps use reserve-then-verify (the row is written with its estimated cost first, then today's rows are re-read), so racing requests can't overshoot.
- **The report page while it's being made:** `GET /api/report/<token>` answers `202 {"status":"running"|"queued"}` until the report is saved; `/report/<token>` shows "We're asking the AI assistants now…" (or the queued wording) and re-checks every 30 seconds. A failed scan or a report that didn't pass the guardrails shows as queued: it waits for a person (Run now makes a fresh scan under the same link).
- **Local test:** `npx wrangler dev --var SCANNER_DRY_RUN:1 --var AUTO_SCAN:on --var TURNSTILE_SITE_KEY:1x00000000000000000000AA --var TURNSTILE_SECRET_KEY:1x0000000000000000000000000000000AA`, then POST the form with `cf-turnstile-response: XXXX.DUMMY.TOKEN.XXXX`. The scan answers from the fixtures, nothing is stored, and the link shows "in progress" until the workflow finishes (then "isn't ready yet", since a dry run stores no report).

## Be the Answer and the Competitor Breakdown

Apply [`supabase/v8_be_the_answer.sql`](supabase/v8_be_the_answer.sql) after `v7_email.sql`: it adds the `monthly` scan trigger, `plan_towns`, and a `report_unlocked()` that ignores a $25 Competitor Breakdown payment on its own and unlocks a plan's town reports.

- **Monthly re-scans:** the daily cron runs the 30-day re-check, then `startDueMonthly` (`src/lib/auto-scan.js`): for each live Be the Answer payment, month 1..12 counted from the payment, a full scan of the plan's report and each extra town, once per month (skipped when that report was scanned in the last 20 days). Scans run as the `ScanWorkflow`, so this needs Workers Paid.
- **Monthly email** (`monthlyEmail`, `src/lib/notify.js`): what changed since the last scan, an alert when the business AI names most is a new one, and the next 3 fixes. Be the Answer buyers get it for the 30-day re-check too, instead of the Be the Answer pitch. A town's email goes to the plan's buyer.
- **Competitor Breakdown** (`buildCompetitorBreakdown`, `shared/report-v2.js`): a scorecard of what the top 3 competitors show that the owner does not, with a do-these-first list, built at serve time from the report's own data. Served on a report paid for `competitor_breakdown` or `be_the_answer` (and on the sample); never on a locked report.
- **Fix Kit zip** for a plan also carries `directory-checklist.txt` and `google-posts.txt`.

## Refunds

The promises are on `/refunds` (`public/refunds.html`): $49 audit, fewer than 3 business-specific problems → $49 back (30 days); $25 Competitor Breakdown, not delivered as described → $25 back (30 days); Be the Answer, not useful in the first 60 days → full refund. Owners ask by replying to their receipt or emailing us; a person refunds in the Stripe dashboard.

The webhook then does the rest (`src/lib/refunds.js`, needs `supabase/v9_refunds.sql` and the `charge.refunded` / `charge.dispute.closed` events):

- **Full refund or lost dispute:** the payment gets `revoked_at`. It no longer unlocks the report, the Fix Kit or the Be the Answer plan and its towns, no 30-day re-check or monthly scan starts for it, it no longer counts as credit at checkout, and the token's open `refund_requests` rows are marked `refunded`.
- **Partial refund of exactly $25** on a checkout that included the Competitor Breakdown: the add-on is removed, the audit stays.
- **Any other partial refund:** recorded (`refunded_cents`), access kept.
- **Money:** `v_money` counts a refund as money out on the day it was made; `channel_funnel` revenue is net of refunds.
- A refund for a payment recorded before v9 (no `stripe_payment_intent`) is only logged: set `revoked_at` on that row by hand.

`refund_requests` (`supabase/v4_ladder.sql`; id, report_token, email, reason, created_at, status open | refunded | declined; service key only) has no public form. `/admin` lists the rows with a "Find in Stripe" link (dashboard search by email, else report token).

## Homepage real AI answer card (showcase)

The hero shows one real, dated AI answer to "What's the best <trade> in <town>, <ST>?" for the visitor's town (else Massapequa) and trade (`?trade=roofer` from an ad or link, else plumber). The card has a picker for the other trades. Code: `src/lib/showcase.js` (Worker, renders the card into `<div data-showcase>`, cached 1 h) and `scanner/showcase.js` (asks the questions from this PC). Until rows exist the static Mega Wash & Dry card in `public/index.html` stays.

1. Apply [`supabase/showcase_v5.sql`](supabase/showcase_v5.sql) once.
2. Weekly: `node scanner/showcase.js --towns "Massapequa,NY,11758;Hicksville,NY,11801"` (default: Massapequa, all 8 trades, the first of ChatGPT/Claude/Gemini with a key; about 3-4 cents per answer, logged to `scan_usage` so /admin shows it). `--estimate` prints the cost; `--dry-run` uses the fixtures and stores nothing.
3. It prints each excerpt. The excerpt is the start of the answer word for word (markdown links removed), cut at a sentence end, ~60 words, and stopped before any phone number or street address. An answer that names no business is skipped.
4. Takedown ("remove my business"): set that row's `active` to false in Supabase. The weekly refresh never turns it back on.

## Website and Google listing checks

Every report build (`scanner/extract/build.js`) runs `scanner/owner-checks.js` first:
- **Website** (no key): robots.txt (which AI crawlers are blocked), sitemap, schema.org business markup, and the phone and address the site shows. Fills `business.facts` when the owner didn't give them, so AI facts get compared too.
- **Google listing** (`GOOGLE_PLACES_API_KEY`, Places API (New) Text Search): name, phone and address compared with the website. Set the key as a Worker secret and in `.dev.vars` for PC scans; without it the Google check is skipped.
- Findings become fixes (`site_blocks_ai`, `site_missing_nap`, `google_missing`, `listing_differs`), the report's listings section and a "Can AI read your website?" section.

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
| `STRIPE_SECRET_KEY` | `POST /api/checkout` (creates Checkout Sessions) | Worker secret. A restricted key with write access to Checkout Sessions is enough. `sk_test_`/`rk_test_` for sandbox |
| `STRIPE_WEBHOOK_SECRET` | `POST /api/stripe-webhook` | **Required before taking payments.** Worker secret: the live endpoint's signing secret (`whsec_...`). Without it every webhook is rejected and no payment unlocks anything |
| `ADMIN_TOKEN` | `/api/admin/*` | Long random string, Worker secret. Unset = admin routes return 404 |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` | Scanner engines + extractor (`scanner/config.js`, which also accepts common alternate names) | Worker secrets |
| `SUPABASE_SERVICE_KEY` | Scanner writes (`scan_raw`, `scan_results`, `scans`, `scan_usage`) and every `/admin` read | Worker secret. Never sent to the browser |
| `SCANNER_DRY_RUN` | Local testing only: `1` answers scans from recorded fixtures (localhost requests only) | Never set on Cloudflare |
| `AUTO_SCAN` | `on` starts a scan for every verified free-report request (`src/lib/auto-scan.js`) | Plain var. Unset/`off` = requests are queued for Run now in `/admin`. Apply `supabase/v4_ladder.sql` first |
| `AUTO_SCAN_DAILY_MAX`, `AUTO_SCAN_DAILY_USD` | Daily caps on automatic scans (count, dollars; UTC day) | Optional plain vars; defaults 25 and 20 |
| `STRIPE_WEBHOOK_SECRET_TEST` | `POST /api/stripe-webhook` | Optional. Signing secret of the Stripe **sandbox** webhook; accepted only for `livemode: false` events. Sandbox payments are stored with `payments.livemode = false` and excluded from `channel_funnel`. Delete once live testing is done |
| `TURNSTILE_SITE_KEY` | Free-report form bot check (`src/lib/turnstile.js`) | Public. In `wrangler.jsonc` `vars`; the Worker writes it into the homepage. See **Bot protection** |
| `TURNSTILE_SECRET_KEY` | `POST /api/request` Siteverify | Worker secret: `npx wrangler secret put TURNSTILE_SECRET_KEY`. See **Bot protection** |
| `RESEND_API_KEY` | Every email: receipts, "report ready", re-checks, monthly, credit alerts (`src/lib/email.js`) | Worker secret. **Required before taking payments** (no key = no receipts). The sending domain `mail.aifoundscore.com` must be verified in Resend |
| `EMAIL_FROM` | Sender of every email | Optional plain var; default `AI Found Score <reports@mail.aifoundscore.com>` |
| `SITE_URL` | Links in emails; Stripe's success/cancel URLs | Optional plain var; default `https://aifoundscore.com` (checkout falls back to the request's origin) |
| `GOOGLE_PLACES_API_KEY` | Google listing, reviews and competitor reviews in the scan (`scanner/owner-checks.js`) | Worker secret. Unset = those checks are skipped |
| `PAGESPEED_API_KEY` | Mobile speed score | Optional; falls back to the Places key (enable the PageSpeed Insights API on its project) |
| `ALERT_EMAILS`, `CREDIT_BUDGET_*` | Engine credit alerts (see **Credit alerts**) | Plain vars in `wrangler.jsonc` |
| `RECHECK_SCAN` | `off` stops the daily 30-day re-checks and Be the Answer monthly scans | Optional plain var; set `off` only in previews |
| `LIVE_PREVIEW_DAILY_USD` | Global daily spend cap on the homepage live answer | Optional; default 1.00, 0 turns previews off |
| `PROOF_MIN_SCANS` | Scans needed before the homepage shows its proof numbers | Optional; default 20 |
| `OPENAI_MODEL`, `GEMINI_MODEL`, `PERPLEXITY_MODEL`, `CLAUDE_MODEL`, `EXTRACT_MODEL`, `EXTRACT_EFFORT` | Model overrides (`scanner/config.js` `DEFAULT_MODELS`) | Optional |

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
4. Deploy, then check `https://aifoundscore.com/api/health` shows `"turnstile": true`. The same page shows every other setting as true/false (never the values): `stripeMode` should read `live`, and `stripeWebhookSecret`, `supabaseServiceKey`, `resendKey` and `adminToken` should be `true`.

Local dev uses Cloudflare's test keys (always pass), without touching `.dev.vars`:

```bash
npx wrangler dev --var TURNSTILE_SITE_KEY:1x00000000000000000000AA --var TURNSTILE_SECRET_KEY:1x0000000000000000000000000000000AA
```

Without JavaScript the widget can't run, so once the check is on, the no-JS form fallback lands on the "email us" notice.

## Deploy to Cloudflare

Two ways: manual (`npm run deploy`) or auto-deploy from GitHub (recommended — every push goes live).

### Push to GitHub

The code lives at `github.com/BF8thRev/ai-found-score`.

### Connect Cloudflare for auto-deploys

1. In the Cloudflare dashboard, go to **Workers & Pages** → **Create** → **Connect to Git**.
2. Authorize the GitHub account and select the repo.
3. Project name: `ai-found-score`. Framework preset: **None**.
4. Build command: `npm ci && npm test` (a failing test stops the deploy; the site keeps the last good version). Deploy command: `npx wrangler deploy`. Branch control: `master` only.
5. Root directory: the repo root (this folder is the repo root).
6. Under **Settings → Variables and Secrets**, add the secrets from the env var table above: `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `TURNSTILE_SECRET_KEY`, `ADMIN_TOKEN`, `GOOGLE_PLACES_API_KEY` and the engine keys. `SUPABASE_URL` lives in `wrangler.jsonc`. Secrets set here are available to every deployment.
7. Save — Cloudflare deploys on every push to `master` from now on.

Connected since Sep 2026 (Workers Builds). Every change goes through a PR into `master`; merging it is the deploy. Each build shows as the **Workers Builds: ai-found-score** check on the merge commit. No check on a merge commit means Cloudflare missed it: retry the build under the Worker's **Deployments**, or merge the next PR.

Manual deploy still works anytime: `npm run deploy` (needs `npx wrangler login` first).

### After the first deploy

1. In the Cloudflare dashboard, add a custom domain (e.g. `aifoundscore.com`) to the Worker.
2. In Stripe dashboard → Developers → Webhooks, create an endpoint pointing at `https://<your-domain>/api/stripe-webhook`, subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded` and `charge.dispute.closed`, and copy the signing secret into the `STRIPE_WEBHOOK_SECRET` secret.
3. Make one real $49 purchase end to end (report unlocks, receipt arrives, full scan starts), then refund it in Stripe and check the report locks again.

## Wiring checklist (the things filled in later)

1. **Supabase.** Run, in this order: `setup.sql`, `scan_v2.sql`, `admin_v3.sql`, `v4_ladder.sql`, `v5_paid_scan.sql`, `showcase_v5.sql`, `v6_fix_kit.sql`, `v7_email.sql`, `v8_be_the_answer.sql`, `v9_refunds.sql` (all in `supabase/`, all safe to re-run). `v9_refunds.sql` must be applied **before** deploying a Worker that includes the refund handling: every payments read filters on its `revoked_at` column. Add `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_KEY` as Worker secrets.
2. **Stripe checkout.** Checkout is our own (`POST /api/checkout`, `src/lib/checkout.js`, Stripe Checkout Sessions in payment mode). Add `STRIPE_SECRET_KEY` as a Worker secret; prices live in `PRICES` in `src/lib/checkout.js`. Nothing goes in `public/js/config.js` except which plans are on sale (`OFFERED_TIERS`).
3. **Stripe webhook.** Endpoint `https://aifoundscore.com/api/stripe-webhook`, events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded` and `charge.dispute.closed`. Store its signing secret (`whsec_...`) as the runtime secret `STRIPE_WEBHOOK_SECRET`. Only paid checkouts are recorded; a full refund or a lost dispute takes access back (see **Refunds**).
4. **Postcards.** QR code and printed URL both point at `https://aifoundscore.com/r/<short_code>`; opt-out line: `aifoundscore.com/stop` + the same code.

## Notes

- Report pages are data-driven: `public/js/report.js` renders whatever `GET /api/report/[id]` returns. The shape is documented in `DATA_MODEL.md`.
- `GET /api/report/[id]` returns 404 JSON for unknown ids; the page shows a friendly "report not found" message. Real reports are `Cache-Control: private, no-store` because they change the moment they're paid for.
- The webhook returns 400 on bad signatures (Stripe won’t retry) and 500 on payment-write failures (Stripe will retry).
- Contact email used in footers: `hello@aifoundscore.com` — confirm this mailbox receives mail before launch (email replies go to `hello@getaifoundscore.com`, `src/lib/email.js` `REPLY_TO`).
