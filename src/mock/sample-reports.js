// Mock report data. Same JSON shape the /api/report/[id] endpoint returns.
// Real scan data will replace this object-for-object when Supabase is wired.

export const MOCK_REPORTS = {
  'sample-001': {
    id: 'sample-001',
    generatedAt: '2026-09-23',
    sample: true,
    business: {
      name: 'Harborview Plumbing & Heating',
      trade: 'Plumbing & HVAC',
      phone: '(516) 555-0148',
      website: 'harborviewplumbing.example.com',
      address: '4820 Merrick Road',
      city: 'Massapequa',
      state: 'NY',
      zip: '11758',
      county: 'Nassau',
    },
    score: 62,
    scoreLabel: 'Needs attention',
    scoreExplanation:
      'Your score is based on two things: whether AI assistants mention your business when local customers ask, and whether your name, phone, and hours agree across the five big listing sites. Higher is better — 80 or above means customers can find you easily.',
    aiResults: [
      {
        assistant: 'ChatGPT',
        named: false,
        quote:
          '“Here are a few well-reviewed plumbers near Massapequa: Roto-Rooter of Massapequa, Parkside Plumbing, and All Island Plumbing.”',
        note: 'Harborview was not mentioned. The assistants named three competitors instead.',
      },
      {
        assistant: 'Google Gemini',
        named: true,
        quote:
          '“Harborview Plumbing & Heating on Merrick Road is one option — customers mention fast emergency response.”',
        note: 'Mentioned by name, with the street but not the full address.',
      },
      {
        assistant: 'Claude',
        named: false,
        quote:
          '“I don’t have real-time business listings, but established options in the Massapequa area include …”',
        note: 'Gave only general names. Harborview was not mentioned.',
      },
      {
        assistant: 'Microsoft Copilot',
        named: false,
        quote:
          '“Top-rated plumbers near you: Benjamin Franklin Plumbing, Mr. Rooter, and Parkside Plumbing.”',
        note: 'Harborview was not mentioned.',
      },
    ],
    listings: [
      {
        platform: 'Google',
        status: 'match',
        details: 'Name, phone, address, hours, and website all agree with your business.',
        fields: { name: 'Harborview Plumbing & Heating', phone: '(516) 555-0148', hours: 'Mon–Fri 8am–6pm, Sat 9am–2pm' },
      },
      {
        platform: 'Apple',
        status: 'match',
        details: 'Name, phone, and address all agree with your business.',
        fields: { name: 'Harborview Plumbing & Heating', phone: '(516) 555-0148', hours: 'Mon–Fri 8am–6pm' },
      },
      {
        platform: 'Bing',
        status: 'mismatch',
        details: 'The phone number on Bing is an old one: (516) 555-0119. Customers calling it reach a disconnected line.',
        fields: { name: 'Harborview Plumbing & Heating', phone: '(516) 555-0119', hours: 'Not listed' },
      },
      {
        platform: 'Yelp',
        status: 'match',
        details: 'Name, phone, and address all agree with your business.',
        fields: { name: 'Harborview Plumbing & Heating', phone: '(516) 555-0148', hours: 'Mon–Fri 8am–6pm, Sat 9am–2pm' },
      },
      {
        platform: 'Facebook',
        status: 'mismatch',
        details: 'The hours on Facebook are outdated — it still shows Sunday hours from before you changed them in 2024.',
        fields: { name: 'Harborview Plumbing', phone: '(516) 555-0148', hours: 'Mon–Sun 8am–8pm' },
      },
    ],
    issues: [
      {
        severity: 'high',
        title: 'AI assistants are not recommending you',
        description:
          'Three out of four AI assistants did not mention Harborview when asked for a plumber near Massapequa. They recommended competitors instead. When customers ask an AI for a plumber, your name is not coming up.',
      },
      {
        severity: 'high',
        title: 'Bing shows an old, disconnected phone number',
        description:
          'Bing lists (516) 555-0119. That number is disconnected, so any customer who finds you on Bing and calls is lost.',
      },
      {
        severity: 'medium',
        title: 'Facebook shows old Sunday hours',
        description:
          'Your Facebook page still says you are open Sundays. You stopped Sunday hours in 2024. Customers who show up on a Sunday will find you closed.',
      },
      {
        severity: 'low',
        title: 'Business name is slightly different on Facebook',
        description:
          'Facebook says “Harborview Plumbing” instead of “Harborview Plumbing & Heating”. Small differences like this make it harder for search engines to trust that all these listings are the same business.',
      },
    ],
    summary:
      'Harborview Plumbing & Heating is easy to find on Google, Apple, and Yelp — but Bing is sending callers to a dead number, Facebook hours are two years out of date, and three out of four AI assistants recommend your competitors instead of you. Fixing the Bing number and the Facebook hours takes about 20 minutes and costs nothing. Getting AI assistants to mention you takes more work — that is what the paid plans are for.',
  },
};
