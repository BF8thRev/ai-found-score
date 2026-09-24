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
    // "right on the North Babylon–Deer Park border" is a location phrase, not an address.
    if (f.field === 'address' && !isAddressFact(q)) { rejected.push({ ...f, reason: 'address quote has no street number + street name or ZIP' }); continue; }
    if (kept.some((x) => x.field === f.field && x.aiSays === q)) continue;
    kept.push({ field: f.field, aiSays: text.slice(pos, pos + q.length), pos });
  }
  return { kept, rejected };
}

const numbersIn = (s) => (String(s).match(/\d+(?:\.\d+)?/g) || []).map(Number);
const is24 = (s) => /\b24\s*\/\s*7\b|\b24[\s-]*(?:hours?|hrs?)\b|\bopen\s+24\b|\baround the clock\b|\bnever closes\b/i.test(s);
const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'with', 'of', 'to', 'for', 'at', 'in', 'on', 'is', 'are', 'its', 'their', 'your', 'per']);
const words = (s) => normalizeName(s).split(' ').filter((w) => w && !STOP.has(w));

// ---- address -----------------------------------------------------------------------------
// A ZIP: 5 digits not followed by a word (so "12345 Main St" is a street number, not a ZIP).
const ZIP_RE = /\b(\d{5})(?:-\d{4})?\b(?!\s+[A-Za-z])/;
// A street without a suffix word: "1502 Deer Park, North Babylon, NY".
const LOOSE_STREET_RE = /\b(\d{1,6})\s+([A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,3})/;

/** { street, number, name, zip } of an address-like string ('' when absent). */
export function addressParts(s) {
  const str = String(s || '');
  const street = streetKey(str);
  const zipM = str.match(ZIP_RE);
  let number = '';
  let name = '';
  if (street) {
    const [n, ...rest] = street.split(' ');
    number = n;
    name = rest.slice(0, -1).join(' ');
  } else {
    const m = str.match(LOOSE_STREET_RE);
    // A bare number + word ("20 lb", "24 hours") is not a street; only count it before a ", NY" / ZIP.
    if (m && (zipM || /,\s*[A-Z]{2}\b/.test(str))) { number = m[1]; name = normalizeName(m[2]); }
  }
  return { street, number, name, zip: zipM ? zipM[1] : '' };
}

/** True when a quote states an address: a street number + street name, or a ZIP. */
export function isAddressFact(s) {
  const p = addressParts(s);
  return !!(p.street || (p.number && p.name) || p.zip);
}

// Compared on street number + street name (Ave/Avenue, case, punctuation normalized) and ZIP;
// town words are ignored ("1502 Deer Park Ave in North Babylon, NY" matches the full address).
function addressStatus(aiSays, sourceSays) {
  const a = addressParts(aiSays);
  if (!(a.street || (a.number && a.name) || a.zip)) return 'not stated';
  const b = addressParts(sourceSays);
  let compared = false;
  if (a.number && b.number) {
    compared = true;
    if (a.number !== b.number) return 'differs';
    if (a.street && b.street) {
      if (a.street !== b.street) return 'differs';
    } else if (a.name && b.name && !a.name.startsWith(b.name) && !b.name.startsWith(a.name)) {
      return 'differs';
    }
  }
  if (a.zip && b.zip) {
    compared = true;
    if (a.zip !== b.zip) return 'differs';
  }
  return compared ? 'match' : 'not stated';
}

// ---- price -------------------------------------------------------------------------------
const UNITS = [
  [/^(?:lbs?|pounds?)\b/i, 'lb'],
  [/^(?:kgs?|kilos?|kilograms?)\b/i, 'kg'],
  [/^loads?\b/i, 'load'],
  [/^(?:hours?|hrs?)\b/i, 'hour'],
  [/^bags?\b/i, 'bag'],
  [/^(?:items?|pieces?|pcs)\b/i, 'item'],
  [/^(?:visits?|calls?|service calls?)\b/i, 'visit'],
];
function unitAt(s) {
  const t = s.replace(/^\s*(?:\/|per\b|an?\b|each\b|every\b)?\s*/i, '');
  for (const [re, u] of UNITS) if (re.test(t)) return u;
  return null;
}

/** "$2.25 per pound with a 20 lb minimum" → { money:[{n:2.25,unit:'lb'}], qty:[{n:20,unit:'lb'}] } */
export function priceParts(s) {
  const str = String(s || '');
  const money = [];
  const qty = [];
  for (const m of str.matchAll(/\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/g)) {
    const after = str.slice(m.index + m[0].length, m.index + m[0].length + 24);
    money.push({ n: Number(m[1].replace(/,/g, '')), unit: /^\s*(?:\/|per\b|an?\b|each\b)/i.test(after) ? unitAt(after) : null });
  }
  for (const m of str.matchAll(/(?<![$\d.,])(\d+(?:\.\d+)?)\s*-?\s*(?=[A-Za-z])/g)) {
    const unit = unitAt(str.slice(m.index + m[0].length, m.index + m[0].length + 24));
    if (unit) qty.push({ n: Number(m[1]), unit });
  }
  return { money, qty };
}

// Numbers + units: "$2.25 per pound with a 20 lb minimum" matches "$2.25/lb, 20 lb minimum".
function priceStatus(aiSays, sourceSays) {
  const a = priceParts(aiSays);
  const b = priceParts(sourceSays);
  if ((!a.money.length && !a.qty.length) || (!b.money.length && !b.qty.length)) return 'not stated';
  const same = (x, y) => Math.abs(x - y) < 0.005;
  let compared = false;
  if (a.money.length && b.money.length) {
    for (const m of a.money) {
      compared = true;
      const hit = b.money.find((x) => same(x.n, m.n));
      if (!hit) return 'differs';
      if (m.unit && hit.unit && m.unit !== hit.unit) return 'differs';
    }
  }
  for (const q of a.qty) {
    const sameUnit = b.qty.filter((x) => x.unit === q.unit);
    if (!sameUnit.length) continue;
    compared = true;
    if (!sameUnit.some((x) => same(x.n, q.n))) return 'differs';
  }
  return compared ? 'match' : 'not stated';
}

// ---- hours -------------------------------------------------------------------------------
// "open 24 hours a day, 365 days a year" / "open 24/7" / "24 hours" all match "Open 24 Hours
// Monday - Sunday". Vague words ("open late") are not compared.
function hoursStatus(aiSays, sourceSays) {
  const a24 = is24(aiSays);
  const b24 = is24(sourceSays);
  if (a24 && b24) return 'match';
  const an = numbersIn(aiSays);
  if (!a24 && !an.length) return 'not stated';
  if (a24 !== b24) return 'differs';
  const bn = numbersIn(sourceSays);
  if (!bn.length) return 'not stated';
  return an.every((n) => bn.includes(n)) ? 'match' : 'differs';
}

// ---- services ----------------------------------------------------------------------------
const SERVICE_FILLER = new Set([
  'offer', 'offers', 'offering', 'offered', 'provide', 'provides', 'providing', 'service', 'services', 'has', 'have',
  'they', 'it', 'you', 'can', 'also', 'as', 'well', 'including', 'include', 'includes', 'from', 'up', 'list', 'lists',
  'location', 'locations', 'there', 'this', 'that', 'be', 'by', 'all', 'across', 'more', 'plus', 'very', 'great',
  'good', 'convenient', 'modern', 'new', 'brand', 'large', 'massive', 'big', 'lot', 'lots', 'number', 'explicitly',
  'noted', 'able', 'take', 'over', 'seamless', 'professional', 'available', 'which', 'who', 'where', 'our', 'we',
  'them', 'these', 'those', 'while', 'every', 'each', 'any', 'some', 'such', 'like', 'capacity', 'lb', 'lbs',
]);
const NEGATION = /\b(?:no|not|never|without|lacks?|doesn['’]?t|does not|don['’]?t|do not|isn['’]?t|aren['’]?t|won['’]?t|cannot|can['’]?t|unavailable)\b/i;
const stem = (w) => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

/** Key terms of a services phrase: "wash & fold pick-up" → ['wash', 'fold', 'pickup']. */
export function serviceTerms(s) {
  const t = String(s || '')
    .toLowerCase()
    .replace(/[‐-―]/g, '-')
    .replace(/\bpick[\s-]*ups?\b/g, 'pickup')
    .replace(/\bdrop[\s-]*offs?\b/g, 'dropoff')
    .replace(/\bself[\s-]*serv(?:e|ice)\b/g, 'selfserve')
    .replace(/\//g, ' ');
  return [...new Set(normalizeName(t).split(' ').filter((w) => w && !/^\d/.test(w) && !STOP.has(w) && !SERVICE_FILLER.has(w)).map(stem))];
}

// Key-term overlap. `match` only when clearly supported, else `not stated`; `differs` only
// when the AI contradicts the owner ("they don't offer delivery").
function servicesStatus(aiSays, sourceSays) {
  const a = serviceTerms(aiSays);
  const b = new Set(serviceTerms(sourceSays));
  if (!a.length || !b.size) return 'not stated';
  const shared = a.filter((w) => b.has(w));
  if (NEGATION.test(aiSays) && shared.length) return 'differs';
  return shared.length >= 2 && shared.length / a.length >= 0.4 ? 'match' : 'not stated';
}

/**
 * factStatus(field, aiSays, sourceSays) → 'match' | 'differs' | 'not stated'
 * 'not stated' = nothing to compare: the owner's website/listings don't state this field, or
 * the AI's words aren't specific enough to check (a vague location, "open late", services the
 * owner's facts don't mention). 'differs' only when the two genuinely disagree.
 */
export function factStatus(field, aiSays, sourceSays) {
  if (sourceSays == null || String(sourceSays).trim() === '') return 'not stated';
  if (field === 'phone') {
    const a = phoneKey(aiSays);
    if (!a) return 'not stated';
    return a === phoneKey(sourceSays) ? 'match' : 'differs';
  }
  if (field === 'address') return addressStatus(aiSays, sourceSays);
  if (field === 'price') return priceStatus(aiSays, sourceSays);
  if (field === 'hours') return hoursStatus(aiSays, sourceSays);
  if (field === 'services') return servicesStatus(aiSays, sourceSays);
  const an = numbersIn(aiSays);
  if (an.length) {
    const bn = numbersIn(sourceSays);
    return an.every((n) => bn.includes(n)) ? 'match' : 'differs';
  }
  const aw = words(aiSays);
  const bw = new Set(words(sourceSays));
  if (!aw.length) return 'not stated';
  return aw.filter((w) => bw.has(w)).length / aw.length >= 0.6 ? 'match' : 'not stated';
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
