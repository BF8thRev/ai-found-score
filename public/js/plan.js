// public/js/plan.js — the Be the Answer page (/plan/<token>, public/plan.html).
//
// Loads GET /api/plan/<token> ({ paid, sample, name, towns, maxTowns, confirmed, directories, paste,
// posts }) and shows the towns (each links to its own report), the directory checklist with the text
// to paste, and the year's Google posts. "Add this town" POSTs { towns: [{ town, state, zip }] }.
// Checklist ticks are saved in this browser only. Plain script, no build step, no dependencies.

(function () {
  var token = decodeURIComponent(location.pathname.replace(/^\/plan\//, '').replace(/\/+$/, ''));
  var api = '/api/plan/' + encodeURIComponent(token);
  var states = document.querySelectorAll('[data-state]');
  var form = document.querySelector('[data-town-form]');
  var status = form.querySelector('.fk-status');
  var tickKey = 'afs_plan_ticks:' + token;

  function show(name) { states.forEach(function (el) { el.hidden = el.getAttribute('data-state') !== name; }); }
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text != null) e.textContent = text;
    return e;
  }
  function copy(text, button) {
    var done = function () { var t = button.textContent; button.textContent = 'Copied'; setTimeout(function () { button.textContent = t; }, 1500); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () {});
  }
  function readTicks() { try { return JSON.parse(localStorage.getItem(tickKey) || '{}'); } catch (e) { return {}; } }
  function saveTicks(t) { try { localStorage.setItem(tickKey, JSON.stringify(t)); } catch (e) {} }

  function renderTowns(data) {
    var list = document.querySelector('[data-towns]');
    list.textContent = '';
    data.towns.forEach(function (t) {
      var li = el('li');
      li.appendChild(el('strong', null, t.town + (t.state ? ', ' + t.state : '') + (t.main ? ' (your report)' : '')));
      if (t.token) li.appendChild(el('a', { href: '/report/' + encodeURIComponent(t.token) }, 'Open this town’s report'));
      else li.appendChild(el('span', null, 'Sample: not saved'));
      list.appendChild(li);
    });
    document.querySelector('[data-max-towns]').textContent = String(data.maxTowns);
    form.hidden = data.towns.length >= data.maxTowns;
  }

  function pasteText(p) {
    return [
      'Business name: ' + p.name,
      'Phone: ' + p.phone,
      p.address ? 'Address: ' + p.address : '',
      p.serviceArea ? 'Service area: ' + p.serviceArea : '',
      p.website ? 'Website: ' + p.website : '',
      p.hours ? 'Hours: ' + p.hours : '',
      p.category ? 'Category: ' + p.category : '',
      'Description: ' + p.description,
    ].filter(Boolean).join('\n');
  }

  function renderDetails(data) {
    var has = !!(data.confirmed && data.paste);
    document.querySelectorAll('[data-has-details]').forEach(function (s) { s.hidden = !has; });
    document.querySelectorAll('[data-needs-details]').forEach(function (s) { s.hidden = has; });
    document.querySelectorAll('[data-kit-link]').forEach(function (a) { a.href = '/fix-kit/' + encodeURIComponent(token); });
    if (!has) return;
    var text = pasteText(data.paste);
    document.querySelector('[data-paste]').textContent = text;
    document.querySelector('[data-copy-paste]').addEventListener('click', function (e) { copy(text, e.currentTarget); });

    var ticks = readTicks();
    var sites = document.querySelector('[data-sites]');
    sites.textContent = '';
    data.directories.forEach(function (s) {
      var li = el('li');
      var label = el('label');
      var box = el('input', { type: 'checkbox' });
      box.checked = !!ticks[s.name];
      box.addEventListener('change', function () { var t = readTicks(); t[s.name] = box.checked; saveTicks(t); });
      var span = el('span');
      span.appendChild(el('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.name));
      if (s.why) span.appendChild(el('small', null, s.why));
      label.appendChild(box);
      label.appendChild(span);
      li.appendChild(label);
      sites.appendChild(li);
    });

    var posts = document.querySelector('[data-posts]');
    posts.textContent = '';
    data.posts.forEach(function (p) {
      var card = el('div', { class: 'pl-post' });
      card.appendChild(el('h3', null, p.month + ': ' + p.title));
      card.appendChild(el('p', null, p.text));
      var b = el('button', { class: 'pl-copy', type: 'button' }, 'Copy this post');
      b.addEventListener('click', function () { copy(p.text, b); });
      card.appendChild(b);
      posts.appendChild(card);
    });
  }

  document.querySelectorAll('[data-report-link]').forEach(function (a) { a.href = '/report/' + encodeURIComponent(token); });
  if (!token) { show('notfound'); return; }

  var current = null;
  fetch(api, { cache: 'no-store' })
    .then(function (r) {
      if (r.status === 404) { show('notfound'); return null; }
      if (r.status === 402) { show('unpaid'); return null; }
      if (!r.ok) { show('error'); return null; }
      return r.json();
    })
    .then(function (data) {
      if (!data) return;
      current = data;
      document.querySelector('[data-sample-note]').hidden = !data.sample;
      if (data.name) document.querySelector('h1').textContent = 'Be the Answer: ' + data.name;
      renderTowns(data);
      renderDetails(data);
      show('plan');
    })
    .catch(function () { show('error'); });

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var town = { town: form.elements.town.value, state: form.elements.state.value, zip: form.elements.zip.value };
    var button = form.querySelector('button[type=submit]');
    button.disabled = true;
    status.textContent = 'Adding…';
    status.className = 'fk-status';
    fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ towns: [town] }) })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (body) {
        button.disabled = false;
        if (body && body.ok) {
          current.towns = body.towns;
          renderTowns(current);
          form.reset();
          status.textContent = body.sample ? 'Added (sample: not saved).' : 'Added. Its first report is on its way; we email you when it’s ready.';
          status.className = 'fk-status ok';
          return;
        }
        var msg = (body && (body.error || (body.errors && body.errors[0] && body.errors[0].message))) || 'Something went wrong. Try again in a minute.';
        status.textContent = msg;
        status.className = 'fk-status bad';
      })
      .catch(function () {
        button.disabled = false;
        status.textContent = 'Could not reach us. Check your connection and try again.';
        status.className = 'fk-status bad';
      });
  });
})();
