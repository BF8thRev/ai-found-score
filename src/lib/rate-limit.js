// Per-IP rate limit for the public form endpoints (POST /api/request, GET /api/questions),
// using the Workers Rate Limiting binding REQUEST_LIMITER (wrangler.jsonc `ratelimits`).
// The binding is per Cloudflare location and eventually consistent: a brake on scripted
// floods, not exact accounting. No binding (tests, old config) -> no limit.

export const RATE_LIMITED_MESSAGE = 'Too many tries from your connection. Wait a minute and try again.';

/**
 * @returns {Promise<Response|null>} a 429 Response when over the limit, else null
 */
export async function rateLimit(env, request, bucket) {
  const limiter = env?.REQUEST_LIMITER;
  if (!limiter || typeof limiter.limit !== 'function') return null;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  let success = true;
  try {
    ({ success } = await limiter.limit({ key: `${bucket}:${ip}` }));
  } catch (e) {
    // The limiter is a brake, not a gate: if it errors, let the request through.
    console.error('[ratelimit] limiter failed', e);
    return null;
  }
  if (success) return null;
  return Response.json({ ok: false, error: RATE_LIMITED_MESSAGE }, {
    status: 429,
    headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' },
  });
}
