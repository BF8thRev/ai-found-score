// src/lib/questions-route.js — GET /api/questions: the exact questions the free scan asks, built from
// the scanner's own templates (scanner/questions.js).
//
//   ?town= &zip= &state=           where
//   ?trade=                        the kind of business, when the owner typed it
//   ?name= ?preset= ?website=      otherwise: the name, else a link's ?preset=, else the website (scanner/kind.js)
//
// → { ok: true, trade, from: 'owner' | 'name' | 'preset' | 'website', questions: [{ id, intent, text }] }
// → 422 { ok: false, needKind: true } when nothing tells us what the business does: the form then asks.

import { freeQuestions, tradeOrKind } from '../../scanner/questions.js';
import { inferKind, guessKind } from '../../scanner/kind.js';

export const TOWN_RE = /^[\p{L}\p{M}0-9 .,'’-]{1,60}$/u;

export async function handleQuestions(url, { fetchImpl } = {}) {
  const p = url.searchParams;
  const town = String(p.get('town') || '').trim().replace(/\s+/g, ' ').replace(/,\s*[A-Za-z]{2}$/, '');
  const zip = String(p.get('zip') || '').trim();
  const state = String(p.get('state') || 'NY').trim();
  const bad = (error, extra = {}) => Response.json({ ok: false, error, ...extra }, { status: 422, headers: { 'Cache-Control': 'no-store' } });
  if (!TOWN_RE.test(town)) return bad('Please enter your town.');
  if (zip && !/^\d{5}$/.test(zip)) return bad('ZIP must be 5 digits.');
  if (!/^[A-Za-z]{2}$/.test(state)) return bad('State must be a 2-letter code.');
  // Typed by the owner, else the name, else a link's preset, else the website.
  const typed = tradeOrKind(String(p.get('trade') || '').slice(0, 40));
  const byName = typed ? null : guessKind(String(p.get('name') || '').slice(0, 120));
  const preset = typed || byName ? null : tradeOrKind(String(p.get('preset') || '').slice(0, 40));
  let trade = typed || byName || preset;
  let from = typed ? 'owner' : byName ? 'name' : preset ? 'preset' : null;
  if (!trade) {
    const k = await inferKind({ website: String(p.get('website') || '').slice(0, 160) }, fetchImpl ? { fetchImpl } : {});
    trade = k.kind;
    from = k.from;
  }
  if (!trade) return bad('What kind of business is it?', { needKind: true });
  const questions = freeQuestions({ trade, town, zip, state }).map(({ id, intent, text }) => ({ id, intent, text }));
  return Response.json({ ok: true, trade, from, questions }, { headers: { 'Cache-Control': 'public, max-age=300' } });
}
