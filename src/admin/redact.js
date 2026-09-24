// src/admin/redact.js — scrub secrets out of any string before it leaves the Worker
// (API responses, logs, the admin page, scans.errors).
//
// Two passes:
//   1. every configured secret value, under every name scanner/config.js accepts
//      (ENV_ALIASES), so alternate key names are covered too;
//   2. key-shaped fragments (masked or not), e.g. OpenAI's "sk-proj-****abcd".

import { ENV_ALIASES } from '../../scanner/config.js';
import { scrubKeyFragments } from '../../scanner/store.js';

// ENV_ALIASES entries that hold secrets (model names and URLs are not secret).
const SECRET_FIELDS = ['openaiKey', 'geminiKey', 'perplexityKey', 'anthropicKey', 'dataforseoLogin',
  'dataforseoPassword', 'supabaseServiceKey', 'adminToken'];
const OTHER_SECRETS = ['SUPABASE_ANON_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_WEBHOOK_SECRET_TEST'];

/** Every configured secret value (trimmed, >= 6 chars), longest first. */
export function secretValues(env = {}) {
  const names = [...SECRET_FIELDS.flatMap((f) => ENV_ALIASES[f] || []), ...OTHER_SECRETS];
  const values = new Set(names.map((n) => String(env?.[n] ?? '').trim()).filter((v) => v.length >= 6));
  // DataForSEO Basic-auth value (every login/password alias pair), in case an error echoes the header.
  for (const login of ENV_ALIASES.dataforseoLogin.map((n) => env?.[n]).filter(Boolean)) {
    for (const pass of ENV_ALIASES.dataforseoPassword.map((n) => env?.[n]).filter(Boolean)) {
      try { values.add(btoa(`${String(login).trim()}:${String(pass).trim()}`)); } catch { /* non-latin1 */ }
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/** Scrub every secret and key-like fragment out of `value`; cap the length. */
export function redact(env, value, max = 500) {
  let s = String(value ?? '');
  for (const secret of secretValues(env)) s = s.split(secret).join('[redacted]');
  s = scrubKeyFragments(s);
  return max ? s.slice(0, max) : s;
}
