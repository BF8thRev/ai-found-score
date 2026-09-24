// src/admin/dry-run.js — Worker-side dry run for LOCAL testing of the scan Workflow.
//
// Honoured only when the Worker env has SCANNER_DRY_RUN=1 (set in a local .dev.vars, never on
// Cloudflare) AND the scan was started from localhost. Every engine call is answered from the
// recorded fixtures in scanner/test/fixtures/engines/, the extractor gets a canned structured
// answer (bold names + the owner's name when the answer contains it), and nothing is written to
// Supabase. No network, no keys, no cost.

import openai from '../../scanner/test/fixtures/engines/openai.responses.json' with { type: 'json' };
import gemini from '../../scanner/test/fixtures/engines/gemini.generateContent.json' with { type: 'json' };
import geminiRedirects from '../../scanner/test/fixtures/engines/gemini.redirects.json' with { type: 'json' };
import perplexity from '../../scanner/test/fixtures/engines/perplexity.agent.json' with { type: 'json' };
import dataforseo from '../../scanner/test/fixtures/engines/dataforseo.ai_mode.json' with { type: 'json' };
import dataforseoUserData from '../../scanner/test/fixtures/engines/dataforseo.user_data.json' with { type: 'json' };
import claude from '../../scanner/test/fixtures/engines/claude.messages.json' with { type: 'json' };
import anthropicModel from '../../scanner/test/fixtures/engines/anthropic.model.json' with { type: 'json' };
import { ENV_ALIASES } from '../../scanner/config.js';

/** SCANNER_DRY_RUN=1 in env. */
export function dryRunEnabled(env) {
  return String(env?.SCANNER_DRY_RUN ?? '').trim() === '1';
}

/** A request from this machine (wrangler dev). */
export function isLocalRequest(url) {
  const h = new URL(url).hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}

/** Env for a dry-run scan: fake engine keys, and no Supabase service key (so nothing is stored). */
export function dryRunEnv(env) {
  const out = { ...env };
  for (const n of ENV_ALIASES.supabaseServiceKey) delete out[n];
  return {
    ...out,
    OPENAI_API_KEY: 'dry-run', GEMINI_API_KEY: 'dry-run', PERPLEXITY_API_KEY: 'dry-run',
    DATAFORSEO_LOGIN: 'dry-run', DATAFORSEO_PASSWORD: 'dry-run', ANTHROPIC_API_KEY: 'dry-run',
    GEMINI_RESOLVE_REDIRECTS: '1',
  };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Canned extractor output: every **bold** name, plus the owner's name if the answer contains it. */
export function fakeProposal(answerText, ownerName) {
  const businesses = [];
  const seen = new Set();
  for (const m of String(answerText).matchAll(/\*\*([^*\n]{3,80})\*\*/g)) {
    const name = m[1].trim().replace(/[:–-]+$/, '').trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    const pos = answerText.indexOf(name, m.index);
    if (pos < 0) continue;
    seen.add(name.toLowerCase());
    businesses.push({ name, pos });
  }
  if (ownerName && !seen.has(ownerName.toLowerCase())) {
    const pos = answerText.indexOf(ownerName);
    if (pos >= 0) businesses.push({ name: ownerName, pos });
  }
  businesses.sort((a, b) => a.pos - b.pos);
  return { businesses, ownerFacts: [] };
}

function extractorReply(body) {
  const content = String(body?.messages?.[0]?.content || '');
  const answer = (content.match(/<answer>\n([\s\S]*)\n<\/answer>/) || [])[1] || '';
  const owner = ((content.match(/Name: (.*)/) || [])[1] || '').trim();
  return {
    id: 'msg_dry_run', type: 'message', role: 'assistant', model: body?.model || 'claude-sonnet-5',
    content: [{ type: 'text', text: JSON.stringify(fakeProposal(answer, owner)) }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 1400 + Math.round(answer.length / 4), output_tokens: 600 },
  };
}

/** A fetch that answers from fixtures. `delayMs` makes progress visible in the dashboard. */
export function dryRunFetch({ delayMs = 400 } = {}) {
  return async (url, init = {}) => {
    const u = String(url);
    const host = new URL(u).hostname;
    if (delayMs) await wait(delayMs + Math.floor(Math.random() * delayMs));
    if (host === 'api.openai.com') return u.includes('/models/') ? json({ id: 'gpt-5-mini', object: 'model' }) : json(openai);
    if (host === 'generativelanguage.googleapis.com') return u.endsWith(':generateContent') ? json(gemini) : json({ name: 'models/gemini-3.8-flash' });
    if (host === 'vertexaisearch.cloud.google.com') {
      const target = geminiRedirects[u];
      return target ? new Response(null, { status: 302, headers: { location: target } }) : new Response('not found', { status: 404 });
    }
    if (host === 'api.perplexity.ai') return json(perplexity);
    if (host === 'api.dataforseo.com') return u.includes('/appendix/user_data') ? json(dataforseoUserData) : json(dataforseo);
    if (host === 'api.anthropic.com') {
      if (u.includes('/v1/models/')) return json(anthropicModel);
      let body = null;
      try { body = typeof init.body === 'string' ? JSON.parse(init.body) : null; } catch { /* not JSON */ }
      return body?.output_config ? json(extractorReply(body)) : json(claude);
    }
    // Directory pages, Supabase, anything else: never leave the machine in a dry run.
    return new Response('dry-run: no fixture for this host', { status: 599 });
  };
}
