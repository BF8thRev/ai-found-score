// public/js/fix-kit.js — the Fix Kit page (/fix-kit/<token>, public/fix-kit.html).
//
// The kit is already built when the page opens: GET /api/fix-kit/<token> answers { paid, confirmed,
// sample, plan, details, kit, problems } where kit (src/lib/fix-kit-route.js kitView) holds the jobs
// left for this business with each file's contents, what's already done, the FAQ and the details we're
// missing. The page shows the key details to check, the FAQ answers that need one detail from the
// owner, and every file. "Edit details" and "Add to my answers" POST { preview: true, details } and
// redraw the rebuilt kit (nothing is saved). "Download my Fix Kit" needs the ownership tick: it POSTs
// { confirm: true, details } (saved) and then opens /api/fix-kit/<token>.zip.
// Plain script, no build step, no dependencies. Everything from the server is set as text, never HTML.

(function () {
  var token = decodeURIComponent(location.pathname.replace(/^\/fix-kit\//, '').replace(/\/+$/, ''));
  var api = '/api/fix-kit/' + encodeURIComponent(token);
  var states = document.querySelectorAll('[data-state]');
  var form = document.querySelector('.fk-form');
  var LIST_FIELDS = ['services', 'serviceTowns'];
  var TEXT_FIELDS = ['name', 'trade', 'phone', 'website', 'street', 'town', 'state', 'zip', 'hours', 'price', 'description', 'googleMapsUrl', 'googleReviewUrl'];
  var current = null; // the details the kit on screen was built from
  var lastKit = null; // the kit on screen
  var suggestions = null; // AI drafts for the blanks: { slots: { type: { sentence, quote } }, services: [{ name, quote }] }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function show(name) {
    states.forEach(function (s) { s.hidden = s.getAttribute('data-state') !== name; });
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function copy(o) { return JSON.parse(JSON.stringify(o || {})); }

  // ---- the details form (opened by "Edit details") ----
  function fill(d) {
    TEXT_FIELDS.forEach(function (f) { if (form.elements[f]) form.elements[f].value = d[f] || ''; });
    LIST_FIELDS.forEach(function (f) { form.elements[f].value = (d[f] || []).join('\n'); });
    count();
  }
  function read() {
    var d = copy(current);
    TEXT_FIELDS.forEach(function (f) { if (form.elements[f]) d[f] = form.elements[f].value; });
    LIST_FIELDS.forEach(function (f) { d[f] = form.elements[f].value.split(/\r?\n/); });
    return d;
  }
  function count() {
    var n = $('[data-count]');
    if (n) n.textContent = String(form.elements.description.value.length);
  }
  function clearErrors() {
    document.querySelectorAll('.fk-field').forEach(function (f) {
      f.classList.remove('has-error');
      var e = f.querySelector('.fk-err');
      if (e) e.textContent = '';
    });
  }
  function showErrors(errors) {
    var first = null;
    errors.forEach(function (err) {
      var f = document.querySelector('.fk-field[data-field="' + err.field + '"]');
      if (!f) return;
      // A field behind "Show all N" is opened so the note and the focus land on something visible.
      for (var d = f.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) d.open = true;
      f.classList.add('has-error');
      var e = f.querySelector('.fk-err');
      if (e && !e.textContent) e.textContent = err.message;
      if (!first) first = f;
    });
    if (first) {
      first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      var input = first.querySelector('input, textarea');
      if (input) input.focus({ preventScroll: true });
    }
    return first;
  }
  function setStatus(node, text, kind) {
    node.textContent = text;
    node.className = 'fk-status' + (kind ? ' ' + kind : '');
  }
  function openForm(open) {
    form.hidden = !open;
    $('[data-edit]').hidden = open;
    if (open) { fill(current); form.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }

  // ---- drawing the kit ----
  function addressText(d) {
    var place = [d.town, d.state].filter(Boolean).join(', ');
    if (d.street) return [d.street, place].filter(Boolean).join(', ') + (d.zip ? ' ' + d.zip : '');
    return place;
  }

  function drawFacts(d, kit) {
    var list = $('[data-facts]');
    list.textContent = '';
    var missing = {};
    (kit.missing || []).forEach(function (m) { missing[m.field] = m; });
    // Details to look at (the name written two ways): shown under the value.
    var notes = {};
    (kit.notes || []).forEach(function (n) { if (n && n.field && n.note) notes[n.field] = n; });
    var towns = (d.serviceTowns || []).filter(function (t) { return t && t.toLowerCase() !== String(d.town || '').toLowerCase(); });
    var rows = [
      ['name', 'Business name', d.name],
      ['phone', 'Phone', d.phone],
      ['website', 'Website', d.website],
      ['street', d.street ? 'Address' : 'Where you are', addressText(d) + (towns.length ? ' (also serving ' + towns.join(', ') + ')' : ''), d.street ? '' : 'No street address: fine if customers don’t visit you.'],
      ['services', 'Services', (d.services || []).join(', ')],
      ['description', 'Description', d.description],
    ];
    rows.forEach(function (r) {
      var li = el('li');
      li.appendChild(el('span', 'k', r[1]));
      var v = el('span', 'v');
      var m = missing[r[0]];
      if (m || !r[2]) {
        v.appendChild(el('span', 'fk-miss', 'Missing — add it'));
        if (m) v.appendChild(el('span', 'note', m.note));
      } else {
        v.appendChild(document.createTextNode(r[2]));
        if (r[3]) v.appendChild(el('span', 'note', r[3]));
        if (notes[r[0]]) v.appendChild(el('span', 'note fk-check', notes[r[0]].note));
      }
      li.appendChild(v);
      list.appendChild(li);
    });
    $('[data-fact-count]').textContent = String(rows.length);
  }

  function drawSlots(d, kit) {
    var box = $('[data-needs]');
    var wrap = $('[data-slots]');
    wrap.textContent = '';
    var items = (kit.faq && kit.faq.items || []).filter(function (i) { return i.slot; });
    box.hidden = !items.length;
    if (!items.length) return;
    var needs = kit.faq.needs || 0;
    $('#fk-needs-h').textContent = needs
      ? plural(needs, 'answer', 'answers') + (needs === 1 ? ' needs' : ' need') + ' one detail from you'
      : 'Your details in the answers';
    var why = (kit.faq.attributes || []).slice(0, 3).map(function (a) { return a.label; });
    $('[data-needs-why]').textContent = why.length ? why.join(', ') : 'what you specialize in and who you work with';
    var facts = (d.faqFacts) || {};
    // The ones still waiting first, and among those, what AI talked about most when it picked others
    // (kit.faq.attributes is most-mentioned first): the buyer's "results" box sat at the bottom.
    var order = {};
    (kit.faq.attributes || []).forEach(function (a, n) { if (!(a.type in order)) order[a.type] = n; });
    var at = function (i) { return i.slot.type in order ? order[i.slot.type] : 99; };
    items.sort(function (a, b) { return (a.complete ? 1 : 0) - (b.complete ? 1 : 0) || at(a) - at(b); });
    // The first SHOW_SLOTS on screen; the rest behind "Show all N" (still read by "Add to my answers").
    var more = null;
    if (items.length > SHOW_SLOTS) {
      more = el('details', 'fk-more');
      more.setAttribute('data-slots-more', '');
      more.appendChild(el('summary', null, 'Show all ' + plural(items.length, 'answer', 'answers')));
    }
    items.forEach(function (it, n) {
      var id = 'fk-slot-' + it.slot.type;
      var row = el('div', 'fk-slot fk-field');
      row.setAttribute('data-field', 'faqFacts.' + it.slot.type);
      var label = el('label', null, it.slot.prompt);
      label.setAttribute('for', id);
      row.appendChild(label);
      // The first blank is the one AI brought up most when it described the businesses it picked.
      if (n === 0 && !it.complete && it.slot.type in order) row.appendChild(el('p', 'fk-most', 'Start here: of these, AI brought this up most when it described the businesses it picked.'));
      row.appendChild(el('p', 'for', 'For: “' + it.question + '”'));
      var input = el('input');
      input.type = 'text';
      input.id = id;
      input.maxLength = 240;
      input.setAttribute('data-slot', it.slot.type);
      input.placeholder = 'e.g. ' + it.slot.example;
      input.value = facts[it.slot.type] || '';
      row.appendChild(input);
      row.appendChild(el('p', 'fk-err'));
      (more && n >= SHOW_SLOTS ? more : wrap).appendChild(row);
    });
    if (more) wrap.appendChild(more);
  }
  var SHOW_SLOTS = 3;

  function qaPreview(items) {
    var box = el('div', 'fk-qa');
    items.forEach(function (it) {
      var row = el('div', it.complete ? '' : 'todo');
      var q = el('strong', null, it.question);
      if (!it.complete) q.appendChild(el('span', 'fk-tag', 'Needs one detail'));
      row.appendChild(q);
      var p = el('p');
      String(it.answer).split(/(\[[^\]]*\])/).forEach(function (part) {
        if (!part) return;
        p.appendChild(/^\[/.test(part) ? el('mark', null, part) : document.createTextNode(part));
      });
      row.appendChild(p);
      box.appendChild(row);
    });
    return box;
  }

  function fileDetails(f) {
    var det = el('details');
    det.appendChild(el('summary', null, 'See the file: ' + f.path));
    if (/\.svg$/.test(f.path)) {
      var img = el('img', 'fk-qr');
      img.alt = 'Your review QR code';
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(f.content);
      det.appendChild(img);
    } else {
      det.appendChild(el('pre', null, f.content));
    }
    return det;
  }

  // The job's meta line: "Needs: <access> · <task> · <time> · No cost from us", the same shape as the
  // report's action plan (owner, Oct 2 2026: "Don't have it say 'you with your web person'. Just say what
  // you need"). The time is the job's own estimate (src/lib/fix-kit.js), only written shorter, never
  // shorter in meaning: "About half an hour" → "~30 min", "Under half an hour" → "under 30 min",
  // "About an hour" → "~1 hr", tails kept. The zip's README keeps the long wording.
  var SHORT_TIME = [
    [/^About an hour for you, then about half an hour for your web person$/, '~1 hr, then ~30 min on the site'],
    [/^Under half an hour to set up, then seconds per customer$/, 'under 30 min to set up, then seconds per customer'],
    [/^Under half an hour( for you| for your web person)?$/, 'under 30 min'],
    [/^About half an hour( for you| for your web person)?$/, '~30 min'],
    [/^About an hour( for you| for your web person)?$/, '~1 hr'],
  ];
  function shortTime(t) {
    var s = String(t || '').trim();
    for (var i = 0; i < SHORT_TIME.length; i++) if (SHORT_TIME[i][0].test(s)) return SHORT_TIME[i][1];
    return s.replace(/ for your web person| for you\b/g, '');
  }
  // What each job asks for, from its own steps ("Where it goes"). The site sign-in is named when we know the builder.
  function needsFor(j, kit) {
    var pf = (j.platform && j.platform.name) || (kit.platform && kit.platform.name) || '';
    var site = pf ? pf + ' sign-in' : 'website access';
    var blanks = (kit.faq && kit.faq.needs) || 0;
    var NEEDS = {
      robots: [site, 'Add one file'],
      faq: [site, blanks ? 'Fill in ' + plural(blanks, 'detail', 'details') + ', then add one page' : 'Add one page'],
      google: ['Google Business Profile sign-in', 'Paste in the text'],
      schema: [site, 'Add one code block to your home page'],
      llms: [site, 'Upload one file'],
      qr: ['your Google review link', String(j.where || 'Send a message after each job.').split('.')[0]],
    };
    // Unknown job: no access claim we can't back, just the time.
    var n = NEEDS[j.id] || [j.who === 'you' ? '' : site, ''];
    // A job the site builder can't take (or makes itself): say to skip it, no "Needs".
    if (j.skip) return 'Skip it' + (pf ? ' on ' + pf : '') + ' · ' + (pf && /setting/.test(j.where || '') ? 'Use ' + pf + '’s setting instead' : 'see “How to do it”') + ' · No cost from us';
    var parts = [n[0], n[1]].filter(Boolean);
    if (j.time) parts.push(shortTime(j.time));
    return 'Needs: ' + parts.join(' · ') + ' · No cost from us';
  }
  // "If …" sentences in "Where it goes" are caveats: they stay on screen, the rest goes behind the click.
  function splitWhere(where) {
    // Sentences end at a full stop followed by a capital, so "robots.txt" or "faq-page.txt" isn't split.
    var parts = String(where || '').split(/(?<=\.)\s+(?=[A-Z])/);
    var ifs = parts.filter(function (x) { return /^If /.test(x); }).join(' ');
    var rest = parts.filter(function (x) { return !/^If /.test(x); }).join(' ');
    return { ifs: ifs, rest: rest };
  }

  function drawJobs(kit) {
    var lists = { you: $('[data-jobs-you]'), web: $('[data-jobs-web]'), after: $('[data-jobs-after]') };
    Object.keys(lists).forEach(function (k) { lists[k].textContent = ''; });
    (kit.jobs || []).forEach(function (j) {
      var list = j.who === 'you' ? lists.you : lists.web;
      var li = el('li', 'fk-job');
      li.setAttribute('data-job', j.id);
      var h = el('h3', null, j.title);
      if (j.optional) h.appendChild(el('span', 'fk-opt', 'Optional'));
      li.appendChild(h);
      li.appendChild(el('span', 'fk-tech', j.tech));
      li.appendChild(el('p', null, j.what));
      li.appendChild(el('p', 'who', needsFor(j, kit)));
      // A caveat in "Where it goes" ("If your site builder won’t let you add files, skip it.") stays on
      // screen; the rest of it sits behind "How to do it".
      var w = splitWhere(j.where);
      if (w.ifs) li.appendChild(el('p', 'fk-if', w.ifs));
      if (j.note) li.appendChild(el('p', 'fk-note sample', j.note));
      // Where it goes, the site builder's steps and the "why" sit behind one click.
      var how = el('details', 'fk-how');
      how.appendChild(el('summary', null, 'How to do it'));
      var where = el('p');
      where.appendChild(el('strong', null, 'Where it goes: '));
      where.appendChild(document.createTextNode(w.rest || j.where));
      how.appendChild(where);
      li.appendChild(how);
      // The site builder's own click-paths and help pages (shared/platforms.js), when we know it.
      if (j.platform && ((j.platform.steps || []).length || (j.platform.guides || []).length)) {
        var box = el('div', 'fk-platform');
        box.appendChild(el('p', null, 'Your site is built on ' + j.platform.name + ':'));
        var ul = el('ul');
        (j.platform.steps || []).forEach(function (s) { ul.appendChild(el('li', null, s)); });
        if (ul.childNodes.length) box.appendChild(ul);
        (j.platform.guides || []).forEach(function (g) {
          if (!/^https:\/\//.test(g.url)) return;
          var a = el('a', null, g.label);
          a.href = g.url;
          a.target = '_blank';
          a.rel = 'noopener';
          var gp = el('p');
          gp.appendChild(a);
          box.appendChild(gp);
        });
        how.appendChild(box);
      }
      if (j.id === 'faq' && kit.faq) {
        var why = (kit.faq.attributes || []).slice(0, 4).map(function (a) { return a.label; });
        if (why.length) how.appendChild(el('p', null, 'When AI picked other businesses, it mentioned ' + why.join(', ') + '. These answers cover the same things for you.'));
        var qa = el('details');
        qa.appendChild(el('summary', null, 'Read all ' + plural((kit.faq.items || []).length, 'question and answer', 'questions and answers')));
        qa.appendChild(qaPreview(kit.faq.items || []));
        li.appendChild(qa);
      }
      (j.files || []).forEach(function (f) { li.appendChild(fileDetails(f)); });
      list.appendChild(li);
    });
    if (kit.readme) {
      var r = el('li', 'fk-job');
      r.appendChild(el('h3', null, 'A one-page guide for whoever updates your site'));
      r.appendChild(el('span', 'fk-tech', 'README.txt'));
      r.appendChild(el('p', null, 'What each file does and where it goes, in plain words, in order.'));
      r.appendChild(fileDetails({ path: 'README.txt', content: kit.readme }));
      lists.web.appendChild(r);
    }
    if (kit.check) {
      var c = el('li', 'fk-job');
      c.appendChild(el('h3', null, 'Check it worked, and what to expect'));
      c.appendChild(el('span', 'fk-tech', 'check-it-worked.txt'));
      c.appendChild(el('p', null, 'How to tell each file is live, what to expect and when, and the questions to ask AI again in about a month.'));
      c.appendChild(fileDetails({ path: 'check-it-worked.txt', content: kit.check }));
      lists.after.appendChild(c);
    }
    ['you', 'web', 'after'].forEach(function (k) { $('[data-sec="' + k + '"]').hidden = !lists[k].childNodes.length; });
    var line = $('[data-platform-line]');
    if (line) {
      line.textContent = kit.platform && kit.platform.name ? 'Your site is built on ' + kit.platform.name + ', so each job says where it goes in ' + kit.platform.name + '.' : '';
      line.hidden = !(kit.platform && kit.platform.name);
    }
        var done = $('[data-done]');
    done.textContent = '';
    (kit.done || []).forEach(function (x) { done.appendChild(el('li', null, x.note)); });
    $('[data-done-wrap]').hidden = !(kit.done || []).length;
  }

  // The AI's drafts for the blanks, each with the words on the owner's website that back it. Nothing is
  // used until the owner clicks "Use this"; a draft only fills the box, and "Add to my answers" saves it.
  function suggestBox(head) {
    var box = el('div', 'fk-suggest');
    box.appendChild(el('p', 'fk-suggest-h', head));
    return box;
  }
  function drawSuggestions() {
    document.querySelectorAll('.fk-suggest').forEach(function (n) { n.remove(); });
    if (!suggestions) return;
    document.querySelectorAll('.fk-slot').forEach(function (row) {
      var input = row.querySelector('input[data-slot]');
      var s = input && suggestions.slots && suggestions.slots[input.getAttribute('data-slot')];
      if (!s || input.value) return;
      var box = suggestBox('Drafted by AI from your website. Check that it is true before you use it.');
      box.appendChild(el('p', null, '“' + s.sentence + '”'));
      var b = el('button', 'btn-secondary', 'Use this');
      b.type = 'button';
      b.addEventListener('click', function () { input.value = s.sentence; box.remove(); input.focus(); });
      box.appendChild(b);
      // The words on their website that back the draft: one click away.
      var src = el('details', 'fk-src');
      src.appendChild(el('summary', null, 'Where this came from'));
      src.appendChild(el('p', 'fk-suggest-q', 'From your website: “' + s.quote + '”'));
      box.appendChild(src);
      row.appendChild(box);
    });
    var svc = (suggestions.services || []);
    var li = [].slice.call(document.querySelectorAll('[data-facts] li')).filter(function (x) { return x.querySelector('.k') && x.querySelector('.k').textContent === 'Services' && x.querySelector('.fk-miss'); })[0];
    if (svc.length && li) {
      // Not "Missing" right above a list of drafts: say we drafted them and they need a check.
      var pill = li.querySelector('.fk-miss');
      pill.textContent = 'Drafted for you — check below';
      pill.className = 'fk-miss drafted';
      var why = li.querySelector('.v .note');
      if (why) why.textContent = 'Your website mentions these. Check you offer each one, click “Use these services”, then remove any that are wrong with Edit details.';
      var sb = suggestBox('Drafted by AI from your website. Check that you offer each one.');
      var ul = el('ul');
      svc.forEach(function (x) {
        var item = el('li');
        item.appendChild(el('strong', null, x.name));
        item.appendChild(el('span', 'fk-suggest-q', 'Your website says: “' + x.quote + '”'));
        ul.appendChild(item);
      });
      sb.appendChild(ul);
      var ub = el('button', 'btn-secondary', 'Use these services');
      ub.type = 'button';
      ub.addEventListener('click', function () {
        var d = copy(current);
        d.services = svc.map(function (x) { return x.name; });
        rebuild(d, $('[data-suggest-status]'), ub);
      });
      sb.appendChild(ub);
      li.querySelector('.v').appendChild(sb);
    }
  }
  function askForSuggestions(sample) {
    var status = $('[data-suggest-status]');
    var blanks = ((lastKit && lastKit.faq && lastKit.faq.needs) || 0) + ((lastKit && lastKit.missing || []).some(function (m) { return m.field === 'services'; }) ? 1 : 0);
    if (sample || !blanks || !current || !current.website) return;
    setStatus(status, 'Reading your website to draft the blanks for you…');
    post({ suggest: true, details: current }).then(function (res) {
      var sg = res.body && res.body.ok && res.body.suggestions;
      var n = sg ? Object.keys(sg.slots || {}).length + ((sg.services || []).length ? 1 : 0) : 0;
      if (!n) { setStatus(status, ''); return; }
      suggestions = sg;
      drawSuggestions();
      setStatus(status, 'We drafted ' + plural(n, 'suggestion', 'suggestions') + ' from your website. Check each one, then click "Use this".', 'ok');
    }).catch(function () { setStatus(status, ''); });
  }

  function draw(details, kit) {
    lastKit = kit;
    current = copy(details);
    current.faqFacts = current.faqFacts || {};
    $('[data-biz-name]').textContent = details.name || 'your business';
    drawFacts(details, kit);
    drawSlots(details, kit);
    drawJobs(kit);
    drawSuggestions();
    var needs = (kit.faq && kit.faq.needs) || 0;
    var miss = (kit.missing || []).length;
    // What's still open goes on its own line under the download note, not in the middle of it.
    var note = $('[data-dl-needs]');
    note.textContent = '';
    note.hidden = !(needs || miss);
    if (needs || miss) {
      note.appendChild(document.createTextNode('You can download now; ' + [miss ? plural(miss, 'detail is', 'details are') + ' missing' : '', needs ? plural(needs, 'answer still needs', 'answers still need') + ' one detail from you' : ''].filter(Boolean).join(' and ') + ', and the guide says so. '));
      if (needs) {
        var a = el('a', null, 'Fill them in below');
        a.href = '#fk-needs';
        note.appendChild(a);
        note.appendChild(document.createTextNode(' for a finished kit.'));
      }
    }
  }

  // ---- talking to the server ----
  function post(body) {
    return fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { status: r.status, body: b }; }); });
  }

  function rebuild(details, statusNode, button, after) {
    clearErrors();
    button.disabled = true;
    setStatus(statusNode, 'Rebuilding your kit…');
    post({ preview: true, details: details }).then(function (res) {
      button.disabled = false;
      if (res.body && res.body.ok) {
        draw(res.body.details, res.body.kit);
        setStatus(statusNode, 'Done. Your kit is rebuilt below.', 'ok');
        if (after) after();
        return;
      }
      if (res.body && res.body.errors) {
        if (res.body.errors.some(function (e) { return !/^faqFacts\./.test(e.field) && e.field !== 'confirm'; })) openForm(true);
        setStatus(statusNode, 'A few details need a fix. See the notes.', 'bad');
        showErrors(res.body.errors);
        return;
      }
      setStatus(statusNode, (res.body && res.body.error) || 'Something went wrong. Try again in a minute.', 'bad');
    }).catch(function () {
      button.disabled = false;
      setStatus(statusNode, 'Could not reach us. Check your connection and try again.', 'bad');
    });
  }

  document.querySelectorAll('[data-report-link]').forEach(function (a) { a.href = '/report/' + encodeURIComponent(token); });

  if (!token) { show('notfound'); return; }

  fetch(api, { cache: 'no-store' })
    .then(function (r) {
      if (r.status === 404) { show('notfound'); return null; }
      if (!r.ok) { show('error'); return null; }
      return r.json();
    })
    .then(function (data) {
      if (!data) return;
      if (!data.paid || !data.kit) { show('unpaid'); return; }
      $('[data-sample-note]').hidden = !data.sample;
      // Be the Answer: the kit also carries the directory checklist and the Google posts.
      document.querySelectorAll('[data-plan-only]').forEach(function (x) { x.hidden = !data.plan; });
      document.querySelectorAll('[data-plan-link]').forEach(function (a) { a.href = '/plan/' + encodeURIComponent(token); });
      draw(data.details || {}, data.kit);
      if (data.confirmed) $('[data-confirm]').checked = true;
      show('kit');
      askForSuggestions(data.sample);
      // Something we read doesn't pass the checks (a state we can't use, say): open the form on it.
      if (data.problems && data.problems.length) { openForm(true); showErrors(data.problems); }
    })
    .catch(function () { show('error'); });

  // Print / Save as PDF shows everything: every closed "How to do it", "Show all" and file opens for
  // the print and closes again after.
  var openedForPrint = [];
  window.addEventListener('beforeprint', function () {
    openedForPrint = [].slice.call(document.querySelectorAll('.fk details:not([open])'));
    openedForPrint.forEach(function (d) { d.open = true; });
  });
  window.addEventListener('afterprint', function () {
    openedForPrint.forEach(function (d) { d.open = false; });
    openedForPrint = [];
  });

  form.elements.description.addEventListener('input', count);
  $('[data-edit]').addEventListener('click', function () { openForm(true); });
  $('[data-cancel]').addEventListener('click', function () { clearErrors(); openForm(false); });

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    rebuild(read(), $('[data-form-status]'), form.querySelector('button[type=submit]'), function () {
      openForm(false);
      $('#fk-check-h').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  $('[data-save-slots]').addEventListener('click', function () {
    var d = copy(current);
    d.faqFacts = d.faqFacts || {};
    document.querySelectorAll('[data-slot]').forEach(function (input) { d.faqFacts[input.getAttribute('data-slot')] = input.value; });
    rebuild(d, $('[data-slots-status]'), $('[data-save-slots]'));
  });

  // "We can do it" box ("Send my request"): one request that emails us. We ask only for a way to reach them, what
  // they want done and what they'd pay; we never publish a price and reply to say if we can do it.
  $('[data-help-send]').addEventListener('click', function () {
    var status = $('[data-help-status]');
    var button = $('[data-help-send]');
    clearErrors();
    var wants = [].slice.call(document.querySelectorAll('[data-want]:checked')).map(function (x) { return x.value; });
    button.disabled = true;
    setStatus(status, 'Sending…');
    post({ help: true, details: current, contact: $('#fk-help-email').value, phone: $('#fk-help-phone').value, wants: wants, price: $('#fk-help-price').value, note: $('#fk-help-note').value }).then(function (res) {
      button.disabled = false;
      if (res.body && res.body.ok) {
        $('[data-help-form]').hidden = true;
        var done = $('[data-help-done]');
        done.hidden = false;
        done.textContent = res.body.sample ? 'This is the sample, so nothing was sent.' : 'Sent. We will write to ' + res.body.contact + '.';
        return;
      }
      if (res.body && res.body.errors) { setStatus(status, 'A few things need a fix.', 'bad'); showErrors(res.body.errors); return; }
      setStatus(status, (res.body && res.body.error) || 'Something went wrong. Try again in a minute.', 'bad');
    }).catch(function () {
      button.disabled = false;
      setStatus(status, 'Could not reach us. Check your connection and try again.', 'bad');
    });
  });

  $('[data-download]').addEventListener('click', function () {
    var status = $('[data-dl-status]');
    var button = $('[data-download]');
    clearErrors();
    if (!$('[data-confirm]').checked) {
      showErrors([{ field: 'confirm', message: 'Tick the box to confirm you own or manage this business and the details are right.' }]);
      return;
    }
    button.disabled = true;
    setStatus(status, 'Getting your kit ready…');
    post({ confirm: true, details: current }).then(function (res) {
      button.disabled = false;
      if (res.body && res.body.ok) {
        setStatus(status, 'Your download has started. Hand the folder to whoever runs your website.', 'ok');
        location.href = api + '.zip';
        return;
      }
      if (res.body && res.body.errors) {
        if (res.body.errors.some(function (e) { return e.field !== 'confirm'; })) openForm(true);
        setStatus(status, 'A few details need a fix first. See the notes.', 'bad');
        showErrors(res.body.errors);
        return;
      }
      setStatus(status, (res.body && res.body.error) || 'Something went wrong. Try again in a minute.', 'bad');
    }).catch(function () {
      button.disabled = false;
      setStatus(status, 'Could not reach us. Check your connection and try again.', 'bad');
    });
  });
})();
