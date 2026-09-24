#!/usr/bin/env node
// scanner/cli.js — Node-only wrapper around runScan / ping.
//
//   node scanner/cli.js --business path.json [--engines perplexity,gemini] [--runs 1]
//                       [--dry-run] [--ping] [--store] [--out result.json] [--estimate]
//
// Keys come from process.env, then .dev.vars in the repo root (process.env wins).
// --dry-run answers every call from scanner/test/fixtures/engines/ (no network, no keys).
// --store   writes one scan_raw row per call to Supabase (needs SUPABASE_URL + SUPABASE_SERVICE_KEY).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScan, pingAll, summarizeScan } from './scan.js';
import { ENGINE_IDS, ACTIVE_ENGINES, DEFAULT_RUNS, estimateScanCost, enginesConfigured } from './config.js';
import { buildQuestions } from './questions.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function parseArgs(argv) {
  const a = { engines: null, runs: null, dryRun: false, ping: false, store: false, out: null, business: null, estimate: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--business' || k === '-b') a.business = next();
    else if (k === '--engines' || k === '-e') a.engines = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--runs' || k === '-r') a.runs = Number(next());
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--ping') a.ping = true;
    else if (k === '--store') a.store = true;
    else if (k === '--estimate') a.estimate = true;
    else if (k === '--out' || k === '-o') a.out = next();
    else if (k === '--help' || k === '-h') a.help = true;
    else throw new Error(`unknown argument: ${k}`);
  }
  return a;
}

/** Parse a .dev.vars / .env file (KEY=VALUE, # comments, optional quotes). */
export function parseDotVars(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function loadEnv() {
  const env = {};
  const file = resolve(ROOT, '.dev.vars');
  if (existsSync(file)) Object.assign(env, parseDotVars(readFileSync(file, 'utf8')));
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && v !== '') env[k] = v;
  return env;
}

const USAGE = `Usage: node scanner/cli.js --business path.json [--engines ${ACTIVE_ENGINES.join(',')}] [--runs 1]
                          [--dry-run] [--ping] [--store] [--out result.json] [--estimate]`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(USAGE);
  // Default: the engines the site advertises. Any of ENGINE_IDS can be named with --engines.
  const engines = args.engines || ACTIVE_ENGINES;

  let env = loadEnv();
  let fetchImpl = globalThis.fetch;
  if (args.dryRun) {
    const dry = await import('./dry-run.js');
    env = { ...dry.DRY_RUN_ENV, GEMINI_RESOLVE_REDIRECTS: '1' };
    fetchImpl = dry.fixtureFetch();
    console.error('[dry-run] answering from scanner/test/fixtures/engines/ — no network');
  }

  if (args.ping) {
    const configured = enginesConfigured(env);
    const results = await pingAll(env, { engines, fetchImpl });
    for (const r of results) {
      console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.engine.padEnd(15)} ${String(r.ms).padStart(5)}ms  ${r.ok ? JSON.stringify(r.detail) : r.error}${configured[r.engine] ? '' : ' (no key)'}`);
    }
    process.exitCode = results.every((r) => r.ok) ? 0 : 1;
    return;
  }

  if (!args.business) throw new Error(`--business is required\n${USAGE}`);
  const business = JSON.parse(readFileSync(resolve(args.business), 'utf8'));
  const runs = args.runs || undefined;

  const questions = buildQuestions(business);
  const est = estimateScanCost({ engines, questions: questions.length, runs: runs || DEFAULT_RUNS });
  console.error(`Questions for ${business.name || '(unnamed)'}:`);
  for (const q of questions) console.error(`  ${q.id} [${q.intent}] ${q.text}`);
  console.error(`Estimated cost: $${est.total.toFixed(3)} (${Object.entries(est.perEngine).map(([e, c]) => `${e} $${c.toFixed(3)}`).join(', ')}, extraction $${est.extract.toFixed(3)})`);
  if (args.estimate) return;

  let done = 0;
  const total = questions.length * engines.length * (runs || DEFAULT_RUNS);
  const scan = await runScan({
    business,
    env,
    engines,
    runs,
    fetchImpl,
    store: args.store ? true : undefined,
    onCall: (c) => {
      done++;
      console.error(`  [${String(done).padStart(2)}/${total}] ${c.ok ? 'ok  ' : 'FAIL'} ${c.engine.padEnd(15)} ${c.questionId} run ${c.run}  $${(c.costUsd || 0).toFixed(4)}  ${c.ok ? `${c.citations.length} citations` : c.error}`);
    },
  });

  const summary = summarizeScan(scan);
  console.log(JSON.stringify(summary, null, 2));
  if (args.out) {
    writeFileSync(resolve(args.out), JSON.stringify(scan, null, 2));
    console.error(`Full result written to ${args.out}`);
  }
  if (args.store && scan.stored && !scan.stored.ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exitCode = 1;
});
