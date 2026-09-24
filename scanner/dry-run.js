// scanner/dry-run.js — Node only. A fake `fetch` that answers every engine call from the
// recorded fixture responses in scanner/test/fixtures/engines/ (no network).
// Used by `node scanner/cli.js --dry-run` and the tests. Not imported by the Worker.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = new URL('./test/fixtures/engines/', import.meta.url);

export function loadFixture(name) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(name, FIXTURE_DIR)), 'utf8'));
}

export function loadEngineFixtures() {
  return {
    openai: loadFixture('openai.responses.json'),
    gemini: loadFixture('gemini.generateContent.json'),
    geminiRedirects: loadFixture('gemini.redirects.json'),
    perplexity: loadFixture('perplexity.agent.json'),
    dataforseo: loadFixture('dataforseo.ai_mode.json'),
    dataforseoUserData: loadFixture('dataforseo.user_data.json'),
    claude: loadFixture('claude.messages.json'),
    anthropicModel: loadFixture('anthropic.model.json'),
  };
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * Build a fetch that routes by host to the fixtures. `overrides` maps an engine host key
 * (openai|gemini|perplexity|dataforseo|anthropic|supabase) to (url, init) => Response for tests.
 * Every request is pushed onto `fetch.calls` for assertions.
 */
export function fixtureFetch(fx = loadEngineFixtures(), overrides = {}) {
  const f = async (url, init = {}) => {
    const u = String(url);
    f.calls.push({ url: u, init });
    const host = new URL(u).hostname;
    const key =
      host === 'api.openai.com' ? 'openai'
      : host === 'generativelanguage.googleapis.com' ? 'gemini'
      : host === 'vertexaisearch.cloud.google.com' ? 'redirect'
      : host === 'api.perplexity.ai' ? 'perplexity'
      : host === 'api.dataforseo.com' ? 'dataforseo'
      : host === 'api.anthropic.com' ? 'anthropic'
      : host.endsWith('.supabase.co') ? 'supabase'
      : 'other';
    if (overrides[key]) return overrides[key](u, init);
    switch (key) {
      case 'openai':
        return u.includes('/models/') ? jsonResponse({ id: 'gpt-5-mini', object: 'model' }) : jsonResponse(fx.openai);
      case 'gemini':
        return u.endsWith(':generateContent') ? jsonResponse(fx.gemini) : jsonResponse({ name: 'models/gemini-3.8-flash' });
      case 'redirect': {
        const target = fx.geminiRedirects[u];
        return target ? new Response(null, { status: 302, headers: { location: target } }) : new Response('not found', { status: 404 });
      }
      case 'perplexity':
        return jsonResponse(fx.perplexity);
      case 'dataforseo':
        return u.includes('/appendix/user_data') ? jsonResponse(fx.dataforseoUserData) : jsonResponse(fx.dataforseo);
      case 'anthropic':
        return u.includes('/v1/models/') ? jsonResponse(fx.anthropicModel) : jsonResponse(fx.claude);
      case 'supabase':
        return new Response(null, { status: 201 });
      default:
        return new Response('dry-run: no fixture for this host', { status: 599 });
    }
  };
  f.calls = [];
  return f;
}

/** Keys that satisfy every adapter in dry-run mode (never sent anywhere real). */
export const DRY_RUN_ENV = {
  OPENAI_API_KEY: 'dry-run',
  GEMINI_API_KEY: 'dry-run',
  PERPLEXITY_API_KEY: 'dry-run',
  DATAFORSEO_LOGIN: 'dry-run',
  DATAFORSEO_PASSWORD: 'dry-run',
  ANTHROPIC_API_KEY: 'dry-run',
  SUPABASE_URL: 'https://dry-run.supabase.co',
  SUPABASE_SERVICE_KEY: 'dry-run',
};
