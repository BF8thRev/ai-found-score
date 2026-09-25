# AI visibility plan: which assistants, what a full audit covers, what it costs

Sep 25, 2026. Prices come from vendor pages as quoted in search results, plus `scanner/config.js`. Nothing was confirmed on a vendor's own page, and anything marked **(uncertain)** needs checking before we rely on it. Recheck each price against the `cost_usd` recorded in the first live scans.

## 1. Keys to get, in order

| # | Account | Covers | Where | Why |
|---|---|---|---|---|
| 1 | **DataForSEO** (already used for AI Mode) | Google AI Mode, **Google AI Overviews + the local map pack** (same page), **ChatGPT and Gemini as the real apps show them** (LLM Scraper) | app.dataforseo.com/register ($50 minimum top-up) | One account covers the assistants people use most for local search, and it reads the real pages, which the APIs don't |
| 2 | **Perplexity API** | Perplexity | Perplexity account → API settings | Cheap (~$0.002/question), same search engine as the app |
| 3 | **cloro** (or Bright Data) | **Microsoft Copilot** and **Grok**, as the real apps show them | cloro.dev (Lite $30/mo) | Copilot has no official API; one account gets us both |
| — | Keep: OpenAI, Anthropic, Gemini | ChatGPT (API), Claude, Gemini (API) | platform.openai.com, platform.claude.com, aistudio.google.com | Already wired. OpenAI may ask for organization ID verification for GPT-5 models **(uncertain)** |
| — | Optional: xAI | Grok via API | console.x.ai | Only if we don't use cloro for Grok |

**Can't be asked, so we check what they draw on instead:**
- **Meta AI:** no reliable way to see what the app says. Drop it from the list.
- **Siri:** runs on Gemini; the proxy is Gemini + Google + Apple Business Connect.
- **Alexa+:** pulls local answers from Yelp; the proxy is Yelp.

**The honest "8" for the $99 audit:** ChatGPT, Google AI Mode, Google AI Overviews, Gemini, Copilot, Perplexity, Claude, Grok. This swaps Meta AI (which we can't ask) for AI Overviews (which Google says reaches 2.5B people a month). The homepage currently shows "ChatGPT, Gemini, Claude, Perplexity and more", which stays true while we add the rest.

Order of reach for local search (BrightLocal 2026, Similarweb May 2026): ChatGPT → Google AI Mode / AI Overviews → Gemini → Copilot, Perplexity → Claude, Grok.

## 2. What a complete AI visibility audit looks like

Six questions, in the order an owner cares about them:

1. **Does AI name me?** Each assistant, each customer question, asked 3 times ("named in 2 of 3 tries"). Who was named instead, and who came first.
2. **Where do I show up on Google's local results?** The map pack on the same page as the AI Overview. That's where AI gets much of its local data, and owners already understand it.
3. **Is what AI says about me true?** Hours, phone, services, service area and prices as AI states them, checked against the business's own website and listings. A wrong phone number is lost calls you can fix today.
4. **Which sites does AI trust, and am I on them?** Every site the AI cited, plus the core listings: Google, Apple Business Connect, Bing Places, Yelp, Facebook, BBB, Angi, Nextdoor, Thumbtack, the trade's own directories. For each one: listed or not, details correct or not, and reviews (count, rating, how recent) against the businesses AI named.
5. **Can AI read my website?** robots.txt lets the AI crawlers in (GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, Google-Extended); name, address and phone are on the site; LocalBusiness schema; a page per main service and town; plain FAQ answers. All cheap to check with one fetch of the site.
6. **What do I fix first?** The top 3 fixes ranked by impact, each with the exact text to paste and where to paste it. The full list goes after that.

For the year tier, add: **what changed** since the last scan, an **alert when a competitor starts getting named instead of you**, and **before-and-after proof** after the owner fixes something.

## 3. What makes it worth paying for

API calls cost a few dollars, so the price has to rest on what the owner gets out of the audit:

- **Say it in money.** Tie each question to the job behind it: "emergency plumber tonight" is a high-value call, "affordable plumber" is a price shopper. Lead with the question that costs the owner the most.
- **Say it the way a customer would.** "When someone asks ChatGPT for an emergency plumber in Massapequa, it names Tidewater. Not you." Answers are quoted word for word so the owner can check them.
- **Only 3 fixes up front.** A local owner won't work through a list of 20. Each fix says where to do it, the text to paste, and roughly how long it takes.
- **Proof that fixes work.** Re-check after a fix and show before and after. This proof is also what sells the year tier.
- **Phone-first and plain.** No jargon and no score. Named or not, who instead, what to fix.

## 4. Cost per scan

Cost of one question on one assistant, with web search on:

| Assistant | Route | $ per question |
|---|---|---|
| ChatGPT (as the app shows it) | DataForSEO LLM Scraper | ~0.004 **(uncertain)** |
| ChatGPT (API) | OpenAI Responses + web_search | ~0.016 |
| Gemini | Gemini API + Google Search | ~0.022 (~0.008 inside the free 5,000 a month) |
| Google AI Mode | DataForSEO | 0.004 |
| Google AI Overviews + map pack | DataForSEO organic SERP | ~0.002–0.004 **(uncertain)** |
| Perplexity | Agent API | ~0.002 **(uncertain)** |
| Claude | Messages API + web search | ~0.068 (most expensive) |
| Copilot | cloro | ~0.002–0.004 |
| Grok | cloro, or the xAI API | ~0.003 (cloro) / ~0.01 (API) |
| **Reading each answer** (our extractor) | Claude Sonnet | ~0.018 per answer |

Per offer:

| Offer | Calls | API cost |
|---|---|---|
| Free Snapshot | 3 assistants × 3 questions × 1 try = 9 answers | **~$0.48** (scanner's own estimate) |
| $99 Audit | 8 assistants × 5 questions × 3 tries = 120 answers | **~$4–5** (~$1.75 asking + ~$2.15 reading + listings and site checks) |
| $499 Year | the audit + 11 more monthly scans | **~$50–60** |

Fixed costs: cloro ~$30/mo, DataForSEO $50 top-ups, Cloudflare Workers Paid $5/mo.

What this means:
- **Reading the answers costs more than asking.** Moving the extractor to a smaller model could roughly halve the audit's cost. Test that it stays accurate first.
- **The real cost is our time.** A person checking each audit before it goes out (~30 min) costs more than the APIs. The $99 still leaves room, but at volume that review has to get fast.
- **The free snapshot is cheap enough to give away.** The existing daily caps (25 scans / $20) keep it safe.
- **The $499 year needs more than repeat scans to feel worth it.** The competitor alert and before-and-after proof are what make it valuable. It also overlaps AI Defense ($99/mo monitoring). Either the year *is* the monitoring product, or AI Defense becomes the done-for-you tier (we make the fixes). Pick one.
- **The Competitor Breakdown upsell** (why AI picks them) costs a few dollars to produce: their listings, reviews, cited sites and website checks. It could be priced as a small add-on after the audit.

## 5. What the scanner needs before the page's claims are true

1. Paid scans ask **5 questions × 3 tries** (`runs: 3`); the free one stays at 3 × 1 (`FREE_QUESTION_COUNT`).
2. New engines: `chatgpt_app` and `gemini_app` (DataForSEO LLM Scraper), `google_aio` (AI Overviews + map pack from the same page), `copilot` and `grok` (cloro), plus a Perplexity key.
3. Listings, reviews and website checks from section 2 (items 2, 4 and 5).
4. Report sections: top 3 fixes with paste text; a before-and-after strip for re-checks (`sample-recheck` already shows one).
5. Checkout: report pages still sell the $49 X-Ray. Switch them to $99 / $499 once the audit really delivers the above.
