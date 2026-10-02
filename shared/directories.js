// The directories and industry lists AI most often cites for our trades and professional firms, and how a
// business gets on each: free, a free basic profile with paid upgrades, paid only, an entry with a fee, or
// editorial. Every row was checked on the directory's OWN pages (`source`) on the `checked` date; a row we
// couldn't confirm there says 'unknown' (never a guess). Pure data + lookups: no fetches, so a stored
// report gets this at serve time (shared/action-plan.js).
//
// Fields: domain, name, joinType (JOIN_TYPES), signUpUrl (where a business signs up, claims or enters;
// null when we didn't see one work), time (rough, or null), source, checked, note (internal, not shown),
// profiles: false for lists entered by submission (no profile page to look up by search).

export const JOIN_TYPES = Object.freeze([
  'free profile', 'free basic, paid upgrades', 'paid only', 'submission/award with fee', 'editorial — can’t apply', 'unknown',
]);

/** What the plan shows next to a site for each join type (null: nothing, we don't know). */
export const JOIN_LABELS = Object.freeze({
  'free profile': 'Free to join',
  'free basic, paid upgrades': 'Free basic profile',
  'paid only': 'Paid listing',
  'submission/award with fee': 'Entry fee',
  'editorial — can’t apply': 'Editorial: pitch the writer',
  unknown: null,
});

const CHECKED = '2026-10-02';
const row = (domain, name, joinType, signUpUrl, source, extra = {}) => Object.freeze({ domain, name, joinType, signUpUrl, time: null, source, checked: CHECKED, ...extra });

export const DIRECTORIES = Object.freeze([
  // Agencies and professional firms.
  row('clutch.co', 'Clutch', 'free basic, paid upgrades', 'https://vendor.clutch.co/profile/create/basic', 'https://clutch.co/get-listed', { note: 'Create a free profile; Verified tier is paid yearly' }),
  row('themanifest.com', 'The Manifest', 'free profile', 'https://clutch.co/get-listed', 'https://themanifest.com/get-listed', { note: 'Listed through a Clutch profile; no fee to be listed' }),
  row('goodfirms.co', 'GoodFirms', 'free basic, paid upgrades', 'https://www.goodfirms.co/get-listed', 'https://help.goodfirms.co/is-it-free-to-get-listed-on-goodfirms/', { time: '5–10 business days to be reviewed', note: 'Free to get listed; Pro and sponsor tiers paid' }),
  row('designrush.com', 'DesignRush', 'free basic, paid upgrades', 'https://www.designrush.com/submit/agency', 'https://www.designrush.com/submit/agency', { note: 'Free profile after review; sponsorship plans optional' }),
  row('upcity.com', 'UpCity', 'free basic, paid upgrades', null, 'https://upcity.com/profiles/salesupply', { note: 'Free partnership; paid certified/sponsor tiers' }),
  row('sortlist.com', 'Sortlist', 'free basic, paid upgrades', 'https://www.sortlist.com/providers', 'https://www.sortlist.com/providers/pricing', { note: 'Free plan, no card; Sortlist+ paid monthly' }),
  row('agencyspotter.com', 'Agency Spotter', 'free basic, paid upgrades', null, 'https://www.agencyspotter.com/pricing', { note: 'Free plan: profile and reviews; 2+ full-time staff' }),
  row('communicationsmatch.com', 'CommunicationsMatch', 'paid only', 'https://www.communicationsmatch.com/account/registration', 'https://www.communicationsmatch.com/', { note: 'Directory profiles paid monthly or yearly; free account is search only' }),
  row('publicrelationsdatabase.com', 'Public Relations Database', 'unknown', null, 'https://www.publicrelationsdatabase.com/', { note: 'Its pages show no way to get listed' }),
  row('odwyerpr.com', 'O’Dwyer’s', 'submission/award with fee', 'https://www.odwyerpr.com/pr_firm_rankings/Rank-Your-Firm-With-ODwyers-2026.pdf', 'https://www.odwyerpr.com/pr_firm_rankings/Rank-Your-Firm-With-ODwyers-2026.pdf', { profiles: false, time: 'Once a year (2026 deadline was March 16)', note: 'CPA-verified fee income; listing and processing fees' }),
  row('provokemedia.com', 'PRovoke Media', 'submission/award with fee', 'https://sabre.provokemedia.com/am/enter', 'https://sabre.provokemedia.com/am/fees', { profiles: false, time: 'Once a year', note: 'SABRE entries paid; Top 250 needs fee-income data' }),
  row('prweek.com', 'PRWeek', 'submission/award with fee', 'https://www.prweek.com/us/awards', 'https://www.prweek.com/article/1896580/prweek-launches-purpose-awards-2025', { profiles: false, note: 'Award entries are paid' }),
  // Local and home services.
  row('yelp.com', 'Yelp', 'free basic, paid upgrades', 'https://biz.yelp.com/claim', 'https://business.yelp.com/', { note: 'Free to be on Yelp; ads paid' }),
  row('bbb.org', 'BBB', 'free basic, paid upgrades', 'https://www.bbb.org/get-listed', 'https://www.bbb.org/get-listed', { note: 'Free business profile; accreditation paid' }),
  row('angi.com', 'Angi', 'free basic, paid upgrades', 'https://signup.angi.com/pro/join', 'https://signup.angi.com/pro', { note: 'Free to sign up; pays per lead' }),
  row('homeadvisor.com', 'HomeAdvisor', 'unknown', null, 'https://pro.homeadvisor.com/help/faqs/', { note: 'Pays per lead; a free basic listing not confirmed' }),
  row('thumbtack.com', 'Thumbtack', 'free basic, paid upgrades', 'https://www.thumbtack.com/pro', 'https://www.thumbtack.com/pro', { note: 'No charge to join; pays per lead' }),
  row('houzz.com', 'Houzz', 'unknown', 'https://pro.houzz.com/pro', 'https://pro.houzz.com/pro-learn/blog/how-to-create-a-free-houzz-business-account', { note: 'Its own pages disagree: free account vs pick a plan' }),
  row('yellowpages.com', 'Yellow Pages', 'free basic, paid upgrades', 'https://www.yellowpages.com/claim-your-listing', 'https://www.yellowpages.com/claim-your-listing', { note: 'Claim a free listing; ads paid' }),
  row('manta.com', 'Manta', 'free basic, paid upgrades', 'https://www.manta.com/business-listings/free-business-listing', 'https://www.manta.com/business-listings/free-business-listing', { note: 'Free listing; premium services paid' }),
  row('nextdoor.com', 'Nextdoor', 'free basic, paid upgrades', 'https://business.nextdoor.com/en-us/getting-started/business-page', 'https://business.nextdoor.com/', { note: 'Free business page; ads paid' }),
  row('business.google.com', 'Google Business Profile', 'free profile', 'https://business.google.com/create/new', 'https://business.google.com/us/business-profile/', { time: 'A few days for Google to verify you', note: 'Creating a Business Profile is free' }),
  row('bingplaces.com', 'Bing Places', 'free profile', 'https://www.bing.com/forbusiness/', 'https://www.bing.com/forbusiness/', { time: 'A few days if verified by postcard', note: 'List your business for free' }),
  row('businessconnect.apple.com', 'Apple Business Connect', 'free profile', 'https://businessconnect.apple.com/', 'https://www.apple.com/newsroom/2023/01/introducing-apple-business-connect/', { note: 'Claim and edit place cards for free' }),
  row('facebook.com', 'Facebook', 'free basic, paid upgrades', 'https://www.facebook.com/pages/creation/', 'https://www.facebook.com/business/help/473994396650734', { note: 'Pages are free; ads paid' }),
  // Lawyers, doctors, travel, weddings.
  row('avvo.com', 'Avvo', 'free basic, paid upgrades', 'https://www.avvo.com/claim-your-profile', 'https://www.avvo.com/for-lawyers/pricing', { note: 'Starter profile free; paid tiers' }),
  row('justia.com', 'Justia', 'free profile', 'https://lawyers.justia.com/lawyer-directory-listings', 'https://lawyers.justia.com/lawyer-directory-listings', { note: 'No fee for a full profile' }),
  row('healthgrades.com', 'Healthgrades', 'free profile', 'https://update.healthgrades.com/', 'https://resources.healthgrades.com/pro', { note: 'Every NPI provider has a free profile to claim' }),
  row('zocdoc.com', 'Zocdoc', 'free basic, paid upgrades', 'https://www.zocdoc.com/grow/sign-up', 'https://www.zocdoc.com/about/newpricing/', { note: 'No upfront fee; pays per new-patient booking' }),
  row('tripadvisor.com', 'Tripadvisor', 'free basic, paid upgrades', 'https://www.tripadvisor.com/Owners', 'https://www.tripadvisor.com/Owners', { note: 'Claiming is free; marketing products paid' }),
  row('theknot.com', 'The Knot', 'free basic, paid upgrades', 'https://www.theknot.com/vendors/home', 'https://www.theknotww.com/press-releases/the-knot-worldwide-announces-new-platform-features-to-drive-wedding-vendor-success', { note: 'Free storefront; advertising tiers paid' }),
]);

const BY_DOMAIN = new Map(DIRECTORIES.map((d) => [d.domain, d]));
// Other domains a directory is cited under.
const ALIASES = { 'angieslist.com': 'angi.com', 'pro.houzz.com': 'houzz.com', 'business.apple.com': 'businessconnect.apple.com', 'bing.com': 'bingplaces.com' };

/** directoryFor('www.clutch.co' | 'https://clutch.co/x') → the row, or null. Subdomains match their site. */
export function directoryFor(domainOrUrl) {
  let d = String(domainOrUrl || '').trim().toLowerCase();
  if (!d) return null;
  if (/^https?:\/\//.test(d)) { try { d = new URL(d).hostname; } catch { return null; } }
  d = d.replace(/^www\./, '');
  while (d.includes('.')) {
    const hit = BY_DOMAIN.get(ALIASES[d] || d);
    if (hit) return hit;
    d = d.slice(d.indexOf('.') + 1);
  }
  return null;
}

/** joinFor(domain) → { type, label, url, source } for the plan, or null when the site isn't in the table. */
export function joinFor(domain) {
  const r = directoryFor(domain);
  if (!r) return null;
  return { type: r.joinType, label: JOIN_LABELS[r.joinType] || null, url: r.signUpUrl || null, source: r.source };
}
