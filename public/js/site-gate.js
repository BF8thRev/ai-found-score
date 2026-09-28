// The gate before a scan (index.html free form, checkout.html paid form): asks GET /api/site-check
// whether the website is real and the business name is a name, and if not, shows a popup that
// says what's wrong and puts the cursor in that field. The Worker checks again on POST /api/request.
//   window.siteGate(form, data) -> Promise<boolean>: true = go ahead, false = the popup is showing.
//   When the website shows its ZIP, it is put on data.siteZip.
// If the check itself can't run (offline, rate limit, error), it goes ahead: the server still checks.
(function () {
  'use strict';
  var dialog = null;

  function build() {
    dialog = document.createElement('dialog');
    dialog.className = 'gate-dialog';
    dialog.setAttribute('aria-labelledby', 'gate-title');
    dialog.innerHTML = '<h2 id="gate-title">Let&rsquo;s double-check that</h2>'
      + '<p id="gate-msg"></p>'
      + '<form method="dialog"><button class="btn" value="fix">Fix it</button></form>';
    document.body.appendChild(dialog);
  }

  function popup(message, field) {
    if (!dialog) build();
    dialog.querySelector('#gate-msg').textContent = message;
    dialog.onclose = function () {
      if (!field) return;
      field.focus();
      try { field.select(); } catch (e) {}
    };
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else { window.alert(message); dialog.onclose(); }
  }

  window.siteGate = function (form, data) {
    var qs = new URLSearchParams({ website: data.website || '', name: data.business_name || '' });
    return fetch('/api/site-check?' + qs.toString(), { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : { ok: true }; })
      .catch(function () { return { ok: true }; })
      .then(function (res) {
        // The ZIP on the business's own website, when it shows one (the hero form doesn't ask for it).
        if (res && typeof res.zip === 'string' && /^\d{5}$/.test(res.zip)) data.siteZip = res.zip;
        if (!res || res.ok !== false) return true;
        var field = form.elements[res.field === 'business_name' ? 'business_name' : 'website'];
        if (field) {
          field.setAttribute('aria-invalid', 'true');
          field.addEventListener('input', function () { field.removeAttribute('aria-invalid'); }, { once: true });
        }
        popup(res.error || 'Please check your details.', field);
        return false;
      });
  };
})();
