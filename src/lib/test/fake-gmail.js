// A fake for everything the Gmail sender talks to: Google's token endpoint, the Gmail send endpoint,
// Supabase (claim_gmail_send with the same rules as supabase/v13_gmail_sender.sql, gmail_sends,
// sender_state, unsubscribes, report_links, and [] for any other read) and Resend (alerts).
// Not a *.test.js file: imported by src/lib/test/gmail-sender.test.js and src/admin/test/gmail.test.js.

export const GMAIL_ENV = {
  GMAIL_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  GMAIL_CLIENT_SECRET: 'client-secret-value-123',
  GMAIL_REFRESH_TOKEN: '1//refresh-token-value-456',
  SUPABASE_URL: 'https://db.example',
  SUPABASE_SERVICE_KEY: 'service-key-value',
  RESEND_API_KEY: 're_test_key',
  ALERT_EMAILS: 'bryan.fields@8threv.com,bryan@getaifoundscore.com',
};

/** Decode one base64url raw message → the MIME text, with each base64 body part decoded too. */
export function decodeRaw(raw) {
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const mime = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  const [head] = mime.split('\r\n\r\n');
  const parts = [...mime.matchAll(/Content-Type: (text\/\w+); charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/g)]
    .map((m) => [m[1], new TextDecoder().decode(Uint8Array.from(atob(m[2].replace(/\r\n/g, '')), (c) => c.charCodeAt(0)))]);
  return { mime, head, text: Object.fromEntries(parts)['text/plain'], html: Object.fromEntries(parts)['text/html'] };
}

export function fakeGmail({ paused = false, cap = null, unsubscribed = [], tokenStatus = 200, sendStatus = 200, sendBody = null, supabaseDown = false } = {}) {
  const f = {
    state: { paused, reason: paused ? 'Paused from /admin' : null },
    sends: [],
    tokenCalls: 0,
    gmail: [],      // { auth, raw, decoded }
    alerts: [],     // Resend bodies
    claims: [],     // claim_gmail_send bodies
    clock: Date.parse('2026-09-29T14:00:00Z'),
    tokenStatus,
    sendStatus,
    sendBody,
    tick(ms) { f.clock += ms; },
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  f.impl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    if (url.href === 'https://oauth2.googleapis.com/token') {
      f.tokenCalls += 1;
      if (f.tokenStatus !== 200) return json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, f.tokenStatus);
      return json({ access_token: `access-${f.tokenCalls}`, expires_in: 3599, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/gmail.send' });
    }
    if (url.href === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
      const { raw } = JSON.parse(init.body);
      f.gmail.push({ auth: init.headers.Authorization, raw, decoded: decodeRaw(raw) });
      if (f.sendStatus !== 200) return new Response(f.sendBody || '{"error":{"code":500}}', { status: f.sendStatus });
      return json({ id: `msg-${f.gmail.length}`, threadId: 't', labelIds: ['SENT'] });
    }
    if (url.hostname === 'api.resend.com') {
      f.alerts.push(JSON.parse(init.body));
      return json({ id: `re-${f.alerts.length}` });
    }
    if (url.hostname !== 'db.example') throw new Error(`unexpected fetch ${url.href}`);
    if (supabaseDown) return new Response('down', { status: 503 });
    const table = url.pathname.replace('/rest/v1/', '');
    if (table === 'rpc/claim_gmail_send') {
      const b = JSON.parse(init.body);
      f.claims.push(b);
      if (f.state.paused) return json({ ok: false, reason: 'paused', detail: f.state.reason });
      const limit = cap ?? b.p_daily_cap;
      if (f.sends.length >= limit) return json({ ok: false, reason: 'cap', sent_today: f.sends.length });
      const last = f.sends.at(-1);
      if (last && last.at > f.clock - b.p_gap_seconds * 1000) {
        return json({ ok: false, reason: 'rate', retry_after: Math.ceil((last.at + b.p_gap_seconds * 1000 - f.clock) / 1000) });
      }
      const row = { id: `send-${f.sends.length + 1}`, at: f.clock, kind: b.p_kind, to_email: b.p_to, subject: b.p_subject, token: b.p_token, campaign: b.p_campaign, status: 'sending' };
      f.sends.push(row);
      return json({ ok: true, id: row.id, sent_today: f.sends.length });
    }
    if (table === 'gmail_sends' && method === 'PATCH') {
      const id = url.searchParams.get('id').replace(/^eq\./, '');
      Object.assign(f.sends.find((r) => r.id === id), JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    if (table === 'sender_state' && method === 'POST') {
      const b = JSON.parse(init.body);
      f.state = { paused: b.paused, reason: b.reason, changed_at: b.changed_at };
      return new Response(null, { status: 201 });
    }
    if (method !== 'GET') throw new Error(`unexpected ${method} ${table}`);
    if (table === 'unsubscribes') {
      const or = decodeURIComponent(url.searchParams.get('or') || '').toLowerCase();
      return json(unsubscribed.some((e) => or.includes(e.toLowerCase())) ? [{ id: 'u1' }] : []);
    }
    if (table === 'sender_state') return json([{ id: 'gmail', ...f.state }]);
    if (table === 'v_gmail_today') return json([{ sent_today: f.sends.length, failed_today: f.sends.filter((r) => r.status === 'failed').length, last_at: f.sends.length ? new Date(f.sends.at(-1).at).toISOString() : null }]);
    if (table === 'gmail_sends') return json([...f.sends].reverse().map((r) => ({ created_at: new Date(r.at).toISOString(), ...r })));
    return json([]);
  };
  return f;
}

export async function withFetch(fake, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = fake.impl;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}
