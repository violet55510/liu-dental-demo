/* =========================================================
   assets/js/auth-pages.js — 登录页 / 注册页的表单交互
   ---------------------------------------------------------
   三个表单共用一个提交函数：
     [data-auth-form="login"]      → POST /api/login
     [data-auth-form="register"]   → POST /api/register
     [data-auth-form="doctor"]     → POST /api/doctor/apply

   这里做的校验只为体验（少一次往返），真正的把关在服务端：
   角色、手机号格式、密码长度、是否重复注册，全部由服务端再判一次。
   ========================================================= */
(function () {
  'use strict';

  var forms = document.querySelectorAll('[data-auth-form]');
  if (!forms.length) return;

  var PHONE_RE = /^1[3-9]\d{9}$/;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  /* ---------- 小工具 ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }

  /* 错误提示统一挂在 <p id="err-{fieldId}">，字段 id 形如 f-phone / d-email */
  function errNode(fieldId) {
    return document.getElementById('err-' + fieldId);
  }

  function showFieldError(fieldId, msg) {
    var input = document.getElementById(fieldId);
    var err = errNode(fieldId);
    if (input) input.setAttribute('aria-invalid', 'true');
    if (err) { err.textContent = msg; err.classList.add('is-visible'); }
  }

  function clearFieldError(fieldId) {
    var input = document.getElementById(fieldId);
    var err = errNode(fieldId);
    if (input) input.removeAttribute('aria-invalid');
    if (err) { err.textContent = ''; err.classList.remove('is-visible'); }
  }

  function clearAll(form) {
    form.querySelectorAll('[aria-invalid]').forEach(function (el) { el.removeAttribute('aria-invalid'); });
    form.querySelectorAll('.error-msg').forEach(function (el) {
      el.textContent = '';
      el.classList.remove('is-visible');
    });
    setStatus(form, '');
  }

  /* .form-status 是共用的提示条：kind = 'error' | 'ok' | 'info' */
  function setStatus(form, msg, kind) {
    var box = form.querySelector('.form-status');
    if (!box) return;
    box.classList.remove('is-visible', 'is-error', 'is-ok');
    if (!msg) { box.textContent = ''; return; }
    box.textContent = msg;
    box.classList.add('is-visible');
    if (kind === 'error') box.classList.add('is-error');
    if (kind === 'ok') box.classList.add('is-ok');
  }

  function submitButton(form) {
    return form.querySelector('button[type="submit"]');
  }

  function lock(form, text) {
    var btn = submitButton(form);
    if (!btn) return function () {};
    var old = btn.textContent;
    btn.disabled = true;
    btn.textContent = text;
    return function () { btn.disabled = false; btn.textContent = old; };
  }

  async function postJSON(url, payload) {
    var res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload)
    });
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { ok: res.ok, status: res.status, data: data || {} };
  }

  /* ---------- 登录 ---------- */
  var loginForm = $('[data-auth-form="login"]');
  if (loginForm) {
    /* 从注册页跳回来时带上手机号，少打一遍 */
    var pre = new URLSearchParams(location.search).get('account');
    if (pre) $('#f-account').value = pre;

    loginForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      clearAll(loginForm);

      var account = $('#f-account').value.trim();
      var password = $('#f-password').value;

      var bad = false;
      if (!account) { showFieldError('f-account', '请填写手机号或邮箱'); bad = true; }
      else if (!PHONE_RE.test(account) && !EMAIL_RE.test(account)) {
        showFieldError('f-account', '手机号填 11 位数字，邮箱要带 @');
        bad = true;
      }
      if (!password) { showFieldError('f-password', '请填写密码'); bad = true; }
      if (bad) { setStatus(loginForm, '请先补全标红的字段', 'error'); $('#f-account').focus(); return; }

      var unlock = lock(loginForm, '登录中…');
      try {
        var r = await postJSON('/api/login', { account: account, password: password });
        if (r.ok) {
          setStatus(loginForm, '登录成功，正在进入控制台…', 'ok');
          var next = new URLSearchParams(location.search).get('next');
          var safe = next && /^[A-Za-z0-9_-]+\.html$/.test(next) ? next : 'dashboard.html';
          location.href = safe;
          return;
        }
        setStatus(loginForm, r.data.error || '登录失败，请稍后重试', 'error');
      } catch (err) {
        setStatus(loginForm, '无法连接后端，请确认已运行 npm start', 'error');
      }
      unlock();
    });
  }

  /* ---------- 病人注册 ---------- */
  var regForm = $('[data-auth-form="register"]');
  if (regForm) {
    regForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      clearAll(regForm);

      var name = $('#f-name').value.trim();
      var phone = $('#f-phone').value.trim();
      var password = $('#f-password').value;

      var bad = false;
      if (name.length < 2 || name.length > 20) { showFieldError('f-name', '请填写 2–20 个字的姓名'); bad = true; }
      if (!PHONE_RE.test(phone)) { showFieldError('f-phone', '请输入 11 位有效的手机号'); bad = true; }
      if (password.length < 8) { showFieldError('f-password', '密码至少 8 位'); bad = true; }
      if (bad) { setStatus(regForm, '请先补全标红的字段', 'error'); $('#f-name').focus(); return; }

      var unlock = lock(regForm, '提交中…');
      try {
        /* 注意：这里没有 role 字段。即使手工加上，服务端也会忽略。 */
        var r = await postJSON('/api/register', { name: name, phone: phone, password: password });
        if (r.ok) {
          setStatus(regForm, '注册成功，正在跳转登录…', 'ok');
          setTimeout(function () {
            location.href = 'login.html?account=' + encodeURIComponent(phone);
          }, 900);
          return;
        }
        if (r.status === 409) showFieldError('f-phone', r.data.error || '该手机号已注册');
        setStatus(regForm, r.data.error || '注册失败', 'error');
      } catch (err) {
        setStatus(regForm, '无法连接后端，请确认已运行 npm start', 'error');
      }
      unlock();
    });
  }

  /* ---------- 医生入驻申请 ---------- */
  var docForm = $('[data-auth-form="doctor"]');
  if (docForm) {
    docForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      clearAll(docForm);

      var name = $('#d-name').value.trim();
      var email = $('#d-email').value.trim();
      var password = $('#d-password').value;

      var bad = false;
      if (name.length < 2 || name.length > 20) { showFieldError('d-name', '请填写 2–20 个字的姓名'); bad = true; }
      if (!EMAIL_RE.test(email)) { showFieldError('d-email', '请输入有效邮箱'); bad = true; }
      if (password.length < 8) { showFieldError('d-password', '密码至少 8 位'); bad = true; }
      if (bad) { setStatus(docForm, '请先补全标红的字段', 'error'); $('#d-name').focus(); return; }

      var unlock = lock(docForm, '提交中…');
      try {
        var r = await postJSON('/api/doctor/apply', { name: name, email: email, password: password });
        if (r.ok) {
          setStatus(docForm, '申请已提交。账号状态为「待审核」，管理员激活后才能登录。', 'ok');
          docForm.reset();
          return;
        }
        if (r.status === 409) showFieldError('d-email', r.data.error || '该邮箱已提交过申请');
        setStatus(docForm, r.data.error || '提交失败', 'error');
      } catch (err) {
        setStatus(docForm, '无法连接后端，请确认已运行 npm start', 'error');
      }
      unlock();
    });
  }
})();
