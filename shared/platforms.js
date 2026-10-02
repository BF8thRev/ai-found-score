// shared/platforms.js — how to do each website job on the builder the owner's site is made with.
//
// One place to update. Every entry was read on the builder's OWN help centre on CHECKED, and carries
// that page as `source`. A job we couldn't confirm there is simply not listed: the report and the Fix
// Kit then keep their generic steps for it. Accuracy over coverage; never fill a gap from memory.
//
// Jobs (the website work the action plan and the Fix Kit hand out):
//   title     the homepage's page title and meta description
//   headCode  code in the <head> (the business code, JSON-LD). `page`: the same for one page only
//   faq       a questions-and-answers section. `schema: true`: that block writes FAQ code itself
//   robots    robots.txt. `can: false`: the builder doesn't let anyone edit it
//   aiCrawlers a builder setting that blocks AI crawlers (steps say where it is, to check it's off)
//   llms      an llms.txt file. `auto: true`: the builder makes one itself
//   footer    phone and address in the footer
// Each entry: { steps, source, plan?, page?, schema?, can?, auto?, needs? }. `steps` is one line in the
// builder's own menu names, joined with →. `plan`: the plan a job needs, as the builder states it.
// `needs: 'yoast'`: only when the site runs Yoast SEO (shared/platform-detect.js reports it).
//
// platformFor(report) → { id, name, seo, jobs } | null      (the report's siteCheck.platform, if we have a playbook)
// platformJob(p, job) → the entry, or null                     (null: use the generic text)
// guideLinks(p, jobs) → [{ label, url }]                      ("Wix’s guide: page title", each source once)

export const CHECKED = '2026-10-02';

export const JOB_LABELS = Object.freeze({
  title: 'page title and description', headCode: 'adding code', faq: 'FAQ section', robots: 'robots.txt',
  aiCrawlers: 'AI crawler setting', llms: 'llms.txt', footer: 'footer',
});

const at = (o) => Object.freeze({ checked: CHECKED, ...o });

export const PLAYBOOKS = Object.freeze({
  wix: {
    name: 'Wix',
    help: 'https://support.wix.com/en',
    jobs: {
      title: at({
        steps: 'In the Editor, open Pages & Menu → click the More Actions icon next to your homepage → SEO basics → fill in “Title tag” and “Meta description” → Publish.',
        source: 'https://support.wix.com/en/article/adding-seo-title-tags-and-meta-descriptions-to-your-pages',
      }),
      headCode: at({
        steps: 'Dashboard → Settings → Custom Code → + Add Custom Code → paste the code → Place Code in: Head → choose your homepage → Apply.',
        page: 'Dashboard → Settings → Custom Code → + Add Custom Code → paste the code → Place Code in: Head → Choose specific pages → pick the page → Apply.',
        plan: 'Wix says the site must be published and have a connected domain.',
        source: 'https://support.wix.com/en/article/embedding-custom-code-on-your-site',
      }),
      faq: at({
        steps: 'In the Editor: Add Apps → search “FAQ” → Add to Site. Then click the app → Manage Questions → Add New, once per question.',
        schema: false,
        source: 'https://support.wix.com/en/article/the-wix-faq-app-an-overview',
      }),
      robots: at({
        steps: 'Dashboard → SEO & GEO → Tools and settings → Robots.txt Editor → View File → edit → Save Changes.',
        source: 'https://support.wix.com/en/article/editing-your-sites-robotstxt-file',
      }),
      llms: at({
        auto: true,
        steps: 'Wix makes and updates an llms.txt file for you (on a premium plan with a connected domain and search indexing on). To see it: Dashboard → SEO & GEO → Tools and settings → Go to llms.txt → View File. Editing it stops Wix’s automatic updates.',
        source: 'https://support.wix.com/en/article/understanding-your-sites-llmstxt-file',
      }),
      footer: at({
        steps: 'In the Editor: Add → Text → type your phone number and address → drag the text to the bottom of the page → Move To Footer → Publish. A phone number typed in a text box becomes tap-to-call.',
        source: 'https://support.wix.com/en/article/wix-editor-placing-elements-in-your-header-footer-and-page',
      }),
    },
  },

  squarespace: {
    name: 'Squarespace',
    help: 'https://support.squarespace.com/hc/en-us',
    jobs: {
      title: at({
        steps: 'Open the SEO/AI Visibility panel → SEO Settings → Search appearance → Home tab → set the title in “SEO Title Format” and the description in “SEO site description” → Save.',
        source: 'https://support.squarespace.com/hc/en-us/articles/206016198-Adding-SEO-descriptions',
      }),
      headCode: at({
        steps: 'Pages panel → the gear icon next to your homepage → Advanced → paste the code in “Page Header Code Injection” → Save.',
        page: 'Pages panel → the gear icon next to that page → Advanced → paste the code in “Page Header Code Injection” → Save.',
        plan: 'Squarespace says code injection is on the Core, Plus and Advanced plans (and some older plans).',
        source: 'https://support.squarespace.com/hc/en-us/articles/205815908-Using-code-injection',
      }),
      faq: at({
        steps: 'Edit the page → Add block → Accordion → click the pencil icon to type each question and its answer → Save.',
        schema: false,
        source: 'https://support.squarespace.com/hc/en-us/articles/4411581892749-Accordion-blocks',
      }),
      robots: at({
        can: false,
        steps: 'Squarespace doesn’t let anyone edit robots.txt: every Squarespace site uses the same one.',
        source: 'https://support.squarespace.com/hc/en-us/articles/206543207-Understanding-Google-SEO-emails-and-console-errors',
      }),
      aiCrawlers: at({
        steps: 'Settings → Crawlers → make sure “Block known artificial intelligence crawlers” is NOT ticked → Save.',
        source: 'https://support.squarespace.com/hc/en-us/articles/360022347072-Request-that-AI-models-exclude-your-site',
      }),
      llms: at({
        steps: 'Open the SEO/AI Visibility panel → SEO Settings → LLMS.txt tab → paste the text of llms.txt → Save. (Squarespace 7.1 sites.)',
        source: 'https://support.squarespace.com/hc/en-us/articles/47434125611277-Create-an-llms-txt-file',
      }),
      footer: at({
        steps: 'Click Edit on any page → hover over the footer → Edit footer → Add block → Text → type your phone number and address → Save.',
        source: 'https://support.squarespace.com/hc/en-us/articles/205816028-Edit-your-site-s-footer',
      }),
    },
  },

  'wordpress-com': {
    name: 'WordPress.com',
    help: 'https://wordpress.com/support/',
    jobs: {
      title: at({
        steps: 'Jetpack → Settings → Traffic → Search engine optimization → “Expand to edit your front page meta description” (and the page title structure in the same place) → Save settings.',
        plan: 'WordPress.com says this is on the Premium, Business and Commerce plans.',
        source: 'https://wordpress.com/support/seo/seo-tools/',
      }),
      headCode: at({
        steps: 'Plugins → install “Insert Headers and Footers” by WPCode → Code Snippets → Header & Footer → paste the code in the Header box → Save Changes.',
        plan: 'WordPress.com says this needs the Personal, Premium, Business or Commerce plan.',
        source: 'https://wordpress.com/support/adding-code-to-headers/',
      }),
      faq: at({
        steps: 'Pages → open the page → add an Accordion block → one item per question → Update.',
        schema: false,
        source: 'https://wordpress.com/support/wordpress-editor/blocks/accordion-block/',
      }),
      robots: at({
        steps: 'Edit it with a robots.txt plugin or your SEO plugin’s settings.',
        plan: 'WordPress.com says this needs a plugin-enabled site on the Personal, Premium, Business or Commerce plan.',
        source: 'https://wordpress.com/support/seo/seo-issues/#i-need-to-edit-my-robots-txt-file',
      }),
      aiCrawlers: at({
        steps: 'Settings → Reading → Site Visibility → make sure “Prevent third-party sharing” is NOT ticked (it adds AI crawlers to your robots.txt’s blocked list) → Save.',
        source: 'https://wordpress.com/support/privacy-settings/make-your-website-public/',
      }),
      llms: at({
        steps: 'Upload llms.txt to the top folder of your site by SFTP, or use an SEO plugin that makes one.',
        plan: 'WordPress.com says this is on the Business and Commerce plans.',
        source: 'https://wordpress.com/support/add-llms-txt-to-your-site/',
      }),
      footer: at({
        steps: 'Appearance → Editor → open the Footer template part (List View, or the Patterns tab) → add a Contact Info block with your phone and address → Save. Older themes: Appearance → Widgets → Footer area.',
        source: 'https://wordpress.com/support/edit-the-footer/',
      }),
    },
  },

  wordpress: {
    name: 'WordPress',
    help: 'https://wordpress.org/documentation/',
    jobs: {
      title: at({
        needs: 'yoast',
        steps: 'With Yoast SEO: Yoast SEO → Settings → Content types → Homepage → edit the SEO title and meta description → Save changes. If your homepage is a page, Yoast links you to that page; set them in its Yoast box.',
        source: 'https://yoast.com/help/optimizing-the-seo-title-and-meta-description-of-your-homepage/',
      }),
      faq: at({
        needs: 'yoast',
        steps: 'In the block editor, add Yoast’s “FAQ” block and type each question and answer. Yoast adds the FAQ code for you, so skip the FAQ code below.',
        schema: true,
        source: 'https://yoast.com/features/structured-data-blocks/faq-block/',
      }),
      robots: at({
        needs: 'yoast',
        steps: 'With Yoast SEO: Yoast SEO → Tools → File editor → Create robots.txt file (or edit the one there) → save.',
        source: 'https://yoast.com/help/how-to-edit-robots-txt-through-yoast-seo/',
      }),
      aiCrawlers: at({
        needs: 'yoast',
        steps: 'Yoast SEO → Settings → Advanced → Crawl optimization → make sure the “Block unwanted bots” switches for AI crawlers are off → Save changes.',
        source: 'https://yoast.com/help/block-unwanted-bots-with-yoast-seo/',
      }),
      llms: at({
        needs: 'yoast',
        auto: true,
        steps: 'Yoast SEO can make this file for you: Yoast SEO → Settings → Site Features → AI tools → LLMS.txt → switch it on → Save changes.',
        source: 'https://yoast.com/help/enable-llmstxt/',
      }),
      footer: at({
        steps: 'Block themes: Appearance → Editor → Patterns → Template Parts → Footer → edit → add a Paragraph block with your phone and address → Save.',
        source: 'https://wordpress.org/documentation/article/site-editor/',
      }),
    },
  },

  shopify: {
    name: 'Shopify',
    help: 'https://help.shopify.com/en',
    jobs: {
      title: at({
        steps: 'Shopify admin → Online Store → Preferences → enter the homepage title and meta description → Save.',
        source: 'https://help.shopify.com/en/manual/promoting-marketing/seo/adding-keywords',
      }),
      headCode: at({
        steps: 'Online Store → the … menu next to your theme → Edit code → open theme.liquid (Layout folder) → paste the code just before </head> → Save.',
        plan: 'Shopify says trial themes can’t be edited, and suggests duplicating your theme first.',
        source: 'https://help.shopify.com/en/manual/online-store/themes/customizing-themes/edit-code/edit-theme-code',
      }),
      faq: at({
        steps: 'Online Store → Edit theme → choose the page → Add section → pick a section with collapsible rows → one row per question (Add block) → Save.',
        source: 'https://help.shopify.com/en/manual/online-store/themes/theme-structure/sections-and-blocks',
      }),
      robots: at({
        steps: 'Online Store → the … menu next to your theme → Edit code → Add a new template → robots → Create template → edit robots.txt.liquid → Save.',
        plan: 'Shopify says this is an unsupported customization: its support team can’t help with it.',
        source: 'https://help.shopify.com/en/manual/promoting-marketing/seo/editing-robots-txt',
      }),
      llms: at({
        auto: true,
        steps: 'Shopify already serves an llms.txt for your store. To use ours instead: Online Store → the … menu next to your theme → Edit code → Add a new template → llms.txt → Create template → paste → Save.',
        source: 'https://help.shopify.com/en/manual/online-sales-channels/agentic-storefronts/products',
      }),
    },
  },

  godaddy: {
    name: 'GoDaddy Website Builder',
    help: 'https://www.godaddy.com/help/websites-marketing-1000041',
    jobs: {
      faq: at({
        steps: 'Websites + Marketing → Manage → Edit Website → hover where you want it → Add section → pick a layout → Add → type your questions and answers → Publish.',
        source: 'https://www.godaddy.com/help/add-a-section-to-my-websites-marketing-site-20119',
      }),
      footer: at({
        steps: 'Edit Website → click anywhere in the footer → Layout → pick a layout that shows your address and phone number → Publish. Your phone and address are kept in Settings → Basic Information.',
        source: 'https://www.godaddy.com/help/change-my-websites-marketing-sites-footer-26473',
      }),
    },
  },

  webflow: {
    name: 'Webflow',
    help: 'https://help.webflow.com/hc/en-us',
    jobs: {
      title: at({
        steps: 'Pages panel → Page settings on your Home page → SEO settings → fill in “Title tag” and “Meta description” → Publish.',
        plan: 'Webflow says this needs a paid Site plan or a paid Workspace.',
        source: 'https://help.webflow.com/hc/en-us/articles/33961237278611-Add-SEO-title-and-meta-description',
      }),
      headCode: at({
        steps: 'Pages panel → Page settings on your Home page → Custom code → paste the code in “Inside <head> tag” → Save → Publish.',
        page: 'Pages panel → Page settings on that page → Custom code → paste the code in “Inside <head> tag” → Save → Publish.',
        plan: 'Webflow says custom code needs a paid Site plan or a Core, Growth, Agency or Freelancer Workspace.',
        source: 'https://help.webflow.com/hc/en-us/articles/33961357265299-Custom-code-in-head-and-body-tags',
      }),
      robots: at({
        steps: 'Site settings → SEO → Indexing → add the robots.txt rules → Save changes → Publish.',
        plan: 'Webflow says this needs a Site plan or a paid Workspace.',
        source: 'https://help.webflow.com/hc/en-us/articles/41954080897683-Set-robots-txt-rules',
      }),
      aiCrawlers: at({
        steps: 'Site settings → SEO → Indexing → Traffic control → make sure AI bots are allowed → Save changes → Publish.',
        source: 'https://help.webflow.com/hc/en-us/articles/33961368603539-Disable-search-engine-indexing',
      }),
      llms: at({
        steps: 'Site settings → SEO → LLMs.txt → Upload file → Save changes → Publish. It goes live on your own domain.',
        source: 'https://help.webflow.com/hc/en-us/articles/43240104183315-Upload-an-llms-txt-file-to-your-site',
      }),
    },
  },

  square: {
    name: 'Square Online',
    help: 'https://squareup.com/help/us/en',
    jobs: {
      title: at({
        steps: 'Square Dashboard → Online → Website → SEO → Update SEO → enter the title and description → Save → publish.',
        source: 'https://squareup.com/help/us/en/article/6874-seo-settings-for-square-online-store',
      }),
      headCode: at({
        steps: 'Square Dashboard → Channels → Square Online → Settings → Tracking Tools → Add new code → name it and paste the code → choose head → Save → publish.',
        plan: 'Square says its support team can’t help with custom code.',
        source: 'https://squareup.com/help/us/en/article/6957-add-custom-tracking-code-to-your-website',
      }),
    },
  },

  weebly: {
    name: 'Weebly',
    help: 'https://www.weebly.com/app/help/us/en',
    jobs: {
      title: at({
        steps: 'Settings → General → Site Title for the title; Settings → SEO → Site Description for the description → Save → publish. Leave the Home page’s own SEO fields blank so it uses these.',
        source: 'https://www.weebly.com/app/help/us/en/topics/site-settings',
      }),
      headCode: at({
        steps: 'Settings → SEO → paste the code in “Header Code” → Save → publish.',
        source: 'https://www.weebly.com/app/help/us/en/topics/site-settings',
      }),
      robots: at({
        can: false,
        steps: 'Weebly makes your robots.txt for you and it can’t be edited. Check that Settings → SEO → “Hide site from search engines” is off.',
        source: 'https://www.weebly.com/app/help/us/en/topics/working-with-your-robots-txt-file',
      }),
      footer: at({
        steps: 'In the editor, click the footer → choose a layout → type your phone number and address → Save Footer → publish.',
        plan: 'Weebly says changing the footer needs a paid plan.',
        source: 'https://www.weebly.com/app/help/us/en/topics/how-do-i-remove-or-change-the-weebly-footer',
      }),
    },
  },

  duda: {
    name: 'Duda',
    help: 'https://support.duda.co/hc/en-us',
    jobs: {
      title: at({
        steps: 'Pages → the three-dot icon next to your homepage → Edit page SEO → “Page meta title” and “Page meta description” → republish.',
        source: 'https://support.duda.co/hc/en-us/articles/26519238639383-Single-Page-Management',
      }),
      headCode: at({
        steps: 'Pages → the gear icon on your homepage → SEO → paste the code in “Header HTML” → republish.',
        page: 'Pages → the gear icon on that page → SEO → paste the code in “Header HTML” → republish.',
        plan: 'Duda says custom code is on Team plans and higher.',
        source: 'https://support.duda.co/hc/en-us/articles/26519964391447-Schema-Markup',
      }),
      faq: at({
        steps: 'Add an Accordion widget, one item per question → right-click it → Edit Content → SEO → turn on “Enable FAQ Schema”. Duda then writes the FAQ code for you, so skip the FAQ code below.',
        schema: true,
        source: 'https://support.duda.co/hc/en-us/articles/26519267522711-Widgets-Accordion',
      }),
      robots: at({
        steps: 'More → Settings → URL Redirect → Add New Redirect → Source URL “robots.txt” → File → + Upload file → Redirect type “2xx OK” → Add → republish.',
        source: 'https://support.duda.co/hc/en-us/articles/26519937500055-Site-Configuration-Files',
      }),
      llms: at({
        auto: true,
        steps: 'Duda makes and updates an llms.txt file for every published site, so you don’t need ours.',
        source: 'https://support.duda.co/hc/en-us/articles/26519937500055-Site-Configuration-Files',
      }),
      footer: at({
        steps: 'CMS → Business Data → Business Info: enter your phone and address. Then right-click a text widget in the footer → Connect to Data → pick the field → Done → republish.',
        source: 'https://support.duda.co/hc/en-us/articles/26519939695767-Dynamic-Content-Business-Info-Text-and-Images',
      }),
    },
  },

  hubspot: {
    name: 'HubSpot',
    help: 'https://knowledge.hubspot.com',
    jobs: {
      title: at({
        steps: 'Open your homepage in the page editor → Settings → General → “Page title” and “Meta description” → update the page.',
        source: 'https://knowledge.hubspot.com/website-and-landing-pages/create-and-customize-pages',
      }),
      headCode: at({
        steps: 'Open your homepage in the page editor → Settings → Advanced → Additional code snippets → paste the code in “Head HTML” → update the page.',
        page: 'Open that page in the page editor → Settings → Advanced → Additional code snippets → paste the code in “Head HTML” → update the page.',
        source: 'https://knowledge.hubspot.com/website-and-landing-pages/use-code-snippets-with-hubspot-content',
      }),
      robots: at({
        steps: 'The settings icon → Content → Pages → choose your domain → SEO & Crawlers tab → Robots.txt → edit → Save.',
        source: 'https://knowledge.hubspot.com/cos-general/customize-your-robots-txt-file',
      }),
      llms: at({
        can: false,
        steps: 'HubSpot doesn’t let you put a file like llms.txt at the top of your domain (it says such a file must be hosted elsewhere), so skip this one.',
        source: 'https://knowledge.hubspot.com/files/supported-file-types',
      }),
      footer: at({
        steps: 'Open any page → click the footer → Open in global content editor → add your phone number and address → Publish.',
        plan: 'HubSpot says this needs the “Global content and theme settings” permission.',
        source: 'https://knowledge.hubspot.com/design-manager/use-global-content-across-multiple-templates',
      }),
    },
  },

  framer: {
    name: 'Framer',
    help: 'https://www.framer.com/help/',
    jobs: {
      title: at({
        steps: 'Site Settings → Page Settings → choose your Home page → “Title” and “Page Description” → Save → publish.',
        source: 'https://www.framer.com/help/articles/how-to-update-page-titles-descriptions-and-social-images/',
      }),
      headCode: at({
        steps: 'Site Settings → Custom Code → Add Script → name it, paste the code, place it in the head and pick your Home page → Save → publish.',
        page: 'Site Settings → Custom Code → Add Script → name it, paste the code, place it in the head and pick that page → Save → publish.',
        source: 'https://www.framer.com/help/articles/how-to-add-custom-code/',
      }),
      robots: at({
        steps: 'In your project dashboard, Files tab → upload your robots.txt at the path / → publish.',
        plan: 'Framer says this is on the Pro and Enterprise plans.',
        source: 'https://www.framer.com/help/articles/how-can-i-access-the-robots-txt-file/',
      }),
      llms: at({
        steps: 'Site Settings → Hosting → Files → Add → upload llms.txt with the path /llms.txt → publish.',
        plan: 'Framer says this is on the Pro and Enterprise plans.',
        source: 'https://www.framer.com/help/articles/llms-txt-framer/',
      }),
    },
  },

  'google-sites': {
    name: 'Google Sites',
    help: 'https://support.google.com/sites',
    jobs: {
      headCode: at({
        can: false,
        steps: 'Google’s help for Sites shows no way to add code to a page’s <head> (only “Embed code” inside the page), so the business code can’t go on a Google Site. Your phone and address as plain text in the footer still help.',
        source: 'https://support.google.com/sites/answer/90569?hl=en',
      }),
      faq: at({
        steps: 'Insert → Collapsible text → one per question: the question as the heading, the answer as the text → Publish.',
        schema: false,
        source: 'https://support.google.com/sites/answer/90538?hl=en',
      }),
      robots: at({
        can: false,
        steps: 'Google’s help for Sites shows no robots.txt editor. Check the arrow next to Publish → Publish settings: “Request public search engines to not display my site” must be off.',
        source: 'https://support.google.com/sites/answer/6372880?hl=en',
      }),
      footer: at({
        steps: 'Point to the bottom of a page → Add footer (or Edit footer) → type your phone number and address → Publish.',
        source: 'https://support.google.com/sites/answer/98216?hl=en',
      }),
    },
  },
});

/** The playbook for the report's site builder (siteCheck.platform), or null when unknown. */
export function platformFor(report) {
  const p = report && report.siteCheck && report.siteCheck.platform;
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !Object.hasOwn(PLAYBOOKS, p.id)) return null;
  const book = PLAYBOOKS[p.id];
  return { id: p.id, name: book.name, seo: typeof p.seo === 'string' ? p.seo : null, help: book.help, jobs: book.jobs };
}

/** One job's entry for this builder, or null (then the generic step stays). */
export function platformJob(p, job) {
  const e = p && p.jobs && p.jobs[job];
  if (!e) return null;
  if (e.needs && e.needs !== p.seo) return null;
  return e;
}

/** "In Wix: …" plus the plan note, as one step line. */
export function platformStep(p, e, { page = false } = {}) {
  return `In ${p.name}: ${page && e.page ? e.page : e.steps}${e.plan ? ` ${e.plan}` : ''}`;
}

/** The builder's own guides for these jobs: [{ label, url }], each page once. */
export function guideLinks(p, jobs) {
  const out = [];
  for (const j of jobs) {
    const e = platformJob(p, j);
    if (!e || out.some((x) => x.url === e.source)) continue;
    out.push({ label: `${p.name}’s guide: ${JOB_LABELS[j] || j}`, url: e.source });
  }
  return out;
}
