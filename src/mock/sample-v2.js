// Fictional v2 sample reports. Every business, competitor, phone number and
// website here is made up; towns are real Long Island towns. Cited sites use
// example.com domains so no real directory or brand appears in a sample.

import { buildSample } from './build-sample.js';
import { ACTIVE_ENGINES } from '../../scanner/config.js';

const Q = (town, zip) => [
  { id: 'q1', intent: 'best', text: `What's the best plumber in ${town}, NY?` },
  { id: 'q2', intent: 'urgent', text: `I need an emergency plumber near ${town} NY tonight` },
  { id: 'q3', intent: 'job', text: `Who can replace a water heater in ${town} NY?` },
  { id: 'q4', intent: 'trust', text: `Plumber with good reviews near ${town}, NY` },
  { id: 'q5', intent: 'price', text: `Affordable plumber near ${town} NY ${zip}` },
];

const OWN = 'https://harborviewplumbing.example.com/';
const LP = 'https://localpages.example.com/massapequa-ny/plumbers';
const BO = 'https://bestof-li.example.com/plumbers/massapequa';
const HF = 'https://homefixfinder.example.com/ny/massapequa/water-heaters';
const TR = 'https://townreviews.example.com/massapequa/plumbing';
const NG = 'https://nassauguide.example.com/emergency-plumbers';

const HARBORVIEW_LISTINGS = [
  {
    platform: 'Google',
    status: 'match',
    details: 'Name, phone, and hours match your website.',
    fields: { name: 'Harborview Plumbing & Heating', phone: '(516) 555-0148', hours: 'Mon–Fri 8am–6pm, Sat 9am–2pm' },
  },
  {
    platform: 'Apple',
    status: 'match',
    details: 'Name, phone, and address all match.',
    fields: { name: 'Harborview Plumbing & Heating', phone: '(516) 555-0148' },
  },
  {
    platform: 'Bing',
    status: 'mismatch',
    details: 'Bing shows (516) 555-0119. Your website and other listings show (516) 555-0148.',
    fields: { name: 'Harborview Plumbing & Heating', phone: '(516) 555-0119' },
  },
  {
    platform: 'Yelp',
    status: 'match',
    details: 'Name, phone, and address all match.',
    fields: { name: 'Harborview Plumbing & Heating', phone: '(516) 555-0148', hours: 'Mon–Fri 8am–6pm, Sat 9am–2pm' },
  },
  {
    platform: 'Facebook',
    status: 'mismatch',
    details: 'Facebook shows Sunday hours. Your website, Google and Yelp show Monday to Saturday only.',
    fields: { name: 'Harborview Plumbing', phone: '(516) 555-0148', hours: 'Mon–Sun 8am–8pm' },
  },
];

const HARBORVIEW_SPEC = {
  id: 'sample-001',
  // Answers are written for every engine; the sample shows the ones the site advertises.
  engines: ACTIVE_ENGINES,
  generatedAt: '2026-09-23T14:19:00-04:00',
  startAt: '2026-09-23T14:04:00-04:00',
  business: {
    name: 'Harborview Plumbing & Heating',
    trade: 'plumber',
    address: '4820 Merrick Road',
    town: 'Massapequa',
    state: 'NY',
    zip: '11758',
    phone: '(516) 555-0148',
    website: 'harborviewplumbing.example.com',
  },
  owner: { aliases: ['Harborview Plumbing & Heating', 'Harborview Plumbing'] },
  competitors: [
    { id: 'e1', name: 'Tidewater Plumbing Co.' },
    { id: 'e2', name: 'Kessler Bros. Plumbing' },
    { id: 'e3', name: 'Sunrise Pipe & Heat' },
    { id: 'e4', name: 'Carrow Drain Service' },
    { id: 'e5', name: 'Blue Point Flow Plumbing' },
    { id: 'e6', name: 'Seaford Valve Works' },
  ],
  questions: Q('Massapequa', '11758'),
  answers: [
    // q1 best
    ['q1', 'chatgpt', 1, 'Here are some well-reviewed plumbers in Massapequa, NY:\n\n1. Tidewater Plumbing Co. – Long-running local company with strong reviews for repairs and remodels.\n2. Kessler Bros. Plumbing – Family-owned, known for clear pricing.\n3. Sunrise Pipe & Heat – Handles plumbing plus boiler and heating work.\n4. Blue Point Flow Plumbing – Smaller shop that customers describe as responsive.\n\nCheck recent reviews and confirm licensing in Nassau County before you hire.', [LP, BO]],
    ['q1', 'gemini', 1, 'Based on local reviews, Tidewater Plumbing Co. is frequently recommended in Massapequa. Harborview Plumbing & Heating on Merrick Road is another well-rated option, especially for heating work. Kessler Bros. Plumbing is also worth a call.', [LP, OWN]],
    ['q1', 'google_ai_mode', 1, 'Top-rated plumbers in Massapequa include:\n• Tidewater Plumbing Co.: praised for repair work and upfront quotes.\n• Harborview Plumbing & Heating: 4820 Merrick Road, offers plumbing and heating with 24/7 emergency service.\n• Sunrise Pipe & Heat: known for boiler service.', [LP, OWN, TR]],
    ['q1', 'perplexity', 1, 'Tidewater Plumbing Co. is listed first on the LocalPages directory for plumbers in Massapequa, NY, followed by Kessler Bros. Plumbing and Carrow Drain Service. Reviews for all three mention prompt service.', [LP]],
    ['q1', 'claude', 1, 'Well-regarded plumbers serving Massapequa, NY include Kessler Bros. Plumbing, Tidewater Plumbing Co. and Blue Point Flow Plumbing. Look for a plumber licensed in Nassau County with recent reviews.', [BO, LP]],
    // q2 urgent
    ['q2', 'chatgpt', 1, 'For a same-night emergency near Massapequa, Harborview Plumbing & Heating advertises a 24/7 emergency line at (516) 555-0148. Carrow Drain Service also takes after-hours drain calls. Call ahead to confirm who is on duty tonight.', [OWN, NG]],
    ['q2', 'gemini', 1, 'Harborview Plumbing & Heating in Massapequa offers emergency service and can be reached at (516) 555-0119. Carrow Drain Service is another after-hours option for clogs and backups.', [NG]],
    ['q2', 'google_ai_mode', 1, 'Harborview Plumbing & Heating (4820 Merrick Road) offers 24/7 emergency plumbing in Massapequa, NY. Other after-hours options:\n• Carrow Drain Service\n• Tidewater Plumbing Co. (emergency calls on weekdays)', [OWN, NG]],
    ['q2', 'perplexity', 1, 'Carrow Drain Service advertises 24-hour drain and sewer emergencies near Massapequa. Harborview Plumbing & Heating also lists a 24/7 emergency line on its website.', [NG, OWN]],
    ['q2', 'claude', 1, 'Harborview Plumbing & Heating lists a 24/7 emergency line for Massapequa on its website. Carrow Drain Service also takes night calls for drain backups.', [OWN, NG]],
    // q3 job
    ['q3', 'chatgpt', 1, 'Several local plumbers install water heaters in Massapequa, including Sunrise Pipe & Heat, Harborview Plumbing & Heating, and Kessler Bros. Plumbing. Ask whether the quote includes permit fees and haul-away of the old tank.', [HF]],
    ['q3', 'gemini', 1, 'Kessler Bros. Plumbing and Harborview Plumbing & Heating both replace tank water heaters in the Massapequa area. Many installers can do same-day swaps for standard 40- and 50-gallon tanks.', [HF]],
    ['q3', 'google_ai_mode', 1, 'Harborview Plumbing & Heating replaces tank and tankless water heaters in Massapequa and charges a flat $79 service call to assess the job. Sunrise Pipe & Heat and Kessler Bros. Plumbing also do installations.', [OWN, HF]],
    ['q3', 'perplexity', 1, 'Harborview Plumbing & Heating says it installs tank and tankless water heaters and serves Massapequa from Merrick Road. Kessler Bros. Plumbing also lists water heater replacement.', [OWN, HF]],
    ['q3', 'claude', 1, 'Sunrise Pipe & Heat and Harborview Plumbing & Heating both replace water heaters in Massapequa, NY.', [HF]],
    // q4 trust
    ['q4', 'chatgpt', 1, 'Plumbers near Massapequa with strong review ratings include Tidewater Plumbing Co. and Kessler Bros. Plumbing. Read the newest reviews, since ratings can change.', [TR]],
    ['q4', 'gemini', 1, 'Tidewater Plumbing Co. has a large number of positive reviews. Harborview Plumbing & Heating is also well reviewed and is open Monday through Saturday.', [TR, OWN]],
    ['q4', 'google_ai_mode', 1, 'Highly reviewed plumbers near Massapequa, NY:\n• Tidewater Plumbing Co.\n• Harborview Plumbing & Heating: reviewers mention fast emergency response\n• Kessler Bros. Plumbing', [TR, BO]],
    ['q4', 'perplexity', 1, 'Based on directory reviews, Tidewater Plumbing Co. and Sunrise Pipe & Heat have strong ratings near Massapequa.', [BO, TR]],
    ['q4', 'claude', 1, 'Tidewater Plumbing Co. and Harborview Plumbing & Heating both have strong reviews from Massapequa customers.', [TR]],
    // q5 price
    ['q5', 'chatgpt', 1, 'For budget-friendly plumbing near 11758, Tidewater Plumbing Co. advertises free estimates and Kessler Bros. Plumbing posts flat-rate pricing for common repairs.', [LP]],
    ['q5', 'gemini', 1, 'Tidewater Plumbing Co. is frequently mentioned for fair prices in Massapequa. Carrow Drain Service offers low-cost drain cleaning.', [BO]],
    ['q5', 'google_ai_mode', 1, 'Tidewater Plumbing Co. offers free estimates and is often called the best value near Massapequa. Kessler Bros. Plumbing posts flat rates. Harborview Plumbing & Heating charges a $89 service call.', [LP, OWN]],
    ['q5', 'perplexity', 1, "Most plumbers near Massapequa don't publish prices online. Tidewater Plumbing Co. and Kessler Bros. Plumbing advertise free estimates, according to the LocalPages listing.", [LP]],
    ['q5', 'claude', 1, 'Kessler Bros. Plumbing posts flat-rate pricing, and Carrow Drain Service runs drain cleaning specials near Massapequa.', [LP, BO]],
  ],
  sourceChecks: {
    'localpages.example.com': { youListed: false, youPosition: null, topListed: 'Tidewater Plumbing Co.' },
    'bestof-li.example.com': { youListed: false, youPosition: null, topListed: 'Kessler Bros. Plumbing' },
    'townreviews.example.com': { youListed: true, youPosition: 4, topListed: 'Tidewater Plumbing Co.' },
    'homefixfinder.example.com': { youListed: true, youPosition: 2, topListed: 'Sunrise Pipe & Heat' },
    'nassauguide.example.com': { youListed: true, youPosition: 1, topListed: 'Harborview Plumbing & Heating' },
    'harborviewplumbing.example.com': { youListed: true, youPosition: null, topListed: null },
  },
  facts: [
    { q: 'q2', engine: 'gemini', run: 1, field: 'phone', aiSays: '(516) 555-0119', sourceSays: '(516) 555-0148', status: 'differs' },
    { q: 'q5', engine: 'google_ai_mode', run: 1, field: 'price', aiSays: 'charges a $89 service call', sourceSays: '$79 service call', status: 'differs' },
    { q: 'q2', engine: 'chatgpt', run: 1, field: 'phone', aiSays: 'a 24/7 emergency line at (516) 555-0148', sourceSays: '24/7 emergency line (516) 555-0148', status: 'match' },
    { q: 'q3', engine: 'google_ai_mode', run: 1, field: 'price', aiSays: 'charges a flat $79 service call', sourceSays: '$79 service call', status: 'match' },
    { q: 'q3', engine: 'perplexity', run: 1, field: 'services', aiSays: 'installs tank and tankless water heaters', sourceSays: 'Tank and tankless water heater installation', status: 'match' },
    { q: 'q4', engine: 'gemini', run: 1, field: 'hours', aiSays: 'open Monday through Saturday', sourceSays: 'Mon–Fri 8am–6pm, Sat 9am–2pm', status: 'match' },
  ],
  listings: HARBORVIEW_LISTINGS,
  issues: [
    {
      severity: 'high',
      title: 'Two sites the AI cited for "best" and "cheapest" don’t list you',
      description: 'ChatGPT, Claude and Gemini cited localpages.example.com and bestof-li.example.com in the searches that didn’t name you. Neither page lists Harborview Plumbing & Heating.',
      steps: [
        'Claim or create your business page on localpages.example.com under Plumbers in Massapequa, NY.',
        'Submit Harborview Plumbing & Heating to the bestof-li.example.com plumbers list for Massapequa.',
        'Use the exact name, address and phone from your website: Harborview Plumbing & Heating, 4820 Merrick Road, (516) 555-0148.',
      ],
    },
    {
      severity: 'high',
      title: 'Bing shows an old phone number, and Gemini repeated it',
      description: 'Bing shows (516) 555-0119. Your website and other listings show (516) 555-0148. Gemini gave the old number in one answer.',
      steps: [
        'Sign in to Bing Places and open the Harborview Plumbing & Heating listing.',
        'Change the phone number to (516) 555-0148 and save.',
      ],
    },
    {
      severity: 'medium',
      title: 'The review site ChatGPT cited for "good reviews" lists you 4th',
      description: 'Asked for a plumber with good reviews, ChatGPT cited townreviews.example.com and named Tidewater Plumbing Co. and Kessler Bros. Plumbing, not you. That page lists Harborview Plumbing & Heating 4th.',
      steps: [
        'Claim your page on townreviews.example.com and check that the name, address and phone match your website.',
        'Send your last ten customers a link to that page and ask for a review.',
      ],
    },
    {
      severity: 'low',
      title: 'Facebook shows Sunday hours and a shorter name',
      description: 'Facebook says Mon–Sun 8am–8pm and "Harborview Plumbing". Everywhere else says Mon–Fri 8am–6pm, Sat 9am–2pm and "Harborview Plumbing & Heating".',
      steps: [
        'In Facebook page settings, set hours to Mon–Fri 8am–6pm, Sat 9am–2pm.',
        'Change the page name to Harborview Plumbing & Heating.',
      ],
    },
  ],
  method: {
    engines: {
      chatgpt: { api: 'OpenAI Responses API with web search', model: null, loggedIn: false },
      gemini: { api: 'Gemini API with Google Search grounding', model: null, loggedIn: false },
      google_ai_mode: { api: 'DataForSEO AI Mode, location Massapequa, NY', model: null, loggedIn: false },
      perplexity: { api: 'Perplexity Sonar API', model: null, loggedIn: false },
      claude: { api: 'Anthropic Messages API with web search', model: null, loggedIn: false },
    },
    enginesFailed: [],
    window: '2:04–2:19pm ET',
    runs: 1,
  },
  baseline: null,
};

const CEDAR_SPEC = {
  id: 'sample-edge-failed',
  // The advertised engines, one of which (Gemini) didn't respond.
  engines: ACTIVE_ENGINES,
  generatedAt: '2026-09-23T15:12:00-04:00',
  startAt: '2026-09-23T15:05:00-04:00',
  business: {
    name: 'Cedar Lane Laundromat',
    trade: 'laundromat',
    address: '210 Wellwood Ave',
    town: 'Lindenhurst',
    state: 'NY',
    zip: '11757',
    phone: '(631) 555-0172',
    website: 'cedarlanelaundromat.example.com',
  },
  owner: { aliases: ['Cedar Lane Laundromat', 'Cedar Lane Laundry'] },
  competitors: [
    { id: 'e1', name: 'Wellwood Wash House' },
    { id: 'e2', name: 'Suds & Spin Laundry Center' },
    { id: 'e3', name: 'Village Coin Laundry' },
  ],
  questions: [
    { id: 'q1', intent: 'best', text: "What's the best laundromat in Lindenhurst, NY?" },
    { id: 'q2', intent: 'urgent', text: '24 hour laundromat near Lindenhurst NY' },
    { id: 'q3', intent: 'job', text: 'Who does laundry pickup and delivery in Lindenhurst NY?' },
    { id: 'q4', intent: 'trust', text: 'Laundromat with good reviews near Lindenhurst, NY' },
    { id: 'q5', intent: 'price', text: 'Cheapest wash and fold near Lindenhurst NY' },
  ],
  answers: [
    ['q1', 'chatgpt', 1, 'Popular laundromats in Lindenhurst include Wellwood Wash House and Suds & Spin Laundry Center. Both are clean and have plenty of machines.', ['https://townreviews.example.com/lindenhurst/laundromats']],
    ['q1', 'google_ai_mode', 1, 'Wellwood Wash House is a top pick in Lindenhurst. Cedar Lane Laundromat is a smaller option on Wellwood Ave with card-operated machines.', ['https://townreviews.example.com/lindenhurst/laundromats', 'https://cedarlanelaundromat.example.com/']],
    ['q1', 'perplexity', 1, 'Suds & Spin Laundry Center and Wellwood Wash House are the most reviewed laundromats in Lindenhurst, NY.', ['https://localpages.example.com/lindenhurst-ny/laundromats']],
    ['q1', 'claude', 1, 'Wellwood Wash House and Village Coin Laundry are both well reviewed in Lindenhurst, NY.', ['https://townreviews.example.com/lindenhurst/laundromats']],
    ['q2', 'chatgpt', 1, 'Suds & Spin Laundry Center advertises 24-hour access near Lindenhurst. Hours can change, so call first.', ['https://localpages.example.com/lindenhurst-ny/laundromats']],
    ['q2', 'google_ai_mode', 1, 'Suds & Spin Laundry Center is open 24 hours on Montauk Highway. Village Coin Laundry is open until midnight.', ['https://localpages.example.com/lindenhurst-ny/laundromats']],
    ['q2', 'perplexity', 1, 'Suds & Spin Laundry Center lists 24-hour service in Lindenhurst.', ['https://localpages.example.com/lindenhurst-ny/laundromats']],
    ['q2', 'claude', 1, 'Suds & Spin Laundry Center is the laundromat near Lindenhurst most often listed as open 24 hours.', ['https://localpages.example.com/lindenhurst-ny/laundromats']],
    ['q3', 'chatgpt', 1, 'Cedar Lane Laundromat offers pickup and delivery in Lindenhurst, according to its website.', ['https://cedarlanelaundromat.example.com/']],
    ['q3', 'google_ai_mode', 1, 'Cedar Lane Laundromat picks up and delivers in Lindenhurst and nearby Copiague. Wellwood Wash House offers drop-off wash and fold.', ['https://cedarlanelaundromat.example.com/']],
    ['q3', 'perplexity', 1, 'Cedar Lane Laundromat lists pickup and delivery for Lindenhurst on its website.', ['https://cedarlanelaundromat.example.com/']],
    ['q3', 'claude', 1, 'Cedar Lane Laundromat offers laundry pickup and delivery in Lindenhurst, NY.', ['https://cedarlanelaundromat.example.com/']],
    ['q4', 'chatgpt', 1, 'Wellwood Wash House has many strong reviews in Lindenhurst. Village Coin Laundry is also well reviewed.', ['https://townreviews.example.com/lindenhurst/laundromats']],
    ['q4', 'google_ai_mode', 1, 'Highly rated nearby: Wellwood Wash House, Cedar Lane Laundromat, and Suds & Spin Laundry Center.', ['https://townreviews.example.com/lindenhurst/laundromats']],
    ['q4', 'perplexity', 1, 'Wellwood Wash House has the most reviews among Lindenhurst laundromats on local review sites.', ['https://townreviews.example.com/lindenhurst/laundromats']],
    ['q4', 'claude', 1, 'Wellwood Wash House and Suds & Spin Laundry Center both have strong reviews near Lindenhurst.', ['https://townreviews.example.com/lindenhurst/laundromats']],
    ['q5', 'chatgpt', 1, 'Village Coin Laundry is often mentioned as a lower-cost wash and fold option near Lindenhurst.', ['https://localpages.example.com/lindenhurst-ny/laundromats']],
    ['q5', 'google_ai_mode', 1, 'Cedar Lane Laundromat charges $1.95/lb for wash and fold with a 15 lb minimum. Village Coin Laundry is similar.', ['https://cedarlanelaundromat.example.com/']],
    ['q5', 'perplexity', 1, 'Prices for wash and fold near Lindenhurst are rarely posted online. Village Coin Laundry and Wellwood Wash House both offer the service.', ['https://localpages.example.com/lindenhurst-ny/laundromats']],
    ['q5', 'claude', 1, 'Village Coin Laundry advertises low wash and fold prices near Lindenhurst.', ['https://localpages.example.com/lindenhurst-ny/laundromats']],
  ],
  sourceChecks: {
    'localpages.example.com': { youListed: false, youPosition: null, topListed: 'Suds & Spin Laundry Center' },
    'townreviews.example.com': { youListed: true, youPosition: 3, topListed: 'Wellwood Wash House' },
    'cedarlanelaundromat.example.com': { youListed: true, youPosition: null, topListed: null },
  },
  facts: [
    { q: 'q5', engine: 'google_ai_mode', run: 1, field: 'price', aiSays: '$1.95/lb for wash and fold with a 15 lb minimum', sourceSays: '$1.95/lb, 15 lb minimum', status: 'match' },
  ],
  listings: [],
  issues: [
    {
      severity: 'high',
      title: 'The directory the AI cited for "24 hour" and "cheapest" doesn’t list you',
      description: 'The AI cited localpages.example.com in answers that didn’t name you. Cedar Lane Laundromat is not on that page.',
      steps: ['Create your business page on localpages.example.com under Laundromats in Lindenhurst, NY.'],
    },
  ],
  method: {
    engines: {
      chatgpt: { api: 'OpenAI Responses API with web search', model: null, loggedIn: false },
      google_ai_mode: { api: 'DataForSEO AI Mode, location Lindenhurst, NY', model: null, loggedIn: false },
      perplexity: { api: 'Perplexity Sonar API', model: null, loggedIn: false },
      claude: { api: 'Anthropic Messages API with web search', model: null, loggedIn: false },
    },
    enginesFailed: ['gemini'],
    window: '3:05–3:12pm ET',
    runs: 1,
  },
  baseline: null,
};

export const SAMPLE_V2 = buildSample(HARBORVIEW_SPEC);
export const SAMPLE_EDGE_FAILED = buildSample(CEDAR_SPEC);

// Same scan as sample-001, shown as a 30-day re-check so the before/after
// strip has something to draw. The baseline totals are fictional too (same number of searches).
export const SAMPLE_RECHECK = {
  ...SAMPLE_V2,
  id: 'sample-recheck',
  baseline: { generatedAt: '2026-08-24T14:10:00-04:00', totals: { answers: SAMPLE_V2.totals.answers, namedYou: 6, firstYou: 2 } },
};
