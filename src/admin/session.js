// src/admin/session.js — admin auth helpers. Web Crypto only (Workers + Node 18+).
//
// Session cookie value: "v1.<expiresAtMs>.<nonce>.<sig>"
//   sig = base64url(HMAC-SHA256(key, "v1.<expiresAtMs>.<nonce>"))
//   key = HMAC key derived from ADMIN_TOKEN (so rotating ADMIN_TOKEN logs every session out).
// Verification uses crypto.subtle.verify, which compares in constant time.

export const SESSION_COOKIE = '__Host-afs_admin';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const enc = new TextEncoder();

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sessionKey(secret) {
  // Derive a dedicated signing key so the raw admin token is never the HMAC key itself.
  const base = await crypto.subtle.importKey('raw', enc.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const derived = await crypto.subtle.sign('HMAC', base, enc.encode('afs-admin-session-v1'));
  return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** New signed session value, valid for `ttlMs`. */
export async function signSession(secret, { now = Date.now(), ttlMs = SESSION_TTL_MS } = {}) {
  if (!secret) throw new Error('signSession: secret required');
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(12)));
  const payload = `v1.${now + ttlMs}.${nonce}`;
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await sessionKey(secret), enc.encode(payload)));
  return `${payload}.${b64url(sig)}`;
}

/** True only for an unexpired value signed with this secret. Never throws. */
export async function verifySession(secret, value, { now = Date.now(), maxTtlMs = SESSION_TTL_MS } = {}) {
  try {
    if (!secret || typeof value !== 'string' || value.length > 300) return false;
    const parts = value.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return false;
    const exp = Number(parts[1]);
    if (!Number.isSafeInteger(exp) || exp <= now || exp > now + maxTtlMs + 60_000) return false;
    if (!/^[A-Za-z0-9_-]{8,32}$/.test(parts[2]) || !/^[A-Za-z0-9_-]{40,50}$/.test(parts[3])) return false;
    return await crypto.subtle.verify('HMAC', await sessionKey(secret), fromB64url(parts[3]), enc.encode(parts.slice(0, 3).join('.')));
  } catch {
    return false;
  }
}

/** Set-Cookie header for a new session (HttpOnly, Secure, SameSite=Strict, host-only). */
export function sessionCookie(value, { ttlMs = SESSION_TTL_MS } = {}) {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${Math.floor(ttlMs / 1000)}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

/** Cookie header → { name: value } (first value wins). */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

async function sha256(str) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(str))));
}

/** Constant-time string compare: hash both sides to equal length, then XOR every byte. */
export async function tokenMatches(given, expected) {
  if (!given || !expected) return false;
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * CSRF guard for cookie-authenticated POSTs: the Origin header must equal this request's own
 * origin. (Bearer-token API clients don't need it: no ambient credential.)
 * Browsers send `Origin: null` on a same-origin form POST from a page served with
 * `Referrer-Policy: no-referrer` (Fetch spec); only in that case (Origin missing or "null") is the
 * browser-set, unforgeable `Sec-Fetch-Site: same-origin` accepted instead.
 */
export function sameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin || origin === 'null') return request.headers.get('Sec-Fetch-Site') === 'same-origin';
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

/**
 * Who is calling: 'bearer' (Authorization: Bearer ADMIN_TOKEN), 'cookie' (valid session), or null.
 */
export async function adminAuth(request, adminToken) {
  if (!adminToken) return null;
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) {
    return (await tokenMatches(auth.slice(7).trim(), adminToken)) ? 'bearer' : null;
  }
  const value = parseCookies(request.headers.get('Cookie'))[SESSION_COOKIE];
  if (value && (await verifySession(adminToken, value))) return 'cookie';
  return null;
}
