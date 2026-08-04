(function () {
  var token = new URLSearchParams(window.location.search).get('token');
  var apiBase = '/api/v1/public/vendor-registration/';
  var els = {
    loading: document.getElementById('loading'),
    form: document.getElementById('form'),
    success: document.getElementById('successScreen'),
    subtitle: document.getElementById('subtitle'),
    messages: document.getElementById('messages'),
    submitBtn: document.getElementById('submitBtn'),
  };

  function showMessage(text, kind) {
    els.messages.innerHTML = '<div class="msg ' + kind + '">' + text + '</div>';
  }

  if (!token) {
    els.loading.classList.add('hidden');
    showMessage('This link is missing its access token — please use the link exactly as shared with you.', 'error');
    return;
  }

  fetch(apiBase + token)
    .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, status: res.status, body: body }; }); })
    .then(function (result) {
      els.loading.classList.add('hidden');
      if (!result.ok) {
        showMessage(result.body.message || 'This link is invalid.', 'error');
        return;
      }
      var info = result.body.data;
      els.subtitle.textContent = info.requirementNumber + ' — ' + info.title + ' (' + info.departmentName + ')';
      if (info.status === 'submitted') {
        els.success.classList.remove('hidden');
        showMessage('This form has already been submitted and is awaiting verification.', 'success');
        return;
      }
      els.form.classList.remove('hidden');
    })
    .catch(function () {
      els.loading.classList.add('hidden');
      showMessage('Could not reach the server. Check your connection and reload the page.', 'error');
    });

  els.form.addEventListener('submit', function (event) {
    event.preventDefault();
    els.submitBtn.disabled = true;
    els.submitBtn.textContent = 'Submitting…';
    showMessage('', '');
    els.messages.innerHTML = '';

    var formData = new FormData(els.form);

    fetch(apiBase + token, { method: 'POST', body: formData })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, status: res.status, body: body }; }); })
      .then(function (result) {
        if (!result.ok) {
          if (result.status === 409) {
            showMessage(result.body.message || 'A vendor with this GST/PAN/Email already exists.', 'error');
          } else if (result.body.errors) {
            var lines = [];
            Object.keys(result.body.errors).forEach(function (key) {
              lines = lines.concat(result.body.errors[key]);
            });
            showMessage(lines.join('<br/>') || 'Please check the highlighted fields.', 'error');
          } else {
            showMessage(result.body.message || 'Submission failed. Please try again.', 'error');
          }
          els.submitBtn.disabled = false;
          els.submitBtn.textContent = 'Submit for Verification';
          return;
        }
        els.form.classList.add('hidden');
        els.success.classList.remove('hidden');
      })
      .catch(function () {
        showMessage('Could not reach the server. Check your connection and try again.', 'error');
        els.submitBtn.disabled = false;
        els.submitBtn.textContent = 'Submit for Verification';
      });
  });
})();
