// src/lib/email.js — email that people asked for, sent through Resend (https://resend.com).
//
// Only transactional mail lives here: "your report is ready", "email me this report", receipts, the
// full audit, the 30-day re-check. Resend forbids cold outreach; outreach/ must never send through it.
//
//   RESEND_API_KEY   Worker secret (`npx wrangler secret put RESEND_API_KEY`). Unset → nothing is sent,
//                    every caller carries on (email is never the reason a request fails).
//   EMAIL_FROM       optional, default "AI Found Score <reports@aifoundscore.com>" (the domain must be
//                    verified in Resend: DNS records on aifoundscore.com).
//   SITE_URL         optional, default https://aifoundscore.com (links in the mail).
//
// Every send carries an Idempotency-Key (Resend keeps it 24 h), so a retried workflow step or two
// racing triggers send one email. Anything not a receipt checks `unsubscribes` first (fails closed).
// Templates are pure: { subject, text, html }, plain words, one link, the sender's address in the footer.

import { isSuppressed } from '../../outreach/suppression.js';

export const RESEND_URL = 'https://api.resend.com/emails';
export const DEFAULT_FROM = 'AI Found Score <reports@aifoundscore.com>';
export const REPLY_TO = 'hello@aifoundscore.com';
export const POSTAL = 'Fields Holding d/b/a GetAiFound Score · 120 Terminal Drive, Plainview, NY 11803';

export function emailConfigured(env) {
  return !!String(env?.RESEND_API_KEY || '').trim();
}

export function siteUrl(env) {
  return String(env?.SITE_URL || 'https://aifoundscore.com').replace(/\/+$/, '');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Send one email. → { ok: true, id } | { ok: false, reason }. Never throws.
 * `transactional: true` (receipts) skips the unsubscribe check; everything else is skipped for an
 * address that unsubscribed, and when the check itself fails.
 */
export async function sendEmail(env, { to, subject, text, html, idempotencyKey, token = null, transactional = false }, { fetchImpl = (...a) => fetch(...a) } = {}) {
  try {
    if (!emailConfigured(env)) return { ok: false, reason: 'not configured' };
    const addr = String(to || '').trim().toLowerCase();
    if (!EMAIL_RE.test(addr)) return { ok: false, reason: 'bad address' };
    if (!transactional) {
      let suppressed = true;
      try { suppressed = await isSuppressed(env, { email: addr }, fetchImpl); } catch { suppressed = true; }
      if (suppressed) return { ok: false, reason: 'suppressed' };
    }
    const unsub = `${siteUrl(env)}/unsubscribe${token ? `?t=${encodeURIComponent(token)}` : ''}`;
    const res = await fetchImpl(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${String(env.RESEND_API_KEY).trim()}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey).slice(0, 256) } : {}),
      },
      body: JSON.stringify({
        from: String(env.EMAIL_FROM || DEFAULT_FROM),
        to: [addr],
        reply_to: REPLY_TO,
        subject,
        text,
        html,
        headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, reason: `resend ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}` };
    const j = await res.json().catch(() => ({}));
    return { ok: true, id: j.id || null };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** One email: paragraphs (plain strings), one button, footer with the unsubscribe link and address. */
export function layout({ subject, paragraphs, button, url, unsubUrl, note = '' }) {
  const text = [
    ...paragraphs,
    `${button}: ${url}`,
    note,
    '—',
    'AI Found Score',
    `Reply to this email with any question. Stop these emails: ${unsubUrl}`,
    POSTAL,
  ].filter(Boolean).join('\n\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f7fb;font-family:Arial,Helvetica,sans-serif;color:#1a2233">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:10px;padding:28px">
<p style="margin:0 0 18px;font-weight:bold;color:#173a6b">AI Found Score</p>
${paragraphs.map((p) => `<p style="font-size:16px;line-height:1.55;margin:0 0 14px">${esc(p)}</p>`).join('\n')}
<p style="margin:22px 0"><a href="${esc(url)}" style="background:#1f5fd6;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold;display:inline-block">${esc(button)}</a></p>
${note ? `<p style="font-size:14px;line-height:1.5;color:#55607a;margin:0 0 14px">${esc(note)}</p>` : ''}
<p style="font-size:12px;line-height:1.5;color:#7a8499;margin:24px 0 0">Reply to this email with any question. <a href="${esc(unsubUrl)}" style="color:#7a8499">Stop these emails</a>.<br>${esc(POSTAL)}</p>
</div></body></html>`;
  return { subject, text, html };
}

const unsubFor = (env, token) => `${siteUrl(env)}/unsubscribe${token ? `?t=${encodeURIComponent(token)}` : ''}`;
const reportUrl = (env, token) => `${siteUrl(env)}/report/${encodeURIComponent(token)}`;
const named = (t) => (t && Number(t.answers) ? `${Number(t.namedYou) || 0} of ${Number(t.answers)}` : null);

/** Free report finished (the owner left their email on the form). */
export function reportReadyEmail(env, { token, name, totals }) {
  const n = named(totals);
  return layout({
    subject: `Your AI report for ${name || 'your business'} is ready`,
    paragraphs: [
      `We asked AI assistants the questions your customers ask about ${name || 'your business'}.`,
      n ? `They named you in ${n} answers. Your report shows who they named instead, and your AI Found Score.` : 'Your report shows whether they named you, who they named instead, and your AI Found Score.',
    ],
    button: 'See my report',
    url: reportUrl(env, token),
    unsubUrl: unsubFor(env, token),
    note: 'The link is private to you. Bookmark it; it keeps working.',
  });
}

/** "Email me this report" on the report page. */
export function leadEmail(env, { token, name }) {
  return layout({
    subject: `Your AI report${name ? ` for ${name}` : ''}`,
    paragraphs: ['Here’s the report you asked us to send.'],
    button: 'Open the report',
    url: reportUrl(env, token),
    unsubUrl: unsubFor(env, token),
    note: 'You got this because someone entered this address on the report page. If that wasn’t you, ignore it.',
  });
}

const TIER_NAMES = { xray: 'AI Visibility Audit', fix_kit: 'Fix Kit', be_the_answer: 'Be the Answer' };

/** Right after payment (a receipt: sent even to an address that unsubscribed from updates). */
export function receiptEmail(env, { token, name, tier }) {
  const plan = TIER_NAMES[tier] || 'your plan';
  const kit = tier === 'fix_kit' || tier === 'be_the_answer';
  const paragraphs = [`Thanks. Your ${plan}${name ? ` for ${name}` : ''} is paid for.`];
  if (tier === 'xray' || tier === 'be_the_answer') {
    paragraphs.push('Your report is unlocked now. We’re also asking all 5 customer questions again on every AI assistant we check; we’ll email you when those answers are in, usually within the hour.');
    paragraphs.push('In 30 days we re-scan for free and email you what changed.');
  }
  if (kit) paragraphs.push('Next: check your business details, then download your Fix Kit and hand it to whoever runs your website.');
  return layout({
    subject: `Receipt: ${plan}${name ? ` for ${name}` : ''}`,
    paragraphs,
    button: kit ? 'Get my Fix Kit' : 'Open my report',
    url: kit ? `${siteUrl(env)}/fix-kit/${encodeURIComponent(token)}` : reportUrl(env, token),
    unsubUrl: unsubFor(env, token),
    note: kit ? `Your report: ${reportUrl(env, token)}` : 'If we can’t show you 3 things to fix, it’s free. Just reply.',
  });
}

/** The paid full scan finished. */
export function fullAuditEmail(env, { token, name, totals }) {
  const n = named(totals);
  return layout({
    subject: `Your full AI audit${name ? ` for ${name}` : ''} is ready`,
    paragraphs: [
      'We asked all 5 customer questions on every AI assistant we check.',
      n ? `They named you in ${n} answers. Every answer is in your report word for word, with the websites AI cited and what to fix first.` : 'Every answer is in your report word for word, with the websites AI cited and what to fix first.',
    ],
    button: 'See my full audit',
    url: reportUrl(env, token),
    unsubUrl: unsubFor(env, token),
  });
}

/** The free 30-day re-check finished. */
export function recheckEmail(env, { token, name, totals, before }) {
  const n = named(totals);
  const b = named(before);
  let line = 'Your report shows what changed since your audit.';
  if (n && b) {
    const pn = totals.namedYou / totals.answers;
    const pb = before.namedYou / before.answers;
    line = pn > pb ? `AI named you in ${b} answers at your audit. Now it’s ${n}. That’s progress.`
      : pn < pb ? `AI named you in ${b} answers at your audit. Now it’s ${n}. You’ve slipped, and your report shows who took your place.`
        : `AI named you in ${b} answers at your audit, and it’s still ${n}.`;
  }
  return layout({
    subject: `30 days later: what AI says about ${name || 'you'} now`,
    paragraphs: [
      'We ran your audit again, free, 30 days after you bought it.',
      line,
      'Want us to do the rest? Be the Answer covers every town you serve, submits your details to 30+ directories and data providers, and re-scans every month for a year. Your $49 counts toward it. Just reply to this email.',
    ],
    button: 'See what changed',
    url: reportUrl(env, token),
    unsubUrl: unsubFor(env, token),
  });
}
