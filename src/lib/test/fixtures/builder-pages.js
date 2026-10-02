// Homepages trimmed from what each site builder really serves (shared/platform-detect.js tests).
export const page = (head, body = '<p>Hello</p>') => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Acme</title>${head}</head><body>${body}</body></html>`;

export const HTML = {
  wix: page('<meta name="generator" content="Wix.com Website Builder"/><link rel="preconnect" href="https://static.parastorage.com">',
    '<img src="https://static.wixstatic.com/media/11062b_abc~mv2.jpg/v1/fill/w_980,h_400/11062b_abc~mv2.jpg">'),
  squarespace: page('<!-- This is Squarespace. --><!-- acme-plumbing -->\n<script>Static.SQUARESPACE_CONTEXT = {"website":{"id":"5f1"}};</script>',
    '<img src="https://images.squarespace-cdn.com/content/v1/5f1/abc/van.jpg"><script src="https://static1.squarespace.com/static/vta/5c5a/scripts/site-bundle.js"></script>'),
  wordpress: page('<meta name="generator" content="WordPress 6.6.2" /><link rel="https://api.w.org/" href="https://acme.com/wp-json/" /><link rel="stylesheet" href="https://acme.com/wp-content/themes/astra/style.css?ver=4.8" />',
    '<script src="https://acme.com/wp-includes/js/jquery/jquery.min.js"></script>'),
  wordpressNoGenerator: page('<link rel="stylesheet" href="/wp-content/themes/kadence/assets/css/global.min.css" />', '<script src="/wp-includes/js/wp-emoji-release.min.js"></script>'),
  wordpressCom: page('<meta name="generator" content="WordPress.com" /><link rel="https://api.w.org/" href="https://acme.com/wp-json/" /><link rel="dns-prefetch" href="//s0.wp.com" />',
    '<img src="https://acme.com/wp-content/uploads/2026/01/van.jpg">'),
  shopify: page('<script>var Shopify = Shopify || {};\nShopify.shop = "acme.myshopify.com";\nShopify.theme = {"name":"Dawn","id":1};</script><link href="//acme.com/cdn/shop/t/2/assets/base.css?v=1" rel="stylesheet">',
    '<img src="//cdn.shopify.com/s/files/1/0001/files/logo.png">'),
  godaddy: page('<meta name="generator" content="Starfield Technologies; Go Daddy Website Builder 8.0.0000"/>',
    '<img src="//img1.wsimg.com/isteam/ip/3f1e/van.jpg/:/rs=w:1200">'),
  webflow: '<!DOCTYPE html><html data-wf-domain="www.acme.com" data-wf-page="65a" data-wf-site="65b"><head><meta name="generator" content="Webflow"/><link href="https://cdn.prod.website-files.com/65b/css/acme.webflow.css" rel="stylesheet"></head><body></body></html>',
  square: page('<link rel="preconnect" href="https://cdn5.editmysite.com">', '<script src="https://cdn5.editmysite.com/app/website/js/runtime.js"></script>'),
  duda: page('<link rel="preconnect" href="https://irp.cdn-website.com">', '<div id="dmRoot"><img src="https://lirp.cdn-website.com/abc/dms3rep/multi/opt/van-1920w.jpg"></div>'),
  hubspot: page('<meta name="generator" content="HubSpot">', '<img src="https://123.fs1.hubspotusercontent-na1.net/hubfs/123/logo.png">'),
  framer: page('<meta name="generator" content="Framer 3c4e8f1">', '<div data-framer-hydrate-v2="{}"><img src="https://framerusercontent.com/images/abc.jpg"></div>'),
  googleSites: page('<link rel="stylesheet" href="https://www.gstatic.com/atari/css/v1/site.css">'),
  plain: page('<link rel="stylesheet" href="/css/site.css">', '<p>Hand-built site</p>'),
};

