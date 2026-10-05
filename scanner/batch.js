#!/usr/bin/env node
// scanner/batch.js — run a list of pre-scans as one batch that can be stopped and re-run safely.
//
//   node scanner/batch.js --batch exp002-2026-10-04 --list prospects.json [--base https://aifoundscore.com] [--yes]
//
// Each prospect is scanned by the live site, exactly as the "Run scan" form on /admin does
// (POST /api/admin/scan, so scan behaviour, scoring and reports are unchanged), one at a time.
// Every scan is tagged with the batch id and the prospect's id (scans.batch_id / batch_item,
// supabase/v14_scan_batch.sql). Before each prospect the runner reads those rows back:
//   - a strictly finished scan (scanFinished in src/admin/scan-core.js) → skipped, nothing is paid
//   - a scan still queued/running (touched in the last --stale-min minutes) → waited for, not restarted
//   - otherwise (none yet, failed, cancelled, "done" with a failed call inside, stuck) → scanned
// The database is the only record: if this process is killed, re-running the same command picks
// up where it stopped and never pays twice for a finished prospect.
//
// prospects.json: an array of { id?, business: { id?, name, trade, town, zip?, website?, ... },
// engines?, runs?, questions?, notes? } or of plain business objects. The prospect id is `id`,
// else business.id (the businesses row); every prospect needs one.
//
// Keys: .dev.vars in the repo root overlaid by process.env: ADMIN_TOKEN (to start scans),
// SUPABASE_URL + SUPABASE_SERVICE_KEY (to read the scans rows). Never prints values.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { loadEnv } from './env.js';
import { canStore, getScan, listBatchScans } from './store.js';
import { parseScanRequest, scanFinished, BATCH_ID_RE } from '../src/admin/scan-core.js';
import { ALL_ENGINES } from '../src/admin/api.js';

const USAGE = `Usage: node scanner/batch.js --batch <id> --list <prospects.json> [--base <url>] [--yes]
  --batch      batch id, e.g. exp002-2026-10-04 (letters, digits, . _ -)
  --list       JSON array of prospects (see the top of scanner/batch.js)
  --base       site that runs the scans (default https://aifoundscore.com, or AFS_BASE_URL)
  --check      only report which prospects are finished / to scan; start nothing
  --yes        start without asking
  --poll-sec   seconds between status reads (default 15)
  --wait-min   minutes to wait for one scan before moving on (default 30)
  --stale-min  a queued/running scan untouched this long is treated as dead and re-run (default 45)`;

const ACTIVE = new Set(['queued', 'running']);
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseArgs(argv) {
  const a = { batch: null, list: null, base: null, check: false, yes: false, help: false, pollSec: 15, waitMin: 30, staleMin: 45 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${k} needs a value`);
      return argv[++i];
    };
    const num = () => {
      const n = Number(next());
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${k} needs a positive number`);
      return n;
    };
    if (k === '--batch') a.batch = next().trim();
    else if (k === '--list') a.list = next();
    else if (k === '--base') a.base = next().trim();
    else if (k === '--check') a.check = true;
    else if (k === '--yes' || k === '-y') a.yes = true;
    else if (k === '--poll-sec') a.pollSec = num();
    else if (k === '--wait-min') a.waitMin = num();
    else if (k === '--stale-min') a.staleMin = num();
    else if (k === '--help' || k === '-h') a.help = true;
    else throw new Error(`unknown option ${k}`);
  }
  return a;
}

/**
 * The list → [{ id, body }], every request validated before anything starts.
 * Throws with every problem listed, so a bad list costs nothing.
 */
export function prepareItems(list, batchId) {
  if (!BATCH_ID_RE.test(String(batchId || ''))) throw new Error('--batch: letters, digits, . _ - (max 64)');
  if (!Array.isArray(list) || !list.length) throw new Error('the list must be a non-empty JSON array');
  const items = [];
  const problems = [];
  const seen = new Set();
  list.forEach((entry, i) => {
    const e = entry && typeof entry === 'object' ? entry : {};
    const { id: itemId, business: b, ...rest } = e.business ? e : { business: e };
    const id = String(itemId ?? (e.business ? b?.id : e.id) ?? '').trim();
    const where = `#${i + 1}${b?.name ? ` (${b.name})` : ''}`;
    if (!id) return void problems.push(`${where}: no id (set "id" or business.id)`);
    if (seen.has(id)) return void problems.push(`${where}: id ${id} appears twice`);
    seen.add(id);
    const body = { ...rest, business: b, batchId, batchItem: id };
    const parsed = parseScanRequest(body, { knownEngines: ALL_ENGINES });
    if (!parsed.ok) return void problems.push(`${where}: ${parsed.error}`);
    items.push({ id, name: parsed.params.business.name, body });
  });
  if (problems.length) throw new Error(`The list has problems; nothing was started:\n  ${problems.join('\n  ')}`);
  return items;
}

/**
 * Where a prospect stands, from its tagged scans rows (newest first).
 * → { action: 'skip'|'wait'|'scan', row?, reason }
 */
export function decide(rows, { now = Date.now(), staleMs = 45 * 60_000 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const done = list.find((r) => scanFinished(r).finished);
  if (done) return { action: 'skip', row: done, reason: 'already finished' };
  const live = list.find((r) => ACTIVE.has(r.status) && now - Date.parse(r.updated_at || r.created_at || 0) < staleMs);
  if (live) return { action: 'wait', row: live, reason: `scan ${live.id} is still ${live.status}` };
  const last = list[0];
  return { action: 'scan', row: last || null, reason: last ? `last try not finished (${scanFinished(last).reason})` : 'not scanned yet' };
}

/** POST /api/admin/scan on the live site → scanId. Throws on refusal. */
async function startOnSite({ base, adminToken, body, fetchImpl }) {
  const res = await fetchImpl(`${base}/api/admin/scan`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let out = null;
  try { out = await res.json(); } catch { /* not JSON */ }
  if (res.status !== 202 || !out?.scanId) throw new Error(`the site refused the scan: ${res.status} ${String(out?.error || '').slice(0, 300)}`);
  return out.scanId;
}

/** Poll the scans row until it leaves queued/running, or `waitMs` passes (→ the last row read). */
async function waitForScan({ env, scanId, fetchImpl, sleep, pollMs, waitMs, now }) {
  const until = now() + waitMs;
  let row = null;
  for (;;) {
    row = await getScan(env, scanId, { fetchImpl }).catch(() => row);
    if (row && !ACTIVE.has(row.status)) return { row, timedOut: false };
    if (now() >= until) return { row, timedOut: true };
    await sleep(pollMs);
  }
}

/**
 * Run (or resume) a batch. One prospect at a time; every decision is read from the database.
 * → { results: [{ id, name, outcome: 'skipped'|'finished'|'not finished'|'timed out'|'error', scanId?, reason }] }
 */
export async function runBatch({
  batchId, items, env, base, adminToken, fetchImpl = globalThis.fetch, sleep = defaultSleep, now = Date.now,
  pollMs = 15_000, waitMs = 30 * 60_000, staleMs = 45 * 60_000, log = () => {}, checkOnly = false,
}) {
  const results = [];
  for (const [i, item] of items.entries()) {
    const tag = `[${i + 1}/${items.length}] ${item.name} (${item.id})`;
    const rows = await listBatchScans(env, batchId, item.id, { fetchImpl });
    const d = decide(rows, { now: now(), staleMs });
    if (d.action === 'skip') {
      log(`${tag}: skip, ${d.reason} (scan ${d.row.id})`);
      results.push({ id: item.id, name: item.name, outcome: 'skipped', scanId: d.row.id, reason: d.reason });
      continue;
    }
    if (checkOnly) {
      log(`${tag}: would ${d.action === 'wait' ? 'wait' : 'scan'}, ${d.reason}`);
      results.push({ id: item.id, name: item.name, outcome: d.action === 'wait' ? 'in progress' : 'to scan', scanId: d.row?.id, reason: d.reason });
      continue;
    }
    let scanId;
    try {
      if (d.action === 'wait') {
        scanId = d.row.id;
        log(`${tag}: waiting, ${d.reason}`);
      } else {
        log(`${tag}: scanning, ${d.reason}`);
        scanId = await startOnSite({ base, adminToken, body: item.body, fetchImpl });
        log(`${tag}: started scan ${scanId}`);
      }
      const { row, timedOut } = await waitForScan({ env, scanId, fetchImpl, sleep, pollMs, waitMs, now });
      const f = scanFinished(row);
      const outcome = timedOut ? 'timed out' : f.finished ? 'finished' : 'not finished';
      log(`${tag}: ${outcome}${f.finished ? '' : `, ${timedOut ? `still ${row?.status || 'unknown'}` : f.reason}`}`);
      results.push({ id: item.id, name: item.name, outcome, scanId, reason: f.reason });
    } catch (e) {
      log(`${tag}: error, ${e?.message || e}`);
      results.push({ id: item.id, name: item.name, outcome: 'error', scanId, reason: String(e?.message || e) });
    }
  }
  return { results };
}

export function formatResults(batchId, { results }) {
  const count = (o) => results.filter((r) => r.outcome === o).length;
  const lines = [`\nBatch ${batchId}: ${results.length} prospect(s)`];
  for (const o of ['skipped', 'finished', 'to scan', 'in progress', 'not finished', 'timed out', 'error']) {
    if (count(o)) lines.push(`  ${o.padEnd(12)} ${count(o)}`);
  }
  const redo = results.filter((r) => !['skipped', 'finished'].includes(r.outcome));
  if (redo.length) lines.push('Re-run the same command to retry only these; finished prospects are skipped.');
  return lines.join('\n');
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^y(es)?$/i.test((await rl.question(question)).trim()); } finally { rl.close(); }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return void console.log(USAGE);
  if (!args.batch || !args.list) throw new Error(`--batch and --list are required\n\n${USAGE}`);
  const { env } = loadEnv();
  const base = String(args.base || env.AFS_BASE_URL || 'https://aifoundscore.com').replace(/\/+$/, '');
  const adminToken = String(env.ADMIN_TOKEN || '').trim();
  if (!canStore(env)) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY missing: the batch cannot see what is already done');
  if (!adminToken && !args.check) throw new Error('ADMIN_TOKEN missing: the batch cannot start scans');

  const items = prepareItems(JSON.parse(readFileSync(resolve(args.list), 'utf8')), args.batch);
  const opts = {
    batchId: args.batch, items, env, base, adminToken, log: (m) => console.error(m),
    pollMs: args.pollSec * 1000, waitMs: args.waitMin * 60_000, staleMs: args.staleMin * 60_000,
  };
  console.error(`Batch ${args.batch}: ${items.length} prospect(s), scans run on ${base}`);
  const plan = await runBatch({ ...opts, checkOnly: true, log: () => {} });
  const toDo = plan.results.filter((r) => r.outcome !== 'skipped');
  console.error(`  ${plan.results.length - toDo.length} already finished (skipped), ${toDo.length} to scan or wait for`);
  if (args.check) return void console.log(formatResults(args.batch, plan));
  if (!toDo.length) return void console.log(formatResults(args.batch, plan));
  if (!args.yes) {
    if (!process.stdin.isTTY) {
      process.exitCode = 1;
      return void console.error('Not an interactive terminal: pass --yes to run.');
    }
    if (!(await confirm(`Start ${toDo.length} scan(s)? [y/N] `))) return void console.error('Cancelled. Nothing was started.');
  }
  const out = await runBatch(opts);
  console.log(formatResults(args.batch, out));
  if (out.results.some((r) => !['skipped', 'finished'].includes(r.outcome))) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e?.message || e);
    process.exitCode = 1;
  });
}
