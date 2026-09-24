// scanner/env.js — Node only. Keys for local runs: the repo's git-ignored .dev.vars (the same
// KEY=value file `wrangler dev` reads) overlaid by process.env (process.env wins).
// Never prints values.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Parse a .dev.vars / .env file (KEY=VALUE, # comments, optional quotes, optional `export`). */
export function parseDotVars(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** { env, file } — `file` is the .dev.vars path when it was found and read, else null. */
export function loadEnv({ root = REPO_ROOT, processEnv = process.env } = {}) {
  const env = {};
  const file = resolve(root, '.dev.vars');
  const found = existsSync(file);
  if (found) Object.assign(env, parseDotVars(readFileSync(file, 'utf8')));
  for (const [k, v] of Object.entries(processEnv)) if (v !== undefined && v !== '') env[k] = v;
  return { env, file: found ? file : null };
}
