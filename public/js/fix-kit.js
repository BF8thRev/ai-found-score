// public/js/fix-kit.js — the Fix Kit page (/fix-kit/<token>, public/fix-kit.html).
//
// Loads GET /api/fix-kit/<token> ({ paid, confirmed, sample, details }), fills the form with the saved
// or prefilled details, and on "Confirm my details" POSTs { confirm, details } as JSON. The server
// checks everything (src/lib/fix-kit.js validateDetails) and answers 422 with [{ field, message }] for
// anything to fix, shown under that field. Once confirmed, the download button links to
// /api/fix-kit/<token>.zip. Plain script, no build step, no dependencies.

(function () {
  var token = decodeURIComponent(location.pathname.replace(/^\/fix-kit\//, '').replace(/\/+$/, ''));
  var api = '/api/fix-kit/' + encodeURIComponent(token);
  var states = document.querySelectorAll('[data-state]');
  var form = document.querySelector('.fk-form');
  var status = document.querySelector('.fk-status');
  var download = document.querySelector('[data-download]');
  var LIST_FIELDS = ['services', 'serviceTowns'];
  var TEXT_FIELDS = ['name', 'trade', 'phone', 'website', 'street', 'town', 'state', 'zip', 'hours', 'description', 'googleMapsUrl', 'googleReviewUrl'];

  function show(name) {
    states.forEach(function (el) { el.hidden = el.getAttribute('data-state') !== name; });
  }

  function fill(d) {
    TEXT_FIELDS.forEach(function (f) { if (form.elements[f]) form.elements[f].value = d[f] || ''; });
    LIST_FIELDS.forEach(function (f) { form.elements[f].value = (d[f] || []).join('\n'); });
    count();
  }

  function read() {
    var d = {};
    TEXT_FIELDS.forEach(function (f) { d[f] = form.elements[f].value; });
    LIST_FIELDS.forEach(function (f) { d[f] = form.elements[f].value.split(/\r?\n/); });
    return d;
  }

  function count() {
    var n = document.querySelector('[data-count]');
    if (n) n.textContent = String(form.elements.description.value.length);
  }

  function clearErrors() {
    document.querySelectorAll('.fk-field').forEach(function (el) {
      el.classList.remove('has-error');
      var e = el.querySelector('.fk-err');
      if (e) e.textContent = '';
    });
  }

  function showErrors(errors) {
    var first = null;
    errors.forEach(function (err) {
      var el = document.querySelector('.fk-field[data-field="' + err.field + '"]');
      if (!el) return;
      el.classList.add('has-error');
      var e = el.querySelector('.fk-err');
      if (e && !e.textContent) e.textContent = err.message;
      if (!first) first = el;
    });
    if (first) {
      first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      var input = first.querySelector('input, textarea');
      if (input) input.focus({ preventScroll: true });
    }
  }

  function setStatus(text, kind) {
    status.textContent = text;
    status.className = 'fk-status' + (kind ? ' ' + kind : '');
  }

  function showDownload(fresh) {
    download.hidden = false;
    download.querySelector('[data-download-link]').href = api + '.zip';
    if (fresh) download.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
      if (!data.paid) { show('unpaid'); return; }
      fill(data.details || {});
      document.querySelector('[data-sample-note]').hidden = !data.sample;
      if (data.confirmed) {
        form.elements.confirm.checked = true;
        showDownload(false);
      }
      show('form');
    })
    .catch(function () { show('error'); });

  form.elements.description.addEventListener('input', count);

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    clearErrors();
    if (!form.elements.confirm.checked) {
      showErrors([{ field: 'confirm', message: 'Tick the box to confirm you own or manage this business and the details are right.' }]);
      return;
    }
    var button = form.querySelector('button[type=submit]');
    button.disabled = true;
    setStatus('Saving…');
    fetch(api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, details: read() }),
    })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (body) { return { status: r.status, body: body }; }); })
      .then(function (res) {
        button.disabled = false;
        if (res.body && res.body.ok) {
          if (res.body.details) fill(res.body.details);
          setStatus('Thanks. Your details are confirmed.', 'ok');
          showDownload(true);
          return;
        }
        if (res.body && res.body.errors) {
          setStatus('A few details need a fix. See the notes above.', 'bad');
          showErrors(res.body.errors);
          return;
        }
        setStatus((res.body && res.body.error) || 'Something went wrong. Try again in a minute.', 'bad');
      })
      .catch(function () {
        button.disabled = false;
        setStatus('Could not reach us. Check your connection and try again.', 'bad');
      });
  });
})();
