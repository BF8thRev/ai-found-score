// POST /api/find-report {email, company_url?}: "Lost your report link?" on the homepage. Emails the
// links to the reports tied to that address, to that address only. The answer is the same whether
// or not we found anything (no way to ask "does this email have a report?"), and the send happens
// after the response so the timing doesn't tell either. The route is rate-limited per IP (worker.js).
import { findReportsByEmail } from './db.js';
import { findReportEmail, sendEmail } from './email.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DONE = { ok: true, message: 'If we have a report for that email, the link is on its way. Check your inbox (and spam).' };

export async function handleFindReport(request, env, { find = findReportsByEmail, send = sendEmail, waitUntil = (p) => p } = {}) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return Response.json({ ok: false, error: 'Bad request' }, { status: 400 });
  if (body.company_url) return Response.json(DONE); // honeypot
  const email = String(body.email || '').trim().toLowerCase().slice(0, 160);
  if (!EMAIL_RE.test(email)) return Response.json({ ok: false, error: 'Please enter a valid email.' }, { status: 422 });
  waitUntil((async () => {
    try {
      const reports = await find(env, email);
      if (!reports.length) return;
      const mail = findReportEmail(env, { reports });
      // transactional: they asked for this one email, so it isn't held back by an old unsubscribe.
      const r = await send(env, { to: email, ...mail, token: reports[0].token, transactional: true });
      if (!r.ok) console.warn('[find-report] email not sent', r.reason);
    } catch (e) {
      console.error('[find-report] failed', String(e?.message || e).slice(0, 200));
    }
  })());
  return Response.json(DONE);
}
