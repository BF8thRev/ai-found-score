# AI Found Score — data model

## Report JSON (returned by `GET /api/report/[id]`)

`public/js/report.js` renders exactly this shape. Mock data lives in `src/mock/sample-reports.js`; when Supabase is wired, `getReport()` in `src/lib/db.js` must return the same shape.

```jsonc
{
  "id": "sample-001",              // public token, used in /report/[id] URLs
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
