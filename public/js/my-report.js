// Homepage: getting back to a report you already have.
//  1. This browser remembers the last report it opened (localStorage afs_last_report, saved by
//     report.js): the hero shows "Your report for X" with a link, above the form.
//  2. "Email me my link": POST /api/find-report emails the links for an address (same answer
//     whether or not one exists).
(function () {
  var KEY = 'afs_last_report', TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/, MAX_AGE = 90 * 864e5;
  function el(id) { return document.getElementById(id); }

  try {
    var d = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (d && TOKEN_RE.test(String(d.token || '')) && Date.now() - Number(d.at || 0) < MAX_AGE) {
      var card = el('return-card'), a = el('return-link');
      if (card && a) {
        a.href = '/report/' + encodeURIComponent(d.token);
        a.textContent = d.name ? 'Open your report for ' + String(d.name).slice(0, 80) + ' →' : 'Open your report →';
        card.hidden = false;
      }
    }
  } catch (e) { /* storage blocked: no card */ }

  var open = el('find-open'), form = el('find-form');
  if (!open || !form) return;
  var status = el('find-status');
  open.addEventListener('click', function () { form.hidden = !form.hidden; if (!form.hidden) form.elements.email.focus(); });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = form.querySelector('button[type=submit]');
    var email = String(form.elements.email.value || '').trim();
    function say(cls, t) { status.className = 'status ' + cls; status.textContent = t; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { say('error', 'Please enter a valid email.'); return; }
    btn.disabled = true;
    fetch('/api/find-report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email, company_url: form.elements.company_url.value }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { r: r, j: j }; }); })
      .then(function (x) {
        btn.disabled = false;
        if (x.r.ok && x.j.ok) say('note', x.j.message || 'If we have a report for that email, the link is on its way.');
        else say('error', x.j.error || 'Something went wrong. Try again in a minute.');
      })
      .catch(function () { btn.disabled = false; say('error', 'Something went wrong. Try again in a minute.'); });
  });
})();
