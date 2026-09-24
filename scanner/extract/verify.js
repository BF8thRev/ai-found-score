// Step 2 of extraction: plain code checks every model proposal against the raw text.
// The model proposes; this file decides. Pure, runtime-agnostic.

import { normalizeName, phoneKey, streetKey, findPhones, findStreets, domainOf, digits } from './normalize.js';

/**
 * verifyBusinesses(text, proposed) → { kept:[{name,pos}], rejected:[{name,pos,reason}] }
 * A name survives only as a literal substring of the text. If the model's pos is
 * off, pos is re-found with indexOf (first appearance). One entry per normalized name.
 */
export function verifyBusinesses(text, proposed = []) {
  const kept = [];
  const rejected = [];
  const seen = new Set();
  for (const p of proposed) {
    const name = p && typeof p.name === 'string' ? p.name : '';
    if (!name.trim()) { rejected.push({ ...p, reason: 'empty name' }); continue; }
    let pos = Number.isInteger(p.pos) && text.slice(p.pos, p.pos + name.length) === name ? p.pos : text.indexOf(name);
    if (pos === -1) { rejected.push({ name, pos: p.pos, reason: 'not a literal substring of the answer' }); continue; }
    // Always use the first appearance so "named first" is measured consistently.
    const firstPos = text.indexOf(name);
    if (firstPos !== -1 && firstPos < pos) pos = firstPos;
    const key = normalizeName(name);
    if (!key) { rejected.push({ name, pos, reason: 'name has no letters or digits' }); continue; }
    if (seen.has(key)) {
      const prev = kept.find((k) => normalizeName(k.name) === key);
      if (prev && pos < prev.pos) { prev.name = name; prev.pos = pos; }
      continue;
    }
    seen.add(key);
    kept.push({ name, pos });
  }
  kept.sort((a, b) => a.pos - b.pos);
  return { kept, rejected };
}

function ownerKeys(business) {
  const names = [business.name, ...(business.aliases || [])].filter(Boolean).map(normalizeName);
  return {
    names,
    phone: phoneKey(business.phone),
    street: streetKey(business.address),
    domain: business.website ? domainOf(/^https?:/i.test(business.website) ? business.website : `https://${business.website}`) : '',
  };
}

function nameRelation(cand, ownerNames) {
  const c = normalizeName(cand);
  if (!c) return 'none';
  if (ownerNames.includes(c)) return 'exact';
  const cw = c.split(' ');
  for (const o of ownerNames) {
    const ow = o.split(' ');
    const [short, long] = cw.length <= ow.length ? [cw, ow] : [ow, cw];
    if (short.length >= 2 && ` ${long.join(' ')} `.includes(` ${short.join(' ')} `)) return 'partial';
    const inter = cw.filter((w) => ow.includes(w)).length;
    const union = new Set([...cw, ...ow]).size;
    if (union && inter / union >= 0.6) return 'partial';
  }
  return 'none';
}

/**
 * matchOwner({ text, citations, entry, nextPos, business }) → 'match' | 'unsure' | 'none'
 * Normalized name first (drops LLC, Inc, the, &/and, punctuation). Then phone,
 * street address and website domain, when present, confirm or contradict.
 *   exact name  + no contradicting contact detail  → match
 *   exact name  + a different phone/street next to it → unsure
 *   near name   + confirming phone/street/domain     → match, else unsure
 */
export function matchOwner({ text, citations = [], entry, nextPos, business }) {
  const k = ownerKeys(business);
  const rel = nameRelation(entry.name, k.names);
  if (rel === 'none') return 'none';
  const end = Math.min(text.length, nextPos != null ? nextPos : entry.pos + entry.name.length + 200);
  const win = text.slice(entry.pos, end);
  const phones = findPhones(win).map((p) => p.key).filter(Boolean);
  const streets = findStreets(win).map((s) => s.key);
  const lowerText = text.toLowerCase();
  const confirm =
    (k.phone && (phones.includes(k.phone) || digits(text).includes(k.phone))) ||
    (k.street && streets.includes(k.street)) ||
    (k.domain && (lowerText.includes(k.domain) || citations.some((c) => domainOf(c.url || '') === k.domain || c.domain === k.domain)));
  const contradict =
    (k.phone && phones.length > 0 && !phones.includes(k.phone)) ||
    (k.street && streets.length > 0 && !streets.includes(k.street));
  if (rel === 'exact') return contradict && !confirm ? 'unsure' : 'match';
  return confirm && !contradict ? 'match' : 'unsure';
}

/** verifyFacts(text, proposedFacts) → { kept:[{field, aiSays, pos}], rejected } — literal quotes only. */
export function verifyFacts(text, proposed = []) {
  const kept = [];
  const rejected = [];
  for (const f of proposed) {
    const q = f && typeof f.quote === 'string' ? f.quote : '';
    const pos = q ? text.indexOf(q) : -1;
    if (pos === -1) { rejected.push({ ...f, reason: 'quote is not a literal substring of the answer' }); continue; }
    if (kept.some((x) => x.field === f.field && x.aiSays === q)) continue;
    kept.push({ field: f.field, aiSays: text.slice(pos, pos + q.length), pos });
  }
  return { kept, rejected };
}

const numbersIn = (s) => (String(s).match(/\d+(?:\.\d+)?/g) || []).map(Number);
const is24 = (s) => /\b24\s*\/\s*7\b|\b24[\s-]*(?:hours?|hrs?)\b|\bopen\s+24\b|\baround the clock\b|\bnever closes\b/i.test(s);
const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'with', 'of', 'to', 'for', 'at', 'in', 'on', 'is', 'are', 'its', 'their', 'your', 'per']);
const words = (s) => normalizeName(s).split(' ').filter((w) => w && !STOP.has(w));

/**
 * factStatus(field, aiSays, sourceSays) → 'match' | 'differs' | 'not stated'
 * 'not stated' = the owner's website/listings don't state this field, so there is
 * nothing to compare against.
 */
export function factStatus(field, aiSays, sourceSays) {
  if (sourceSays == null || String(sourceSays).trim() === '') return 'not stated';
  if (field === 'phone') {
    const a = phoneKey(aiSays);
    return a && a === phoneKey(sourceSays) ? 'match' : 'differs';
  }
  if (field === 'address') {
    const a = streetKey(aiSays);
    const b = streetKey(sourceSays);
    if (a && b) return a === b ? 'match' : 'differs';
  }
  if (field === 'hours' && (is24(aiSays) || is24(sourceSays))) {
    return is24(aiSays) && is24(sourceSays) ? 'match' : 'differs';
  }
  const an = numbersIn(aiSays);
  if (an.length) {
    const bn = numbersIn(sourceSays);
    return an.every((n) => bn.includes(n)) ? 'match' : 'differs';
  }
  const aw = words(aiSays);
  const bw = new Set(words(sourceSays));
  if (!aw.length) return 'differs';
  return aw.filter((w) => bw.has(w)).length / aw.length >= 0.6 ? 'match' : 'differs';
}

/** What the owner's own website/listings say for a field, or null. */
export function ownerFact(field, business, listings = []) {
  const f = business.facts || {};
  if (f[field] != null && f[field] !== '') return String(f[field]);
  if (field === 'phone' && business.phone) return business.phone;
  if (field === 'address' && business.address) return business.address;
  for (const l of listings) {
    const v = l && l.fields && l.fields[field];
    if (v) return String(v);
  }
  return null;
}

/**
 * verifyAnswer({ answer, proposal, business }) → {
 *   businessesNamed:[{name,pos,isYou?,ownerMatch?}], namedYou, namedYouFirst,
 *   ownerMatch:'match'|'unsure'|'none', facts:[{field,aiSays,pos}], rejected:{businesses,facts} }
 */
export function verifyAnswer({ answer, proposal, business }) {
  const text = answer.text || '';
  const { kept, rejected } = verifyBusinesses(text, (proposal && proposal.businesses) || []);
  let ownerMatch = 'none';
  const businessesNamed = kept.map((b, i) => {
    const m = matchOwner({ text, citations: answer.citations, entry: b, nextPos: kept[i + 1] && kept[i + 1].pos, business });
    if (m === 'match') { ownerMatch = 'match'; return { ...b, isYou: true }; }
    if (m === 'unsure') { if (ownerMatch === 'none') ownerMatch = 'unsure'; return { ...b, ownerMatch: 'unsure' }; }
    return { ...b };
  });
  const earliest = businessesNamed.filter((b) => b.ownerMatch !== 'unsure').reduce((m, b) => (!m || b.pos < m.pos ? b : m), null);
  const namedYou = businessesNamed.some((b) => b.isYou);
  const facts = verifyFacts(text, (proposal && proposal.ownerFacts) || []);
  return {
    businessesNamed,
    namedYou,
    namedYouFirst: namedYou && !!earliest && !!earliest.isYou,
    ownerMatch,
    facts: facts.kept,
    rejected: { businesses: rejected, facts: facts.rejected },
  };
}
