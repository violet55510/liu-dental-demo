/* =========================================================
   assets/js/session.js — 顶栏登录状态（全站共用）
   ---------------------------------------------------------
   - 向 /api/me 取当前身份，填充 [data-auth-slot]
   - 未登录：显示「登录 / 注册」
   - 已登录：显示「姓名 · 角色 → 控制台」+「退出」
   - 用 file:// 直接打开（没有后端）时静默降级为「登录」，不报错
   注意：这里只决定「显示什么」，不代表权限。权限一律由服务端判断。
   ========================================================= */
(function () {
  'use strict';

  var slots = document.querySelectorAll('[data-auth-slot]');
  if (!slots.length) return;

  var ROLE_TEXT = { patient: '病人', doctor: '医生', admin: '管理员' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderGuest() {
    var html =
      '<a class="auth-link" href="login.html">登录</a>' +
      '<a class="auth-link auth-link--primary" href="register.html">注册</a>';
    slots.forEach(function (el) { el.innerHTML = html; });
    document.documentElement.setAttribute('data-auth', 'guest');
  }

  function renderUser(user) {
    var initial = (user.name || '?').slice(0, 1);
    var html =
      '<a class="auth-user" href="dashboard.html" title="进入控制台">' +
        '<span class="auth-avatar" aria-hidden="true">' + esc(initial) + '</span>' +
        '<span class="auth-user-text">' +
          '<span class="auth-user-name">' + esc(user.name) + '</span>' +
          '<span class="auth-user-role">' + esc(ROLE_TEXT[user.role] || user.role) + '</span>' +
        '</span>' +
      '</a>' +
      '<button class="auth-logout" type="button" data-logout>退出</button>';
    slots.forEach(function (el) { el.innerHTML = html; });
    document.documentElement.setAttribute('data-auth', 'user');
    document.documentElement.setAttribute('data-role', user.role);

    slots.forEach(function (el) {
      var btn = el.querySelector('[data-logout]');
      if (!btn) return;
      btn.addEventListener('click', function () {
        btn.disabled = true;
        btn.textContent = '退出中';
        fetch('/api/logout', { method: 'POST', credentials: 'same-origin' })
          .catch(function () { /* 断网也把本地状态清掉 */ })
          .then(function () { window.location.href = 'index.html'; });
      });
    });
  }

  fetch('/api/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : { user: null }; })
    .then(function (data) { data && data.user ? renderUser(data.user) : renderGuest(); })
    .catch(renderGuest);
})();
