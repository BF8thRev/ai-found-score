// A paid PR agency report shaped like the live "PR 73" one (Oct 2 2026): the owner typed "PR 73", the
// website writes "PR73" everywhere, Google lists it as "PR73", and AI cited agency directories when it
// named other firms. The rivals, page contents and Google data are made up; the directory domains are
// real public sites. Everything here is offline: fakeWeb() answers every request the scan makes.

import { PLACES_URL } from '../../owner-checks.js';
import { buildReport } from '../../extract/build.js';

export const BUSINESS = Object.freeze({
  name: 'PR 73', trade: 'pr agency', town: 'New York City', state: 'NY', zip: '10001', website: 'https://www.pr73.com',
});

export const HOME = `<!doctype html><html><head>
<title>Integrated Communications, PR &amp; Media Relations | PR73</title>
<meta name="description" content="PR73 is an integrated communications and media relations firm in New York City.">
</head><body><h1>Integrated communications for brands that want to be heard</h1>
<p>PR73 works with consumer and B2B brands. Call PR73 at <a href="tel:2125550173">(212) 555-0173</a>.</p>
</body></html>`;

const pad = (s) => `${s} ${'Agencies are listed by specialty, size and client reviews. '.repeat(8)}`;

/** The cited pages, as the directories would serve them to our crawler. */
export const PAGES = {
  // Clutch turns crawlers away (a real 403 for our user agent, Oct 2 2026).
  'https://clutch.co/pr-firms/new-york': { status: 403, body: 'Forbidden' },
  // Lists PR73 with a link to its website and a profile on the directory.
  'https://www.communicationsmatch.com/agencies/new-york-public-relations': {
    status: 200,
    body: `<html><body><h1>New York PR agencies</h1>${pad('')}
      <div><a href="/company/brightline-communications">Brightline Communications</a></div>
      <div><a href="/company/pr73">PR73</a> <a href="https://www.pr73.com/?utm_source=cm">Visit website</a></div></body></html>`,
  },
  // Read in full: other firms, not PR73.
  'https://www.publicrelationsdatabase.com/best-pr-firms-new-york': {
    status: 200,
    body: `<html><body><h1>Best PR firms in New York</h1><ol><li>Brightline Communications</li><li>Kestrel PR</li></ol>${pad('')}</body></html>`,
  },
  // A bot wall, not the page.
  'https://themanifest.com/pr/agencies/new-york': { status: 200, body: '<html><head><title>Just a moment...</title></head><body><div id="cf-chl-widget"></div></body></html>' },
  // Read in full, PR73 not on it; GoodFirms has an "add your company" page we know.
  'https://www.goodfirms.co/directory/city/public-relations/new-york': {
    status: 200,
    body: `<html><body><h1>Top PR companies in New York</h1><a href="/company/kestrel-pr">Kestrel PR</a>${pad('')}</body></html>`,
  },
  // robots.txt says no: never fetched.
  'https://www.designrush.com/agency/public-relations/new-york': { status: 200, body: '<html><body>PR73</body></html>' },
};

export const ROBOTS = {
  'https://www.goodfirms.co': 'User-agent: *\nDisallow: /search/service-location\n',
  'https://www.designrush.com': 'User-agent: *\nDisallow: /agency/\n',
  'https://www.communicationsmatch.com': 'User-agent: *\nDisallow:\n',
};

const R1 = 'Brightline Communications';
const R2 = 'Kestrel PR';
const text1 = `**${R1}** and **${R2}** are well known New York PR agencies.`;
const text2 = `Many people pick **${R1}**; **${R2}** is also well reviewed.`;
const cite = (url) => ({ url });

export const SCAN = {
  questions: [
    { id: 'q1', intent: 'best', text: "What's the best pr agency in New York City, NY?" },
    { id: 'q2', intent: 'job', text: 'Can you recommend a pr agency in New York City NY?' },
  ],
  engines: ['chatgpt', 'gemini'],
  calls: [
    { engine: 'chatgpt', questionId: 'q1', run: 1, ok: true, text: text1, askedAt: '2026-10-01T17:49:00Z', model: 'gpt-x',
      citations: [cite('https://clutch.co/pr-firms/new-york'), cite('https://www.communicationsmatch.com/agencies/new-york-public-relations'), cite('https://www.publicrelationsdatabase.com/best-pr-firms-new-york')] },
    { engine: 'gemini', questionId: 'q1', run: 1, ok: true, text: text2, askedAt: '2026-10-01T17:49:30Z', model: 'gemini-x',
      citations: [cite('https://themanifest.com/pr/agencies/new-york'), cite('https://www.goodfirms.co/directory/city/public-relations/new-york'), cite('https://www.designrush.com/agency/public-relations/new-york')] },
    { engine: 'chatgpt', questionId: 'q2', run: 1, ok: true, text: text2, askedAt: '2026-10-01T17:50:00Z', model: 'gpt-x', citations: [cite('https://clutch.co/pr-firms/new-york')] },
    { engine: 'gemini', questionId: 'q2', run: 1, ok: true, text: text1, askedAt: '2026-10-01T17:50:30Z', model: 'gemini-x', citations: [] },
  ],
};

const at = (t, n) => ({ name: n, pos: t.indexOf(n) });
export const PROPOSALS = {
  'chatgpt:q1:1': { businesses: [at(text1, R1), at(text1, R2)], ownerFacts: [] },
  'gemini:q1:1': { businesses: [at(text2, R1), at(text2, R2)], ownerFacts: [] },
  'chatgpt:q2:1': { businesses: [at(text2, R1), at(text2, R2)], ownerFacts: [] },
  'gemini:q2:1': { businesses: [at(text1, R1), at(text1, R2)], ownerFacts: [] },
};

/** Google's listing for PR73: found when searched as "PR73", not as "PR 73". */
export const PR73_PLACE = {
  id: 'place-pr73', displayName: { text: 'PR73' }, websiteUri: 'https://www.pr73.com/', formattedAddress: '73 Spring St, New York, NY 10012, USA',
  nationalPhoneNumber: '(212) 555-0173', googleMapsUri: 'https://maps.google.com/?cid=73', businessStatus: 'OPERATIONAL', rating: 4.9, userRatingCount: 12,
};

/**
 * The web as the scan sees it. places(textQuery) → the Places reply for that search (default: PR73's
 * listing only when searched as "PR73"). Every request is logged in `calls`.
 */
export function fakeWeb({ places = (q) => (/^PR73\b/.test(q) ? [PR73_PLACE] : /^PR 73\b/.test(q) ? [{ id: 'other', displayName: { text: 'PR 7 Studio' }, websiteUri: 'https://pr7studio.example.com/' }] : []) } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    calls.push({ u, init });
    if (u === PLACES_URL) {
      const q = JSON.parse(init.body).textQuery;
      return Response.json({ places: places(q) });
    }
    const { origin, pathname } = new URL(u);
    if (pathname === '/robots.txt') return ROBOTS[origin] ? new Response(ROBOTS[origin]) : new Response('', { status: 404 });
    if (u === 'https://www.pr73.com/') return new Response(HOME, { headers: { 'content-type': 'text/html' } });
    const p = PAGES[u];
    if (p) return new Response(p.body, { status: p.status, headers: { 'content-type': 'text/html' } });
    return new Response('not found', { status: 404 });
  };
  f.calls = calls;
  f.placesQueries = () => calls.filter((c) => c.u === PLACES_URL && JSON.parse(c.init.body).textQuery && c.init.headers['X-Goog-FieldMask'].includes('nationalPhoneNumber')).map((c) => JSON.parse(c.init.body).textQuery);
  return f;
}

/** The PR 73 report as the scan builds it (scanner/extract/build.js), fully offline. */
export async function buildPr73Report() {
  const web = fakeWeb();
  const { report, validation } = await buildReport({ scan: SCAN, business: BUSINESS, proposalsByAnswer: PROPOSALS, env: { GOOGLE_PLACES_API_KEY: 'test-key' }, fetchImpl: web, id: 'pr73-test-token' });
  return { report, validation, web };
}
