# AI Found Score: Operating Bible

This file records what we decided, why we decided it, how each decision changed over time, and what
we learned along the way. It is the source of truth for the reasoning behind the product. The code
shows *what* the product does; this file explains *why*.

- **Starting a new offer or idea?** Run it through [section 2, the Offer Playbook](#2-the-offer-playbook-how-we-decide-what-to-sell-and-how-to-sell-it) first.
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

## 2. The Offer Playbook: how we decide what to sell and how to sell it

This section is the reusable part. **The bar for every offer: exceptional value, incredibly easy to achieve** (2.1). It records the **theory** behind our offers, the **questions**
we used to pressure-test them, **what each question caught**, and a **template** for running a new
idea through the same process quickly. If we start another product, service or offer, start here.

> Scores quoted below come from AI reviewer and persona role-play, not real customers. They show
> direction, not demand. Real sales data replaces them as soon as we have it.

### 2.1 The bar: exceptional value, incredibly easy to achieve (Hormozi's value equation)

Every offer must be so good that saying no feels stupid, and so easy that the buyer can't fail.
We measure that with Alex Hormozi's value equation:

```
            Dream outcome  ×  Perceived likelihood of achieving it
Value  =  ─────────────────────────────────────────────────────────
                  Time delay  ×  Effort and sacrifice
```

Push the top up and the bottom toward zero. The bottom is usually where the easy wins are: cutting
time and effort raises value faster than adding more stuff. **Price isn't in the equation.** We raise
value until $49 looks like a mistake on our part, not until the price feels fair.

**The four levers, applied to us**

| Lever | What it means here | What we already do | Where we're still weak |
|---|---|---|---|
| **Dream outcome ↑** | "When customers ask AI who to call, it says *my* name." | Lead with their loss in their own town and trade (Law 4); "Take the call back from {rival}" | We can't promise the outcome (Law 7), so we sell the clearest path to it and the proof it moved |
| **Likelihood ↑** | "I believe this will work *for me*." | Their own real data, not a pitch; real sample reports; a countable money-back promise; a 30-day re-check that shows what changed; honest limits | No testimonials or before/after case study yet; no named person on the report |
| **Time delay ↓** | "How soon do I see something?" | The report opens instantly; "Do these 3 this week", quick wins first; time shown on every step | The proof of change arrives at day 30 |
| **Effort and sacrifice ↓** | "How much work, risk and hassle is this for me?" | Website-only form; pre-built Fix Kit; AI prefill from their own site; click-by-click steps for 13 site builders; no logins or passwords; "Do it for me" | The website part still needs a web person; "Do it for me" has no price yet |

**How to build a Hormozi-style offer the honest way**

1. **List every obstacle the buyer will hit**, before, during and after buying. Examples: "I don't
   know what's wrong", "I don't trust AI stuff", "I don't have time", "I don't know how to edit my
   site", "I'll do it wrong", "will it even work?", "what if it's a waste of $49?"
2. **Turn each obstacle into a solution**, and each solution into a deliverable:
   - "I don't know how to edit my site" → builder-specific clicks.
   - "I'll get it wrong" → pre-built files I only verify.
   - "Will it work?" → a re-check in 30 days.
   - "A waste of money?" → fewer than 3 problems found, money back.
3. **Trim and stack.** Keep what's high value to the buyer and cheap for us to deliver (software,
   templates, AI drafts checked against their site). Cut what's low value or needs our hands (Law 8).
   Stack what's left so the offer is plainly worth far more than its price, using **real** numbers only
   (Law 6).
4. **Make it easy at every step.** Every field we ask for, click, login and decision is a cost.
   Infer it, prefill it, or do it for them. If a step can't be removed, show who does it, how long it
   takes and what it costs.
5. **Reverse the risk.** A guarantee the system can count, offered only when it can't trigger by
   design (Law 7). Say plainly what we *don't* promise; it raises belief.
6. **Real enhancers only.** Urgency and scarcity must be true. An industry list's entry deadline is
   real urgency; a countdown timer isn't. A bonus must be a real deliverable (the 30-day re-check),
   never a made-up "$X value". A name says the outcome without promising it ("AI Visibility Audit").

**Where Hormozi and our rules meet.** His method assumes the value stack is real. Ours makes that
non-negotiable. If an enhancer would need a fake number, a fake deadline or an outcome promise, drop
it and find value on the bottom of the equation (less time, less effort) instead. That's where we've
won every time:

| Move | Lever |
|---|---|
| Website-only form | Effort |
| Instant report | Time |
| Pre-built kit | Effort |
| "Do these 3 this week" | Time |
| Builder-specific steps | Effort |
| "Do it for me" | Effort |

**The value scorecard (run it before any offer ships)**

Score each lever 1–10 from the buyer's side, with a skeptical-buyer persona and then real data:

- Dream outcome: is it stated in their words, about their business?
- Likelihood: what proof do they see that it works *for them*?
- Time: what do they get in the first 5 minutes? The first week?
- Effort: count the fields, clicks, logins, decisions and "now find someone to…" moments.

**Ship only when every lever scores 8 or more and the whole offer reads as a no-brainer at its price.**
The lowest lever is the next thing to fix. Right now that's likelihood (no proof stories yet) and
effort (the website part needs a person).

### 2.2 The theory: twelve laws we learned the hard way

Each law gives the rule, why it works, and where we learned it.

**Law 1: Only sell what you can deliver today.**
A promise the system can't keep costs a refund, trust and support time, and it's a legal risk.
*Learned:* on Sep 24 we checked every plan against the code. $29 had no real fix steps (Mega Wash had
1 fixable issue, so its guarantee would have triggered). $69 "Full Year" had no scheduler and was
$10 for 11 months of work. $199 needed hand labour. Two of the four came off sale that night. On Sep
26 Be the Answer could deliver 3 of its 8 promises, so it stayed "Opening soon". It came off sale on
Sep 28. Bryan: *"your call, it's your business."*

**Law 2: Free diagnoses; paid cures.**
The free report proves there's a problem: the verdict, who won, one real answer as proof, the
score, and a *count* of problems. A count creates pull; problem titles are almost the fix itself.
The paid audit explains every problem and fixes it. *Counterweight:* if free gets too thin, nobody
trusts the $49. *Learned:* Sep 26. The free report gave away every answer and check detail, so the
$49 added only instructions, and the "nothing new? it's free" promise was at risk. Bryan:
*"it seems out of whack… not so heavy for free."*

**Law 3: Proof before promise, and only real proof.**
An unaware buyer needs to *see* the problem before any pitch. The hero shows a real AI answer for the
visitor's own trade and town, with real competitors named. Every number traces to a stored scan, and
missing data drops the line instead of guessing. Copy tests we use: can you picture it, can you check
it, could no one else say it? *Learned:* hero rounds, Sep 25 and Sep 28.

**Law 4: Sell the loss, and make the reader the loser.**
"Is it sending your calls to someone else?" Show who *got* the call (green) and "everyone else: not
mentioned" (red). The reader works out the loss for themselves; we never claim "you're losing
customers". We never show a real business losing without its permission. *Learned:* Sep 28. The card
had shown Mega Wash *winning*, which reads as "nice for them". On the report page, the rival's name
in amber turned "an abstract 0 into a named villain". Bryan: *"we are pitching is it sending your
calls to someone else."*

**Law 5: The entry price is an impulse price, anchored to a real loss.**
$49, not $99 ("makes them stop and think") and not $29 ("signals cheap tool"). The anchor is
"less than one missed service call", never a crossed-out price. *Learned:* Sep 25. A scan costs a
few dollars at most, so $49 is mostly margin. Bryan: *"$99 feels high… make it lower and such a
steal."*

**Law 6: Anchors and value stacks use real prices only.**
No "~~$99~~ $49" for a product never sold at $99, and no "$1,981 total value". Comparisons are
arithmetic on prices we actually charge ("12 re-scans at $49 = $588"). *Learned:* the Sep 25 offer
spec. Fake anchors are FTC risk, and they contradict our "every number is real" trust copy.

**Law 7: Guarantees must be countable, not triggerable by design, and capped.**
"Fewer than 3 problems specific to you → your $49 back within 30 days." The system counts it, and the
audit is offered only when the report already has 3 or more specific problems. A human approves
refunds. No guarantees of outcomes (placement, rank, score lift, calls). Names can't imply what we
don't promise: "Answer Guarantee" was renamed "Accuracy Guarantee", then dropped. *Learned:* Sep 25–26.

**Law 8: The owner's constraints shape the product. Design inside them.**
"I don't want to be involved" turned "we fix your listings" into **identify, don't fix**. "We post to
your Google profile" became a monthly ready-to-post email, and "we write it" became "pre-built,
owner verifies". Anything that needs a person (manual filing, approvals, "Run now") is a defect.
*Learned:* Sep 26. Bryan: *"keep [the] script to identify as part of the value we offer."*

**Law 9: Put each upsell at the moment of intent.**
- **Checkout bump:** one cheap-to-fulfil add-on, unticked (+$25 Competitor Breakdown).
- **After delivery:** the next rung, pitched from what the report found.
- **Day 30:** the free re-check shows what changed, and doubles as the natural pitch for more help.
- **Recurring plans:** never sold cold; only after delivery.
- **Not on a page that has a different job:** no $499 next to a $49 decision, no upsell above the
  action plan.

Bryan on the re-check: *"at least we will know who to easily upsell."* *Learned:* Sep 26–29, Oct 2.

**Law 10: Intent decides the path. Paid clicks go to checkout; free gets value first.**
Someone who clicks a price wants to pay, so give them a dedicated, distraction-free `/checkout`.
Someone who clicks free gets their answer, then the upsell. Never swap one form's text in place; it
reads as broken. *Learned:* Sep 27–28. Bryan overruled four critic agents: *"if someone wants to pay
we should be taking them for paid."* The known cost is that pay-before-report buyers may qualify for
a refund.

**Law 11: Every page has one job and one decision.**
- **Pages that sell:** one button wording, with the price only on the button. No "Questions?" lines,
  no cross-sell next to the main offer, no fake buttons in pictures.
- **Pages after purchase:** the job is action. Show the impact-ordered checklist first, with who does
  each step, how long it takes and what it costs. Evidence comes after, offers last.
- **Every page:** short first, click for more. Same meaning, details behind a toggle.

*Learned:* Sep 29 (report offer), Oct 2 (paid report; buyer feedback: "too much information to
start"). Bryan: *"they just paid, they are… ready to lock in solve the issues."*

**Law 12: Effortless beats DIY, and plain words beat precise ones.**
Pre-build everything, prefill from the customer's own site (quote it or drop it), and offer "Do it
for me" for the rest. Write so "a plumber with a high-school degree" understands it in 5 seconds:
"mentioned", not "named"; "times we asked AI", not "searches". Fit fixes to the business type: an
agency gets industry lists, not "open now" advice. *Learned:* Sep 28 to Oct 2. Bryan: *"effortless
and massive value."* Personas: the kit "hands owners a task list when they want a result."

### 2.3 The question bank: what we asked, what it caught, what it changed

These are the questions that changed the product. Ask them, in roughly this order, of any new offer.

**A. Value: is it worth paying for?**
| Question | Asked by | What it caught | What changed |
|---|---|---|---|
| "Where is the value? I can't find it easily." | Bryan, Oct 2 | Fixes 9 screens down, kit 16 down, filler counted as deliverables, "12 fixes" really 6 | Action-plan checklist first (PR #51). Ratings: value 3→8, ease 3→9 |
| "Be the Answer doesn't seem worth it, confirm." | Bryan, Sep 26 | $49 + $149 got the same files; the extra $300 bought ~$80 of work | BTA rebuilt as "keep you visible for a year", later taken off sale |
| "Do we build correctly for enough value for the two?" | Bryan, Sep 26 | Paying didn't run the promised 5-question scan; free gave away the paid evidence | Payment starts a fresh scan; free/paid rebalanced |
| "The Competitor Breakdown feels valueless." | Bryan, Sep 29 | A scoreboard of rival trivia | Match List: what they have that you don't, with evidence, and "do these first" |
| "Is it effortless? What does the buyer still have to do?" | Bryan + 3 personas, Oct 2 | Buyers want a result, not a task list | Pre-built kit, AI prefill, "Do it for me" (PRs #52–#57) |
| "What would you pay?" | Persona role-play, Oct 2 | $100–300 one-time; no monthly "AI stuff" ("SEO guys already burned me") | Done-for-you priced as a one-time quote; monthly not pushed |

**B. Truth: is every word true today?**
| Question | Asked by | What it caught | What changed |
|---|---|---|---|
| "Can we confidently deliver what we say?" | Bryan, Sep 25 | A 5-platform listings check claimed site-wide but never built | Claim removed; the real checks built the next day |
| "Push back if you don't agree." (on his own 8-point spec) | Bryan, Sep 25 | $1,981 value stack, invented "Tidewater" lost call, "asked 3 times" (false) | Real-math anchors; town-templated loss line; claims cut to what's delivered |
| "Make the date dynamic so it looks current." | Bryan, Sep 25/28 | A false date on the trust device itself | Refused; date removed from the fallback card instead |
| "Can we say we helped them?" | Bryan, Sep 28 | Not true yet | Refused; saved as a future true before/after story |
| Fact-check: OK / WRONG / INVENTED / MISLEADING for every claim | Fact-check agent, Sep 28 onward | Mockups with invented check names, fake fix titles, wrong guarantee wording | Every mockup is fact-checked against live data before Bryan sees it |
| "Safe to sell as 'every tick has evidence'?" | 3 accuracy audits, Sep 29 | Negations and complaints counted as strengths | Same-sentence rule; 97% precision; prefer a miss over a false claim |

**C. Deliverability and operations: can it run without us?**
| Question | Asked by | What it caught | What changed |
|---|---|---|---|
| "Can we deliver each plan today?" (promise / exists / deliverable / who unblocks) | Claude, Sep 24 | 2 of 4 plans undeliverable | Law 1 |
| "What's missing to launch? Verify we can handle the full offer." | Bryan, Sep 26 | The GBP API needs a profile we can't legitimately have; big platforms need owner logins | Identify-don't-fix; directory submissions and their guarantee dropped |
| "Can anyone pay for nothing, see paid content free, or run up our costs?" | Adversarial agent before each deploy | Buy buttons with no report; another business's paid report leaking | Payment tied to your own report; locked data removed on the server |
| "Does this need my hands?" | Bryan, every offer | Manual "Run now", manual filing, manual refunds | Automate it, cut it, or flag it (refunds are still manual) |

**D. Price, anchor and guarantee**
| Question | Asked by | What it caught | What changed |
|---|---|---|---|
| "$99 feels high. Make it a steal, with a checkout upsell?" | Bryan, Sep 25 | $99 is a considered purchase; unit cost is a few dollars | $49 + one bump |
| "Need a bigger anchor? Upsells between $49 and $499?" | Bryan, Sep 26 | Empty gap; an anchor must be something we'd really sell | Middle rungs mapped; no fake anchors |
| "Hide the re-check, reveal it at checkout as a '$49 value'? Consider all sides." | Bryan, Sep 28 | Most drop-off happens at the card; "$49 value" isn't a real price | Kept on the card as an outcome; tagged "Included" at checkout |
| "Is the guarantee something we can count, and can it trigger by design?" | Claude, Sep 25 | "Show you something you didn't know" was uncheckable | The 3-problem rule, offered only when 3+ exist |
| "How much would one more question add?" | Bryan, Oct 2 | $0.12–0.17 per question | Paid audit only (+$0.34 a scan, under 1% of $49); free stays lean |

**E. Funnel and placement: does the path match the intent?**
| Question | Asked by | What it caught | What changed |
|---|---|---|---|
| "Get the full audit feels broken and off-putting." | Bryan + 4 critics, Sep 27 | Every price button led to the free form; six competing CTAs; "every word" promised but locked | Separate paid path; one buy action per screen |
| "I cancelled. Shouldn't back go back, not give me a free scan?" | Bryan, Sep 28 | Cancel dumped buyers into something they didn't ask for | Back returns to a prefilled checkout; no unrequested scans |
| "When should the free report ask for email?" | Bryan, Sep 24 | An email gate before value | Questions shown first, email optional after |
| "This is a bad step." (trade picker) | Bryan, Sep 27 | The form blocked any business outside 8 trades | Infer the kind of business; ask only as a last resort |
| "Only show what's needed to make it easy and clean." | Bryan, Oct 2 | Four boxes up front | Website-only hero; the rest inferred |

**F. Clarity and design: does it land in 5 seconds?**
| Question | Asked by | What it caught | What changed |
|---|---|---|---|
| "Hero isn't wow, too much going on. Loop until 9+, give me 2 options." | Bryan, Sep 25 | Bait-like blurred answers, false "asked today" | Option A (9/10): a real answer card, live ask behind the CTA |
| "How does it become a 9/10?" | Bryan → critic, Sep 28 | The card read as someone else's problem; no tap target | "Your free report shows this for your business"; "Would it give yours?" |
| "Can a plumber with a high-school degree understand it?" | Bryan, Sep 28 | "named", "searches", an asterisk score essay | Plain words; "We asked AI 6 times. It never mentioned you." |
| "Have the agent rate the order." | Bryan, Sep 28 | The money moment was in section 7 | Result → who got the call → offer (order 6 → 8.5/10) |
| "What else is excessive?" | Bryan, Sep 29 | Duplicate CTAs; a 2,400 px offer; "Why AI skips you" | Cut; phone page 8,430 → 5,060 px |
| "Too much information to start." | A buyer, Oct 2 | A wall of evidence reads as work | Short first, click for more, on every page |

**G. Customer: who is this really for?**
| Question | Asked by | What it caught | What changed |
|---|---|---|---|
| "Is a B2B agency our customer?" (Claude said no) | Bryan overruled, Oct 2 | Storefront assumptions everywhere | B2B is core; fixes and questions gated by business type |
| "Does this fit a business outside the 8 trades?" (skeptical bakery-owner persona) | Critic, Sep 27 | Plumber-only "calls" framing | Trade-agnostic copy; any kind of business accepted |

### 2.4 The method: how we pressure-test (the loop)

1. **Write the promise table first.** For each promise: what exists today, can we deliver it, who
   unblocks it. Anything undeliverable is off sale or "coming soon" before any payment link exists.
2. **Build the smallest true version.**
3. **Send out independent reviewers, one role each**, read-only and in parallel: conversion/copy,
   design, fact-check, plain-language persona, skeptical buyer, order/structure, edge-case QA, and
   adversarial (abuse, leaks, cost). For pricing, add feasibility, product and buyer reviewers.
4. **Merge their findings into one ranked list.** Flag where they disagree, decide, and fix in one pass.
5. **Re-rate with fresh reviewers and loop until 9/10** on Bryan's rubric: *value, ease of use,
   clarity, design*. Present two options with scores and a recommendation; Bryan decides.
6. **Triage outside critiques as agree / partly / disagree.** Bryan: *"If I am wrong say that."*
7. **Show, don't describe.** A side-by-side "live now vs new" page.
8. **Ship behind tests and a preview click-through.** Then measure real behaviour (GA4 events,
   `/admin` funnel, cost per sale) and let data replace the role-play scores.

**Rubrics we actually used**
| Reviewer | Scores |
|---|---|
| Copy critic (hero) | 5-second clarity, wow, credibility, specificity, simplicity, CTA pull, rule compliance, owner fit. 9 = every rule passes, the proof is in the reader's own trade, nothing invented |
| Skeptical owner, 10 seconds | Grabs in 5 s? Feels real and personal? Drives the next step? |
| Fact-checker | Every claim: OK / WRONG / INVENTED / MISLEADING, plus "did anything locked leak?" |
| Plain-language persona | Words they'd misread (with replacements), repetition, clarity, impact, keep reading |
| Skeptical buyer (offer) | Top 10 objections in blocking order; does the page answer each; what must they picture before paying |
| Offer design | Fit, clarity, pull |
| Hostile paid-report reviewer | Value for money, "what do I do Monday?", trust, scannability, upsell tact |
| Accuracy auditor | Precision, recall, "safe to sell as every claim has evidence?" |
| Personas for a new offer | Score; what I'd do alone today; would I click; what scares me; what I'd pay |

### 2.5 The graveyard: ideas we killed and why

These are as instructive as what shipped. Don't re-propose them without new facts.

| Idea | Why it died |
|---|---|
| "Your customers stopped Googling" | An overclaim the stats don't support. "Are asking AI now" is backed by a source. |
| ~~$99~~ $49 strikethrough; "$1,981 total value" | Fake anchors (FTC risk). |
| An invented business losing ("AI named Tidewater, not you") | Fabricated. A real business needs its permission. |
| A dynamic "asked today" date on a stored answer | False, and on the very element meant to build trust. |
| "Answer Guarantee"; "keep working free until it is" | Implies an outcome we can't control; open-ended labour. |
| "Named by AI" badge | Goes stale within a week; implies the AI companies endorse it. |
| $69 one-time "Full Year" | Undeliverable and underpriced. Monitoring returns only as a real recurring plan. |
| Directory submissions, GBP posting, "we fix your listings" | Need owner logins or hand work; break the hands-off rule. |
| Haiku or a "cleaner" question prompt to save cost | Answers drift from what customers see. Cut effort and search caps instead. |
| Blurred fix titles as a teaser | Blurred text is still in the page; fake titles imply findings that don't exist. |
| Promising score lift or more calls | Can't be backed. Show time, cost and who instead. |
| A surprise "$49 value" bonus at checkout | Not a real price; the value belongs on the card where people decide. |
| `cta_click` on every button | Muddies the event list; the funnel is already measured downstream. |
| "Based in Plainview, NY" | "It limits us." |

**Still contested (decide with data, not opinion):** fold the $25 Breakdown into $49 (the agents say
yes; Bryan says later); unlock one real fix title as proof; a named person or phone on the report;
a price range on "Do it for me"; the unproven homepage claims Bryan chose to keep ("Most popular").

### 2.6 Running a new idea through this: the template

Copy this into the PR or a planning doc for any new offer, product or business idea. A bad idea
should fail by step 4; a good one should be ready to build by step 10.

0. **Value equation first.** Fill in the four levers (2.1): dream outcome, likelihood, time, effort. List every obstacle and the solution to each. If you can't get every lever to 8 or more on paper, the idea isn't ready.
1. **Customer and loss.** Who is the buyer (every type: local, B2B, office, storefront)? What are they
   losing today, shown with *their own* real data? Who is the "loser" in the picture? (Laws 3, 4, 12)
2. **Free vs paid split.** What does free prove? What does paid cure? What is teased only as a count?
   (Law 2)
3. **Promise table.** List every promise: exists today? deliverable without us? who unblocks it?
   Anything that fails is cut or "coming soon". (Laws 1, 8)
4. **Unit economics.** Cost per free unit, cost per paid unit, fee, margin, and how many free units
   one sale pays for. Can a cheaper setting give the same answer? Test it on real inputs. (Law 5)
5. **Price and anchor.** An impulse entry price anchored to a real loss. Any comparison uses only real
   prices. (Laws 5, 6)
6. **Guarantee.** Countable by the system, offered only when it can't trigger by design, capped, and
   refunded by a human. No outcome promises. (Law 7)
7. **Path and placement.** Paid intent goes to its own checkout. Where does each upsell sit: bump,
   after delivery, day 30? What must *not* sit next to the main decision? (Laws 9, 10, 11)
8. **First screen after purchase.** What does the buyer do first, ranked by impact, with who, time
   and cost? What can we pre-build, prefill or do for them? (Laws 11, 12)
9. **Truth pass.** Fact-check every number and claim (OK / WRONG / INVENTED / MISLEADING). Check the
   banned words. Name nothing as losing without permission. (Laws 3, 6, 7)
10. **Value scorecard.** Re-score the four levers with a skeptical-buyer persona. Every lever must be 8 or more, and the lowest one is the next fix.
11. **Pressure loop.** Run the question bank (2.3) and the reviewer roles (2.4). Loop until 9/10 on
    value, ease, clarity and design. Check the graveyard (2.5) so we don't repeat a dead idea.
12. **Ship small, then measure.** Tests and a preview click-through, then real events and cost per
    sale. Record the decision, the why and what we rejected in section 8 of this file.

---

## 3. Operating principles (the framework)

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

## 4. How the big things evolved

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

## 5. Lessons learned (mistake → rule)

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
| Oct 2 | PR #48 (Find my report) was merged into its stacked base branch after that base had already merged, so the feature never reached `master` or the site | Before merging a stacked PR, retarget it to `master`. After merging, check that the commit is on `master`. |
| Oct 5 | A scan is marked `done` when any engine call answered, so "done" can hide a failed call | Anything that skips or reuses a scan uses the strict `scanFinished` check, not `status`. |
| Recurring | sed, heredoc and quoting mangled edits | Use the Edit tool for multi-line changes; write scripts to files. |

---

## 6. How Bryan works (so agents don't have to ask)

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

## 7. Open questions (keep this list current)

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

## 8. Decision log (newest first)

Add new entries at the top of this section. Format:
`### YYYY-MM-DD · Area · Short title (PR #n)`, then **Decision**, **Why**, **Replaces** (if any).
When a decision changes, add a new entry and mark the old one `**Superseded by …**`. Don't delete it.
The history is the point.

### 2026-10-05 · Process/Cost · Pre-scan batches resume from the database, not KV (PR #PRNUM)
**Decision:** A batch of pre-scans runs through `scanner/batch.js`. Every scan is tagged with `scans.batch_id` + `scans.batch_item` (`supabase/v14_scan_batch.sql`), and before each prospect the runner reads those rows back. A strictly finished scan is skipped (nothing is paid again), a live one is waited for, and anything else is scanned again. "Strictly finished" (`scanFinished` in `src/admin/scan-core.js`) means status `done` **and** a report link **and** a valid report **and** every engine call answered **and** no errors. Scans still start through `POST /api/admin/scan`, so scan behaviour, scoring and reports are unchanged.
**Why:** A batch that crashed halfway restarted from prospect #1 and paid again (about $0.095) for every completed scan. The 26 EXP-002 pre-scans were queued one at a time from /admin, so there was no batch runner to resume. `status = 'done'` alone can't be trusted: `scanTotals` marks a scan done when *any* call answered, so a skip based on it would keep half-failed scans for good.
**Rejected:** A KV checkpoint per prospect (`prescan:{batch}:{prospect}`). It would be a second record that can disagree with `scans`. Inferring the batch from timestamps was rejected too: the tag is explicit.
**Held:** Built 2026-10-05, not merged until Tue 2026-10-06, after the Oct 5 EXP-002 wave. Apply `v14_scan_batch.sql` before the first tagged scan; until then a tagged start is refused (untagged scans are unaffected).

### 2026-10-02 · Strategy · The bar: exceptional value, incredibly easy (Hormozi value equation)
**Decision:** Every offer is built and scored on Hormozi's value equation. Raise the dream outcome and the buyer's belief it will work; drive time and effort toward zero. Every lever must score 8 or more before an offer ships. Enhancers (urgency, scarcity, bonuses, value stacks) are used only when they're real.
**Why:** Bryan wants offers with exceptional value that are incredibly easy to achieve, Hormozi style. Our biggest past wins already came from cutting time and effort: the website-only form, the pre-built kit, builder-specific steps, "Do it for me". The weakest levers now are likelihood (no proof stories yet) and effort (the website part still needs a person).

### 2026-10-02 · Strategy · Offer Playbook added (section 2)
**Decision:** The theory behind our offers is written down as 12 laws, alongside the question bank (each question, what it caught, what it changed), the review loop and its rubrics, the graveyard of killed ideas, and an 11-step template for running any new idea through the same process.
**Why:** Bryan wants the lessons applied as a framework, so a new idea gets to a clear value proposition and offer faster, without re-learning them.

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

1. **New decision?** Add an entry at the top of section 8: date, area, title, PR number, then
   Decision, Why, and Replaces/Rejected. Decisions include product, pricing, copy rules, cost and
   process choices, and anything Bryan said yes or no to.
2. **Changed an old decision?** Add the new entry, and append `**Superseded by YYYY-MM-DD …**` to
   the old one. If it affects a big topic, update the matching part of section 4.
3. **Something went wrong or nearly did?** Add a row to section 5 with the rule that prevents it.
4. **Answered or raised an open question?** Edit section 7.
5. **Changed what's on sale, prices, costs or the stack?** Update section 1.
6. **Pressure-tested an offer or idea?** Add the question, what it caught and what changed to the question bank in 2.3, and any killed idea to the graveyard in 2.5. If we learned a new law, add it to 2.2. Re-score the value scorecard in 2.1 when an offer changes.
7. **Truly nothing to record** (a dependency bump, a typo)? Add the `no-decision-log` label to the PR.
