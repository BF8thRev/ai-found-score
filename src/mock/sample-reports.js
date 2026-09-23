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
      'Two inputs: whether AI assistants name you when locals ask, and whether your name, phone, and hours match across five listing sites. 80 or above is strong.',
    aiResults: [
      {
        assistant: 'ChatGPT',
        named: false,
        quote:
          '“Here are a few well-reviewed plumbers near Massapequa: Roto-Rooter of Massapequa, Parkside Plumbing, and All Island Plumbing.”',
        note: 'Named three other companies. Not Harborview.',
      },
      {
        assistant: 'Google Gemini',
        named: true,
        quote:
          '“Harborview Plumbing & Heating on Merrick Road is one option — customers mention fast emergency response.”',
        note: 'Named you, with the street but not the full address.',
      },
      {
        assistant: 'Claude',
        named: false,
        quote:
          '“I don’t have real-time business listings, but established options in the Massapequa area include …”',
        note: 'Gave general names only. Not Harborview.',
      },
      {
        assistant: 'Microsoft Copilot',
        named: false,
        quote:
          '“Top-rated plumbers near you: Benjamin Franklin Plumbing, Mr. Rooter, and Parkside Plumbing.”',
        note: 'Named three other companies. Not Harborview.',
      },
    ],
    listings: [
      {
        platform: 'Google',
        status: 'match',
        details: 'Name, phone, address, hours, and website all match.',
        fields: { name: 'Harborview Plumbing & Heating', phone: '(516) 555-0148', hours: 'Mon–Fri 8am–6pm, Sat 9am–2pm' },
      },
      {
        platform: 'Apple',
        status: 'match',
        details: 'Name, phone, and address all match.',
        fields: { name: 'Harborview Plumbing & Heating', phone: '(516) 555-0148', hours: 'Mon–Fri 8am–6pm' },
      },
      {
        platform: 'Bing',
        status: 'mismatch',
        details: 'Bing shows (516) 555-0119. That line is disconnected. Your other listings show (516) 555-0148.',
        fields: { name: 'Harborview Plumbing & Heating', phone: '(516) 555-0119', hours: 'Not listed' },
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
        details: 'Facebook shows Sunday hours. Google and Yelp show Mon–Sat only.',
        fields: { name: 'Harborview Plumbing', phone: '(516) 555-0148', hours: 'Mon–Sun 8am–8pm' },
      },
    ],
    issues: [
      {
        severity: 'high',
        title: 'Three of four AI assistants didn’t name you',
        description:
          'Asked for a plumber near Massapequa, ChatGPT, Claude, and Copilot named other companies. Gemini named you.',
      },
      {
        severity: 'high',
        title: 'Bing lists a disconnected number',
        description:
          'Bing shows (516) 555-0119. That line is disconnected. Every other listing shows (516) 555-0148.',
      },
      {
        severity: 'medium',
        title: 'Facebook shows old Sunday hours',
        description:
          'Facebook says Mon–Sun 8am–8pm. Google and Yelp say Mon–Fri 8am–6pm, Sat 9am–2pm.',
      },
      {
        severity: 'low',
        title: 'Name differs on Facebook',
        description:
          'Facebook says “Harborview Plumbing.” Everywhere else says “Harborview Plumbing & Heating.” Matching names help platforms link your listings.',
      },
    ],
    summary:
      'Google, Apple, and Yelp are correct. Bing shows a disconnected number. Facebook hours are out of date. One of four AI assistants named you. The Bing and Facebook fixes take about 20 minutes and cost nothing. Getting named by AI takes more work. That is what the paid plans cover.',
  },
};
