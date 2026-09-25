// src/lib/showcase.js — the homepage hero's "Real AI answer" card.
//
// showcase_answers (supabase/showcase_v5.sql, filled weekly by `node scanner/showcase.js`) holds one
// real answer per trade × town to that trade's "best" question. The Worker picks the visitor's town
// (src/lib/geo.js; else the default town), the trade from ?trade= (else plumbing), and renders the card
// into <div data-showcase> on the server, with every trade's answer for that town as JSON so the
// card's trade picker swaps answers without another request. No rows / Supabase down → the static
// card already in index.html stays (the real Mega Wash & Dry answer).
//
// Everything shown is the stored text: the question exactly as asked, a verbatim excerpt, the
// named businesses in bold (their stored character ranges), and the date asked. Nothing is rewritten.
// Rows are read with the anon key (public select on active rows) and cached 1 hour at the edge.

import { TRADES, normalizeTrade } from '../../scanner/questions.js';
import { DEFAULT_GEO } from './geo.js';

export const CACHE_SECONDS = 3600;
export const FAIL_CACHE_SECONDS = 300;
export const DEFAULT_TRADE = 'plumbing';

/** Picker labels, in TRADES order. */
export const TRADE_LABELS = {
  plumbing: 'Plumbers', hvac: 'Heating & AC', electrical: 'Electricians', roofing: 'Roofers',
  landscaping: 'Landscapers', cleaning: 'House cleaners', auto_repair: 'Auto repair', laundromat: 'Laundromats',
};

/** ?trade= → a TRADES key, or '' (anything else is ignored, never echoed). */
export function tradeParam(v) {
  if (typeof v !== 'string' || v.length > 40) return '';
  const k = normalizeTrade(v);
  return k && TRADES[k] ? k : '';
}

const clean = (s, max) => (typeof s === 'string' && s.trim() && s.length <= max ? s : '');

/** Keep only well-formed rows; spans must lie inside the excerpt, in order, non-overlapping. */
export function validRow(r) {
  if (!r || !TRADES[r.trade] || !clean(r.town, 60) || !/^[A-Z]{2}$/.test(r.state || '')) return false;
  const ex = clean(r.excerpt, 1200);
  if (!ex || !clean(r.question, 200) || Number.isNaN(Date.parse(r.asked_at))) return false;
  let at = 0;
  for (const s of Array.isArray(r.spans) ? r.spans : [null]) {
    if (!Array.isArray(s) || !Number.isInteger(s[0]) || !Number.isInteger(s[1]) || s[0] < at || s[1] <= s[0] || s[1] > ex.length) return false;
    at = s[1];
  }
  return r.spans.length > 0;
}

/**
 * rows → the card data for this visitor, or null.
 * { town, state, trade, answers: { [trade]: { question, excerpt, spans, truncated, askedAt } } }
 */
export function pickShowcase(rows, geo, trade) {
  const byTown = new Map();
  for (const r of rows || []) {
    if (!validRow(r)) continue;
    const key = `${r.town.toLowerCase()}|${r.state}`;
    if (!byTown.has(key)) byTown.set(key, { town: r.town, state: r.state, answers: {} });
    byTown.get(key).answers[r.trade] = { question: r.question, excerpt: r.excerpt, spans: r.spans, truncated: r.truncated !== false, askedAt: r.asked_at };
  }
  const g = geo || DEFAULT_GEO;
  const want = tradeParam(trade) || DEFAULT_TRADE;
  const pick = byTown.get(`${String(g.town).toLowerCase()}|${g.state}`)
    || byTown.get(`${DEFAULT_GEO.town.toLowerCase()}|${DEFAULT_GEO.state}`)
    || [...byTown.values()].find((t) => t.answers[DEFAULT_TRADE])
    || [...byTown.values()][0];
  if (!pick) return null;
  const order = Object.keys(TRADES).filter((k) => pick.answers[k]);
  return { town: pick.town, state: pick.state, trade: pick.answers[want] ? want : order[0], order, answers: pick.answers };
}

export function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The excerpt as HTML: escaped text, named businesses in <b>, a trailing … when cut. */
export function answerHtml(a) {
  // Blank lines between list items are collapsed (the card shows line breaks; see .sc-a).
  const text = (s) => escapeHtml(s.replace(/\n{2,}/g, '\n'));
  let out = '';
  let at = 0;
  for (const [s, e] of a.spans) {
    out += text(a.excerpt.slice(at, s)) + `<b>${escapeHtml(a.excerpt.slice(s, e))}</b>`;
    at = e;
  }
  out += text(a.excerpt.slice(at));
  return out + (a.truncated ? '<span class="sc-more"> &hellip;</span>' : '');
}

/** Inner HTML of <div data-showcase> for picked data `p`. */
export function renderShowcase(p) {
  const a = p.answers[p.trade];
  const options = p.order.map((k) => `<option value="${k}"${k === p.trade ? ' selected' : ''}>${escapeHtml(TRADE_LABELS[k] || k)}</option>`).join('');
  // JSON inside <script>: escape "<" so no string can close the tag.
  const data = JSON.stringify({ answers: p.answers }).replace(/</g, '\\u003c');
  return `<figure class="sc-card">
  <div class="sc-head">
    <figcaption class="sc-label">Real AI answer &middot; asked <span data-sc-date>${escapeHtml(formatDate(a.askedAt))}</span></figcaption>
    <label class="sc-pick"><span class="sr-only">Show the answer for</span><select data-sc-trade>${options}</select></label>
  </div>
  <p class="sc-q" data-sc-q>${escapeHtml(a.question)}</p>
  <p class="sc-a" data-sc-a>${answerHtml(a)}</p>
  <p class="sc-link"><a href="/report/mega-wash-and-dry">See what you get: a real full report &rarr;</a></p>
</figure>
<p class="sc-caption">Is your name in it? These businesses are. If AI doesn&rsquo;t say your name, the call goes to them.</p>
<p class="sc-note">Businesses shown are named by AI, not by us. <a href="mailto:hello@aifoundscore.com?subject=Remove%20from%20homepage%20answer">Ask us to remove one</a>.</p>
<script type="application/json" id="sc-data">${data}</script>`;
}

/** Short stable tag for the page ETag (changes when the shown answer set changes). */
export function showcaseTag(p) {
  if (!p) return '';
  let h = 0x811c9dc5;
  const s = `${p.town}|${p.state}|${p.trade}|${p.order.map((k) => `${k}:${p.answers[k].askedAt}:${p.answers[k].excerpt.length}`).join(',')}`;
  for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return `-sc.${h.toString(36)}`;
}

export async function readShowcaseRows(env, { fetchImpl = fetch } = {}) {
  const key = String(env?.SUPABASE_ANON_KEY || '').trim();
  const base = String(env?.SUPABASE_URL || '').replace(/\/+$/, '');
  if (!base || !key) throw new Error('supabase not configured');
  const q = 'active=eq.true&select=trade,town,state,question,excerpt,spans,truncated,asked_at&limit=5000';
  const res = await fetchImpl(`${base}/rest/v1/showcase_answers?${q}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(2500),
  });
  if (!res.ok) throw new Error(`showcase_answers read failed: ${res.status}`);
  return res.json();
}

/**
 * All active rows, from the edge cache when warm. Never throws: a failure is [] (the static card
 * stays), cached for FAIL_CACHE_SECONDS so a missing table doesn't cost every page view a request.
 * deps: { readRows, cache, waitUntil, origin }
 */
export async function loadShowcaseRows(env, deps = {}) {
  const cache = deps.cache ?? (typeof caches !== 'undefined' ? caches.default : null);
  const cacheKey = new Request(`${deps.origin || 'https://aifoundscore.com'}/__showcase-rows?v=1`, { method: 'GET' });
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return await hit.json();
    } catch { /* treat as a miss */ }
  }
  let rows = [];
  let ttl = CACHE_SECONDS;
  try {
    const r = await (deps.readRows || readShowcaseRows)(env);
    rows = Array.isArray(r) ? r : [];
  } catch (e) {
    console.warn('[showcase] read failed', String(e?.message || e).slice(0, 200));
    ttl = FAIL_CACHE_SECONDS;
  }
  if (cache) {
    const put = cache.put(cacheKey, new Response(JSON.stringify(rows), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}` } })).catch(() => {});
    if (deps.waitUntil) deps.waitUntil(put); else await put;
  }
  return rows;
}

/** Fill <div data-showcase> when there is something to show; otherwise leave the static card. */
export function addShowcaseHandler(rewriter, picked) {
  if (!picked) return rewriter;
  const html = renderShowcase(picked);
  return rewriter.on('[data-showcase]', { element(el) { el.setInnerContent(html, { html: true }); el.setAttribute('data-showcase', 'live'); } });
}
