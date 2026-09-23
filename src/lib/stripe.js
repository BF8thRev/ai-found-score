// lib/stripe.js — Stripe webhook signature verification (WebCrypto, no deps).
//
// Stripe signs webhooks as:  t=<timestamp>,v1=<hmac-sha256 hex>
// over the string `${timestamp}.${rawBody}`, keyed by STRIPE_WEBHOOK_SECRET.

/**
 * Verify the Stripe-Signature header against the raw request body.
 * @param {string} rawBody - exact request text (do NOT re-serialize)
 * @param {string} signatureHeader - value of the Stripe-Signature header
 * @param {string} secret - STRIPE_WEBHOOK_SECRET env var
 * @param {number} toleranceSec - reject signatures older than this (default 5 min)
 * @returns {Promise<boolean>}
 */
export async function verifyStripeSignature(rawBody, signatureHeader, secret, toleranceSec = 300) {
  if (!signatureHeader || !secret) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(',').map((kv) => kv.split('=', 2))
  );
  const timestamp = Number(parts.t);
  const received = parts.v1;
  if (!timestamp || !received) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSec) return false;

  const payload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const expected = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');

  return timingSafeEqual(expected, received);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
