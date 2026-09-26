// scanner/config.js — one place for env var names, default models and price constants.
//
// Runtime-agnostic: no Node built-ins, never reads process.env. Every caller passes an
// `env` object (the Worker env, or process.env in the CLI).

/** Every engine the scanner knows how to call. */
export const ENGINE_IDS = ['chatgpt', 'gemini', 'google_ai_mode', 'perplexity', 'claude'];

/** Engines the business actually runs and advertises. Owner decision (Sep 2026): start with these
 *  three; add 'google_ai_mode' / 'perplexity' here once their keys exist, and every page's copy
 *  (assistant names, "N searches") follows. Order = how they're listed in copy. */
export const ACTIVE_ENGINES = ['chatgpt', 'claude', 'gemini'];
// ACTIVE_ENGINES is the static fallback for code that has no env (site copy, samples).
// Scans default to activeEngines(env): whatever has keys right now.

export const ENGINE_NAMES = {
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
  google_ai_mode: 'Google AI Mode',
  perplexity: 'Perplexity',
  claude: 'Claude',
};

/** Ask each question this many times per engine. Owner decision (Sep 2026): start at 1;
 *  runs stay configurable per scan (CLI --runs, admin/scan body.runs). */
export const DEFAULT_RUNS = 1;

/** Parallel engine calls during a scan, and the per-call timeout. */
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_TIMEOUT_MS = 120_000;

export const DEFAULT_MODELS = {
  // Reasoning model; supports the Responses API web_search tool.
  chatgpt: 'gpt-5-mini',
  // Stable Gemini 3.x Flash; grounding with Google Search is free for 5,000 queries/month.
  gemini: 'gemini-3.8-flash',
  // Perplexity Agent API preset. "fast" is Perplexity's replacement for the retired `sonar` model.
  // A value containing "/" (e.g. "openai/gpt-5-mini") is sent as `model` instead of `preset`.
  perplexity: 'fast',
  // DataForSEO endpoint mode, not a model. Kept here so method lines can print it.
  google_ai_mode: 'dataforseo/serp/google/ai_mode/live/advanced',
  // Messages API + web_search_20260209. Override with CLAUDE_MODEL.
  claude: 'claude-sonnet-5',
  // Default extractor model (scanner/extract/propose.js owns the real default; kept in step here).
  extract: 'claude-sonnet-5',
};

// Published prices (USD), Sep 2026. Used for per-call cost when the API doesn't report one,
// and for the pre-scan estimate. Update here when prices change.
//   OpenAI:     https://developers.openai.com/api/docs/pricing
//   Gemini:     https://ai.google.dev/gemini-api/docs/pricing
//   Perplexity: https://docs.perplexity.ai/api-reference/agent-post (usage.cost is used when present)
//   DataForSEO: https://dataforseo.com/pricing/google-serp/google-ai-mode-serp-api
//   Anthropic:  https://platform.claude.com/docs/en/about-claude/pricing ,
//               https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
export const PRICES = {
  chatgpt: {
    inputPerM: 0.25, // gpt-5-mini
    outputPerM: 2.0,
    searchPerCall: 0.01, // web_search, reasoning models: $10 / 1k calls (+ search tokens at model rate)
  },
  gemini: {
    inputPerM: 0.75, // gemini-3.8-flash through 2026-12-31 ($1.50 from 2027-01-01)
    outputPerM: 3.75, // ($7.50 from 2027-01-01)
    // $14 / 1k search queries after 5,000 free per month. Counted as paid so estimates stay
    // conservative; the real bill is $0 while under the free tier.
    searchPerQuery: 0.014,
  },
  perplexity: {
    inputPerM: 0.1, // fast preset runs openai/gpt-6-luna; fallback only, usage.cost wins
    outputPerM: 0.5,
    searchPerCall: 0.001, // fast search: $1 / 1k invocations
  },
  google_ai_mode: {
    perTask: 0.004, // live mode: $4 / 1k SERPs (standard queue is $1.20 / 1k)
  },
  claude: {
    inputPerM: 2.0, // claude-sonnet-5 (search results fed back to the model bill as input tokens)
    outputPerM: 10.0,
    searchPerCall: 0.01, // web search: $10 / 1k searches (usage.server_tool_use.web_search_requests)
  },
  // Extractor (scanner/extract/propose.js), one call per successful answer. claude-sonnet-5.
  // Adaptive thinking tokens bill as output.
  extract: {
    inputPerM: 2.0,
    outputPerM: 10.0,
  },
};

// Typical usage per call, for estimates only (real calls report their own cost).
export const TYPICAL_CALL = {
  chatgpt: { inputTokens: 12_000, outputTokens: 1_500, searches: 1 },
  gemini: { inputTokens: 400, outputTokens: 2_000, searches: 1 },
  perplexity: { inputTokens: 5_000, outputTokens: 800, searches: 1 },
  google_ai_mode: { tasks: 1 },
  // Search results (and dynamic-filtering code runs) are re-read across the server-side loop,
  // so input is large. Estimate only; recalibrate from the first live scans' usage.
  claude: { inputTokens: 18_000, outputTokens: 1_200, searches: 2 },
  // System prompt + target + one answer in; thinking + JSON out. Recalibrate from live usage.
  extract: { inputTokens: 1_500, outputTokens: 1_500 },
};

/** Cost of one call from token/search counts using PRICES. */
export function priceCall(engine, u = {}) {
  const p = PRICES[engine];
  if (!p) return 0;
  if (engine === 'google_ai_mode') return round6((u.tasks ?? 1) * p.perTask);
  const tokens =
    ((u.inputTokens || 0) * (p.inputPerM || 0) + (u.outputTokens || 0) * (p.outputPerM || 0)) / 1e6;
  const search = (u.searches || 0) * (p.searchPerCall ?? p.searchPerQuery ?? 0);
  return round6(tokens + search);
}

/**
 * Estimated USD for a scan: questions × engines × runs engine calls at typical usage, plus
 * one extractor call per answer (assumes every call answers). Directory-page fetches are free.
 * → { total, engines, extract, perEngine }
 */
export function estimateScanCost({ engines = ENGINE_IDS, questions = 5, runs = DEFAULT_RUNS } = {}) {
  const perEngine = {};
  let engineTotal = 0;
  for (const e of engines) {
    const c = priceCall(e, TYPICAL_CALL[e]) * questions * runs;
    perEngine[e] = round6(c);
    engineTotal += c;
  }
  const extract = priceCall('extract', TYPICAL_CALL.extract) * questions * engines.length * runs;
  return { total: round6(engineTotal + extract), engines: round6(engineTotal), extract: round6(extract), perEngine };
}

export function round6(n) {
  return Math.round((Number(n) || 0) * 1e6) / 1e6;
}

// Env var names, primary first, then accepted alternates.
export const ENV_ALIASES = {
  openaiKey: ['OPENAI_API_KEY', 'OPENAI_KEY', 'OPENAI_TOKEN'],
  geminiKey: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_API_KEY', 'GEMINI_KEY'],
  perplexityKey: ['PERPLEXITY_API_KEY', 'PPLX_API_KEY', 'PERPLEXITY_KEY'],
  anthropicKey: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'ANTHROPIC_KEY'],
  dataforseoLogin: ['DATAFORSEO_LOGIN', 'DATAFORSEO_USERNAME', 'DATAFORSEO_USER', 'DFS_LOGIN'],
  dataforseoPassword: ['DATAFORSEO_PASSWORD', 'DATAFORSEO_API_PASSWORD', 'DATAFORSEO_PASS', 'DFS_PASSWORD'],
  supabaseUrl: ['SUPABASE_URL'],
  supabaseServiceKey: ['SUPABASE_SERVICE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY'],
  googlePlacesKey: ['GOOGLE_PLACES_API_KEY', 'GOOGLE_MAPS_API_KEY', 'GOOGLE_Maps_API_KEY', 'PLACES_API_KEY'],
  adminToken: ['ADMIN_TOKEN'],
  openaiModel: ['OPENAI_MODEL'],
  geminiModel: ['GEMINI_MODEL'],
  perplexityModel: ['PERPLEXITY_MODEL', 'PERPLEXITY_PRESET'],
  claudeModel: ['CLAUDE_MODEL'],
  extractModel: ['EXTRACT_MODEL'],
  geminiResolveRedirects: ['GEMINI_RESOLVE_REDIRECTS'],
};

function pick(env, names) {
  for (const n of names) {
    const v = env?.[n];
    // Trim: a pasted secret often carries a trailing space or newline.
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

/**
 * Resolve keys and model choices from an env object, accepting alternate names.
 * Missing values are null (never throws).
 */
export function resolveKeys(env = {}) {
  const k = {};
  for (const [name, aliases] of Object.entries(ENV_ALIASES)) k[name] = pick(env, aliases);
  k.openaiModel ||= DEFAULT_MODELS.chatgpt;
  k.geminiModel ||= DEFAULT_MODELS.gemini;
  k.perplexityModel ||= DEFAULT_MODELS.perplexity;
  k.claudeModel ||= DEFAULT_MODELS.claude;
  k.extractModel ||= DEFAULT_MODELS.extract;
  k.geminiResolveRedirects = !/^(0|false|no|off)$/i.test(k.geminiResolveRedirects || '');
  if (k.supabaseUrl) k.supabaseUrl = k.supabaseUrl.replace(/\/+$/, '');
  return k;
}

/** Which engines have the keys they need. */
export function enginesConfigured(env = {}) {
  const k = resolveKeys(env);
  return {
    chatgpt: !!k.openaiKey,
    gemini: !!k.geminiKey,
    perplexity: !!k.perplexityKey,
    google_ai_mode: !!(k.dataforseoLogin && k.dataforseoPassword),
    claude: !!k.anthropicKey,
  };
}

/**
 * The engines a scan runs by default: every engine whose keys are configured in `env`
 * (resolveKeys aliases included), in ENGINE_IDS order. [] when none are configured.
 * Code with no env uses the static ACTIVE_ENGINES instead.
 */
export function activeEngines(env = {}) {
  const c = enginesConfigured(env);
  return ENGINE_IDS.filter((e) => c[e]);
}

/** The free Snapshot asks only these (owner decision, Sep 26 2026): the paid audit asks every
 *  engine with a key, so adding Perplexity / Google AI Mode keys widens the audit, never the free
 *  report. The site's free card names exactly these three. */
export const FREE_ENGINES = ['chatgpt', 'gemini', 'claude'];

/** The engines a free-report scan runs: FREE_ENGINES that have keys, in ENGINE_IDS order. */
export function freeEngines(env = {}) {
  return activeEngines(env).filter((e) => FREE_ENGINES.includes(e));
}

/** activeEngines(env), or ACTIVE_ENGINES when no engine has a key (so the error names the missing key). */
export function defaultScanEngines(env = {}) {
  const a = activeEngines(env);
  return a.length ? a : [...ACTIVE_ENGINES];
}

// US state abbreviations → names (DataForSEO location_name and API user_location need names).
export const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts',
  MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

/** Default state for businesses that don't carry one (the first batch is Long Island). */
export const DEFAULT_STATE = 'NY';

export function stateAbbr(state) {
  const s = String(state || DEFAULT_STATE).trim();
  if (s.length === 2) return s.toUpperCase();
  const hit = Object.entries(US_STATES).find(([, name]) => name.toLowerCase() === s.toLowerCase());
  return hit ? hit[0] : s;
}

export function stateName(state) {
  const a = stateAbbr(state);
  return US_STATES[a] || String(state || '');
}
