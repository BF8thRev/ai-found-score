#!/usr/bin/env node
// Outreach preview (Node only). Prints the filled postcard or email for one
// recipient. There is no send path: without --dry-run it calls send(), which
// throws "sending not enabled".
//
//   node outreach/cli.js --report report.json --token TOKEN --email a@b.c --arm email_a --dry-run
//   node outreach/cli.js --report report.json --token TOKEN --arm mail --code ABC234 --dry-run
//
// Options: --code (report_links.short_code), --first-name, --sender.
// If SUPABASE_URL and SUPABASE_SERVICE_KEY are set, the unsubscribes check runs
// too; otherwise the preview says it was not checked.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { postcard, coldEmail, skipReason } from './templates.js';
import { isSuppressed } from './suppression.js';
import { send } from './send.js';

const ARMS = ['email_a', 'email_b', 'mail'];

async function main() {
  const { values: o } = parseArgs({
    options: {
      report: { type: 'string' }, token: { type: 'string' }, email: { type: 'string' },
      arm: { type: 'string' }, code: { type: 'string' }, 'first-name': { type: 'string' },
      sender: { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
    },
  });
  if (!o.report || !o.token || !ARMS.includes(o.arm)) {
    throw new Error('usage: --report file.json --token X --arm email_a|email_b|mail [--email a@b.c] [--code C] [--first-name N] [--sender S] --dry-run');
  }
  const isEmail = o.arm !== 'mail';
  if (isEmail && !o.email) throw new Error(`--email is required for arm ${o.arm}`);

  let report = JSON.parse(readFileSync(o.report, 'utf8'));
  if (report && report.report && !report.answers) report = report.report; // a scan_results row

  const reason = skipReason(report);
  if (reason) {
    console.log(`SEND NOTHING (${reason}) for report ${report.id}`);
    return;
  }

  const env = process.env;
  let suppressed = 'not checked (SUPABASE_URL / SUPABASE_SERVICE_KEY not set)';
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
    suppressed = await isSuppressed(env, { email: isEmail ? o.email : undefined, reportToken: o.token });
    if (suppressed === true) {
      console.log(`SUPPRESSED: ${o.email || o.token} is in unsubscribes. Send nothing.`);
      return;
    }
  }

  const opts = { token: o.token, code: o.code, firstName: o['first-name'], sender: o.sender };
  const lines = [`arm: ${o.arm}`, `report: ${report.id}`, `suppressed: ${suppressed}`];
  let message;
  if (isEmail) {
    message = coldEmail(report, opts);
    lines.push(`to: ${o.email}`, ...Object.entries(message.headers).map(([k, v]) => `${k}: ${v}`),
      `subject: ${message.subject}`, '', message.text);
  } else {
    message = postcard(report, opts);
    lines.push('', '--- postcard front ---', message.front, '', '--- postcard back ---', message.back);
  }
  console.log(lines.join('\n'));

  if (!o['dry-run']) await send({ arm: o.arm, to: o.email, message });
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
