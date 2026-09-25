// Server-side lock for unpaid reports. Pure: no I/O, safe to unit-test.
//
// Headline findings stay visible: which assistants named you, which listings are wrong, the
// issue titles (so the owner can count the fixes before paying). What's wrong on each listing
// and how to fix each issue — descriptions, steps and copy-paste text — are removed here, so
// they are never in the page for anyone to un-blur.
// v2: sections 1-7 and 9-11 are the free report; section 8's descriptions, steps and
// copyText, plus the X-Ray sections (competitor gap sheet, fix checklist), are the paid part:
// the $49 AI Visibility X-Ray (tier `xray`). Any recorded payment for the token unlocks all of it.

import { xraySections } from '../../shared/report-v2.js';

/** The fields of an issue that survive locking. Everything else (description, steps, copyText, …) is dropped. */
export const LOCKED_ISSUE_FIELDS = ['kind', 'severity', 'title'];

/** What a locked report carries for the X-Ray sections: only that they exist. */
export const LOCKED_XRAY = Object.freeze({ locked: true });

function lockIssue(i) {
  const out = { locked: true };
  for (const k of LOCKED_ISSUE_FIELDS) if (i && i[k] != null) out[k] = i[k];
  // A v1 issue has no kind; keep the shape it always had.
  return out;
}

/** lockReport(report) → a copy with the paid details removed and locked: true. Never mutates. */
export function lockReport(r) {
  if (r.version === 2) {
    // Anything paid that a stored report might carry is dropped, never passed through.
    const { xray, gapSheet, checklist, ...rest } = r;
    return {
      ...rest,
      locked: true,
      // Anything that isn't a clean match keeps only its platform and status.
      listings: (r.listings || []).map((l) =>
        l.status === 'match' ? l : { platform: l.platform, status: l.status, locked: true }),
      issues: (r.issues || []).map(lockIssue),
      xray: { ...LOCKED_XRAY },
    };
  }
  return {
    ...r,
    locked: true,
    listings: (r.listings || []).map((l) =>
      l.status === 'mismatch' ? { platform: l.platform, status: l.status, locked: true } : l),
    issues: (r.issues || []).map((i) => ({ severity: i.severity, title: i.title, locked: true })),
  };
}

/**
 * The body served for a report. Unlocked v2 reports say locked: false and carry the X-Ray
 * sections (built from the report's own data); locked ones go through lockReport.
 */
export function reportBody(report, unlocked) {
  if (!unlocked) return lockReport(report);
  return report.version === 2 ? { ...report, locked: false, xray: xraySections(report) } : report;
}
