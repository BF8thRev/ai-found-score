// scanner/engines/claude.js — Claude via the Messages API with the server-side web search tool.
//
// Docs: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
//       https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools (pause_turn)
//   POST https://api.anthropic.com/v1/messages   (official SDK, @anthropic-ai/sdk)
//   body: { model, max_tokens, messages: [{ role: "user", content: <question> }],
//           tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5,
//                     user_location: { type: "approximate", city, region, country: "US" } }] }
//   No system prompt: the question goes in exactly as a customer would type it.
//   response.content[]:
//     { type: "text", text }                                   (preamble, e.g. "I'll search…")
//     { type: "server_tool_use", id, name: "web_search", input: { query } }
//     { type: "web_search_tool_result", tool_use_id, content: [{ type: "web_search_result", url, title, page_age, encrypted_content }] }
//       or, on a search error (still HTTP 200): content = { type: "web_search_tool_result_error", error_code }
//     { type: "text", text, citations: [{ type: "web_search_result_location", url, title, cited_text, encrypted_index }] }
//   usage: { input_tokens, output_tokens, cache_*_input_tokens, server_tool_use: { web_search_requests } }
//   stop_reason: end_turn | max_tokens | pause_turn | refusal (+ stop_details) | ...
//   pause_turn: resend the user message plus the paused assistant content unchanged; the server resumes.
//   _20260209 runs dynamic filtering (code execution under the hood), so extra code-execution blocks
//   and a `caller` field can appear; the parser keys on block types and ignores what it doesn't know.
// Citations = web_search_result_location citations on the answer's text blocks only. If the answer
// cites nothing, every returned search result is listed, flagged `uncited: true` (as perplexity.js).

import Anthropic from '@anthropic-ai/sdk';
import { resolveKeys, priceCall, stateName, DEFAULT_TIMEOUT_MS } from '../config.js';
import { makeCitations, questionText, baseResult, finish, timedPing, truncate, sleep } from './_common.js';

export const id = 'claude';
export const API_URL = 'https://api.anthropic.com/v1/messages';
export const MAX_SEARCHES = 5;
/** How many times a paused turn (stop_reason "pause_turn") is resumed before giving up. */
export const MAX_CONTINUATIONS = 3;

export function buildRequest({ question, business, model }) {
  const location = { type: 'approximate', country: 'US' };
  if (business?.town) location.city = String(business.town);
  if (business?.state || business?.town) location.region = stateName(business?.state);
  return {
    model,
    max_tokens: 16000,
    messages: [{ role: 'user', content: questionText(question) }],
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: MAX_SEARCHES, user_location: location }],
  };
}

const isToolBlock = (b) => b && (b.type === 'server_tool_use' || /_tool_result$/.test(b.type || ''));

/**
 * Parse the assistant content of one (possibly continued) turn plus its usage.
 * `messages` is every Messages API response for the turn, in order.
 */
export function parseResponse(messages) {
  const list = Array.isArray(messages) ? messages : [messages];
  const content = list.flatMap((m) => (Array.isArray(m?.content) ? m.content : []));

  // The answer is the text after the last tool block (earlier text is "I'll search for…" preamble).
  // Citation-bearing text arrives split into several adjacent blocks, so they are joined with ''.
  let lastTool = -1;
  content.forEach((b, i) => { if (isToolBlock(b)) lastTool = i; });
  let answerBlocks = content.slice(lastTool + 1).filter((b) => b?.type === 'text');
  if (!answerBlocks.some((b) => (b.text || '').trim())) answerBlocks = [];
  const text = answerBlocks.map((b) => b.text || '').join('').trim();

  const cites = [];
  for (const b of answerBlocks) {
    for (const c of b.citations || []) {
      if (c?.type === 'web_search_result_location' && c.url) cites.push({ url: c.url, title: c.title || null });
    }
  }
  const results = [];
  const searchErrors = [];
  for (const b of content) {
    if (b?.type !== 'web_search_tool_result') continue;
    if (Array.isArray(b.content)) {
      for (const r of b.content) if (r?.type === 'web_search_result' && r.url) results.push({ url: r.url, title: r.title || null });
    } else if (b.content && typeof b.content === 'object') {
      searchErrors.push(b.content.error_code || b.content.type || 'unknown');
    }
  }
  if (!cites.length) for (const r of results) cites.push({ ...r, uncited: true });

  let inputTokens = 0;
  let outputTokens = 0;
  let searches = 0;
  for (const m of list) {
    const u = m?.usage || {};
    // Cache writes bill at 1.25x input, cache reads at 0.1x.
    inputTokens += (u.input_tokens || 0) + 1.25 * (u.cache_creation_input_tokens || 0) + 0.1 * (u.cache_read_input_tokens || 0);
    outputTokens += u.output_tokens || 0;
    searches += u.server_tool_use?.web_search_requests || 0;
  }
  const last = list[list.length - 1] || {};
  return {
    text,
    citations: makeCitations(cites),
    inputTokens,
    outputTokens,
    searches,
    searchErrors,
    stopReason: last.stop_reason || null,
    stopDetails: last.stop_details || null,
    model: last.model || null,
  };
}

function makeClient(keys, fetchImpl, timeoutMs) {
  return new Anthropic({
    apiKey: keys.anthropicKey,
    fetch: fetchImpl,
    maxRetries: 0, // retried below, but never after a timeout (a timed-out call may still be billed)
    timeout: timeoutMs,
  });
}

/** Map an SDK error to { error, retry, raw }. Non-SDK errors are rethrown (bugs, not API failures). */
function describeError(e, timeoutMs) {
  if (e instanceof Anthropic.APIConnectionTimeoutError) return { error: `timeout after ${timeoutMs}ms`, retry: false, raw: null };
  if (e instanceof Anthropic.APIConnectionError) return { error: `network error: ${e.cause?.message || e.message}`, retry: true, raw: null };
  if (e instanceof Anthropic.APIError) {
    const msg = e.error?.error?.message || e.message;
    const retry = e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError;
    return { error: `HTTP ${e.status ?? 'n/a'}: ${truncate(msg, 300)}`, retry, raw: e.error ?? null };
  }
  throw e;
}

async function createWithRetry(client, body, { timeoutMs, retries, retryDelayMs }) {
  for (let attempt = 1; ; attempt++) {
    try {
      return { message: await client.messages.create(body) };
    } catch (e) {
      const d = describeError(e, timeoutMs);
      if (!d.retry || attempt > retries) return d;
      if (retryDelayMs > 0) await sleep(retryDelayMs * attempt);
    }
  }
}

export async function ask({ question, business, env, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1, retryDelayMs = 2000 } = {}) {
  const keys = resolveKeys(env);
  const model = keys.claudeModel;
  const body = buildRequest({ question, business, model });
  const request = { method: 'POST', url: API_URL, body };
  const result = baseResult(id, model, request);
  try {
    if (!keys.anthropicKey) return finish(result, { error: 'missing ANTHROPIC_API_KEY' });
    const client = makeClient(keys, fetchImpl, timeoutMs);
    const responses = [];
    let assistantContent = [];
    let next = body;
    for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
      const r = await createWithRetry(client, next, { timeoutMs, retries, retryDelayMs });
      if (r.error) {
        const partial = responses.length ? parseResponse(responses) : null;
        result.raw = responses.length ? { responses, error: r.raw } : r.raw;
        return finish(result, { error: r.error, costUsd: partial ? priceCall(id, partial) : 0 });
      }
      responses.push(r.message);
      if (r.message.stop_reason !== 'pause_turn') break;
      if (i === MAX_CONTINUATIONS) break;
      // Resume: same user message, then the paused assistant turn exactly as returned.
      assistantContent = [...assistantContent, ...(r.message.content || [])];
      next = { ...body, messages: [body.messages[0], { role: 'assistant', content: assistantContent }] };
    }
    result.raw = responses.length === 1 ? responses[0] : { responses };
    if (responses.length > 1) request.continuations = responses.length - 1;

    const p = parseResponse(responses);
    const costUsd = priceCall(id, p);
    if (p.model) result.model = p.model;
    if (p.stopReason === 'refusal') {
      const cat = p.stopDetails?.category;
      return finish(result, { costUsd, error: `refusal${cat ? ` (${cat})` : ''}` });
    }
    if (p.stopReason === 'pause_turn') return finish(result, { costUsd, error: `pause_turn: not finished after ${MAX_CONTINUATIONS} continuations` });
    if (p.stopReason === 'max_tokens') return finish(result, { costUsd, error: 'answer cut off at max_tokens' });
    if (!p.text) {
      const why = p.searchErrors.length ? `web_search error: ${[...new Set(p.searchErrors)].join(', ')}` : `no answer text (stop_reason ${p.stopReason})`;
      return finish(result, { costUsd, error: why });
    }
    return finish(result, { ok: true, text: p.text, citations: p.citations, costUsd });
  } catch (e) {
    return finish(result, { error: `adapter error: ${e?.message || e}` });
  }
}

/** Free live check: GET /v1/models/{model} (validates the key and the model id, no tokens). */
export async function ping(env, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  return timedPing(id, async () => {
    const keys = resolveKeys(env);
    if (!keys.anthropicKey) return { ok: false, status: 0, error: 'missing ANTHROPIC_API_KEY', detail: null };
    const client = makeClient(keys, fetchImpl, timeoutMs);
    try {
      const m = await client.models.retrieve(keys.claudeModel);
      return { ok: true, status: 200, error: null, detail: { model: m.id, displayName: m.display_name || null } };
    } catch (e) {
      const d = describeError(e, timeoutMs);
      return { ok: false, status: e?.status ?? 0, error: d.error, detail: null };
    }
  });
}
