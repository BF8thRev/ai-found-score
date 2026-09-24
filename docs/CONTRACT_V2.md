# Build contract (v2) — shared decisions for every builder

Source of truth: `docs/BUILD_PLAN.md`. This file only pins down what the plan leaves open, so parallel work fits together.

## Runtime

- API keys live as **Cloudflare Worker secrets** (they cannot be read back). So all scanner/extractor code is **runtime-agnostic ES modules**: global `fetch` only, no Node built-ins (`fs`, `path`, `crypto` from node, `process`) inside library code. Node-only code lives in thin CLI files (`scanner/cli.js`).
- Every function that needs keys takes an `env` object (the Worker `env`, or `process.env` in the CLI). Never read `process.env` inside library code.
- The Worker bundles these modules via wrangler (`src/worker.js` imports from `../scanner/...` and `../shared/...`). Keep them dependency-free.

## Env var names (one place: `scanner/config.js`, easy to rename)

| Var | Use |
| --- | --- |
| `OPENAI_API_KEY` | ChatGPT engine only (Responses API + `web_search` tool) |
| `ANTHROPIC_API_KEY` | Claude engine (`scanner/engines/claude.js`, Messages API + `web_search` tool) and the extractor (`scanner/extract/propose.js`), both via `@anthropic-ai/sdk` |
| `GEMINI_API_KEY` | Gemini engine (grounding with Google Search) |
| `PERPLEXITY_API_KEY` | Perplexity Sonar |
| `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` | Google AI Mode via DataForSEO |
| `SUPABASE_SERVICE_KEY` | Scanner writes (`scan_raw`, `scan_results`). Worker-side only, never sent to browsers |
| `ADMIN_TOKEN` | Bearer token guarding `/api/admin/*` routes |
| `OPENAI_MODEL`, `GEMINI_MODEL`, `PERPLEXITY_MODEL` | Optional engine model overrides; sensible defaults in config |
| `CLAUDE_MODEL` | Claude engine model; defaults to `claude-sonnet-5` |
| `EXTRACT_MODEL` | Extractor model; defaults to `claude-sonnet-5` (cost constants in `propose.js` assume Sonnet 5 prices) |

`scanner/config.js` exports `resolveKeys(env)` that also accepts common alternates (e.g. `OPENAI_KEY`, `GOOGLE_API_KEY`, `PPLX_API_KEY`, `CLAUDE_API_KEY`) so the names on Cloudflare don't have to match exactly.

## Engine ids (used everywhere)

`chatgpt`, `gemini`, `google_ai_mode`, `perplexity`, `claude`. Display names: ChatGPT, Gemini, Google AI Mode, Perplexity, Claude. Tie-break order for the headline: chatgpt, google_ai_mode, perplexity, gemini, claude. Code derives engine counts from `ENGINE_IDS` / the report's answers, never a hardcoded number.

## Engine adapter interface (`scanner/engines/<id>.js`)

```js
export const id = 'perplexity';
export async function ask({ question, business, env, fetchImpl = fetch }) → {
  engine, ok: boolean, text: string|null,
  citations: [{ url, domain, title? }],   // from the API's citation data only, never from a model
  request: object, raw: object|null,      // raw = full parsed API response (stored in scan_raw)
  costUsd: number, error: string|null, askedAt: ISOString, model: string
}
```
`fetchImpl` is injectable so tests run on recorded fixture responses with no network.

## Shared report module (`shared/report-v2.js`, owned by the extractor builder)

Pure functions, used by the scanner (publish gate), the Worker (serve gate) and tests:

- `computeTotals(report)` → `{ answers, namedYou, firstYou }` recomputed from `report.answers`.
- `validateReport(report)` → `{ ok: boolean, errors: string[] }`. Enforces the plan's guardrails: stored totals equal recomputed; every entity shown (named ≥ 2) has ≥ 2 `answerIds` whose answer text literally contains its name/alias; every `businessesNamed[].name` is `text.slice(pos, pos+name.length)`; every `aiFacts[].aiSays` is a literal substring of its answer; `method` present; banned words absent from all customer-facing strings (see below).
- `BANNED_WORDS` = `["disconnected", "minutes", "guarantee placement", "more customers", "rank"]` (whole-word, case-insensitive; `rank` must not match inside e.g. "Frank"). `lintText(str)` → list of hits. Answer `text` fields (verbatim AI output) and URLs are **excluded** from the lint — only our own copy is linted.
- `pickHeadline(report)` → `{ answerId, rule }` per the plan's hero rule.
- `lostIntents(report)` → intents the owner **lost**, in question order. An intent is lost when the owner was named in **half or fewer** of that intent's answers (`named × 2 <= answers`; exactly half counts as lost, matching the demo's 1-of-2 "best" and "cheapest"). Answers with an `unsure` owner match are left out of both counts; an intent with no counted answers is neither lost nor won. `intentResults(report)` → `[{ intent, answers, named, lost }]` for the tiles and the "where you win / lose" sentence. The report page must use the same rule (it must not re-derive "lost" as "any answer missed you").
- `edgeState(report)` → one of `zero`, `all_named`, `nobody_twice`, `no_fixes`, `normal` (plus `failedEngines: []`).
- `validateReport` also fails: a report with **0 answers** (every engine failed; nothing to publish); any `method.extractionFailed` entry (a failed extraction makes an answer look like "didn't name you"); an owner mention (`businessesNamed[].isYou`) whose entity is not `isYou`, or a competitor mention attached to the owner entity; more than one `isYou` entity.
- Lint masks verbatim data our templates interpolate (`aiFacts[].aiSays`/`sourceSays`, entity names/aliases, `businessesNamed[].name`, `sources[].topListed`, listing field values) before checking the words around it, so an AI quote like "within 30 minutes" in an issue description doesn't block a report.

## Scanner → extractor hand-off

`buildReport({ scan })` takes `runScan()`'s result **as-is**: engine calls are in `scan.calls` (the name `runScan` returns). `results` is no longer read; a scan without a `calls` array throws. The Worker passes `scan`, not `{ ...scan, results: scan.calls }`. `buildReport` returns `{ report, validation, rejected, extraction }`: `extraction.costUsd` is the extractor spend to add to `scan.costUsd`.

## Report JSON v2 additions/clarifications

- Exactly the plan's shape, plus: `answers[].intent` (copied from question for convenience), `method.enginesFailed: [engineId]` (failed engines' answers are **not** in `answers`; the page drops that column and names the engine), `method.failedCalls` (single failed calls from engines that otherwise answered), `method.extractionFailed` (only on reports that must not publish), `method.window`, `method.runs`, `method.engines[id] = { api, model, loggedIn:false }`, `sample: true` on fictional samples.
- `businessesNamed[].pos` is a character offset into that answer's `text`.
- `namedYou` counts only confirmed owner matches (not `unsure`). An `unsure` match sets `ownerMatch: "unsure"` on the answer.
- The owner is marked `isYou: true` on every `businessesNamed` entry that is a confirmed owner match **and** on its one entity in `entities`; competitors never carry `isYou`. Pages filter competitors with `!e.isYou`.
- `totals.answers` = number of successful answers (5 questions × engines that responded × runs).
- `baseline` = previous scan's `{ generatedAt, totals }` or null.
- v1 reports (no `version` or `version: 1`) must still render exactly as today.

## Supabase

New SQL goes in `supabase/scan_v2.sql` (idempotent, run by the owner in the SQL editor — builders do **not** apply it to the live project): `scan_raw` table (id, scan_id, business_id, engine, question_id, run, request jsonb, response jsonb, ok, error, cost_usd, asked_at), `scan_results.report jsonb` + `scan_results.version int`. RLS on, no anon access to `scan_raw`.

## Ownership (don't edit files outside yours; tell the lead instead)

- **Scanner**: `scanner/` except `scanner/extract/`; `supabase/scan_v2.sql`.
- **Extractor**: `scanner/extract/`, `shared/`, `scanner/test/fixtures/megawash/`.
- **Report page**: `public/js/report.js`, `public/report.html`, `public/css/styles.css`, `src/worker.js`, `src/lib/db.js`, `src/mock/`, `DATA_MODEL.md`.
- **Site + outreach**: `public/index.html`, `outreach/`.
- Nobody edits `package.json` (lead adds scripts). Tests use `node --test`.
