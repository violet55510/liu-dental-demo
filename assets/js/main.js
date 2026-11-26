/* =========================================================
   齿记工具助手 · 交互脚本
   1) 移动端导航开合
   2) 页脚年份
   3) 滚动出现动画
   4) 预约表单：校验、医师参数预选、医师-项目联动、日期范围
   ========================================================= */
(function () {
  'use strict';

  /* ---------- 1. 移动端导航 ---------- */
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.getElementById('site-nav');

  function closeNav() {
    if (!nav || !toggle) return;
    nav.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', 'false');
  }

  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    // 点击导航项后收起
    nav.addEventListener('click', function (e) {
      if (e.target.closest('a')) closeNav();
    });

    // Esc 收起
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeNav();
    });

    // 视口变宽到桌面时复位
    window.addEventListener('resize', function () {
      if (window.innerWidth >= 960) closeNav();
    });
  }

  /* ---------- 2. 页脚年份 ---------- */
  var yearEls = document.querySelectorAll('[data-year]');
  for (var i = 0; i < yearEls.length; i++) {
    yearEls[i].textContent = new Date().getFullYear();
  }

  /* ---------- 3. 滚动出现动画 ---------- */
  var revealEls = document.querySelectorAll('.reveal');
  if (revealEls.length) {
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-in');
            io.unobserve(entry.target);
          }
        });
      }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

      revealEls.forEach(function (el, index) {
        el.style.transitionDelay = (index % 4) * 60 + 'ms';
        io.observe(el);
      });
    } else {
      revealEls.forEach(function (el) { el.classList.add('is-in'); });
    }
  }

  /* ---------- 3.1 营业时间高亮已由 render.js 处理 ---------- */

  /* ---------- 4. 预约表单校验 ---------- */
  var form = document.getElementById('appointment-form');
  if (!form) return;

  var statusBox = document.getElementById('form-status');
  var phonePattern = /^1[3-9]\d{9}$/;

  function showError(field, message) {
    var msg = form.querySelector('[data-error-for="' + field.name + '"]');
    if (msg) {
      msg.textContent = message;
      msg.classList.toggle('is-visible', !!message);
    }
    if (message) {
      field.setAttribute('aria-invalid', 'true');
    } else {
      field.removeAttribute('aria-invalid');
    }
  }

  function validateField(field) {
    // 复选框单独判断：value 恒为 "on"，必须看 checked
    if (field.type === 'checkbox') {
      if (field.hasAttribute('required') && !field.checked) {
        showError(field, '请先阅读并同意隐私说明');
        return false;
      }
      showError(field, '');
      return true;
    }

    var value = (field.value || '').trim();

    if (field.hasAttribute('required') && !value) {
      showError(field, '此项为必填');
      return false;
    }

    if (field.name === 'phone' && value) {
      if (!phonePattern.test(value.replace(/[\s-]/g, ''))) {
        showError(field, '请输入 11 位手机号，例如 13800138000');
        return false;
      }
    }

    if (field.name === 'date' && value) {
      if (field.min && value < field.min) {
        showError(field, '请选择今天或之后的日期');
        return false;
      }
      if (field.max && value > field.max) {
        showError(field, '目前仅开放 30 天内的日期');
        return false;
      }
    }

    showError(field, '');
    return true;
  }

  /* ---------- 4.1 从链接参数预选医师（医生团队页「预约该医师」） ---------- */
  var doctorSelect = document.getElementById('f-doctor');
  var wantedDoctor = '';
  try {
    wantedDoctor = new URLSearchParams(window.location.search).get('doctor') || '';
  } catch (err) {
    wantedDoctor = '';
  }
  if (doctorSelect && wantedDoctor) {
    for (var d = 0; d < doctorSelect.options.length; d++) {
      if (doctorSelect.options[d].value === wantedDoctor) {
        doctorSelect.selectedIndex = d;
        var preselectNote = document.getElementById('doctor-preselect-note');
        if (preselectNote) preselectNote.hidden = false;
        break;
      }
    }
  }

  /* ---------- 4.2 医师与项目联动：只做标记与提示，不限制选择 ---------- */
  var serviceSelect = document.getElementById('f-service');
  var serviceNote = document.getElementById('project-doctor-note');
  var doctorSuggest = document.getElementById('doctor-suggest');

  if (serviceSelect) {
    // 记住原始文案，反复标记时先还原，避免 ★ 越叠越多
    Array.prototype.forEach.call(serviceSelect.options, function (opt) {
      opt.setAttribute('data-label', opt.textContent);
    });
  }

  function markDoctorServices() {
    if (!serviceSelect || !doctorSelect) return;

    var picked = doctorSelect.value;
    var hits = [];

    Array.prototype.forEach.call(serviceSelect.options, function (opt) {
      var label = opt.getAttribute('data-label') || opt.textContent;
      var owners = (opt.getAttribute('data-doctors') || '').split(/\s+/);
      var hit = picked && owners.indexOf(picked) > -1;

      if (hit) {
        opt.textContent = '★ ' + label;
        opt.style.color = 'var(--green-700)';
        opt.style.fontWeight = '600';
        hits.push(label);
      } else {
        opt.textContent = label;
        opt.style.color = '';
        opt.style.fontWeight = '';
      }
    });

    // 原生下拉收起时看不到 ★，所以在下方把擅长项目列出来
    if (serviceNote) {
      if (picked && hits.length) {
        var docOpt = doctorSelect.options[doctorSelect.selectedIndex];
        var who = (docOpt.getAttribute('data-name') || '该医师') +
                  (docOpt.getAttribute('data-dept') ? '（' + docOpt.getAttribute('data-dept') + '）' : '');
        serviceNote.hidden = false;
        serviceNote.textContent = who + '擅长：' +
          hits.map(function (item) { return '★ ' + item; }).join('、') +
          '。下拉中带 ★ 的项目仅作参考，你仍可选择其他。';
      } else {
        serviceNote.hidden = true;
        serviceNote.textContent = '';
      }
    }
  }

  function updateDoctorSuggestion() {
    if (!serviceSelect || !doctorSelect || !doctorSuggest) return;

    var svcOpt = serviceSelect.querySelector('option[value="' + serviceSelect.value + '"]');
    var owners = svcOpt ? (svcOpt.getAttribute('data-doctors') || '').trim() : '';

    // 已选医师、未选项目、或该项目无对应专科时，不提示
    if (doctorSelect.value || !owners) {
      doctorSuggest.hidden = true;
      doctorSuggest.textContent = '';
      return;
    }

    var docOpt = doctorSelect.querySelector('option[value="' + owners.split(/\s+/)[0] + '"]');
    if (!docOpt) {
      doctorSuggest.hidden = true;
      return;
    }

    var svcLabel = svcOpt.getAttribute('data-label') || svcOpt.textContent;
    doctorSuggest.textContent = svcLabel + '建议选择' + docOpt.getAttribute('data-dept') +
      '医师（' + docOpt.getAttribute('data-name') + '），也可以不指定，由门诊按排班安排。';
    doctorSuggest.hidden = false;
  }

  if (serviceSelect && doctorSelect) {
    doctorSelect.addEventListener('change', function () {
      markDoctorServices();
      updateDoctorSuggestion();
    });
    serviceSelect.addEventListener('change', updateDoctorSuggestion);

    markDoctorServices();
    updateDoctorSuggestion();
  }

  /* ---------- 4.3 日期范围：当天起 30 天内 ---------- */
  var dateInput = document.getElementById('f-date');
  var dateTodayHint = document.getElementById('date-today-hint');
  if (dateInput) {
    var today = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var fmt = function (dt) {
      return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
    };
    dateInput.min = fmt(today);
    dateInput.max = fmt(new Date(today.getTime() + 30 * 86400000));

    // 选到「今天」时提示号源需电话确认（选其他日期则收起）
    var syncTodayHint = function () {
      if (!dateTodayHint) return;
      dateTodayHint.hidden = dateInput.value !== dateInput.min;
    };
    dateInput.addEventListener('change', syncTodayHint);
    dateInput.addEventListener('input', syncTodayHint);
    syncTodayHint();
  }

  var fields = form.querySelectorAll('input, select, textarea');
  fields.forEach(function (field) {
    field.addEventListener('blur', function () { validateField(field); });
    field.addEventListener('input', function () {
      if (field.getAttribute('aria-invalid') === 'true') validateField(field);
    });
  });

  form.addEventListener('submit', function (e) {
    /* 已登录病人：提交交给 booking.js 走真实接口。
       这里直接返回，连 preventDefault 都不做，避免两个处理器互相覆盖提示。 */
    if (window.LSD_BOOKING && window.LSD_BOOKING.active) return;

    e.preventDefault();

    var firstInvalid = null;
    fields.forEach(function (field) {
      var ok = validateField(field);
      if (!ok && !firstInvalid) firstInvalid = field;
    });

    if (firstInvalid) {
      firstInvalid.focus();
      if (statusBox) statusBox.classList.remove('is-visible');
      return;
    }

    // 演示用：无后端，仅展示提交状态，不表示预约已成立
    if (statusBox) {
      statusBox.textContent = '';
      var icon = document.createElement('span');
      icon.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
      statusBox.appendChild(icon.firstChild);
      var phoneText = (window.SITE_DATA && window.SITE_DATA.clinic && window.SITE_DATA.clinic.phone)
        ? window.SITE_DATA.clinic.phone.display
        : '0731-8888 0000';
      statusBox.appendChild(document.createTextNode(
        '演示提交完成：信息未发送，也未生成预约记录。真实预约请致电 ' + phoneText + '，以门诊电话确认为准。'
      ));
      statusBox.classList.add('is-visible');
      statusBox.setAttribute('role', 'status');
      form.reset();
      fields.forEach(function (field) { showError(field, ''); });
      if (dateTodayHint) dateTodayHint.hidden = true;
      markDoctorServices();
      updateDoctorSuggestion();
      statusBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
})();
