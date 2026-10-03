# AI Found Score: Operating Bible

This file records what we decided, why we decided it, how each decision changed over time, and what
we learned along the way. It is the source of truth for the reasoning behind the product. The code
shows *what* the product does; this file explains *why*.

- **Read it before starting work.** If a request conflicts with a rule below, say so and ask before acting.
- **Every PR updates it** (see [How to update](#how-to-update-this-file)). The "Decision log" check fails if it doesn't.
- **This repo is public.** Never put personal emails, report tokens, keys, or a customer's name here
  (the two public samples, Mega Wash & Dry and Glenn Wayne Bakery, have their owners' permission).

Coverage: every Claude Code session for this project from 2026-09-23 to 2026-10-02 (29 sessions),
plus the descriptions of PRs that were built in web sessions (#1, #5, #40, #41). Last full review: 2026-10-02.

---

## 1. Where we are now (as of 2026-10-02)

**What the business is.** AI Found Score (aifoundscore.com) asks AI assistants the questions a
business's customers ask, and shows whether the business is named, who is named instead, and what
to fix. Operated by Fields Holding d/b/a GetAiFound Score. It is run largely by AI agents; the owner,
Bryan, reviews and merges but does not test by hand or use a terminal.

**What's on sale**

| Offer | Price | What it is |
|---|---|---|
| Free Snapshot | $0 | 3 questions × ChatGPT, Gemini, Claude. Shows whether you're named, who's named instead, one answer word for word, the AI Found Score, and pass/fail tallies. Fix titles stay locked. |
| AI Visibility Audit | $49 | A fresh scan on every engine with a key: 5 questions, plus 2 small-firm questions on the paid audit only. You get an impact-ordered **action plan checklist**, the pre-built **Fix Kit** zip, directory checks, "Why AI picked them", and a free automatic **30-day re-check**. Guarantee: fewer than 3 business-specific problems found means $49 back within 30 days. |
| Competitor Breakdown | +$25 | An order bump on `/checkout` ($74 total) and an upsell after purchase. A scorecard of what the top 3 rivals have that you don't (the "Match List"). |
| "Do it for me" | quote on request | A request box on paid Fix Kits that emails us. No price yet. |
| Be the Answer | $499/yr | **Off sale and hidden.** Existing plans keep running. |

**How it runs.** One Cloudflare Worker (on Workers Paid, $5/mo since 2026-09-28) with Supabase,
Stripe Checkout Sessions (our own `/api/checkout`; every Payment Link is off), Resend for
transactional mail from `mail.aifoundscore.com`, and a Gmail API sender for outreach (built, but
switched **off**). Free scans run automatically (`AUTO_SCAN`), capped at 3 per connection per day
and 25 scans or $20 per day. A merge to `master` deploys automatically through Workers Builds.

**Real costs.** A free scan costs about $0.33–0.36. A paid audit costs about $1.29. Gemini's first
5,000 searches each month are free. The money view on `/admin` shows exactly 2 decimals.

**Who it's for.** Local trades and storefronts, **and** B2B and professional firms (agencies,
consultancies) that win big clients through AI search. Both groups are core customers.

---

## 2. Operating principles (the framework)

These are the standing rules. Each one came from a specific decision or mistake, given in brackets.

### Truth
1. **Every number, quote and claim is real and checkable.** No invented value anchors ("$1,981
   value"), no fake strikethrough prices, no made-up businesses presented as real, no fake dates.
   We refused to fake a "today" date on the hero card even when asked. [Sep 23–28]
2. **Only sell what we can deliver today.** If it isn't built, it isn't on the page. If it's coming,
   it gets a star ("*being added"). [Sep 24: $69/$199 pulled; Sep 25: false listings-check claim removed]
3. **Guarantees must be checkable and specific to the business.** "3 problems or your money back",
   not "you'll see something new". No outcome guarantees: no promised ranking, AI placement or score
   lift. [Sep 25; Sep 26: the Accuracy Guarantee was dropped]
4. **Claim only what we saw.** "We searched Google and found no profile", never "you're not on it".
   "Not seen in this scan", never "they don't have it". Prefer a missed finding (false negative)
   over a false claim in anything people pay for. [Match List audits, Sep 29; directories, Oct 2]
5. **Never name a real business as the loser** without its permission. In the hero, the visitor is
   the one not mentioned. [Sep 28]
6. **Banned in copy:** "rank", time promises ("5-minute", "within the hour", "minutes"), "stopped
   Googling", fear claims, and assistant names or counts in marketing copy. Quoted answers are the
   exception, and so is the hero card label "ChatGPT's answer". [Sep 24–28]
7. **The question we send is exactly what a customer would type.** We never add instructions to it,
   because that would change the answers away from what real users see. [Sep 28 cost work]

### Hands-off
8. **Bryan does no fulfillment and no terminal work.** Offers that need his hours or manual filing
   get cut or automated. He enters secrets himself; Claude never handles their values. [Sep 26, Sep 28]
9. **Identify, don't fix, on the big platforms.** We find the Google, Apple, Yelp, Bing and Facebook
   problems and give the exact fix. The owner makes the change. No directory submissions. [Sep 26]
10. **Never start a scan or spend money the visitor didn't ask for.** [Sep 28: an abandoned checkout
    was auto-running a free scan]

### The funnel
11. **Free proves there's a problem; $49 explains it and fixes it.** The free report gives the
    verdict. The evidence and the fixes are paid. [Sep 26 rebalance]
12. **Free and paid are separate paths.** Paid clicks go to `/checkout`, then Stripe. Free visitors
    see value first and are upsold from their report. [Sep 27–28]
13. **Ask for email after the visitor sees value, and make it optional.** [Sep 24]
14. **Fewer fields; infer instead of asking.** The hero asks for a website only. Name, area and kind
    of business come from the site and Google. [Sep 25 → Oct 2]
15. **A paid page has one decision on it.** One CTA wording, the price only on the button, no
    "Questions?" lines, and no cross-sell next to the main offer. [Sep 29]
16. **Someone who has paid wants to act.** Order fixes by impact as a checklist; explain how and why
    in plain words; pre-build everything we can so they only verify. [Oct 2]
17. **Write for "a plumber with a high-school degree."** Plain words, no jargon, no repetition. [Sep 28]
18. **Fit fixes and copy to the business type** (office, trade or storefront). No "open now" or
    storefront advice for an agency. [Oct 2]

### Cost
19. **Accurate, not premium.** Tune effort and search limits before changing models; measure with a
    real A/B before deciding. [Sep 28: Claude at medium effort with 3 searches, half the cost, same picks]
20. **Prefer a free script to a paid API call.** Track the real cost of every call in Supabase so
    `/admin` stays truthful. [Sep 24, Oct 2]
21. **No upgrade until it's needed**, and once it is, upgrade without hesitating. [Workers Paid: delayed on Sep 24, bought Sep 28]

### Engineering process
22. **Every change is a PR into `master`.** Never push to a merged branch. Never deploy from a branch. [Sep 28]
23. **Nothing is done until it's verified.** Write a router-level test, show it fails without the
    change, get `npm test` and `npm run check` green, click through the PR preview, and say plainly
    what wasn't verified. See `CLAUDE.md`. [Sep 28: the Cancel 404]
24. **Use adversarial review as a gate.** Builders, then independent critics, then a fact-check
    against live code and data. Bryan sets numeric bars ("show me when it scores 9+"). [Sep 24 onward]
25. **Fetch `origin/master` before comparing or deploying.** Other sessions land work there. [Sep 25, Sep 29]
26. **Merge one PR at a time**, then confirm the newest change is live. [Oct 2 deploy race]
27. **This file is updated in every PR.** [Oct 2]

---

## 3. How the big things evolved

### Offer ladder
| Date | Ladder | Why it changed |
|---|---|---|
| Sep 23 | Free report → $29 "full version with fixes" | Original brief. |
| Sep 24 | $29 / $59 / $69 / $199 in Stripe | First ladder. |
| Sep 24 (eve) | Only $29 Fix steps and $59 Fix + re-check on sale | "Only sell what we can deliver": no monthly scheduler existed, and $69/yr lost money. |
| Sep 25 | Free → **$49 X-Ray** → $499 Overhaul ("coming soon") | An outside offer review; a checkable "3 things to fix" guarantee. $29 and $59 retired. |
| Sep 25 | Free Snapshot (3 questions) → $99 Audit → $499 Be the Answer | Offer v2.3 (PR #1). |
| Sep 25 | Audit **$99 → $49** | "$99 feels high." Scans cost about $4–5, and $49 is an impulse buy. No fake strikethrough. |
| Sep 26 | + $149 Fix Kit; free 30-day re-scan (the $19 add-on was dropped) | Hands-off files the owner verifies; the re-scan shows who to pitch $499 to. |
| Sep 27 | Fix Kit **folded into $49**; +$25 Competitor Breakdown; BTA put on sale | PR #5, own checkout. |
| Sep 28 | Homepage shows two offers; **BTA off sale**; `/checkout` page with the $25 bump | "BTA isn't working correctly"; the paid path felt broken. |
| Sep 29 | $25 Breakdown rebuilt as the Match List, still an add-on | Keep costs low; fold it into the $49 later. |
| Oct 2 | BTA hidden from audit buyers; "Do it for me" request hook | Done-for-you interest; BTA not ready. |

### Be the Answer ($499)
It started as a hands-on "Front Door Overhaul". It became a fix-it tier with "The Accuracy Guarantee"
(work free until listings are accurate). On Sep 26 that guarantee was dropped, along with directory
submissions and the Google Business Profile API (we can't hold our own GBP as an online-only
business), leaving an "identify, not fix" plan: 3 towns, 12 monthly re-scans, competitor alerts and
monthly Google post text. PR #5 then put a 60-Day Guarantee and a 30+ directory checklist back on the
card. That conflict was never settled, and BTA was taken off sale on Sep 28 and hidden on Oct 2.
**Lesson:** a big package was promised before its fulfillment was proven.

### Hero and homepage
"Customers ask AI. Do you show up?" (Sep 23) → "When someone in {Town} asks AI who to call, does it
say your name?" (Sep 25) → after 3 rounds of writers against critics, "Your customers are asking AI
now. Is it sending your calls to someone else?" with a real answer card (Sep 25, scored 9/10) → the
card shows the **loss**: who got the call in green, "Not mentioned" in red (Sep 28) → a single form in
the hero (name and website; ZIP worked out automatically) → **website box only**, with the rest
inferred (Oct 2). Each step cut fields or words and moved the pain closer to the top.

### Free report form
Name, trade, town and ZIP with email after (Sep 24) → name, website and ZIP, with the trade guessed
(Sep 25) → no trade step, any kind of business (Sep 27, after a bakery had no option to pick) →
name and website, ZIP worked out automatically (Sep 28) → website first, area instead of ZIP, office
questions (PR #41, Oct 1) → website box only (Oct 2). PR #41 also found that a leftover CSS rule had
hidden every free result since Sep 28: 9 requests and 1 page view.

### Report page
Restyled while keeping the data and lock logic (Sep 28). A full redesign mockup was rejected for its
contrast. Then: a plain-language "Your result" at the top, rivals highlighted in amber, "Who got the
call instead" moved up, a slim report-only header, and a navy closing offer card with one amber button
(Sep 29; phone page cut from 8,430 to 5,060 px). The paid version became an **action plan checklist**
(Oct 2: an adversarial reviewer scored it 3 → 9 over four rounds), followed by evidence, then offers last.

### Fix Kit
A $149 standalone zip the owner verifies (Sep 26) → included in the $49 (Sep 27) → **pre-built**,
so the owner checks 6 details and downloads (Oct 2) → builder-specific steps for 13 site builders →
AI prefill that must quote the owner's site and cite a concrete fact, with slogans rejected →
split into "do these yourself", "for your web person" and "after it's live" → a "Do it for me" box.

### Engines and cost
Five engines were built: ChatGPT, Claude, Gemini, Google AI Mode and Perplexity. Launch used 3
(Sep 24), with 1 run per engine plus one re-ask of the headline question. Claude Sonnet 5 extracts
the answers. Full scans first ran from Bryan's PC, to avoid paying for Workers Paid. Gemini credits ran
out without anyone noticing (Sep 27), which led to a fallback engine and credit alerts. Workers Paid
was bought and auto-scan turned on (Sep 28). Claude at medium effort with 3 searches halved its cost.
Gemini's free searches now count as $0. The paid audit added 2 questions (+$0.34 a scan) to make it
"as detailed and accurate as possible".

### Outreach and attribution
The plan was postcards against cold email (Sep 24). Resend is for transactional mail only, because
cold email is against its policy (Sep 26). Email tracking uses a generic `ref` token that postcards
can reuse later and that never blocks the form (Sep 28). Then UTMs, and GTM forwarding events to GA4
(Sep 29). A send-only Gmail API sender was built with a manual Pause (Sep 29). **Outreach stays off
until the EXP-001 read on Oct 5.** The GA4 acceptance test is still pending.

### Process
Manual deploys (Sep 23) → production must match `master` → parallel agents with reviewers (Sep 24)
→ a PR for every change, auto-deploy on merge, no terminal for the owner (Sep 28) → CLAUDE.md
testing rules and the "Tests" GitHub check after the Cancel 404 (Sep 28) → a git worktree per session
→ side-by-side "live vs new" reviews → merge one PR at a time after the deploy race (Oct 2) → this
file (Oct 2).

---

## 4. Lessons learned (mistake → rule)

| When | What went wrong | Rule now |
|---|---|---|
| Sep 23 | A manual deploy outside git made production differ from `master` | Production = `master`, deployed only by merging. |
| Sep 24 | Keys put in Cloudflare *Build* variables; the running Worker never saw them | Secrets go in runtime Variables and Secrets. Non-secret config goes in `wrangler.jsonc`. Check `/api/health`. |
| Sep 24–25 | Adversarial review caught buy buttons that charged for nothing, a 7-day dedupe that leaked another business's paid report, and an admin login no browser could use | Run an adversarial review before every deploy. Paid content never carries over between requests. |
| Sep 24 | Offers promised work that couldn't be delivered ($29 had no real steps; $69/yr had no scheduler) | Only sell what we can deliver today. |
| Sep 25 | Site claimed a 5-platform listings check, "asked 3 times" and "every assistant", none of them built | Check every offer line against the code. Star anything that isn't live yet. |
| Sep 25 | The live site and the repo had drifted; a push would have wiped out the owner's offer v2.3 | Fetch and merge `origin/master` first. |
| Sep 26 | Paying only unlocked the old 3-question report | Payment starts the paid scan. |
| Sep 26 | Advised creating a Google Business Profile for AI Found Score (against Google's rules), then retracted | Check platform rules before recommending. |
| Sep 26–27 | Two agents rewrote the same DB trigger; 11 unpushed commits diverged from master | Push early; master is the base; never re-run old migrations. |
| Sep 27 | Gemini credits ran out without anyone noticing, and scans looked green with an engine missing | Fallback engine, credit alerts, and a banner on `/admin`. |
| Sep 27 | `AUTO_SCAN` off meant every free report waited for a manual "Run now" | Hands-off claims must be checked end to end. |
| Sep 28 | Deployed from a stale, already-merged branch, which reverted PR #9 in production | Every change is a PR into master. Never deploy from a branch. |
| Sep 28 | Gave PowerShell 5.1 `&&` commands that silently did nothing | No terminal commands for the owner. |
| Sep 28 | Said auto-deploy wasn't connected; the build was just queued (about 8 min) | Check build status and timing before saying it's broken. |
| Sep 28 | **The admin Cancel button 404'd in production** (route missing from the allow-list; only the handler was tested) | Router-level tests, proof each test fails without the fix, and the "Tests" CI check (CLAUDE.md). |
| Sep 28 | The test site "garage" ran a full-cost scan | Check the website and name before any scan or checkout. |
| Sep 28 | The name matcher missed "Glenn Wayne Bakery Outlet" (7/9 shown, really 9/9) | Test matcher variants; a public sample must be right. |
| Sep 28 | Several sessions in one folder switched branches under each other | Use one worktree per session; check which branch you're on. |
| Sep 28 | The first report mockup had invented checks, fix titles and guarantee wording | A fact-check agent compares every mockup to the API and code before the owner sees it. |
| Sep 29 | CSS blur left locked text readable in the page | Locked items are bars with no text in them. |
| Sep 29 | The first Match List credited negations and complaints as strengths | Precision-first audits until ~97%. Mutation-test each rule. |
| Sep 28–Oct 1 | A leftover CSS rule hid every free result from Sep 28 to Oct 1 | Test the full flow from the visitor's side, not just the API. |
| Sep 29 | Claimed "9 extra commits" from a stale local master | Compare against `origin/master`. |
| Oct 2 | Called a B2B PR agency "not core"; storefront assumptions were everywhere | B2B firms are core customers. Gate fixes and copy by business type. |
| Oct 2 | Filler sold as deliverables ("X is a Y in Z" ×8; "12 fixes" was really 6) | No boilerplate posing as content. Count fixes honestly. A blank beats a slogan. |
| Oct 2 | Mock "unlocked" data was shown without a label, and the owner thought it was real | Label mock data clearly. |
| Oct 2 | Merge-when-green merged before CI ran (no required checks) | Watch the checks yourself; turn on branch protection. |
| Oct 2 | Two merges seconds apart: the older build finished last and overwrote the newer | Merge one at a time; check the live page for the newest change. |
| Oct 2 | Real reports return 500 on PR previews | Click through `sample-001` on previews; never commit real customer data (the repo is public). |
| Recurring | sed, heredoc and quoting mangled edits | Use the Edit tool for multi-line changes; write scripts to files. |

---

## 5. How Bryan works (so agents don't have to ask)

- **Wants an operator, not an assistant.** "You are running this business completely independent."
  He checks dollars on `/admin`. Claude still asks before anything that sends, publishes, spends
  money, or touches keys.
- **Options with a recommendation, then he decides.** He invites pushback ("if I'm wrong say that",
  "consider all sides"). He brings in outside critiques and expects them sorted into agree, partly,
  and disagree.
- **Rated review loops.** Writers against critics, scored out of 10, looped until they reach 9+.
  He likes persona and skeptic role-play.
- **Show, don't tell.** Side-by-side "live vs new" pages and screenshots.
- **Terse instructions.** One line, often informal. Claude carries the context and reports back
  briefly with what was verified.
- **Batches work.** "One agent at a time, same PR, one build."
- **Clean visuals.** He rejects low contrast, clutter, fake buttons and over-clever fixes; the
  simplest option usually wins.
- **Pain-led positioning,** but honest. He'll sometimes push on an honesty rule (a dynamic date,
  claims with nothing behind them yet); Claude holds the line on anything false and offers an alternative.
- **Hard formatting rules:** every $ on `/admin` shows 2 decimals; no prices on the About page.

---

## 6. Open questions (keep this list current)

1. "Do it for me": price range, reply deadline, named person, and how it fits the hands-off rule.
2. Be the Answer: rebuild, rescope or retire. Includes the leftover 60-Day Guarantee/directory copy from PR #5 on the refunds and privacy pages.
3. Should the $25 Competitor Breakdown be folded into the $49? And is it the right upsell for B2B firms?
4. Should the free report unlock 1–2 real fix titles as a teaser?
5. Trust signals: a named person, a phone number, a screenshot of the paid report.
6. Email: the GA4 acceptance test, a live Gmail test send, then the EXP-001 read on Oct 5 decides the winning version and whether to turn `GMAIL_OUTREACH` on.
7. GitHub: turn on branch protection with required checks, and "Allow auto-merge".
8. Unproven claims kept by owner decision ("Most popular", "Most owners still find…"). Revisit once there's data.
9. Weekly showcase answers (`scanner/showcase.js`) are not scheduled, so the hero falls back to Mega Wash.
10. Footer legal name: "GetAiFound Score" or "AI Found Score".
11. Features merged but not yet seen on real data: AI prefill on a paid kit, the directory "listed" check, the small-firm questions, and "Do it for me" emails.

---

## 7. Decision log (newest first)

Add new entries at the top of this section. Format:
`### YYYY-MM-DD · Area · Short title (PR #n)`, then **Decision**, **Why**, **Replaces** (if any).
When a decision changes, add a new entry and mark the old one `**Superseded by …**`. Don't delete it.
The history is the point.

### 2026-10-02 · Process · Operating Bible started; every PR updates it
**Decision:** `docs/DECISIONS.md` records decisions, reasons, how they changed, and lessons learned. CLAUDE.md requires an update in every PR; a "Decision log" GitHub check fails without one (label `no-decision-log` for PRs with no decision, like dependency bumps).
**Why:** Bryan wants the reasoning behind the project kept in one place that every agent reads, so it isn't lost when a chat ends.

### 2026-10-02 · Product · "Open spot" answers (PR #62)
**Decision:** When AI names no one, show it as an amber "Open spot". The score is unchanged. Directories don't count as a named business. "Pending check" replaces the repeated badge.
**Why:** These answers are the easiest to win. We partly disagreed with a critique that they shouldn't count against the score.

### 2026-10-02 · Product · Fix Kit prefill must be factual (PRs #56, #61)
**Decision:** One Claude call per kit drafts the blanks from the owner's own site. A draft is dropped unless it quotes the site word for word and cites a concrete fact. Taglines are rejected. Nothing is used until the owner clicks "Use this".
**Why:** "Effortless and massive value", without filler. A blank beats a slogan.

### 2026-10-02 · Offer · Be the Answer hidden from audit buyers (PR #60)
**Decision:** BTA removed from the kit files, the 30-day email and the error copy. Existing plans are untouched.
**Why:** It's off sale; mentioning it confuses the people who just bought.

### 2026-10-02 · Offer · "Do it for me" request hook (PR #57)
**Decision:** A box on paid kits emails us a request with full context. "Asking is free". No passwords; we're added as a manager or collaborator instead. At most one request per kit per day.
**Why:** Bryan was intrigued by done-for-you. Personas would pay $100–300 one time. Price not set yet.

### 2026-10-02 · Product · Fix Kit value pass (PR #55)
**Decision:** Real Google category, time and cost on each job, `check-it-worked.txt`, review-request templates. "Drafted for you", not "Already written for you".
**Rejected:** a required phone field at checkout (friction on a $49 buy).

### 2026-10-02 · Product · Directory checks and "Why AI picked them" (PR #54)
**Decision:** A curated list of ~30 directories with checked join costs. Gemini search-grounding confirms a listing only when Google returns the profile page. Answers are collapsed under "The proof". There's no raw markdown.
**Why:** "Don't leave 'not checked'"; "ideally a script for free".

### 2026-10-02 · Product/Cost · Small-firm questions on the paid audit only (PR #53)
**Decision:** +2 questions (small/boutique firm and their specialty). Paid audit cost goes from ~$0.95 to ~$1.29. Free stays at 3 questions.
**Why:** "As detailed and accurate as possible" for paid; keep free cheap.

### 2026-10-02 · Product · Paid audit round 2: pre-built kit and builder steps (PR #52)
**Decision:** "Do these 3 this week", who/time/cost on each step, a free re-check date card, the $25 offer last, a pre-built Fix Kit (verify 6 details), click-by-click steps for 13 site builders, share and PDF.
**Rejected:** promising a score lift.

### 2026-10-02 · Product · Paid report = action plan checklist (PR #51)
**Decision:** After the score: numbered steps ordered by impact, with tick boxes and who/why/how. Evidence comes next, offers last. Fixes are gated by business type.
**Why:** "They just paid, they are ready to … solve the issues." The page scored 3–4/10 before; the adversarial reviewer scored the final version 9.
**Also:** B2B and professional firms are **core** customers (Claude had wrongly said otherwise).

### 2026-10-02 · Ops · Every $ on /admin shows exactly 2 decimals (PR #49)
**Decision:** A hard rule. Use `usd()` in `src/admin/metrics.js`.

### 2026-10-02 · Ops · Admin "Find report" with manual unlock (PRs #49, #50)
**Decision:** Paste a link to see status, payments and per-scan cost. Unlock writes a Stripe-shaped payment row. A $0 unlock is a comp (no revenue, no re-check). The full audit run is opt-in and its cost is shown.
**Why:** To upsell a free-report holder and keep costs tied to that business.

### 2026-10-02 · Product · Find my report (PR #48)
**Decision:** The browser remembers the last real report opened. "Email me my link" gives the same response whether or not a report exists.
**Rejected:** looking a report up by business name (the token *is* the access control).

### 2026-10-02 · Product · Hero shows only the website box (PR #47)
**Decision:** After the site check, show one confirmation line with "Change", or prefilled boxes if something wasn't found.
**Replaces:** the four stacked boxes.

### 2026-10-02 · Copy · About page: founder note, AI-run business, no price (PR #46)
**Decision:** The founder's story, a "how we're different" section, and an open statement that the business is run largely by an AI agent. A test fails if a `$` appears on the page.

### 2026-10-01 · Product · Free report results visible again; website-first form; office questions (PR #41)
**Decision:** Removed a CSS rule that had hidden results since Sep 28. One step, website first. "Area" instead of ZIP. Professional firms get "Top rated {kind} in {town}" questions.
**Why:** The first B2B request showed the flow broke for businesses that don't have a ZIP or storefront.

### 2026-09-29 · Tech/Outreach · Gmail API send-only sender, off until EXP-001 (PR #34)
**Decision:** Scope `gmail.send` only, a manual Pause on `/admin`, a cap of 150/day, logs in `gmail_sends`.
**Rejected:** read and Postmaster scopes. Bryan watches complaints by hand.

### 2026-09-29 · Marketing · Email UTMs + GTM → GA4; no `cta_click` on nav/hero (PR #33)
**Decision:** `/e/click` adds UTMs and the email token. GTM Version 3 forwards 19 site events. `cta_click` stays reserved for the $49 button on real reports.
**Why:** Adding it elsewhere "would just muddy the taxonomy".

### 2026-09-29 · Copy · Checkout add-on box: one line + listed contents (PR #32)
**Decision:** Cut the $25 box from about 60 words to one line. The order summary lists the 4 items it includes.

### 2026-09-29 · Product · Competitor Breakdown rebuilt as the Match List, still +$25 (PR #30)
**Decision:** A rival scorecard, "you match X of 8", "do these first", verbatim quotes. A tick counts only when the same sentence names that business.
**Why:** The old version was thin. "Keep it less costs now and an upsell; eventually fold it in."

### 2026-09-29 · Copy · Report offer: one decision (PR #29)
**Decision:** Cut "Why AI skips you", the Gemini example link (added, then reversed), "Questions?" lines, every BTA/$499 mention and "$49 one time". A navy card with one amber button.

### 2026-09-28 · Product · Report page elements; plain-language result (PR #28)
**Decision:** Keep the original look and add 4 elements: a sticky phone CTA, "Who got the call instead", cited sites, and a website meter. "We asked AI 6 times. It never mentioned you." Rival highlighted in amber.
**Rejected:** a full redesign mockup ("colors are off and contrast is difficult").

### 2026-09-28 · Marketing · Email arm tracking with generic `ref` token (PR #27)
**Decision:** Clicks are the trusted metric. Optional, non-blocking `ref` → `report_requests.ref_token`. Redirects only to our own domain.
**Why:** "Tracking must never risk breaking the money path." Postcard QR codes will reuse it.

### 2026-09-28 · Copy · Homepage: no time promises, rebuilt How it works, no Admin link (PRs #25, #26)
**Decision:** "It's instant, we upgraded", so every "one business day" line went. No fake buttons in pictures.
**Kept by owner decision:** "Most popular" and other unproven lines, for now.

### 2026-09-28 · Copy · Hero card shows the loss; one form in the hero (PRs #21, #23)
**Decision:** "AI sent this customer to" (green) and "Not mentioned" (red). Name and website only, ZIP worked out automatically. "Based in Plainview, NY" removed ("it limits us"). Glenn Wayne Bakery is the second public sample.
**Refused:** a fake "today" date on a real answer.

### 2026-09-28 · Process · CLAUDE.md testing rules + "Tests" CI check (PR #22)
**Decision:** A router-level test for every route or button, shown to fail without the fix. Tests and check pass before merge. Preview click-through. Say plainly what wasn't verified.
**Why:** The admin Cancel button 404'd in production.

### 2026-09-28 · Cost · Claude engine at medium effort, max 3 searches (PR #20)
**Decision:** Cut Claude's cost 51% with the same picks in a real-API A/B test.
**Rejected:** Haiku, and adding instructions to the question (both make answers drift from what users see).

### 2026-09-28 · Product · One locked teaser instead of five; offer band built on findings (PRs #18, #19)
**Decision:** The offer opens with this business's own findings, and the guarantee shows the number of problems found.

### 2026-09-28 · Cost · Gemini free searches count as $0; site/name gate; checkout rows apart; Cancel (PR #17)
**Decision:** The first 5,000 Gemini searches each month are $0 on `/admin`. Junk websites and names are blocked before a scan. Unpaid checkouts get their own list and a Cancel button. Abandoned checkouts never start a scan on their own.

### 2026-09-28 · Process · Auto-deploy on merge; README says so (PR #16)
**Decision:** Workers Builds deploys `master` after `npm ci && npm test`. The owner does no terminal work.

### 2026-09-28 · Cost · Costs and break-even on /admin (PR #15)
**Decision:** A `FIXED_COSTS` list with start dates (Workers Paid $5/mo from Sep 28). One sale pays for about 82 free reports.

### 2026-09-28 · Cost · Free scans: 3 per connection per day (PR #14)
**Decision:** Hashed, with no IP stored. The 4th waits for a manual Run now.

### 2026-09-28 · Ops · Workers Paid + AUTO_SCAN on; Stripe cancel returns to /checkout (PR #13)
**Decision:** Free reports run within minutes. Cancelling keeps the details and offers the free snapshot, but never starts one on its own.

### 2026-09-28 · Copy · 30-day re-check stays on the card; guarantee once on checkout (PR #11)
**Rejected:** hiding the re-check to reveal it at checkout as a "$49 value" (not a real price; most drop-off happens at the card).

### 2026-09-28 · Product · `/checkout` page with +$25 bump; BTA off sale (PR #10)
**Decision:** Paid clicks go to a dedicated page with security badges by the pay button.
**Why:** The paid button swapping the free form's text "looked broken". "BTA isn't working correctly… so it's clear, just two."

### 2026-09-27 · Ops · Launch checker rounds; refunds take access back (PR #9)
**Decision:** Paid-scan alerts, retries, llms.txt, unsubscribe confirmation, a health check that shows the Stripe mode.

### 2026-09-27 · Product · Free and paid paths split; fallback engine; credit alerts (PR #8)
**Decision:** Paid visitors go to checkout before a report exists. Free visitors get their answer, then an upsell. ChatGPT answers live when Gemini fails. Credit alerts go to both of Bryan's inboxes.
**Why:** "If someone wants to pay we should be taking them for paid." Gemini ran out of credits without anyone noticing.

### 2026-09-27 · Product · No trade step; any kind of business (PR #7)
**Why:** A bakery had no option to pick ("this is a bad step"). The kind of business is now inferred from the name or the website.

### 2026-09-27 · Tech · Master is the base when branches diverge (PR #6)
**Decision:** Port only the missing pieces from the stale branch; no DB changes.

### 2026-09-27 · Pricing · Fix Kit inside $49; $25 Breakdown; own Stripe Checkout (PR #5)
**Decision:** Checkout Sessions with a restricted key. All Payment Links switched off. Trust row at every buy point.
**Note:** PR #5 also added a 60-Day Guarantee and a 30+ directory checklist to BTA, which conflicts with the Sep 26 scope (see Open questions).

### 2026-09-26 · Product · Be the Answer = identify, not fix; no guarantee; 3 towns
**Decision:** No directory submissions, so no Accuracy Guarantee. No GBP API. Monthly Google post text instead. The Competitor Breakdown is included in $499.
**Why:** Big platforms need the owner's login; promise only what's automated.

### 2026-09-26 · Product · Free/paid rebalance; free 30-day re-scan; Fix Kit; Resend (PRs #3, #4)
**Decision:** Free shows the verdicts and $49 shows the evidence and fixes. Paying starts a fresh scan. The re-scan is free and automatic, and shows who to pitch BTA to. Resend sends transactional mail only, from the `mail.` subdomain.
**Why:** "Not so heavy for free." Bryan doesn't want to be involved in fulfillment.

### 2026-09-25 · Pricing · Audit $99 → $49; AI Found Score 0–100
**Decision:** $49 is an impulse buy. The score weights: named 50, named first 25, facts right 15, own site cited 10. It's footnoted as our own measure.
**Rejected:** a fake "~~$99~~" strikethrough and invented value anchors.

### 2026-09-25 · Copy · Hero "Is it sending your calls to someone else?" (PR #1 + hero v5)
**Decision:** Option A after 3 rounds of writers against critics (9/10). A real dated answer card. A live ask behind the CTA.
**Rejected:** "stopped Googling" (an overclaim) and made-up sample businesses.

### 2026-09-25 · Pricing · Free → $49 X-Ray → $499 "coming soon"
**Decision:** $29/$59 retired. The guarantee is "3 things to fix or it's free". Refunds are done by Bryan in Stripe, never automatically.

### 2026-09-24 · Pricing · Only sell what we can deliver today
**Decision:** $69 Full Year and $199 off sale (no scheduler; underpriced).

### 2026-09-24 · Cost · /admin dashboard; no Workers Paid yet; scans from the PC
**Decision:** Real cost per scan stored per API call. Money, engine value and funnel all on `/admin`.
**Why:** "I can log in and see the status of $." "Don't upgrade until it's needed."

### 2026-09-24 · Product · Engines: 5 built, 3 at launch; 1 run + headline re-ask; Claude extracts
**Decision:** Engines are included automatically when a key exists. Marketing copy names no assistants and gives no counts.
**Why:** Cost. Perplexity and DataForSEO weren't needed to start.

### 2026-09-24 · Product · Email after value; real sample report (Mega Wash & Dry)
**Decision:** Show the questions first, then ask for email (optional). The real report is shown with the owner's permission, never a fake labelled "real".

### 2026-09-24 · Tech · Test-ready infrastructure: short codes, server-side lock, visit log, `/stop`
**Decision:** Fix details are withheld on the server until paid (CSS blur rejected). Stripe is attributed with `client_reference_id`. Live and test webhook secrets both work, and every payment is tagged with its mode.

### 2026-09-23 · Tech/Copy · Launch: Cloudflare Worker auto-deploying `master`; sourced stats only
**Decision:** Nameservers at Cloudflare. Secrets in the Worker. Short, direct copy. Every homepage stat links to its source. CAN-SPAM address in the footer.

---

## How to update this file

Do this in every PR, before asking for a merge:

1. **New decision?** Add an entry at the top of section 7: date, area, title, PR number, then
   Decision, Why, and Replaces/Rejected. Decisions include product, pricing, copy rules, cost and
   process choices, and anything Bryan said yes or no to.
2. **Changed an old decision?** Add the new entry, and append `**Superseded by YYYY-MM-DD …**` to
   the old one. If it affects a big topic, update the matching part of section 3.
3. **Something went wrong or nearly did?** Add a row to section 4 with the rule that prevents it.
4. **Answered or raised an open question?** Edit section 6.
5. **Changed what's on sale, prices, costs or the stack?** Update section 1.
6. **Truly nothing to record** (a dependency bump, a typo)? Add the `no-decision-log` label to the PR.
