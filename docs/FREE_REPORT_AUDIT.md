# Free-report flow audit (Oct 1 2026)

Trigger: the owner ran a free report for **PR 73** (https://www.pr73.com/, a PR agency in New York
City) and reported: the form asked for a ZIP (a PR agency isn't in one ZIP), then asked what kind of
business it is, then sent them to `#results`, which never loaded.

This file is the audit: what actually happened (from the database), the bugs, what was fixed in this
change, and what to change next to make the flow shorter and the questions right for businesses
that aren't one-town trades.

## 1. What happened to the PR 73 request (database, times UTC)

| Time | Event | Source |
|---|---|---|
| 17:49:14 | Request saved: "PR 73", New York City NY 10001, trade `pr agency`, no email | `report_requests` |
| 17:49:15 | Scan row created, status `running`, engines chatgpt + gemini + claude | `scans` |
| 17:49:17 | Live answer: Gemini answered q1 in about 2 s, $0.006 | `scan_usage` (`live-preview:…`) |
| 17:49:20 | Scan started, 3 questions × 3 engines | `scan_raw` |
| 17:51:20 | Claude q1 timed out after 120 s; the workflow moved on (a Gemini re-run filled the slot) | `scans.errors` |
| 17:52:19 | Scan done: 9 of 10 calls ok, 8 answers, report valid, AI named PR 73 in 0 of 8, cost $0.33 | `scans`, `scan_results` |
| never | No `page_visits` row for the report token: the finished report was never seen | `page_visits` |

So the server side worked end to end in 3 minutes. The report exists at `/report/zDLK7Xwl4vsA3SaJ-FQr4w`.
The owner never saw it because of the bug in section 2.

## 2. Bug: the results block has been invisible since Sep 28 (fixed here)

On Sep 28 (`388203e`, "One form, in the hero") the form moved into the hero and `#results` was
left with a single child, `#request-next`. A CSS rule from the old two-column layout,
`.request.done > div:first-child { display: none; }`, now hid that one child: the whole results
block. What a visitor got after pressing the button:

- the form disappears and a green line says "Asking AI about your business now. See it below ↓";
- "below" is an empty dark box at the very bottom of the page (after pricing and the FAQ);
- the live answer, the **Open my free report** button, the questions and the email box were all
  there in the DOM but hidden.

Impact (`scans` where trigger = request, joined to `page_visits` and `report_requests`): 9 free
requests since Sep 28, 1 report page ever opened, 0 emails given. The email box was hidden too,
so no "report ready" email could go out either.

Fixed in this change:

- `public/css/styles.css`: removed `.request.done > div:first-child { display: none }` and the
  `.request-col` rule (no `.request-col` exists any more).
- `public/index.html`: the `#results` section now sits directly under the hero, so "See it below"
  is one short scroll, not 9,700 px down a phone screen.
- `src/lib/test/free-report-results.test.js`: fails on the old stylesheet (proved by running it
  against the stale CSS), passes now; also pins the section's position and the hero link.
- Verified in headless Chromium against `public/` with the API mocked the way the Worker answered
  on Oct 1: after the third submit the live answer, "See who AI names instead of you", the Open my
  free report button and the email box are all visible and laid out (block height 1,523 px at
  phone width; before the fix: 0 px). The PR preview build could not be reached from the sandbox
  that made this change, so please click through once on the preview before merging.

## 3. The three-submit chain (friction, not a crash)

For a business whose website shows no "Town, ST 12345" and whose name says nothing about what it
does, the current flow is:

1. Name + website → submit → "We couldn't find your ZIP code on your website. What's your ZIP?"
   (shown in the red error style).
2. ZIP → submit → "One quick thing: what kind of business is it?" (red error style again).
3. Kind → submit → results.

Three presses of the same button, two of them answered with error styling for something the
visitor did nothing wrong about. Each round trip also re-runs `/api/questions`, and the second
one burns the per-IP rate budget. Recommendation (section 6) is one confirm step instead.

## 4. ZIP and "my business isn't in one ZIP"

What the scanner actually needs (`scanner/questions.js`): a **town string** and a state. The ZIP
is optional; it only fills `{zip}` in one plumbing price template and the dedupe key. The form
asks for a ZIP because it is the easiest way to get a clean town name (`/api/zip`).

For a PR agency, a law firm, an accountant, a mover, a contractor, a web shop, "the town" is
really a **service area**. Today the only way to say "New York City" or "Long Island" is to click
*change* next to the ZIP's town and type over it (the owner did exactly that: ZIP 10001 resolved
to "New York", the saved town is "New York City").

Recommendation:

- Keep the ZIP lookup as the shortcut, but label the result as the **area the report is about**
  ("Your report asks about *New York, NY* · change") and let the owner type any place:
  a town, a city, a county ("Nassau County"), a region ("Long Island"). `TOWN_RE` already allows
  this; nothing in the scanner breaks.
- Do not add a "nationwide / online" option yet. Every free question is "… in {town}, {state}";
  "best PR agency in Nationwide, NY" is nonsense, and a no-place question set is a different
  product (different templates, different competitors, a different headline). If that is wanted,
  it is a new intent set in `scanner/questions.js`, not a form change.
- When the site has no ZIP, ask for the **area** in plain words ("Where are your customers?
  Town, city or area"), not "What's your ZIP?", and not in the error style.

## 5. Accuracy: the questions were wrong for this kind of business

The three questions asked for PR 73:

1. "What's the best pr agency in New York City, NY?" — fine (both engines gave a long ranked list).
2. "Pr agency open now near New York City NY" — the generic *urgent* template
   (`{Trade} open now near {near} {state}`). ChatGPT answered with a question back ("Do you need an
   agency that's open right now…?"); Claude said it has no hours data. One of the three free
   questions was wasted. "Open now" only makes sense for trades and storefronts.
3. "Can you recommend a pr agency in New York City NY?" — fine.

Also: "pr" stays lower case in every question and in the report ("best pr agency"). AI tolerates
it; the owner reads it as sloppy.

Recommendations (`scanner/questions.js`, `scanner/kind.js`):

- Add a small **kind class** to the question builder: `trade` (plumbing, roofing… the TRADES
  keys and words like "contractor", "cleaner"), `storefront` (bakery, cafe, salon, laundromat…),
  `professional` (agency, firm, consultant, accountant, lawyer, insurance, real estate, marketing,
  PR, IT, web design…). The urgent slot becomes, per class: trade → "{Trade} open now near…",
  storefront → "{Trade} open now near…", professional → "Who are the top rated {trade}s in
  {town}, {state}?" (or "Which {trade} do people in {town} recommend?"). Same three intents, same
  before/after comparability within a class.
- Title-case known acronyms when the kind is typed: pr → PR, hvac → HVAC, it → IT, cpa → CPA,
  seo → SEO. One map in `tradeOrKind`.
- Guess more kinds from the name and site so step 2 of the chain happens less: `KIND_WORDS` has
  no entry for agency, marketing, public relations, communications, consulting, design, software,
  IT, staffing, printing, photography, tutoring, med spa, physical therapy, optometrist,
  dermatologist, urgent care, funeral home, storage, towing, auto glass. The site check already
  fetches the home page; `kindFromPage` reads only the schema type, `<title>`, description and
  the first `<h1>`. Reading `og:site_name`/`og:description` and the first 300 words of body text
  through the same word list would have caught "public relations" on pr73.com.

## 6. Make it one step: website first, then one confirm card

Answer to "do we need the business name or can we get it from the website": we need the name,
because the report literally matches it in the answers (`businessesNamed`, `isYou`), but we can
**prefill** it. The site check (`src/lib/site-check.js`) already fetches the home page; the name is
in `schema.org name`, `og:site_name`, or the `<title>` before the first " | " or " – ". The Google
listing lookup (`zipFromPlaces`) returns `displayName` for the same price.

Proposed flow (one form, no error-styled follow-ups):

1. **Website** (or Facebook/Yelp page). On blur or submit, `/api/site-check` returns everything it
   can read: `{ name, zip, town, state, kind, kindFrom }`.
2. **One confirm card** with three prefilled, editable fields: *Business name* (from the site),
   *Area the report is about* (from the site's ZIP, else Google, else empty with the placeholder
   "Town, city or area"), *What you do* (from name/site, else empty with a short list of common
   kinds as chips plus free text). Empty fields are just empty fields, not errors. One button.
3. Results appear in place of the form (the hero), not in a separate section. The live answer,
   the report button and the email box are what the visitor is waiting for; they should not have
   to be told to scroll.

This removes two of the three submits for a business like PR 73 and all three "what's wrong"
messages. It is a front-end change in `public/index.html` plus the site-check response; the
scanner and `/api/request` already accept the fields.

## 7. The wait after the click

- The report page polls every 30 s (`PENDING_POLL_MS`) and only reloads on the poll after the
  report lands. A 3-minute scan can look like 3.5 minutes. Poll every 5 s for the first minute,
  then 15 s, then 30 s. `scans.calls_ok / calls_total` is already written per call; show
  "7 of 9 answers in" instead of a bare spinner.
- One engine hanging stretches the scan to the full engine timeout (120 s, `DEFAULT_TIMEOUT_MS`).
  For the free scan, 60 s is plenty: the slow engine's answer is dropped and retried as today.
- The landing page's live answer has a 50 s client wait. Gemini answered in 2 s here; when it
  doesn't, the block folds away silently. Keep that, but say "No live answer this time, your
  report has every answer" in the next-step heading (it does, via `paintNext`).

## 8. Smaller things seen on the way

- After a save failure the hero button stays "One moment…" (disabled) while the form is hidden;
  harmless now, but if the results block is ever moved into the hero, restore the button.
- `/api/questions` answers are `public, max-age=300` cached by trade+town+name+website; fine,
  but the 422 "need kind" answer must stay uncached (it is: `no-store`).
- `hero-done` says "Asking AI about your business now" even when the live preview is off
  (no Turnstile) — then nothing is being asked live. Minor copy.
- Dedupe: the same name + ZIP within 7 days gets a copy of the earlier report. Since the area may
  now be typed, the key should be name + area (lower-cased), not name + ZIP, or an owner trying
  "Long Island" after "Massapequa" gets the Massapequa report copied.

## 9. Suggested order

1. Merge this fix (results visible again, under the hero). Everything else is behind it.
2. Question classes + acronym casing (section 5): small, scanner-only, improves every report for
   agencies and professionals.
3. More kinds from the name and page (section 5), so the "what kind" step rarely appears.
4. Website-first confirm card and results in the hero (section 6).
5. Faster pending page and a 60 s free-scan timeout (section 7).
