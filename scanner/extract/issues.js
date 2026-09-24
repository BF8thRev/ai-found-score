// "What to fix" list, generated from report data only. Every title/description is a
// fixed template string with slots; nothing is free-written. Pure, runtime-agnostic.

import { ENGINE_NAMES } from '../../shared/report-v2.js';

const SEV = { high: 0, medium: 1, low: 2 };
const FIELD_LABEL = { hours: 'hours', phone: 'phone number', price: 'price', address: 'address', services: 'services' };
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

export const TEMPLATES = {
  factDiffers: {
    title: (s) => `AI states your ${s.field} differently than your ${s.sourceName}`,
    description: (s) => `${s.engine} said "${s.aiSays}". Your ${s.sourceName} says "${s.sourceSays}".`,
  },
  notListed: {
    title: (s) => `Not listed on ${s.domain}, which AI cited when it named others`,
    description: (s) =>
      `${s.engines} cited ${s.url} for "${s.question}" and did not name you.` +
      (s.topListed ? ` ${s.topListed} is listed first on that page.` : ''),
  },
  lostQuestion: {
    title: (s) => `Not named when asked "${s.question}"`,
    // `count` = every other business named; `names` = only those proven (named in ≥ 2 answers).
    description: (s) =>
      `${s.engines} answered without naming you` +
      (s.count
        ? ` and named ${s.count} other ${s.count === 1 ? 'business' : 'businesses'}` +
          (s.shown ? `${s.shown < s.count ? ', including' : ':'} ${s.names}.` : '.')
        : '.'),
  },
};

/**
 * buildIssues({ report, extra }) → [{ severity, title, description, kind }]
 * `report` must already have answers, questions, aiFacts, sources, entities.
 * `extra` (e.g. listing mismatches from the listing checker) is merged in, then
 * everything is ordered high → medium → low, stable.
 */
export function buildIssues({ report, extra = [] }) {
  const out = [];
  const byId = new Map(report.answers.map((a) => [a.id, a]));
  const qText = (qid) => (report.questions.find((q) => q.id === qid) || {}).text || '';
  const engineName = (e) => ENGINE_NAMES[e] || e;
  const entById = new Map((report.entities || []).map((e) => [e.id, e]));

  for (const f of report.aiFacts || []) {
    if (f.status !== 'differs') continue;
    const a = byId.get(f.answerId);
    const s = { field: FIELD_LABEL[f.field] || f.field, engine: engineName(a.engine), aiSays: f.aiSays, sourceSays: f.sourceSays, sourceName: f.sourceFrom === 'listing' ? 'listing' : 'website' };
    out.push({ kind: 'fact_differs', severity: 'high', title: TEMPLATES.factDiffers.title(s), description: TEMPLATES.factDiffers.description(s) });
  }

  for (const src of report.sources || []) {
    if (src.youListed !== false) continue;
    const lostIn = src.citedIn.map((id) => byId.get(id)).filter((a) => a && !a.namedYou && a.ownerMatch !== 'unsure');
    if (!lostIn.length) continue;
    const s = {
      domain: src.domain, url: src.url, topListed: src.topListed,
      engines: list([...new Set(lostIn.map((a) => engineName(a.engine)))]),
      question: qText(lostIn[0].questionId),
    };
    out.push({ kind: 'not_listed', severity: 'high', title: TEMPLATES.notListed.title(s), description: TEMPLATES.notListed.description(s) });
  }

  for (const q of report.questions) {
    const lost = report.answers.filter((a) => a.questionId === q.id && !a.namedYou && a.ownerMatch !== 'unsure');
    if (!lost.length) continue;
    // Every other business counts; a name is only printed when it has proof (named in ≥ 2 answers).
    const others = [];
    for (const a of lost) for (const b of a.businessesNamed || []) {
      const e = b.entityId ? entById.get(b.entityId) : null;
      if (e && !e.isYou && !b.isYou && !others.includes(e)) others.push(e);
    }
    const proven = others.filter((e) => (e.named || 0) >= 2).map((e) => e.name).slice(0, 3);
    const s = {
      question: q.text,
      engines: list([...new Set(lost.map((a) => engineName(a.engine)))]),
      count: others.length,
      shown: proven.length,
      names: list(proven),
    };
    out.push({ kind: 'lost_question', severity: 'medium', title: TEMPLATES.lostQuestion.title(s), description: TEMPLATES.lostQuestion.description(s) });
  }

  for (const x of extra) if (x && x.title) out.push({ severity: 'medium', ...x });

  return out
    .map((x, i) => ({ x, i }))
    .sort((a, b) => (SEV[a.x.severity] ?? 3) - (SEV[b.x.severity] ?? 3) || a.i - b.i)
    .map(({ x }) => x);
}
