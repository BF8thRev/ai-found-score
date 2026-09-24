// Group name variants of the same business and count answers named / first.
// Two mentions are the same business when they share a phone, a street address,
// a normalized name, or a core name (normalized minus generic trade words, e.g.
// "Park Avenue Laundromat" / "Park Avenue Laundry"). Owner mentions form their own
// group and are never merged with a competitor. Pure, runtime-agnostic.

import { normalizeName, coreName, findPhones, findStreets } from './normalize.js';

/**
 * groupEntities(answers) → { entities, entityIdOf: Map<`${answerId}#${index}`, entityId> }
 * `answers[]` need { id, text, businessesNamed:[{name,pos,isYou?,ownerMatch?}] }.
 * Mentions with ownerMatch 'unsure' are left out (no entity).
 * entities: [{ id, name, aliases, phone, address, isYou, named, first, answerIds }]
 *   sorted owner first, then named desc, first desc, earliest appearance.
 */
export function groupEntities(answers, { ownerName } = {}) {
  const mentions = [];
  answers.forEach((a, ai) => {
    const list = a.businessesNamed || [];
    list.forEach((b, bi) => {
      if (b.ownerMatch === 'unsure') return;
      const next = list[bi + 1];
      const end = Math.min(a.text.length, next ? next.pos : b.pos + b.name.length + 200);
      const win = a.text.slice(b.pos, end);
      const phone = (findPhones(win)[0] || {}).key || '';
      const st = findStreets(win)[0];
      mentions.push({
        answerId: a.id, order: ai * 1e6 + b.pos, key: `${a.id}#${bi}`, name: b.name, pos: b.pos,
        isYou: !!b.isYou, norm: normalizeName(b.name), core: coreName(b.name),
        phone, street: st ? st.key : '', streetRaw: st ? st.raw.replace(/[.,]$/, '') : '',
      });
    });
  });

  // Union-find.
  const parent = mentions.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const isYouRoot = mentions.map((m) => m.isYou);
  const union = (i, j) => {
    const a = find(i);
    const b = find(j);
    if (a === b) return;
    if (isYouRoot[a] !== isYouRoot[b]) return; // never merge owner with a competitor
    parent[b] = a;
  };
  const byKey = (k) => {
    const first = new Map();
    mentions.forEach((m, i) => {
      const v = m[k];
      if (!v) return;
      if (first.has(`${m.isYou}|${v}`)) union(first.get(`${m.isYou}|${v}`), i);
      else first.set(`${m.isYou}|${v}`, i);
    });
  };
  mentions.forEach((m, i) => { if (m.isYou) union(mentions.findIndex((x) => x.isYou), i); });
  for (const k of ['phone', 'street', 'norm', 'core']) byKey(k);

  const groups = new Map();
  mentions.forEach((m, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(m);
  });

  const firstByAnswer = new Map();
  for (const a of answers) {
    const e = (a.businessesNamed || []).filter((b) => b.ownerMatch !== 'unsure').reduce((m, b) => (!m || b.pos < m.pos ? b : m), null);
    if (e) firstByAnswer.set(a.id, e.pos);
  }

  const entities = [...groups.values()].map((ms) => {
    ms.sort((x, y) => x.order - y.order);
    const counts = new Map();
    for (const m of ms) counts.set(m.name, (counts.get(m.name) || 0) + 1);
    const variants = [...counts.keys()];
    let name = variants.sort((x, y) => counts.get(y) - counts.get(x) || ms.findIndex((m) => m.name === x) - ms.findIndex((m) => m.name === y))[0];
    const isYou = ms[0].isYou;
    if (isYou && ownerName && counts.has(ownerName)) name = ownerName;
    const answerIds = [...new Set(ms.map((m) => m.answerId))];
    const firstIn = new Set(ms.filter((m) => firstByAnswer.get(m.answerId) === m.pos).map((m) => m.answerId));
    return {
      name,
      aliases: variants.filter((v) => v !== name),
      phone: (ms.find((m) => m.phone) || {}).phone || null,
      address: (ms.find((m) => m.streetRaw) || {}).streetRaw || null,
      isYou,
      named: answerIds.length,
      first: firstIn.size,
      answerIds,
      _order: ms[0].order,
      _keys: ms.map((m) => m.key),
    };
  });

  entities.sort((a, b) => (b.isYou ? 1 : 0) - (a.isYou ? 1 : 0) || b.named - a.named || b.first - a.first || a._order - b._order);
  const entityIdOf = new Map();
  entities.forEach((e, i) => {
    e.id = `e${i + 1}`;
    for (const k of e._keys) entityIdOf.set(k, e.id);
    delete e._order;
    delete e._keys;
  });
  return { entities: entities.map(({ id, ...rest }) => ({ id, ...rest })), entityIdOf };
}
