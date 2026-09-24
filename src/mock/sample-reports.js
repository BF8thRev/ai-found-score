// Sample reports served at /report/sample-*. Fictional businesses only.
//
//   sample-001          v2 report (the site's "See a sample report" link)
//   sample-edge-failed  v2 report where one engine (Gemini) didn't respond
//   sample-recheck      sample-001 with a baseline, to show the before/after strip
//   sample-v1           the legacy v1 report, kept so the v1 renderer stays covered

import { SAMPLE_V1 } from './sample-v1.js';
import { SAMPLE_V2, SAMPLE_EDGE_FAILED, SAMPLE_RECHECK } from './sample-v2.js';

export const MOCK_REPORTS = {
  'sample-001': SAMPLE_V2,
  'sample-edge-failed': SAMPLE_EDGE_FAILED,
  'sample-recheck': SAMPLE_RECHECK,
  'sample-v1': SAMPLE_V1,
};
