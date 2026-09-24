// Admin defaults follow ACTIVE_ENGINES (scanner/config.js); other engines stay selectable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withActiveDefault, ALL_ENGINES } from '../api.js';
import { renderDashboard } from '../page.js';
import { parseScanRequest } from '../scan-core.js';
import { usd } from '../metrics.js';
import { ACTIVE_ENGINES, ENGINE_IDS, estimateScanCost } from '../../../scanner/config.js';

const business = { name: 'Acme', trade: 'plumber', town: 'Massapequa' };

test('withActiveDefault: no engines → ACTIVE_ENGINES; named engines kept', () => {
  const r = parseScanRequest(withActiveDefault({ business }), { knownEngines: ALL_ENGINES });
  assert.ok(r.ok);
  assert.deepEqual(r.params.engines, ACTIVE_ENGINES);
  const named = parseScanRequest(withActiveDefault({ business, engines: ['perplexity'] }), { knownEngines: ALL_ENGINES });
  assert.deepEqual(named.params.engines, ['perplexity']);
  assert.deepEqual(withActiveDefault({ business, engines: [] }).engines, ACTIVE_ENGINES);
  assert.equal(withActiveDefault(null), null);
});

test('Run-scan form: every engine listed, only ACTIVE_ENGINES ticked, estimate for ACTIVE_ENGINES', () => {
  const html = renderDashboard({ configured: true, data: { scans: [], engines: [] }, errors: {} },
    { nonce: 'n', engineIds: ENGINE_IDS, watch: [] });
  for (const e of ENGINE_IDS) {
    const box = html.match(new RegExp(`<input type="checkbox" name="engines" value="${e}"( checked)?>`));
    assert.ok(box, `${e} listed`);
    assert.equal(!!box[1], ACTIVE_ENGINES.includes(e), `${e} ticked only if active`);
  }
  const est = usd(estimateScanCost({ engines: ACTIVE_ENGINES, questions: 5, runs: 1 }).total);
  assert.ok(est !== usd(estimateScanCost({ engines: ENGINE_IDS, questions: 5, runs: 1 }).total));
  assert.ok(html.includes(`Estimated cost: ${est}`), `estimate ${est}`);
});

test('withActiveDefault(body, env): no engines named → every engine with a key, in ENGINE_IDS order', () => {
  const env = { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', PERPLEXITY_API_KEY: 'k' };
  assert.deepEqual(withActiveDefault({ business }, env).engines, ['chatgpt', 'perplexity', 'claude']);
  // No keys at all: the static ACTIVE_ENGINES, so the scan reports the missing keys.
  assert.deepEqual(withActiveDefault({ business }, {}).engines, ACTIVE_ENGINES);
  assert.deepEqual(withActiveDefault({ business, engines: ['gemini'] }, env).engines, ['gemini']);
  // The Run-scan form ticks the engines with keys.
  const html = renderDashboard({ configured: true, data: { scans: [], engines: [] }, errors: {} },
    { nonce: 'n', engineIds: ENGINE_IDS, watch: [], activeIds: ['chatgpt', 'perplexity'] });
  for (const e of ENGINE_IDS) {
    const box = html.match(new RegExp(`<input type="checkbox" name="engines" value="${e}"( checked)?>`));
    assert.equal(!!box[1], ['chatgpt', 'perplexity'].includes(e), `${e}`);
  }
});
