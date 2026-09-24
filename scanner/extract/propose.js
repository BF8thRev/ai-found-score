// Step 1 of extraction: Claude PROPOSES what an answer contains.
// Nothing it returns is trusted; verify.js checks every item against the raw text.
//
// One Messages API call per answer with structured outputs
// (output_config.format = json_schema). Official SDK (@anthropic-ai/sdk), which runs
// in Cloudflare Workers. Keys come from `env`, never from process.env; `fetchImpl`
// is passed to the SDK so tests run offline.

import Anthropic from '@anthropic-ai/sdk';
import { resolveKeys, PRICES } from '../config.js';

export const DEFAULT_EXTRACT_MODEL = 'claude-sonnet-5'; // override with env.EXTRACT_MODEL
/** Per-call timeout for one extraction request. */
export const EXTRACT_TIMEOUT_MS = 120_000;
export const FACT_FIELDS = ['hours', 'phone', 'price', 'address', 'services'];
// $ per 1M tokens (input, output) for claude-sonnet-5, used for the scan's cost total.
// One source of truth: PRICES.extract in scanner/config.js (update it if EXTRACT_MODEL changes).
export const EXTRACT_PRICE_PER_MTOK = { input: PRICES.extract.inputPerM, output: PRICES.extract.outputPerM };

export const PROPOSAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['businesses', 'ownerFacts', 'ownerDescriptors'],
  properties: {
    businesses: {
      type: 'array',
      description: 'Every specific business named in the answer, in order of first appearance.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'pos'],
        properties: {
          name: { type: 'string', description: 'The business name copied exactly as written in the answer.' },
          pos: { type: 'integer', description: 'Character offset (0-based) of its first appearance in the answer.' },
        },
      },
    },
    ownerFacts: {
      type: 'array',
      description: 'Statements the answer makes about the target business only.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'quote'],
        properties: {
          field: { type: 'string', enum: FACT_FIELDS },
          quote: { type: 'string', description: 'The shortest exact span of the answer that states this fact, copied character for character. An address quote must contain a street number and street name, or a ZIP code; a vague location ("near the border", "off the highway") is not an address.' },
        },
      },
    },
    ownerDescriptors: {
      type: 'array',
      description: 'Short phrases the answer uses to describe the TARGET business (what it is known or praised for, how it is characterized). At most 6.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['quote'],
        properties: {
          quote: { type: 'string', description: 'A short exact span of the answer (about 3 to 15 words) describing the target business, copied character for character. Not hours, phone, price or address. Never a phrase about another business.' },
        },
      },
    },
  },
};

// Fixed system prompt (stable across calls, so it is cache-friendly).
export const EXTRACT_SYSTEM = [
  'You extract structured data from one AI search answer about local businesses. Your output is checked by code against the answer text, character for character, so copy text exactly: never paraphrase, correct spelling, expand abbreviations or add words.',
  '',
  'businesses: every specific, named local business the answer presents as a provider (not directories, review sites or apps unless the answer offers them as the provider). List each business once, in order of first appearance, using the exact spelling at that first appearance, with its 0-based character offset in the answer.',
  '',
  'ownerFacts: only facts the answer states about the TARGET business (hours, phone, price, address, services). Each quote must be an exact substring of the answer. If the answer does not name the target business or states nothing about it, return an empty list.',
  '- address: only a quote that contains a street number and street name (e.g. "1502 Main St") or a ZIP code. Vague location phrases ("on the town border", "near the train station", "in the village") are not addresses: leave them out.',
  '- hours: opening hours or days. price: amounts with their units. services: what the business offers. phone: a phone number.',
  '- At most one quote per field: the most specific one.',
  '',
  'ownerDescriptors: short phrases the answer uses to describe the TARGET business: what it is known or praised for, or how it is characterized (e.g. "praised for fast emergency response", "a massive, amenity-packed 24/7 alternative"). Exact substrings of the answer, about 3 to 15 words each, at most 6. Not hours, phone, price or address (those are ownerFacts). Never a phrase about another business. Empty if the answer does not name the target business.',
].join('\n');

export function buildProposalRequest({ answerText, business, model, effort = 'low' }) {
  const target = [
    `Name: ${business.name}`,
    business.address && `Address: ${business.address}`,
    business.town && `Town: ${business.town}`,
    business.phone && `Phone: ${business.phone}`,
    business.website && `Website: ${business.website}`,
  ].filter(Boolean).join('\n');
  return {
    model,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    // Extraction is a copy-out task checked by code afterwards; low effort keeps thinking (billed
    // as output) short. The first live scan at default effort cost ~13¢ per answer and one call
    // ran out of room at 16k tokens.
    output_config: { effort, format: { type: 'json_schema', schema: PROPOSAL_SCHEMA } },
    system: EXTRACT_SYSTEM,
    messages: [{
      role: 'user',
      content: `<target_business>\n${target}\n</target_business>\n\n<answer>\n${answerText}\n</answer>`,
    }],
  };
}

export function estimateCost(usage) {
  if (!usage) return 0;
  return ((usage.input_tokens || 0) * EXTRACT_PRICE_PER_MTOK.input + (usage.output_tokens || 0) * EXTRACT_PRICE_PER_MTOK.output) / 1e6;
}

function cleanProposal(p) {
  return {
    businesses: ((p && p.businesses) || [])
      .filter((b) => b && typeof b.name === 'string' && b.name.trim())
      .map((b) => ({ name: b.name, pos: Number.isInteger(b.pos) ? b.pos : -1 })),
    ownerFacts: ((p && p.ownerFacts) || [])
      .filter((f) => f && FACT_FIELDS.includes(f.field) && typeof f.quote === 'string' && f.quote)
      .map((f) => ({ field: f.field, quote: f.quote })),
    // Older recorded proposals have no descriptors: treated as none, never invented.
    ownerDescriptors: ((p && p.ownerDescriptors) || [])
      .filter((d) => d && typeof d.quote === 'string' && d.quote.trim())
      .map((d) => ({ quote: d.quote })),
  };
}

const failed = (model, error, usage = null) => ({
  ok: false, error, businesses: [], ownerFacts: [], ownerDescriptors: [], model, usage, costUsd: estimateCost(usage), source: 'model',
});

function errorReason(e) {
  if (e instanceof Anthropic.RateLimitError) return `rate_limited (HTTP ${e.status})`;
  if (e instanceof Anthropic.AuthenticationError) return `auth_failed (HTTP ${e.status})`;
  if (e instanceof Anthropic.BadRequestError) return `bad_request (HTTP ${e.status}): ${e.message}`;
  if (e instanceof Anthropic.APIConnectionError) return `connection_error: ${e.message}`;
  if (e instanceof Anthropic.APIError) return `api_error (HTTP ${e.status ?? 'n/a'}): ${e.message}`;
  if (e instanceof SyntaxError) return `invalid_json: ${e.message}`;
  throw e; // a bug in our code, not an API failure
}

/**
 * proposeForAnswer({ answer, business, env, fetchImpl, proposals, maxRetries })
 *   → { ok, error, businesses:[{name,pos}], ownerFacts:[{field,quote}], ownerDescriptors:[{quote}], model, usage, costUsd, source }
 * `proposals` (a recorded proposal for this answer) skips the network entirely.
 * On refusal, max_tokens, API errors or unparseable output: ok:false, empty lists,
 * and `error` says why. Nothing is ever invented.
 */
export async function proposeForAnswer({ answer, business, env = {}, fetchImpl, proposals, maxRetries } = {}) {
  if (proposals) {
    // A recorded failure (e.g. a background extraction step that gave up) stays a failure,
    // so the report is blocked exactly as if the call had failed here.
    if (proposals.ok === false) {
      return { ok: false, error: String(proposals.error || 'extraction failed'), businesses: [], ownerFacts: [], ownerDescriptors: [], model: proposals.model || 'recorded', usage: null, costUsd: 0, source: 'recorded' };
    }
    return { ok: true, error: null, ...cleanProposal(proposals), model: proposals.model || 'recorded', usage: null, costUsd: 0, source: 'recorded' };
  }
  // Same key/model resolution as the engines (accepts CLAUDE_API_KEY etc., trims pasted secrets).
  const keys = resolveKeys(env);
  const model = keys.extractModel || DEFAULT_EXTRACT_MODEL;
  if (!keys.anthropicKey) return failed(model, 'ANTHROPIC_API_KEY missing and no recorded proposals given');

  const client = new Anthropic({
    apiKey: keys.anthropicKey,
    // SDK defaults (10+ min timeout, 2 retries) could hold a Worker for half an hour on one answer.
    timeout: EXTRACT_TIMEOUT_MS,
    maxRetries: maxRetries != null ? maxRetries : 1,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });

  let msg;
  try {
    msg = await client.messages.create(buildProposalRequest({ answerText: answer.text, business, model, effort: env.EXTRACT_EFFORT || 'low' }));
  } catch (e) {
    return failed(model, errorReason(e));
  }
  const usage = msg.usage ? { input_tokens: msg.usage.input_tokens || 0, output_tokens: msg.usage.output_tokens || 0 } : null;

  if (msg.stop_reason === 'refusal') {
    const cat = msg.stop_details && msg.stop_details.category;
    return failed(model, `refusal${cat ? ` (${cat})` : ''}`, usage);
  }
  if (msg.stop_reason === 'max_tokens') return failed(model, 'max_tokens', usage);

  const block = (msg.content || []).find((b) => b.type === 'text');
  if (!block) return failed(model, `no text block (stop_reason ${msg.stop_reason})`, usage);
  let parsed;
  try {
    parsed = JSON.parse(block.text);
  } catch (e) {
    return failed(model, errorReason(e), usage);
  }
  return { ok: true, error: null, ...cleanProposal(parsed), model: msg.model || model, usage, costUsd: estimateCost(usage), source: 'model' };
}

/** proposeAll: one call per answer, sequential (keeps rate limits simple). */
export async function proposeAll({ answers, business, env, fetchImpl, proposalsByAnswer = {} }) {
  const out = {};
  for (const a of answers) {
    out[a.id] = await proposeForAnswer({ answer: a, business, env, fetchImpl, proposals: proposalsByAnswer[a.id] || (a.key && proposalsByAnswer[a.key]) });
  }
  return out;
}
