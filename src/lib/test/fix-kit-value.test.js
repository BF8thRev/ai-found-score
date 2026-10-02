// The Fix Kit after the Oct 2 2026 buyer review of the PR 73 kit (src/lib/fix-kit.js, shared/faq.js):
//   - site copy that talks to the visitor ("to help you build trust") is cut before it reaches a listing;
//   - an agency or firm gets a real Google Business Profile category, not "pick the one that fits";
//   - every job says how long it takes; the builder's paid-plan warning is said once, not on every job;
//   - check-it-worked.txt: what to expect (no promise), how to tell each file is live, the questions to ask again;
//   - ask-for-reviews.txt when reviews matter to AI or the owner gave a review link.
// The routes are covered through the real Worker in faq.test.js and fix-kit.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { aboutTheBusiness } from '../../../shared/faq.js';
import { prefillDetails, validateDetails, buildKit, gbpCategories, gbpTxt, checkTxt, reviewsTxt } from '../fix-kit.js';
import { officeReport } from './fixtures/office-report.js';
import { lintText } from '../../../shared/report-v2.js';

const SITE_COPY = "PR73's integrated communications team specializes in public relations & media relations to help you build trust & connect with your audience effectively.";
const kitFor = (report, over = {}) => {
  const v = validateDetails({ ...prefillDetails(report), ...over });
  assert.deepEqual(v.errors, []);
  return { d: v.details, kit: buildKit(v.details, report, { token: 'tok_1', date: new Date(2026, 9, 2) }) };
};

test('aboutTheBusiness: keeps what comes before the clause that says "you"; nothing is reworded', () => {
  assert.equal(aboutTheBusiness(SITE_COPY), "PR73's integrated communications team specializes in public relations & media relations.");
  assert.equal(aboutTheBusiness('Family owned and operated since 1990.'), 'Family owned and operated since 1990.', 'no "you": as it is');
  assert.equal(aboutTheBusiness('We help you grow.'), '', 'too little left to stand on its own');
  assert.equal(aboutTheBusiness("Call us today and we'll get you scheduled."), '');
  assert.equal(aboutTheBusiness(''), '');
});

test('prefill: a homepage description that talks to the visitor never reaches the description', () => {
  const report = officeReport();
  report.siteCheck.meta.description = SITE_COPY;
  const p = prefillDetails(report);
  assert.doesNotMatch(p.description, /\b(you|your)\b/i, p.description);
  assert.match(p.description, /specializes in public relations & media relations\.$/);
  // Copy that is only about "you" adds nothing: the one line we write is the whole description.
  report.siteCheck.meta.description = 'We help you grow your brand with a team you can trust.';
  assert.equal(prefillDetails(report).description, 'Harbor Lane PR is a PR agency in New York City, NY.');
});

test('Google categories: trades as before, agencies and firms by their words, anything else is told how to find it', () => {
  assert.deepEqual(gbpCategories({ trade: 'plumber' }), ['Plumber']);
  assert.deepEqual(gbpCategories({ trade: 'pr agency' }), ['Public relations firm', 'Marketing agency', 'Consultant']);
  assert.equal(gbpCategories({ trade: 'Digital marketing agency' })[0], 'Marketing agency');
  assert.equal(gbpCategories({ trade: 'CPA firm' })[0], 'Accountant');
  assert.equal(gbpCategories({ trade: 'immigration law firm' })[0], 'Law firm');
  assert.deepEqual(gbpCategories({ trade: 'bakery' }), []);
  const pr = gbpTxt(validateDetails({ name: 'PR73', trade: 'pr agency', town: 'New York City', state: 'NY' }).details);
  assert.match(pr, /PRIMARY CATEGORY \(our suggestion\)\nPublic relations firm\n\(Google words its categories its own way/);
  assert.match(pr, /OTHER CATEGORIES TO CONSIDER[^\n]*\n- Marketing agency\n- Consultant/);
  const bakery = gbpTxt(validateDetails({ name: 'Rise Bakery', trade: 'bakery', town: 'Bohemia', state: 'NY' }).details);
  assert.match(bakery, /PRIMARY CATEGORY \(our suggestion\)\nType "bakery" into the category box and pick the closest match Google offers\./);
  assert.doesNotMatch(bakery, /Pick the category that best matches/);
});

test('every job says how long it takes, and the README says it costs nothing from us', () => {
  const { kit } = kitFor(officeReport());
  assert.ok(kit.jobs.length >= 4);
  for (const j of kit.jobs) assert.match(j.time, /^(About|Under) /, j.id);
  const readme = kit.files[0].content;
  assert.equal(readme.split('No cost from us.').length - 1, kit.jobs.length, 'one time-and-cost line per job');
});

test('a site builder\'s paid-plan warning is said once, on the first job that needs it', () => {
  const report = officeReport();
  report.siteCheck.platform = { id: 'webflow', seo: null };
  const { kit } = kitFor(report);
  const warning = /Webflow says custom code needs a paid Site plan/g;
  const steps = kit.jobs.flatMap((j) => (j.platform ? j.platform.steps : []));
  assert.ok(steps.filter((s) => /Custom code/.test(s)).length >= 2, 'the FAQ code and the business code both go in Custom code');
  assert.equal(steps.join('\n').match(warning).length, 1, 'once across the jobs');
  assert.equal(kit.files[0].content.match(warning).length, 1, 'and once in the README');
  assert.match(kit.jobs.find((j) => j.platform && warning.test(j.platform.steps.join(' '))).id, /faq/, 'on the first job shown');
});

test('check-it-worked.txt: what to expect with no promise, each file to check, the questions to ask again', () => {
  const report = officeReport();
  const { d, kit } = kitFor(report, { website: 'harborlanepr.example.com' });
  const t = kit.files[kit.files.length - 1];
  assert.equal(t.path, 'check-it-worked.txt', 'the last file in the kit');
  assert.equal(t.content, kit.check.content);
  const text = t.content;
  assert.match(text, /^CHECK IT WORKED: Harbor Lane PR/);
  assert.match(text, /We cannot promise any assistant will name you/);
  assert.match(text, /Your next scan asks AI the same questions again[^\n]*a free re-check 30 days after you buy\./);
  assert.doesNotMatch(text, /Be the Answer/, 'off sale: never named to an audit buyer');
  assert.doesNotMatch(text, /free re-check, 30 days/);
  assert.match(text, /validator\.schema\.org/);
  assert.doesNotMatch(text, /rich-results/, 'Google shows FAQ results for few sites: no check that depends on it');
  assert.match(text, /https:\/\/harborlanepr\.example\.com\/llms\.txt/, 'the real address of each file');
  for (const q of report.questions.slice(0, 3)) assert.ok(text.includes(`- ${q.text}`), q.text);
  assert.deepEqual(lintText(text).map((h) => h.match), []);
  assert.doesNotMatch(text, /will rank|guarantee|you will (?:be|get) named/i);
  // No website on file: it says where to look instead of printing a broken address.
  assert.match(checkTxt({ ...d, website: '' }, report, [{ id: 'llms' }]), /your website address followed by \/llms\.txt/);
  // Nothing to install, nothing to check on the site.
  assert.match(checkTxt(d, report, []), /Nothing on your website to check/);
});

test('ask-for-reviews.txt: the two messages, the review link or what is missing, what Google allows', () => {
  const link = 'https://g.page/r/abc/review';
  const withLink = reviewsTxt({ name: 'Harbor Lane PR', trade: 'pr agency', googleReviewUrl: link });
  assert.ok(withLink.split(link).length - 1 === 2, 'in the text and in the email');
  assert.match(withLink, /Ask every client after the job is done/);
  assert.match(withLink, /review-qr\.svg/);
  assert.match(withLink, /Google does not allow paying for reviews/);
  const noLink = reviewsTxt({ name: 'Harborview Plumbing', trade: 'plumber', googleReviewUrl: '' });
  assert.match(noLink, /\[Missing: your Google review link\./);
  assert.match(noLink, /Ask every customer/);
  assert.doesNotMatch(noLink, /https?:\/\/|review-qr/);
  assert.deepEqual(lintText(withLink + noLink).map((h) => h.match), []);
});

test('the review messages come with a review link, or when AI mentioned reviews for the others; else they stay out', () => {
  const quiet = { ...officeReport(), answers: [] }; // no answer text to read, so AI mentioned nothing
  const { kit } = kitFor(quiet);
  assert.ok(!kit.jobs.some((j) => j.id === 'qr'), 'nothing says reviews matter here');
  const link = kitFor(quiet, { googleReviewUrl: 'https://g.page/r/abc/review' }).kit;
  const qr = link.jobs.find((j) => j.id === 'qr');
  assert.deepEqual(qr.files, ['ask-for-reviews.txt', 'review-qr.svg']);
  const mentioned = kitFor(officeReport()).kit;
  assert.deepEqual(mentioned.jobs.find((j) => j.id === 'qr').files, ['ask-for-reviews.txt'], 'no link yet: messages only');
});

// ---- found by the adversarial review of this change ----
test('aboutTheBusiness: whole sentences without "you" are kept; a capitalised You inside a name is not the reader', () => {
  assert.equal(aboutTheBusiness('Harbor Lane PR is a full-service PR agency in New York. We help you tell your story.'), 'Harbor Lane PR is a full-service PR agency in New York.');
  assert.equal(aboutTheBusiness('We are Thank You Roofing, a family roofer in Austin TX, offering free estimates.'), 'We are Thank You Roofing, a family roofer in Austin TX, offering free estimates.');
  assert.equal(aboutTheBusiness('Your trusted Brooklyn plumber, serving Park Slope since 1990.'), '', 'addressed to the reader from the first word: nothing to keep');
});

test('office categories: the specific kind wins over the general word', () => {
  const first = (trade) => gbpCategories({ trade })[0];
  assert.equal(first('tax attorney'), 'Law firm');
  assert.equal(first('accounting software company'), 'Software company');
  assert.equal(first('financial software company'), 'Software company');
  assert.equal(first('marketing law firm'), 'Law firm');
  assert.equal(first('real estate appraiser'), 'Real estate appraiser');
  assert.equal(first('ad agency'), 'Marketing agency');
  assert.equal(first('SEO agency'), 'Marketing agency');
  assert.deepEqual(gbpCategories({ trade: 'museum consulting' }), ['Business management consultant', 'Consultant'], 'seo inside "museum" is not SEO');
  assert.deepEqual(gbpCategories({ trade: 'accountability coach' }), [], 'account inside "accountability" is not an accountant');
  assert.deepEqual(gbpCategories({ trade: 'Sloan advisory' }), ['Financial planner', 'Financial consultant'], 'loan inside "Sloan" is not a mortgage');
});

test('check-it-worked.txt: no check for a file the kit says to skip, no QR step without a link', () => {
  const on = (id) => { const r = officeReport(); r.siteCheck.platform = { id, seo: null }; r.siteCheck.robots = { found: true, blocked: [{ agent: 'GPTBot', who: 'ChatGPT' }] }; return kitFor(r); };
  // Wix makes its own llms.txt and has no robots.txt editor.
  const wix = on('wix');
  assert.ok(wix.kit.jobs.filter((j) => j.skip).map((j) => j.id).includes('llms'));
  assert.doesNotMatch(wix.kit.check.content, /llms\.txt: open/);
  assert.ok(wix.kit.jobs.filter((j) => j.skip).every((j) => j.time === undefined), 'a skipped job has no time');
  // Google Sites can't take the business code or robots.txt.
  const gs = on('google-sites');
  const skipped = gs.kit.jobs.filter((x) => x.skip).map((x) => x.id);
  assert.ok(skipped.includes('robots'), 'Google Sites has no robots.txt editor');
  assert.doesNotMatch(gs.kit.check.content, /robots\.txt: open/);
  // The same report on a builder that takes everything keeps its checks.
  const none = kitFor(officeReport());
  assert.match(none.kit.check.content, /llms\.txt: open/);
  // QR: with a link it says scan; without, it says add the link first.
  const noLink = kitFor(officeReport()).kit.check.content;
  assert.match(noLink, /add your Google review link on your Fix Kit page/);
  assert.doesNotMatch(noLink, /scan the QR code/);
  assert.match(kitFor(officeReport(), { googleReviewUrl: 'https://g.page/r/abc/review' }).kit.check.content, /scan the QR code/);
});

test('README: START HERE names what the owner can do alone, before anything for a web person', () => {
  const { kit } = kitFor(officeReport());
  const readme = kit.files[0].content;
  const at = (s) => { const i = readme.indexOf(s); assert.ok(i >= 0, s); return i; };
  const mine = readme.slice(at('START HERE: JOBS YOU CAN DO YOURSELF, TODAY'), at('JOBS FOR WHOEVER RUNS YOUR WEBSITE'));
  const web = readme.slice(at('JOBS FOR WHOEVER RUNS YOUR WEBSITE'), at('YOUR DETAILS, AS YOU CHECKED THEM'));
  assert.match(mine, /1\. Your Google Business Profile text\n   File: google-business-profile\.txt\n[^]*Time: Under half an hour for you/);
  assert.match(mine, /2\. Ask happy customers for a Google review/);
  assert.doesNotMatch(mine, /faq-page|schema-local|llms\.txt/, 'nothing for a web person under the owner\'s jobs');
  assert.match(web, /1\. A Questions page AI can quote/);
  assert.doesNotMatch(web, /google-business-profile\.txt|ask-for-reviews/, 'nothing the owner does alone under the website jobs');
  assert.match(web, /Nobody does that for you\? Ask us on your Fix Kit page/);
});
