#!/usr/bin/env node
// Guardrail lint for the bundled sample reports and the report page's copy.
//
//   node src/mock/lint-samples.js
//
// - every v2 sample must pass validateReport (totals, proof for every
//   competitor name, exact quotes, method present, no banned words)
// - v1 (legacy) samples are linted for banned words in our own copy
// - public/js/report.js and public/report.html are linted too, since the
//   page's fixed strings are copy the customer reads
// Exits 1 on any failure, so it can gate a deploy.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateReport, lintReport, lintText } from '../../shared/report-v2.js';
import { MOCK_REPORTS } from './sample-reports.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let failed = 0;

for (const [id, report] of Object.entries(MOCK_REPORTS)) {
  if (report.version === 2) {
    const v = validateReport(report);
    if (v.ok) console.log(`ok    ${id} (v2, ${report.totals.namedYou} of ${report.totals.answers} named)`);
    else {
      failed++;
      console.log(`FAIL  ${id} (v2)`);
      for (const e of v.errors) console.log(`      - ${e}`);
    }
    if (!report.sample) {
      failed++;
      console.log(`FAIL  ${id}: bundled samples must set sample: true`);
    }
  } else {
    const hits = lintReport(report);
    if (!hits.length) console.log(`ok    ${id} (v1, lint only)`);
    else {
      failed++;
      console.log(`FAIL  ${id} (v1)`);
      for (const h of hits) console.log(`      - banned word "${h.word}" in ${h.path}: ${JSON.stringify(h.match)}`);
    }
  }
}

for (const rel of ['public/js/report.js', 'public/report.html']) {
  const text = await readFile(join(root, rel), 'utf8');
  const hits = lintText(text);
  if (!hits.length) console.log(`ok    ${rel}`);
  else {
    failed++;
    console.log(`FAIL  ${rel}`);
    for (const h of hits) {
      const line = text.slice(0, h.index).split('\n').length;
      console.log(`      - banned word "${h.word}" at line ${line}: ${JSON.stringify(h.match)}`);
    }
  }
}

if (failed) {
  console.log(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll sample reports pass.');
