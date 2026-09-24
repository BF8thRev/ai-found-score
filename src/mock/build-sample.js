// Builds a fictional v2 sample report from a compact spec.
//
// Only the answer text, the question set and the per-source page checks are
// written by hand. Everything the guardrails check is derived from the text
// here, the same way the extractor does it: name positions are literal
// indexOf hits, "first" is the earliest name, entity counts and totals are
// counted from answers, and every aiFacts quote is verified as a substring.
// A spec that doesn't hold together throws at import time.

import { pickHeadline } from '../../shared/report-v2.js';

/** Earliest occurrence of any alias; longest alias wins at the same spot. */
function findName(text, aliases) {
  let best = null;
  for (const alias of aliases) {
    const pos = text.indexOf(alias);
    if (pos < 0) continue;
    if (!best || pos < best.pos || (pos === best.pos && alias.length > best.name.length)) {
      best = { name: alias, pos };
    }
  }
  return best;
}

function domainOf(url) {
  return new URL(url).hostname.replace(/^www\./, '');
}

/**
 * spec = {
 *   id, generatedAt, business, owner: { aliases },
 *   competitors: [{ id, name, aliases?, phone? }],
 *   questions: [{ id, intent, text }],
 *   answers: [[questionId, engine, run, text, [citationUrl...]]],
 *   startAt: ISO string (askedAt is spaced 20s apart from here),
 *   sourceChecks: { [domain]: { youListed, youPosition, topListed } },
 *   facts: [{ q, engine, run, field, aiSays, sourceSays, status }],
 *   listings, issues, method, baseline
 * }
 */
export function buildSample(spec) {
  const questionById = Object.fromEntries(spec.questions.map((q) => [q.id, q]));
  const comps = spec.competitors.map((c) => ({ ...c, aliases: c.aliases?.length ? c.aliases : [c.name] }));
  const start = Date.parse(spec.startAt);

  const answers = spec.answers.map(([questionId, engine, run, text, citations = []], i) => {
    const q = questionById[questionId];
    if (!q) throw new Error(`sample ${spec.id}: unknown question ${questionId}`);
    const named = [];
    const you = findName(text, spec.owner.aliases);
    if (you) named.push({ name: you.name, pos: you.pos, entityId: null, isYou: true });
    for (const c of comps) {
      const hit = findName(text, c.aliases);
      if (hit) named.push({ name: hit.name, pos: hit.pos, entityId: c.id });
    }
    named.sort((a, b) => a.pos - b.pos);
    return {
      id: `a${i + 1}`,
      questionId,
      intent: q.intent,
      engine,
      run,
      askedAt: new Date(start + i * 20000).toISOString(),
      text,
      businessesNamed: named,
      namedYou: !!you,
      namedYouFirst: !!you && named[0]?.isYou === true,
      citations: citations.map((url) => ({ domain: domainOf(url), url })),
    };
  });

  // The grid is complete: one answer per question × responding engine × run,
  // so the page's "N searches" is exactly questions × engines (× runs).
  const engines = Object.keys(spec.method.engines);
  const runs = spec.method.runs;
  for (const e of spec.method.enginesFailed || []) {
    if (engines.includes(e)) throw new Error(`sample ${spec.id}: failed engine ${e} is also in method.engines`);
  }
  for (const q of spec.questions) for (const e of engines) for (let r = 1; r <= runs; r++) {
    const n = answers.filter((a) => a.questionId === q.id && a.engine === e && a.run === r).length;
    if (n !== 1) throw new Error(`sample ${spec.id}: ${q.id}/${e}/run ${r} has ${n} answers, expected 1`);
  }
  if (answers.length !== spec.questions.length * engines.length * runs) {
    throw new Error(`sample ${spec.id}: ${answers.length} answers, expected ${spec.questions.length} × ${engines.length} × ${runs}`);
  }

  const entities = comps.map((c) => {
    const hits = answers.filter((a) => a.businessesNamed.some((n) => n.entityId === c.id));
    return {
      id: c.id,
      name: c.name,
      aliases: c.aliases.filter((x) => x !== c.name),
      phone: c.phone ?? null,
      named: hits.length,
      first: hits.filter((a) => a.businessesNamed[0]?.entityId === c.id).length,
      answerIds: hits.map((a) => a.id),
    };
  }).sort((a, b) => b.named - a.named || b.first - a.first);

  const totals = {
    answers: answers.length,
    namedYou: answers.filter((a) => a.namedYou).length,
    firstYou: answers.filter((a) => a.namedYouFirst).length,
  };

  // Hero: the same rule the scanner and the serve gate use.
  const headline = pickHeadline({ questions: spec.questions, answers });

  const byUrl = new Map();
  for (const a of answers) {
    for (const c of a.citations) {
      if (!byUrl.has(c.url)) {
        const check = spec.sourceChecks?.[c.domain] || {};
        byUrl.set(c.url, {
          domain: c.domain,
          url: c.url,
          citedIn: [],
          youListed: check.youListed ?? null,
          youPosition: check.youPosition ?? null,
          topListed: check.topListed ?? null,
        });
      }
      byUrl.get(c.url).citedIn.push(a.id);
    }
  }

  const aiFacts = (spec.facts || []).map((f) => {
    const a = answers.find((x) => x.questionId === f.q && x.engine === f.engine && x.run === f.run);
    if (!a || !a.text.includes(f.aiSays)) {
      throw new Error(`sample ${spec.id}: fact "${f.aiSays}" is not a quote from ${f.q}/${f.engine}/${f.run}`);
    }
    return { answerId: a.id, field: f.field, aiSays: f.aiSays, sourceSays: f.sourceSays ?? null, status: f.status };
  });

  return {
    id: spec.id,
    version: 2,
    sample: true,
    generatedAt: spec.generatedAt,
    business: spec.business,
    questions: spec.questions,
    answers,
    entities,
    totals,
    headline,
    sources: [...byUrl.values()],
    aiFacts,
    listings: spec.listings || [],
    issues: spec.issues || [],
    method: spec.method,
    baseline: spec.baseline ?? null,
  };
}
