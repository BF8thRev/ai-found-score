// Cloudflare Turnstile: server-side check of the token the free-report form sends.
//
// Config (see README "Bot protection"):
//   TURNSTILE_SITE_KEY    public; wrangler.jsonc `vars`; the Worker writes it into the page
//   TURNSTILE_SECRET_KEY  Worker secret (`npx wrangler secret put TURNSTILE_SECRET_KEY`)
// Until BOTH are set (and the site key is not the placeholder) the widget is left off the page
// and the Worker skips the check, logging one warning per isolate, so the live form keeps working.

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const SITE_KEY_PLACEHOLDER = 'REPLACE_WITH_TURNSTILE_SITE_KEY';
/** data-action on the free-report widget; Siteverify must echo it back. */
export const REQUEST_ACTION = 'free_report';

// Cloudflare's documented test secrets. Their dummy tokens are not bound to a real hostname or
// action, so only for these the hostname/action echo is not enforced. Real secrets always are.
const TEST_SECRETS = new Set([
  '1x0000000000000000000000000000000AA', // always passes
  '2x0000000000000000000000000000000AA', // always fails
  '3x0000000000000000000000000000000AA', // "token already spent"
]);

let warned = false;

/** Site key to put on the page, or '' when Turnstile isn't fully configured. */
export function turnstileSiteKey(env) {
  return turnstileConfigured(env) ? String(env.TURNSTILE_SITE_KEY).trim() : '';
}

/** True only when both the public site key and the secret are set. */
export function turnstileConfigured(env) {
  const site = String(env?.TURNSTILE_SITE_KEY || '').trim();
  const secret = String(env?.TURNSTILE_SECRET_KEY || '').trim();
  return !!site && site !== SITE_KEY_PLACEHOLDER && !!secret;
}

/** Log the "not configured" warning once per isolate. */
export function warnUnconfiguredOnce(log = console.warn) {
  if (warned) return;
  warned = true;
  log('[turnstile] TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY not both set: free-report requests are NOT bot-checked. See README "Bot protection".');
}

/** Test hook. */
export function _resetWarning() { warned = false; }

/**
 * Siteverify a token. Fails closed: anything other than a clean, matching success is { ok: false }.
 *
 * @param {object} o
 * @param {string} o.secret
 * @param {string} o.token              cf-turnstile-response from the form
 * @param {string} [o.remoteip]         CF-Connecting-IP
 * @param {string} o.expectedAction
 * @param {string[]} o.expectedHostnames  hostnames the widget may have been solved on
 * @param {Function} [o.fetchImpl]      injected in tests
 * @param {number} [o.timeoutMs]        per attempt
 * @param {string} [o.idempotencyKey]   reused on the retry so a spent token still verifies
 * @returns {Promise<{ok: boolean, reason?: string, codes?: string[]}>}
 *   reason: 'missing-token' | 'rejected' | 'action-mismatch' | 'hostname-mismatch' | 'unavailable'
 */
export async function verifyTurnstile({
  secret, token, remoteip, expectedAction, expectedHostnames,
  fetchImpl = fetch, timeoutMs = 4000, idempotencyKey = crypto.randomUUID(),
}) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) {
    return { ok: false, reason: 'missing-token' };
  }
  const body = new URLSearchParams({ secret, response: token, idempotency_key: idempotencyKey });
  if (remoteip) body.set('remoteip', remoteip);

  // Two attempts at most (network error, timeout, 5xx); same idempotency key both times.
  let result = null;
  for (let attempt = 0; attempt < 2 && !result; attempt++) {
    try {
      const r = await fetchImpl(SITEVERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.status >= 500) throw new Error(`siteverify ${r.status}`);
      if (!r.ok) return { ok: false, reason: 'unavailable', codes: [`http-${r.status}`] };
      result = await r.json();
    } catch (e) {
      console.warn('[turnstile] siteverify attempt failed:', String(e?.name || ''), String(e?.message || e).slice(0, 120));
    }
  }
  if (!result || typeof result !== 'object') return { ok: false, reason: 'unavailable' };

  const codes = Array.isArray(result['error-codes']) ? result['error-codes'] : [];
  if (result.success !== true) {
    // internal-error is Cloudflare's side, not the visitor's.
    return { ok: false, reason: codes.includes('internal-error') ? 'unavailable' : 'rejected', codes };
  }
  if (TEST_SECRETS.has(secret)) return { ok: true };
  if (result.action !== expectedAction) return { ok: false, reason: 'action-mismatch' };
  if (!expectedHostnames.includes(result.hostname)) return { ok: false, reason: 'hostname-mismatch' };
  return { ok: true };
}
