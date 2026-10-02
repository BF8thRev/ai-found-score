// src/lib/done-for-you.js — the Fix Kit's "do it for me" button: one click on the kit page emails us.
//
//   validateHelp(body)                       → { ok, help: { contact, phone, wants[], note }, errors: [{ field, message }] }
//   helpEmails(env, { token, tiers, ... })   → { toUs, toOwner }: the two emails (src/lib/email.js sendEmail shape)
//
// POST { help: true, details, contact, phone?, wants[], note? } on /api/fix-kit/<token> (src/lib/fix-kit-route.js).
// Paid kits only. It promises nothing about price or timing: it says we got the request and will reply by
// email. The email to us carries everything needed to answer without asking the owner again: who, how to
// reach them, what they asked for, their site and builder, the kit link and report link, what the kit is
// still missing. No logins are ever asked for here; the owner decides what to share when we write back.

import { platformFor } from '../../shared/platforms.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const WANTS = Object.freeze({
  google: 'My Google Business Profile',
  website: 'My website (a Questions page and the details Google reads)',
  reviews: 'Getting more Google reviews',
});
const clean = (v) => (v == null ? '' : String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim());

export function validateHelp(body) {
  const b = body && typeof body === 'object' ? body : {};
  const errors = [];
  const contact = clean(b.contact).toLowerCase();
  if (!EMAIL_RE.test(contact) || contact.length > 200) errors.push({ field: 'helpContact', message: 'Enter the email we should write to.' });
  const phone = clean(b.phone).slice(0, 40);
  if (phone && phone.replace(/\D/g, '').length < 10) errors.push({ field: 'helpPhone', message: 'Enter a 10-digit phone number, or leave it blank.' });
  const wants = [...new Set((Array.isArray(b.wants) ? b.wants : []).map(clean).filter((w) => Object.hasOwn(WANTS, w)))];
  if (!wants.length) errors.push({ field: 'helpWants', message: 'Pick at least one thing you want help with.' });
  const note = clean(b.note);
  if (note.length > 600) errors.push({ field: 'helpNote', message: 'Keep the note under 600 characters.' });
  return { ok: !errors.length, help: { contact, phone, wants, note: note.slice(0, 600) }, errors };
}

/** What the kit still lacks, in a line each, for the email to us. */
function gaps(kit) {
  const out = [];
  for (const m of (kit && kit.missing) || []) out.push(`Missing ${m.label.toLowerCase()}`);
  const needs = kit && kit.faq && kit.faq.needs;
  if (needs) out.push(`${needs} FAQ answer${needs === 1 ? '' : 's'} still need a sentence from the owner`);
  return out;
}

export function helpEmails(env, { origin, token, tiers = [], details, report, kit, help, date = new Date() }) {
  const d = details;
  const platform = platformFor(report);
  const day = date.toISOString().slice(0, 10);
  const lines = [
    `${d.name} asked us to do their Fix Kit for them.`,
    '',
    `Reply to: ${help.contact}${help.phone ? ` · phone ${help.phone}` : ''}`,
    `They want help with: ${help.wants.map((w) => WANTS[w]).join('; ')}`,
    ...(help.note ? [`Their note: ${help.note}`] : []),
    '',
    `Business: ${d.name}${d.trade ? ` (${d.trade})` : ''}, ${[d.town, d.state].filter(Boolean).join(', ')}`,
    `Website: ${d.website || '(none on file)'}${platform && platform.name ? ` · built on ${platform.name}` : ''}`,
    `Phone on kit: ${d.phone || '(missing)'}`,
    `Paid for: ${tiers.length ? tiers.join(', ') : '(unknown)'}`,
    ...(gaps(kit).length ? ['Kit is missing: ' + gaps(kit).join('; ')] : []),
    '',
    `Their Fix Kit page: ${origin}/fix-kit/${encodeURIComponent(token)}`,
    `Their report: ${origin}/report/${encodeURIComponent(token)}`,
    '',
    'We have not asked them for any login. Decide what to offer, then reply to them.',
  ];
  const key = `dfy-${token}-${day}`;
  return {
    toUs: { subject: `Done-for-you request: ${d.name}`, text: lines.join('\n'), idempotencyKey: `${key}-us`, transactional: true },
    toOwner: {
      to: help.contact,
      subject: 'We got your request',
      text: [
        `Hi,`,
        '',
        `Thanks for asking us to help with ${d.name}. We got your request and will reply to this address by email with what we would do and what it would cost.`,
        'Asking is free, and you don’t owe anything unless you say yes in writing. This is one reply, not a mailing list. We will never ask for a password in a message like this.',
        '',
        `Your Fix Kit is still here whenever you want it: ${origin}/fix-kit/${encodeURIComponent(token)}`,
        '',
        'AI Found Score',
        'hello@aifoundscore.com',
      ].join('\n'),
      idempotencyKey: `${key}-owner`,
      transactional: true,
    },
  };
}
