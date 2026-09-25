#!/usr/bin/env node
// scanner/showcase.js — the homepage "real AI answer" card, asked from this PC.
//
// For each town × trade, asks ONE assistant that trade's "best" question ("What's the best plumber in
// Massapequa, NY?"), finds the businesses it names (extractor + literal check), cuts the homepage
// excerpt (scanner/answer-text.js) and upserts it into showcase_answers (supabase/showcase_v5.sql).
// Every paid call is written to scan_usage (kind 'other', answer_ref 'showcase:<trade>:<town>,<ST>'),
// so /admin shows the spend. A row whose `active` was set false (takedown) stays off: the upsert
// never sends `active`.
//
//   node scanner/showcase.js [--towns "Massapequa,NY,11758;Hicksville,NY"] [--trades plumbing,hvac]
//                            [--engine chatgpt] [--estimate] [--yes] [--dry-run]
//
// Run it weekly; the card always shows the date the question was asked.
// Keys: .dev.vars (same as scanner/run.js). --dry-run answers from the fixtures and stores nothing.

import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { ACTIVE_ENGINES, ENGINE_IDS, TYPICAL_CALL, enginesConfigured, priceCall, resolveKeys, round6, stateAbbr } from './config.js';
import { TRADES, buildQuestions } from './questions.js';
import { ENGINES } from './engines/index.js';
import { proposeForAnswer } from './extract/propose.js';
import { verifyBusinesses } from './extract/verify.js';
import { displayText, excerptAnswer } from './answer-text.js';
import { canStore, usageRow, saveUsage } from './store.js';
import { loadEnv } from './env.js';

export const DEFAULT_TOWNS = [{ town: 'Massapequa', state: 'NY', zip: '11758' }];
export const REF_PREFIX = 'showcase';

export const USAGE = `Usage: node scanner/showcase.js [--towns "Town,ST[,ZIP];Town,ST"] [--trades ${Object.keys(TRADES).join(',')}]
                              [--engine chatgpt] [--estimate] [--yes] [--dry-run]

  --towns     semicolon list of "Town,ST[,ZIP]" (default ${DEFAULT_TOWNS.map((t) => `${t.town},${t.state}`).join(';')})
  --trades    comma list (default: all ${Object.keys(TRADES).length})
  --engine    one assistant (default: the first of ${ACTIVE_ENGINES.join(', ')} with a key)
  --estimate  print the plan and cost estimate, then exit
  --yes       don't ask "Proceed? [y/N]"
  --dry-run   fixture answers, nothing stored, no cost`;

export function parseArgs(argv) {
  const a = { towns: null, trades: null, engine: null, estimate: false, yes: false, dryRun: false, help: false, error: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--towns') a.towns = next();
    else if (k === '--trades') a.trades = next();
    else if (k === '--engine') a.engine = next();
    else if (k === '--estimate') a.estimate = true;
    else if (k === '--yes' || k === '-y') a.yes = true;
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--help' || k === '-h') a.help = true;
    else a.error = `unknown argument: ${k}`;
  }
  return a;
}

/** "Massapequa,NY,11758;Hicksville,NY" → [{ town, state, zip }] (throws on a bad entry). */
export function parseTowns(s) {
  if (!s) return DEFAULT_TOWNS;
  return String(s).split(';').map((x) => x.trim()).filter(Boolean).map((x) => {
    const [town, st, zip] = x.split(',').map((p) => p.trim());
    const state = st ? stateAbbr(st) : '';
    if (!town || !/^[A-Z]{2}$/.test(state || '')) throw new Error(`bad town "${x}" (want "Town,ST[,ZIP]")`);
    if (zip && !/^\d{5}$/.test(zip)) throw new Error(`bad ZIP in "${x}"`);
    return { town, state, zip: zip || '' };
  });
}

export function parseTrades(s) {
  if (!s) return Object.keys(TRADES);
  const list = String(s).split(',').map((x) => x.trim()).filter(Boolean);
  for (const t of list) if (!TRADES[t]) throw new Error(`unknown trade "${t}" (known: ${Object.keys(TRADES).join(', ')})`);
  return list;
}

export function pickShowcaseEngine(env, wanted) {
  const on = enginesConfigured(env);
  if (wanted) {
    if (!ENGINE_IDS.includes(wanted)) throw new Error(`unknown engine "${wanted}"`);
    if (!on[wanted]) throw new Error(`no key for ${wanted}`);
    return wanted;
  }
  return ACTIVE_ENGINES.find((e) => on[e]) || null;
}

export function estimate({ towns, trades, engine }) {
  const n = towns.length * trades.length;
  return round6(n * (priceCall(engine, TYPICAL_CALL[engine]) + priceCall('extract', TYPICAL_CALL.extract)));
}

/**
 * Ask one town × trade and build its row. Never throws.
 * → { ok, row?, reason?, usage: [scan_usage rows], preview? }
 */
export async function showcaseOne({ trade, town, state, zip, engine, env, fetchImpl = fetch, propose = proposeForAnswer, now = () => new Date() }) {
  const usage = [];
  const ref = `${REF_PREFIX}:${trade}:${town},${state}`;
  const question = buildQuestions({ trade, town, state, zip }).find((q) => q.intent === 'best');
  let res;
  try {
    res = await ENGINES[engine].ask({ question: { id: question.id, text: question.text }, business: { name: '', trade, town, state, zip }, env, fetchImpl, timeoutMs: 120_000 });
  } catch (e) {
    res = { ok: false, error: String(e?.message || e), costUsd: 0 };
  }
  usage.push(usageRow({ kind: 'other', provider: engine, model: res?.model || null, costUsd: res?.costUsd || 0, ok: !!res?.ok, error: res?.ok ? null : res?.error, answerRef: ref }));
  if (!res?.ok || !String(res.text || '').trim()) return { ok: false, reason: `engine: ${res?.error || 'no answer'}`, usage };

  const text = displayText(res.text);
  const prop = await propose({ answer: { text }, raw: String(res.text), business: { name: '(none: list every business)', town }, env, fetchImpl });
  usage.push(usageRow({ kind: 'extract', model: prop.model, usage: prop.usage, costUsd: prop.costUsd || 0, ok: prop.ok, error: prop.error, answerRef: ref }));
  if (!prop.ok) return { ok: false, reason: `extract: ${prop.error}`, usage };

  const names = verifyBusinesses(text, prop.businesses).kept.map((b) => b.name);
  const ex = excerptAnswer(text, names);
  if (!ex) return { ok: false, reason: names.length ? 'no clean excerpt (phone/address before any name, or too long)' : 'answer names no business', usage };

  return {
    ok: true,
    usage,
    row: {
      trade, town, state,
      question: question.text,
      excerpt: ex.text,
      spans: ex.spans,
      truncated: ex.truncated,
      answer: String(res.text),
      engine,
      asked_at: res.askedAt || now().toISOString(),
      updated_at: now().toISOString(),
    },
  };
}

/** Upsert rows into showcase_answers (service key). `active` is never sent, so a takedown sticks. */
export async function saveShowcase(env, rows, { fetchImpl = fetch } = {}) {
  if (!rows.length) return { ok: true };
  const k = resolveKeys(env);
  const res = await fetchImpl(`${k.supabaseUrl}/rest/v1/showcase_answers?on_conflict=trade,town,state`, {
    method: 'POST',
    headers: {
      apikey: k.supabaseServiceKey, Authorization: `Bearer ${k.supabaseServiceKey}`,
      'Content-Type': 'application/json', Prefer: 'return=minimal,resolution=merge-duplicates',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) return { ok: false, error: `showcase_answers upsert failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}` };
  return { ok: true };
}

async function confirm(q) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^y(es)?$/i.test((await rl.question(q)).trim()); } finally { rl.close(); }
}

export async function main(argv = process.argv.slice(2), { log = console.log, err = console.error } = {}) {
  const a = parseArgs(argv);
  if (a.help) { log(USAGE); return 0; }
  if (a.error) { err(a.error); err(USAGE); return 2; }
  let towns, trades, engine, env, fetchImpl = fetch, propose = proposeForAnswer;
  try {
    towns = parseTowns(a.towns);
    trades = parseTrades(a.trades);
    if (a.dryRun) {
      const { fixtureFetch, DRY_RUN_ENV } = await import('./dry-run.js');
      const { fakeProposal } = await import('../src/admin/dry-run.js');
      env = { ...DRY_RUN_ENV };
      fetchImpl = fixtureFetch();
      // Canned extractor: the answer's **bold** names (as the Worker's dry run does), no network.
      propose = async ({ raw }) => ({ ok: true, error: null, model: 'dry-run', usage: null, costUsd: 0, businesses: fakeProposal(raw, '').businesses });
    } else {
      env = loadEnv().env;
    }
    engine = pickShowcaseEngine(env, a.engine);
    if (!engine) throw new Error('no engine key in .dev.vars');
    if (!a.dryRun && !resolveKeys(env).anthropicKey) throw new Error('ANTHROPIC_API_KEY missing (the extractor finds the business names)');
    if (!a.dryRun && !canStore(env)) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY missing');
  } catch (e) {
    err(String(e.message || e));
    return 2;
  }

  const est = estimate({ towns, trades, engine });
  log(`Showcase: ${towns.length} town(s) × ${trades.length} trade(s) on ${engine}. Estimated cost $${est.toFixed(2)}${a.dryRun ? ' (dry run: $0, nothing stored)' : ''}.`);
  if (a.estimate) return 0;
  if (!a.yes && !a.dryRun && !(await confirm('Proceed? [y/N] '))) { log('Cancelled.'); return 1; }

  let spent = 0;
  let saved = 0;
  let failed = 0;
  for (const t of towns) {
    for (const trade of trades) {
      const r = await showcaseOne({ trade, ...t, engine, env, fetchImpl, propose });
      spent += r.usage.reduce((s, u) => s + u.cost_usd, 0);
      if (!a.dryRun) {
        const u = await saveUsage(env, r.usage, { fetchImpl });
        if (!u.ok) err(`  usage not recorded: ${u.error}`);
      }
      const label = `${trade} · ${t.town}, ${t.state}`;
      if (!r.ok) { failed++; log(`✗ ${label}: ${r.reason}`); continue; }
      const s = a.dryRun ? { ok: true } : await saveShowcase(env, [r.row], { fetchImpl });
      if (!s.ok) { failed++; err(`✗ ${label}: ${s.error}`); continue; }
      saved++;
      log(`✓ ${label}\n    ${r.row.excerpt.replace(/\n+/g, ' / ')}${r.row.truncated ? ' …' : ''}`);
    }
  }
  log(`Done: ${saved} saved, ${failed} skipped. ${a.dryRun ? "Dry run: nothing spent" : `Spent $${round6(spent).toFixed(4)}`}.`);
  return failed && !saved ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}
