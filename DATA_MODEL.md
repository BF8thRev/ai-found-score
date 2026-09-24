# AI Found Score — data model

Two report shapes are served by `GET /api/report/[id]`. `public/js/report.js` picks the renderer by `version`:

- **v2** (`version: 2`) — the searched-answers report built by the scanner (`scanner/`) and the extractor (`scanner/extract/`). Current.
- **v1** (no `version`, or `version: 1`) — the original score report. **Legacy**; still renders exactly as before.

Samples live in `src/mock/` (fictional businesses only, example.com sites): `sample-001` (v2, the site's sample link: 5 questions × 5 assistants × 1 run = 25 searches), `sample-edge-failed` (v2, Gemini didn't respond: 20 searches, the page names Gemini), `sample-recheck` (sample-001 with a `baseline`, for the before/after strip), `sample-v1` (legacy). `build-sample.js` derives every count from the answer text and throws unless the grid is complete (one answer per question × engine × run). `node src/mock/lint-samples.js` checks all of them.

**Searches vs answers.** A *search* is one question asked on one assistant. The default is 5 questions × 5 assistants (ChatGPT, Claude, Gemini, Google AI Mode, Perplexity) × 1 run = **25 searches**, one answer each. The page's wording comes from the data (`countWords()` in `report.js`): with `method.runs` = 1 it counts "searches" ("16 of 25 searches named you"); with runs > 1 it counts answers and says so ("50 answers from 25 searches"). A failed engine lowers the count (4 assistants → 20 searches).

## Report JSON v2

Source of truth: `docs/BUILD_PLAN.md` ("Report data model v2") and `docs/CONTRACT_V2.md`. Guardrail checks live in `shared/report-v2.js` (`validateReport`).

```jsonc
{
  "id": "k7m2qx",                       // public token (/report/[id])
  "version": 2,
  "sample": true,                       // fictional samples only
  "generatedAt": "2026-09-23T14:19:00-04:00",
  "business": { "name": "...", "trade": "plumber", "address": "...", "town": "Massapequa", "state": "NY",
                "zip": "11758", "phone": "...", "website": "..." },
  "questions": [ { "id": "q1", "intent": "best", "text": "What's the best plumber in Massapequa, NY?" } ],
                                        // intents: best | urgent | job | trust | price
  "answers": [ {                        // one per successful engine call; failed engines are NOT here
    "id": "a1", "questionId": "q1", "intent": "best", "engine": "chatgpt", "run": 1,   // run: positive integer
    "askedAt": "2026-09-23T18:04:00.000Z",
    "text": "<full answer, verbatim>",
    "businessesNamed": [                // in order of position; name === text.slice(pos, pos + name.length)
      { "name": "Tidewater Plumbing Co.", "pos": 62, "entityId": "e1" },
      { "name": "Harborview Plumbing & Heating", "pos": 140, "entityId": null, "isYou": true }
    ],
    "namedYou": false,                  // confirmed owner match only
    "namedYouFirst": false,             // owner is the earliest business named
    "ownerMatch": "unsure",             // optional; unsure matches are not counted
    "citations": [ { "domain": "localpages.example.com", "url": "https://..." } ]  // from API citation data only
  } ],
  "entities": [ {                       // competitors; the owner is not an entity
    "id": "e1", "name": "Tidewater Plumbing Co.", "aliases": [], "phone": null,
    "named": 22, "first": 17, "answerIds": ["a1", "a2"]   // shown only when named >= 2
  } ],
  "totals": { "answers": 25, "namedYou": 16, "firstYou": 6 },   // must equal a recount of answers
  "headline": { "answerId": "a1", "rule": "most_others_named_not_you" },  // or "best_named_you"
  "sources": [ {
    "domain": "localpages.example.com", "url": "https://...", "citedIn": ["a1", "a7"],
    "youListed": false,                 // true | false | null (not checked)
    "youPosition": null,                // null or a positive integer (1 = listed first)
    "topListed": "Tidewater Plumbing Co."
  } ],
  "aiFacts": [ {                        // aiSays is a literal substring of the answer
    "answerId": "a11", "field": "phone", "aiSays": "(516) 555-0119", "sourceSays": "(516) 555-0148",
    "status": "differs"                 // match | differs | not stated
  } ],
  "listings": [ /* same shape as v1, below */ ],
  "issues": [ { "severity": "high", "title": "...", "description": "...", "steps": ["..."] } ],
  "method": {
    "engines": { "chatgpt": { "api": "...", "model": null, "loggedIn": false } },
    "enginesFailed": ["gemini"],        // the page drops that column and names the engine
    "window": "2:04–2:19pm ET",
    "runs": 1                           // runs per search; the page's wording derives from this
  },
  "baseline": { "generatedAt": "...", "totals": { "answers": 25, "namedYou": 11, "firstYou": 4 } },  // or null; totals are non-negative integers
  "locked": true                        // set by the Worker per request, see below
}
```

### How the page uses it (sections 1–11)

| # | Section | Reads | Notes |
|---|---|---|---|
| 1 | Hero | `headline`, `answers`, `entities` | Competitor names shown only if the entity is named in 2+ answers; others are counted ("and 1 other business"). |
| – | Before and after | `baseline` | Only when `baseline` is set (the 30-day re-check). |
| 2 | The short version | recomputed totals, `intentResults` rule | A question (intent) is lost when the owner is named in **half or fewer** of its answers (`named × 2 <= answers`); `unsure` matches are left out of both counts. `report.js` mirrors `intentResults()` from `shared/report-v2.js` (the browser can't import it); keep them identical. |
| 3 | Who AI names | `entities` (named ≥ 2) | Hidden when nobody is named twice; the page says how many answers named no one. |
| 4 | Every search grid | `answers` | Question × engine; one mark per run; each mark opens its answer. Only the grid scrolls sideways. |
| 5 | Why they got named instead | `sources` | Only sources cited in answers that didn't name the owner; the owner's own site is left out. |
| 6 | What AI says about you | `aiFacts` | Exact quotes, `differs` first. |
| 7 | Your listings | `listings` | Same cards as v1. |
| 8 | What to fix | `issues` | Titles free; descriptions and steps removed server-side until paid. |
| 9 | Offer | `sources`, `listings` | Names the sites the fix covers. Named in every answer: Full Year only and no $29 unlock panel, even if a listing mismatch exists. No mismatches and no missing sources: same. |
| 10 | Every answer | `answers` | Full text, collapsed, citations under each. |
| 11 | How we searched | `method` | Always rendered. |

### Serving rules (Worker)

- `getReport()` returns `scan_results.report` for the newest row with `version = 2`; otherwise it shapes a v1 report from the row.
- Every v2 report (samples included) runs through `validateReport` before it is served. Besides the guardrails it type-checks the numbers the page prints: `answers[].run` (positive integer), `sources[].youPosition` (null or positive integer) and `baseline.totals.*` (non-negative integers); `report.js` also forces them through `num()` before printing. If it fails, the Worker logs the errors and answers **503 `{"error":"Report not ready"}`**; the page shows "This report isn't ready yet." A broken report is never sent.
- Locking (unpaid): every listing that is not `match` keeps only `platform` + `status`; issues keep only `severity` + `title` (`description` and `steps` are withheld). Everything else is the free report. Paid: `locked: false`.

### Supabase (v2)

`supabase/scan_v2.sql` adds `scan_results.report jsonb`, `scan_results.version int`, `scan_results.scan_id uuid`, and `scan_raw` (one row per engine call: engine, question, run, model, request, response, answer text, citations, ok, error, cost, asked_at; service key only, no anon access). The scanner writes both with `SUPABASE_SERVICE_KEY`; the Worker's anon key only reads `scan_results`.

### Admin routes

Both need `Authorization: Bearer <ADMIN_TOKEN>` (constant-time compare). With no `ADMIN_TOKEN` set they return 404.

- `GET /api/admin/ping` → `{ chatgpt|gemini|google_ai_mode|perplexity|extractor: { ok, error, latencyMs, ... } }`. One live call each; no key values in the response.
- `POST /api/admin/scan` with `{ business, engines?, runs?, reportToken? }` → runs the scan, builds and validates the report, stores it when `SUPABASE_SERVICE_KEY` is set and validation passed. Returns `{ reportId, totals, costUsd, validation, enginesFailed, scan, stored }`.

`GET /api/health` also reports which scanner keys are present (booleans only).

---

## Report JSON v1 (legacy)

`renderV1()` in `public/js/report.js` renders this shape unchanged. The legacy sample is `src/mock/sample-v1.js` (`/report/sample-v1`); `getReport()` in `src/lib/db.js` still shapes pre-v2 `scan_results` rows into it.

```jsonc
{
  "id": "sample-v1",               // public token, used in /report/[id] URLs
  "generatedAt": "2026-09-23",     // ISO date the scan ran
  "sample": true,                  // true for the demo report; omit/false for real ones
  "business": {
    "name": "Harborview Plumbing & Heating",
    "trade": "Plumbing & HVAC",
    "phone": "(516) 555-0148",
    "website": "harborviewplumbing.example.com",
    "address": "4820 Merrick Road",
    "city": "Massapequa",
    "state": "NY",
    "zip": "11758",
    "county": "Nassau"
  },
  "score": 62,                     // 0–100 composite
  "scoreLabel": "Needs attention", // short band label
  "scoreExplanation": "...",       // one plain-English sentence on what the score means
  "aiResults": [                   // one entry per assistant tested
    {
      "assistant": "ChatGPT",
      "named": false,              // was the business mentioned by name?
      "quote": "“...”",            // exact quote from the assistant
      "note": "..."                // plain-English gloss
    }
  ],
  "listings": [                    // one entry per platform checked
    {
      "platform": "Google",        // Google | Apple | Bing | Yelp | Facebook
      "status": "match",           // "match" | "mismatch"
      "details": "...",            // what agrees / what is wrong
      "fields": {
        "name": "...",
        "phone": "...",
        "hours": "..."
      }
    }
  ],
  "issues": [                      // ordered: fix-first at the top
    {
      "severity": "high",          // "high" | "medium" | "low"
      "title": "...",
      "description": "..."         // plain English: what it is, why it costs customers
    }
  ],
  "summary": "...",                 // the bottom line, 3–5 sentences
  "locked": true                   // set by the Worker until a payment exists for this token
}
```

When `locked` is true the Worker has already removed, server-side, `details`/`fields` from every `mismatch` listing and `description` from every issue (each gets `locked: true`). The page draws blurred stand-in text in their place. Nothing withheld is ever sent to the browser.

Rules for real scan data:
- Every string is customer-facing — plain English, no jargon. The scanner writes them, not the site.
- `quote` must be the assistant’s actual words (quoted).
- `issues` is pre-sorted by impact; the page renders it as-is.
- `score` is computed by the scanner (weights TBD); the page only displays it.

## Supabase tables → report JSON

Planned tables: `businesses`, `scan_results`, `page_visits`, `email_events`, `payments`.

| Table | Role in the report flow |
|---|---|
| `businesses` | One row per scanned business. Supplies `report.business.*`. |
| `scan_results` | One row per scan, keyed by public `report_id`. Supplies `score`, `scoreLabel`, `scoreExplanation`, `aiResults`, `listings`, `issues`, `summary`, `generatedAt`. The JSON sub-documents (`aiResults`, `listings`, etc.) live in jsonb columns on this row. |
| `page_visits` | Analytics only — records visits to `/report/[id]` (not rendered on the page). |
| `email_events` | Analytics only — cold-email sent/opened/clicked events (not rendered on the page). |
| `payments` | Written by `POST /api/stripe-webhook` on `checkout.session.completed`. Not rendered on the report page; links a purchase to a `business_id` / `report_id` and a `tier`. |

Proposed mapping (column names are placeholders — confirm against the live schema in `src/lib/db.js`):

- `scan_results.report_id` → report JSON `id` (public token in the URL)
- `scan_results.business_id` → `businesses.id`
- `businesses.name/phone/website/address/trade/county` → `report.business.*`
- `scan_results.score` → `report.score`
- `scan_results.ai_results` (jsonb) → `report.aiResults`
- `scan_results.listing_results` (jsonb) → `report.listings`
- `scan_results` issue/summary fields (jsonb or text) → `report.issues`, `report.summary`, `report.scoreExplanation`

## Webhook → payments row

On `checkout.session.completed`, the Worker reads the report token from `session.client_reference_id` (appended to the Payment Link by the report page), looks it up in `report_links`, and builds:

```jsonc
{
  "businessId": "<report_links.business_id>",
  "reportToken": "<session.client_reference_id>",
  "arm": "<report_links.arm>",               // mail | email_a | email_b
  "tier": "<from session.metadata.tier>",   // snapshot | before_after | full_year | listing_fix
  "amountCents": 5900,
  "currency": "usd",
  "stripeSessionId": "cs_test_...",
  "stripePaymentIntent": "pi_...",
  "customerEmail": "owner@shop.com",
  "status": "paid"
}
```

`recordPayment()` in `src/lib/db.js` maps these onto the `payments` table columns. Each Stripe Payment Link carries only `tier` in its metadata; everything else comes from the token.
