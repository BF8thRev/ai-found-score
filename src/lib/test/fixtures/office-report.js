// A paid report for an office business (a PR agency), shaped like a real one from Oct 1 2026 but with
// made-up names: the business, its rivals and their websites are fictional. The directories and
// rankings AI cited (clutch.co, themanifest.com, odwyerpr.com) are real public sites.
// Its stored fixes are the ones scanned before Oct 2 2026: one per lost question, storefront and
// "open now" advice, and a "doesn't say what you do" that missed "PR & Media Relations".

const NAMES = { e1: 'Brightline Communications', e2: 'Kestrel PR', e3: 'Clutch', e4: 'Monarch Media Group' };

function answer(id, questionId, intent, engine, ids, citations = []) {
  let text = 'Here are some options. ';
  const businessesNamed = ids.map((eid) => {
    const pos = text.length + 2; // after the "**"
    text += `**${NAMES[eid]}** is well known. `;
    return { pos, name: NAMES[eid], entityId: eid };
  });
  return { id, run: 1, text, engine, intent, askedAt: '2026-10-01T17:49:20.000Z', namedYou: false, namedYouFirst: false, questionId, citations, businessesNamed };
}

export function officeReport() {
  const cite = (url) => ({ url, domain: new URL(url).hostname.replace(/^www\./, '') });
  const answers = [
    answer('a1', 'q1', 'best', 'chatgpt', ['e1', 'e2', 'e3'], [cite('https://clutch.co/pr-firms/new-york'), cite('https://themanifest.com/public-relations/agencies/new-york'), cite('https://www.publicnow.com/view/123')]),
    answer('a2', 'q1', 'best', 'gemini', ['e1', 'e4', 'e2'], [cite('https://www.odwyerpr.com/pr_firm_rankings/newyork.htm'), cite('https://www.brightlinecommunications.example.com/offices')]),
    answer('a3', 'q2', 'urgent', 'chatgpt', ['e4'], []),
    answer('a4', 'q2', 'urgent', 'gemini', ['e1', 'e4'], [cite('https://4dayweek.io/company/kestrel')]),
    answer('a5', 'q3', 'job', 'gemini', ['e2', 'e3'], [cite('https://kestrelpr.example.com/careers')]),
    answer('a6', 'q3', 'job', 'claude', ['e1'], []),
  ];
  const entity = (id) => {
    const ids = answers.filter((a) => a.businessesNamed.some((b) => b.entityId === id)).map((a) => a.id);
    return { id, name: NAMES[id], first: 0, isYou: false, named: ids.length, aliases: [], answerIds: ids, phone: null, address: null };
  };
  const source = (url, citedIn) => ({ url, domain: new URL(url).hostname.replace(/^www\./, ''), citedIn, topListed: null, youListed: null, youPosition: null });
  const q = (id, text, intent) => ({ id, text, intent });
  const lost = (text, engines, names) => ({
    kind: 'lost_question', severity: 'medium',
    title: `Not named when asked "${text}"`,
    description: `${engines} answered without naming you and named 4 other businesses, including ${names}.`,
    steps: [
      `Add a short question-and-answer section to your website (an FAQ, or the bottom of your homepage) that answers "${text}" using the text below.`,
      'Edit the answer so everything in it is true today. Keep your name, address and phone written exactly as they are.',
      'Put the same facts in your Google Business Profile (description and services), so your website and your profile say the same thing.',
      'Make sure your hours match on your website, Google and every listing you control.',
    ],
    copyText: [{ label: 'Website FAQ: question and answer', text: `${text}\nHarbor Lane PR is a pr agency in New York City, NY.` }],
  });
  return {
    id: 'office-test-token',
    version: 2,
    locked: false,
    generatedAt: '2026-10-01T17:51:00.000Z',
    business: { zip: '10001', name: 'Harbor Lane PR', town: 'New York City', phone: null, state: 'NY', trade: 'pr agency', address: null, website: 'https://www.harborlanepr.example.com/' },
    questions: [
      q('q1', "What's the best pr agency in New York City, NY?", 'best'),
      q('q2', 'Pr agency open now near New York City NY', 'urgent'),
      q('q3', 'Can you recommend a pr agency in New York City NY?', 'job'),
    ],
    answers,
    entities: ['e1', 'e2', 'e3', 'e4'].map(entity),
    sources: [
      source('https://clutch.co/pr-firms/new-york', ['a1']),
      source('https://themanifest.com/public-relations/agencies/new-york', ['a1']),
      source('https://www.publicnow.com/view/123', ['a1']),
      source('https://www.odwyerpr.com/pr_firm_rankings/newyork.htm', ['a2']),
      source('https://www.communicationsmatch.com/company/brightline-communications', ['a2']),
      source('https://www.brightlinecommunications.example.com/offices', ['a2']),
      source('https://4dayweek.io/company/kestrel', ['a4']),
      source('https://kestrelpr.example.com/careers', ['a5']),
    ],
    aiFacts: [],
    listings: [{ fields: {}, status: 'mismatch', details: "We couldn't find a Google Maps listing for Harbor Lane PR near New York City.", platform: 'Google' }],
    reviews: null,
    totals: { answers: 6, firstYou: 0, namedYou: 0 },
    headline: { rule: 'most_others_named_not_you', answerId: 'a2' },
    method: { runs: 1, engines: { chatgpt: { model: 'gpt-5-mini' }, gemini: { model: 'gemini-3.8-flash' }, claude: { model: 'claude-sonnet-5' } }, enginesFailed: [], failedCalls: [] },
    ownerDescriptors: [],
    siteCheck: {
      url: 'https://www.harborlanepr.example.com',
      reachable: true,
      meta: {
        title: 'Integrated Communications, PR & Media Relations | HarborLane',
        description: "Harbor Lane's integrated communications team specializes in public relations & media relations to help brands build trust.",
        h1: 'Empowering Brands to Engage Audiences and Inspire Trust',
        mentionsTrade: false,
        mentionsTown: false,
      },
      https: { loads: true, redirects: true },
      pages: { townPages: 0, servicePages: 1, internalLinks: 7 },
      onSite: { phone: '', address: '' },
      robots: { found: false, blocked: [] },
      schema: { found: false, types: [] },
      llmsTxt: false, sitemap: true, faqSchema: false,
    },
    issues: [
      { kind: 'google_missing', severity: 'high', title: 'We couldn’t find you on Google Maps', description: "We couldn't find a Google Maps listing for Harbor Lane PR near New York City. AI assistants lean on Google Maps for local answers.", steps: ['Search Google Maps for "Harbor Lane PR New York City".'], copyText: [] },
      lost("What's the best pr agency in New York City, NY?", 'ChatGPT and Gemini', 'Brightline Communications and Kestrel PR'),
      lost('Pr agency open now near New York City NY', 'ChatGPT and Gemini', 'Monarch Media Group'),
      lost('Can you recommend a pr agency in New York City NY?', 'Gemini and Claude', 'Kestrel PR'),
      { kind: 'site_missing_nap', severity: 'medium', title: "Your website doesn't show your phone number or street address where AI can read it", description: 'We read the homepage and found no phone or address.', steps: ['Add your phone number and street address as plain text in the footer of every page.'], copyText: [] },
      { kind: 'site_title_meta', severity: 'medium', title: 'Your homepage title and heading don’t say what you do and where you work', description: "Your homepage's title, meta description and main heading don't say what you do and where you work.", steps: ['Set the page title to the suggested title below.'], copyText: [{ label: 'Suggested page title', text: 'Harbor Lane PR | Pr agency in New York City, NY' }] },
      { kind: 'site_no_llms_txt', severity: 'low', title: 'Your website has no llms.txt file', description: 'llms.txt is a newer, optional plain-text file for AI tools.', steps: ['Save it as llms.txt at the top level of your site.'], copyText: [{ label: 'llms.txt', text: '# Harbor Lane PR\n\n> Harbor Lane PR is a pr agency serving New York City, NY.' }] },
      { kind: 'site_no_faq_schema', severity: 'low', title: 'Your website has no FAQ schema', description: 'We found no FAQ schema on your homepage.', steps: ['Add the code below.'], copyText: [{ label: 'FAQPage schema (JSON-LD)', text: '{}', format: 'code' }] },
      { kind: 'site_thin_pages', severity: 'low', title: 'Your homepage doesn’t link to pages about the towns you serve', description: 'None of your pages is about the towns you serve.', steps: ['Make a "Service area" page.'], copyText: [] },
      { kind: 'baseline_gbp', severity: 'low', title: 'Make your Google Business Profile complete and consistent', description: 'Check your profile.', steps: ['Add your opening hours, the same as on your website.', 'Add a few recent photos of your storefront and your work.'], copyText: [{ label: 'Google Business Profile description', text: 'Harbor Lane PR is a pr agency in New York City, NY.' }] },
      { kind: 'baseline_schema', severity: 'low', title: 'Add or check LocalBusiness schema on your website', description: 'Schema states your name and address.', steps: ['Test your homepage.'], copyText: [{ label: 'LocalBusiness schema (JSON-LD)', text: '<script type="application/ld+json">\n{"@type":"LocalBusiness","name":"Harbor Lane PR"}\n</script>', format: 'code' }] },
      { kind: 'baseline_faq', severity: 'low', title: 'Answer the 3 questions we asked AI on your website', description: 'These are the searches we ran.', steps: ['Add a "Questions" section.'], copyText: [{ label: 'Website questions and answers', text: 'x' }] },
    ],
  };
}
