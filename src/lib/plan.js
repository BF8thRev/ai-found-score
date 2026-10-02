// src/lib/plan.js — what Be the Answer ($499, one year) hands the owner, built from their confirmed details.
//
//   directoriesFor(trade)          → the directory checklist: 30+ sites, each with its link and what to do there
//   directoryPaste(details)        → the text to paste on every one of them (the same everywhere)
//   directoryChecklistTxt(details) → both, as a text file for the Fix Kit zip
//   googlePosts(details, opts)     → 12 Google Business Profile posts, one a month, ready to paste
//   googlePostsTxt(details, opts)  → the same, as a text file
//
// We never sign in or submit anything for the owner: every site decides what it accepts, and the owner
// (or whoever they choose) makes the change. Truthful by construction, like src/lib/fix-kit.js: fixed
// templates filled only with what the owner confirmed. No AI call, no offers, prices or claims invented.
// Pure: no fetch, no Node APIs.

import { tradeKey, tradeNoun, gbpDescriptionText, gbpCategories } from './fix-kit.js';

/** How many towns a plan covers: the report's own town plus 2 more. */
export const PLAN_MAX_TOWNS = 3;
/** Months of re-scans (and Google posts) in a plan. */
export const PLAN_MONTHS = 12;

// Each site: its name, a link that opens it, and what to do there. Links go to the site's own
// business sign-up or home page; the owner searches for their business there first.
const CORE = [
  { name: 'Google Business Profile', url: 'https://business.google.com/', why: 'Google Maps and Google’s AI answers read it.' },
  { name: 'Apple Business Connect', url: 'https://businessconnect.apple.com/', why: 'Apple Maps and Siri read it.' },
  { name: 'Bing Places for Business', url: 'https://www.bingplaces.com/', why: 'Bing and Microsoft Copilot read it.' },
  { name: 'Yelp for Business', url: 'https://biz.yelp.com/', why: 'AI assistants often cite Yelp for local businesses.' },
  { name: 'Facebook Page', url: 'https://www.facebook.com/pages/create', why: 'Often cited, and customers check it.' },
  { name: 'Better Business Bureau', url: 'https://www.bbb.org/', why: 'A trusted listing AI assistants cite.' },
  { name: 'Nextdoor Business', url: 'https://business.nextdoor.com/', why: 'Neighbors ask for recommendations here.' },
  { name: 'Foursquare', url: 'https://foursquare.com/', why: 'Its places data feeds many apps and maps.' },
  { name: 'Data Axle', url: 'https://www.data-axle.com/', why: 'A business data provider other directories copy from.' },
  { name: 'OpenStreetMap', url: 'https://www.openstreetmap.org/', why: 'Free map data many apps use.' },
  { name: 'Waze for Business', url: 'https://www.waze.com/business', why: 'Drivers find you on the map.' },
  { name: 'TomTom MapShare', url: 'https://www.tomtom.com/mapshare/tools/', why: 'Map data used in cars and apps.' },
  { name: 'Google Search Console', url: 'https://search.google.com/search-console', why: 'Tells Google your website exists and shows what it can read.' },
  { name: 'Bing Webmaster Tools', url: 'https://www.bing.com/webmasters', why: 'Tells Bing (and the AI that uses Bing) your website exists.' },
];
const DIRECTORIES = [
  { name: 'Yellow Pages', url: 'https://www.yellowpages.com/' },
  { name: 'Superpages', url: 'https://www.superpages.com/' },
  { name: 'Manta', url: 'https://www.manta.com/' },
  { name: 'ChamberofCommerce.com', url: 'https://www.chamberofcommerce.com/' },
  { name: 'Hotfrog', url: 'https://www.hotfrog.com/' },
  { name: 'MerchantCircle', url: 'https://www.merchantcircle.com/' },
  { name: 'Brownbook', url: 'https://www.brownbook.net/' },
  { name: 'EZlocal', url: 'https://ezlocal.com/' },
  { name: 'ShowMeLocal', url: 'https://www.showmelocal.com/' },
  { name: 'n49', url: 'https://www.n49.com/' },
  { name: 'CitySquares', url: 'https://citysquares.com/' },
  { name: 'Alignable', url: 'https://www.alignable.com/' },
  { name: 'Trustpilot', url: 'https://business.trustpilot.com/' },
  { name: 'Bark', url: 'https://www.bark.com/' },
  { name: 'LinkedIn company page', url: 'https://www.linkedin.com/company/setup/new/' },
  { name: 'Instagram', url: 'https://www.instagram.com/' },
];
const HOME_TRADES = [
  { name: 'Angi', url: 'https://www.angi.com/' },
  { name: 'Thumbtack', url: 'https://www.thumbtack.com/pro' },
  { name: 'HomeAdvisor', url: 'https://pro.homeadvisor.com/' },
  { name: 'Houzz', url: 'https://www.houzz.com/' },
  { name: 'Porch', url: 'https://porch.com/' },
  { name: 'Networx', url: 'https://www.networx.com/' },
];
const TRADE_SITES = {
  plumbing: HOME_TRADES,
  hvac: HOME_TRADES,
  electrical: HOME_TRADES,
  roofing: [...HOME_TRADES, { name: 'BuildZoom', url: 'https://www.buildzoom.com/' }],
  landscaping: HOME_TRADES,
  cleaning: HOME_TRADES.filter((s) => s.name !== 'Networx'),
  auto_repair: [
    { name: 'RepairPal', url: 'https://repairpal.com/' },
    { name: 'Openbay', url: 'https://www.openbay.com/' },
    { name: 'Mechanic Advisor', url: 'https://www.mechanicadvisor.com/' },
  ],
  laundromat: [],
};

/** The checklist for a trade: the core sites first (most read by AI), then directories, then the trade's own. */
export function directoriesFor(trade) {
  const key = tradeKey(trade);
  return [
    ...CORE.map((s) => ({ ...s, group: 'core' })),
    ...DIRECTORIES.map((s) => ({ ...s, group: 'directory' })),
    ...(TRADE_SITES[key] || []).map((s) => ({ ...s, group: 'trade' })),
  ];
}

const clean = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
const fullAddress = (d) => [d.street, d.town, [d.state, d.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
const joinAnd = (list) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

/** The text to paste on every site, written exactly the same way everywhere. */
export function directoryPaste(d) {
  const cats = gbpCategories(d);
  return {
    name: d.name,
    phone: d.phone,
    address: d.street ? fullAddress(d) : '',
    serviceArea: (d.serviceTowns || []).join(', '),
    website: d.website || '',
    hours: d.hours || '',
    category: cats[0] || tradeNoun(d.trade) || '',
    description: gbpDescriptionText(d),
  };
}

export function directoryChecklistTxt(d) {
  const p = directoryPaste(d);
  const sites = directoriesFor(d.trade);
  const out = [
    `YOUR DIRECTORY CHECKLIST: ${d.name}`,
    `${sites.length} sites. Work down the list; the first ${CORE.length} matter most to AI assistants.`,
    '',
    'On each site: search for your business first. If it is there, claim it. If not, add it.',
    'Paste the details below exactly as written, the same on every site. Matching details are what',
    'AI assistants trust. Each site decides what it accepts, and some take a few weeks to show a change.',
    '',
    'PASTE THIS',
    `Business name: ${p.name}`,
    `Phone: ${p.phone}`,
    ...(p.address ? [`Address: ${p.address}`] : []),
    ...(p.serviceArea ? [`Service area: ${p.serviceArea}`] : []),
    ...(p.website ? [`Website: ${p.website}`] : []),
    ...(p.hours ? [`Hours: ${p.hours}`] : []),
    ...(p.category ? [`Category: ${p.category}`] : []),
    `Description: ${p.description}`,
    '',
    'THE SITES',
  ];
  sites.forEach((s, i) => out.push(`[ ] ${i + 1}. ${s.name}: ${s.url}${s.why ? `\n       ${s.why}` : ''}`));
  out.push('', 'Your monthly re-scan shows which sites AI cites next to your competitors, so you know where to look next.', '');
  return out.join('\n');
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** Google caps a post at 1,500 characters. */
export const GOOGLE_POST_MAX = 1500;

/**
 * 12 posts, one a month, from `start` (a Date; default now). Each rotates what it talks about: who you
 * are, one service, where you work, your hours, how to reach you, reviews. Only confirmed details.
 * → [{ month: 'October 2026', title, text }]
 */
export function googlePosts(d, { start = new Date() } = {}) {
  const noun = tradeNoun(d.trade) || 'local business';
  const towns = (d.serviceTowns || []).length ? d.serviceTowns : [d.town].filter(Boolean);
  const services = (d.services || []).length ? d.services : [];
  const call = `Call ${d.phone}${d.website ? ` or visit ${d.website}` : ''}.`;
  let si = 0;
  const service = () => services[si++ % Math.max(services.length, 1)];
  const writers = [
    () => ({ title: 'Who we are', text: `${d.name} is a ${noun} serving ${joinAnd(towns)}. ${call}` }),
    () => (services.length
      ? ((s) => ({ title: s, text: `Need ${s.toLowerCase()} in ${d.town}? ${d.name} can help. ${call}` }))(service())
      : { title: 'How we can help', text: `Looking for a ${noun} in ${d.town}? ${d.name} is here to help. ${call}` }),
    () => ({ title: 'Where we work', text: `${d.name} works in ${joinAnd(towns)}${d.state ? `, ${d.state}` : ''}. ${call}` }),
    () => (d.hours
      ? { title: 'Our hours', text: `Our hours: ${d.hours}. ${call}` }
      : { title: 'Get in touch', text: `Questions about a job? ${d.name} is a ${noun} in ${d.town}. ${call}` }),
    () => ({
      title: 'Thank you',
      text: `Thank you to every customer in ${joinAnd(towns)} who chose ${d.name}. `
        + `${d.googleReviewUrl ? `If we did good work for you, a Google review helps your neighbors find us: ${d.googleReviewUrl}` : 'If we did good work for you, a Google review helps your neighbors find us.'}`,
    }),
  ];
  const order = [0, 1, 2, 3, 1, 4, 1, 2, 1, 3, 1, 4];
  const y0 = start.getUTCFullYear();
  const m0 = start.getUTCMonth();
  return order.map((w, i) => {
    const post = writers[w]();
    const text = clean(post.text).slice(0, GOOGLE_POST_MAX);
    return { month: `${MONTHS[(m0 + i) % 12]} ${y0 + Math.floor((m0 + i) / 12)}`, title: post.title, text };
  });
}

export function googlePostsTxt(d, opts = {}) {
  const posts = googlePosts(d, opts);
  const out = [
    `YOUR GOOGLE POSTS: ${d.name}`,
    '12 posts, one a month. Sign in at business.google.com, choose "Add update", and paste the month\'s post.',
    'Add a photo of your own work if you have one: posts with a photo get more attention.',
    '',
  ];
  for (const p of posts) out.push(`${p.month.toUpperCase()}: ${p.title}`, p.text, '');
  return out.join('\n');
}
