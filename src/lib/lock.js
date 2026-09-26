// Server-side lock for unpaid reports. Pure: no I/O, safe to unit-test.
//
// The rule (owner decision, Sep 26 2026): the free Snapshot proves there's a problem; the $49 AI
// Visibility Audit shows the evidence and the fix. A locked v2 report keeps: who AI named (every
// answer's verdict and the names in it), ONE answer word for word (the headline, as proof), the
// AI Found Score, what AI said about the owner (aiFacts, descriptors), each listing's pass/fail, a
// pass/fail tally of the website checks, and how many fixes there are. Removed here, so they are
// never in the page for anyone to un-blur: every other answer's text and citations, the cited
// sites (only a count stays), which website checks failed, what's wrong on each listing, the fix
// titles, descriptions, steps and copyText, and the X-Ray sections (gap sheet, checklist, reviews).
// Any recorded payment for the token unlocks all of it.
import { xraySections, computeVisibilityScore } from '../../shared/report-v2.js';

/** The fields of an issue that survive locking. Everything else (description, steps, copyText, …) is dropped. */
export const LOCKED_ISSUE_FIELDS = ['kind', 'severity', 'title'];

/** What a locked report carries for the X-Ray sections: only that they exist. */
export const LOCKED_XRAY = Object.freeze({ locked: true });

/** The fields of a v2 issue that survive locking: only how serious it is, so the page can count them. */
export const LOCKED_V2_ISSUE_FIELDS = ['severity'];

/** The fields of a non-headline answer that survive locking: the verdict, never the words or the sources. */
export const LOCKED_ANSWER_FIELDS = ['id', 'questionId', 'intent', 'engine', 'run', 'askedAt', 'namedYou', 'namedYouFirst', 'ownerMatch'];

function lockIssue(i) {
  const out = { locked: true };
  for (const k of LOCKED_ISSUE_FIELDS) if (i && i[k] != null) out[k] = i[k];
  // A v1 issue has no kind; keep the shape it always had.
  return out;
}

function pick(o, keys, extra) {
  const out = { ...extra };
  for (const k of keys) if (o && o[k] != null) out[k] = o[k];
  return out;
}

/**
 * Every website check as { key, ok } (true = passed), from scanner/owner-checks.js siteCheck.
 * A check the report doesn't carry is left out. The free report shows only the tally.
 */
export function siteCheckResults(sc) {
  if (!sc || typeof sc !== 'object') return [];
  if (sc.reachable === false) return [{ key: 'reachable', ok: false }];
  const out = [];
  const add = (key, v) => { if (v !== undefined && v !== null) out.push({ key, ok: !!v }); };
  if (sc.robots) add('robots', !((sc.robots.blocked || []).length));
  if (sc.schema) add('schema', sc.schema.found);
  if (sc.onSite) { add('phone', !!sc.onSite.phone); add('address', !!sc.onSite.address); }
  if ('sitemap' in sc) add('sitemap', sc.sitemap);
  if (sc.llmsTxt != null) add('llmsTxt', typeof sc.llmsTxt === 'object' ? sc.llmsTxt.found : sc.llmsTxt);
  if (sc.https && typeof sc.https === 'object') {
    add('https', sc.https.loads);
    if (sc.https.loads) add('httpsRedirect', sc.https.redirects);
  }
  if (sc.faqSchema != null) add('faqSchema', sc.faqSchema);
  if (sc.meta && typeof sc.meta === 'object') {
    add('title', sc.meta.title);
    add('metaTrade', sc.meta.mentionsTrade);
    add('metaTown', sc.meta.mentionsTown);
  }
  if (sc.speed && Number.isFinite(Number(sc.speed.score))) add('speed', Number(sc.speed.score) >= 50);
  return out;
}

/** A locked siteCheck: which page was read and how many checks passed, nothing about which. */
function lockSiteCheck(sc) {
  if (!sc || typeof sc !== 'object') return sc ?? null;
  const results = siteCheckResults(sc);
  return { url: sc.url, reachable: sc.reachable !== false, locked: true, checks: results.length, passed: results.filter((r) => r.ok).length };
}

/** lockReport(report) → a copy with the paid details removed and locked: true. Never mutates. */
export function lockReport(r) {
  if (r.version === 2) {
    // Free proves there's a problem; the $49 audit shows the evidence and the fix (Sep 26 2026).
    // Anything paid that a stored report might carry is dropped, never passed through.
    const { xray, gapSheet, checklist, reviews, ...rest } = r;
    const headlineId = r.headline && r.headline.answerId;
    const lostIds = new Set((r.answers || []).filter((a) => a && !a.namedYou && a.ownerMatch !== 'unsure').map((a) => a.id));
    const sources = Array.isArray(r.sources) ? r.sources.filter((s) => s && typeof s === 'object') : [];
    return {
      ...rest,
      locked: true,
      // One answer stays word for word (the headline, as proof). The rest keep only their verdict
      // and who they named; the text and the sites they cited are the audit's.
      answers: (r.answers || []).map((a) => (!a || a.id === headlineId ? a : pick(a, LOCKED_ANSWER_FIELDS, {
        locked: true,
        text: '',
        businessesNamed: a.businessesNamed || [],
      }))),
      // Anything that isn't a clean match keeps only its platform and status.
      listings: (r.listings || []).map((l) =>
        l.status === 'match' ? l : { platform: l.platform, status: l.status, locked: true }),
      // Only the count (and how serious): titles like "Unblock GPTBot in robots.txt" are the fix.
      issues: (r.issues || []).map((i) => pick(i, LOCKED_V2_ISSUE_FIELDS, { locked: true })),
      // The cited sites are the "why": free gets the tally only.
      sources: [],
      sourcesSummary: {
        cited: sources.filter((s) => (s.citedIn || []).some((id) => lostIds.has(id))).length,
        missingYou: sources.filter((s) => s.youListed === false && (s.citedIn || []).some((id) => lostIds.has(id))).length,
      },
      siteCheck: lockSiteCheck(r.siteCheck),
      xray: { ...LOCKED_XRAY },
    };
  }
  return {
    ...r,
    locked: true,
    listings: (r.listings || []).map((l) =>
      l.status === 'mismatch' ? { platform: l.platform, status: l.status, locked: true } : l),
    issues: (r.issues || []).map((i) => ({ severity: i.severity, title: i.title, locked: true })),
  };
}

/**
 * The body served for a report. Unlocked v2 reports say locked: false and carry the X-Ray
 * sections (built from the report's own data); locked ones go through lockReport.
 */
export function reportBody(report, unlocked) {
  // v2: the AI Found Score is computed from the report's own data every time it is served, so it
  // always matches what the page shows (shared/report-v2.js computeVisibilityScore). Free, never locked.
  const withScore = (r) => (r.version === 2 ? { ...r, score: computeVisibilityScore(report) } : r);
  if (!unlocked) return withScore(lockReport(report));
  return report.version === 2 ? withScore({ ...report, locked: false, xray: xraySections(report) }) : report;
}
