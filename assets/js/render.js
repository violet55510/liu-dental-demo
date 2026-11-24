/* =========================================================
   刘氏口腔 · 配置渲染层
   ---------------------------------------------------------
   读取 window.SITE_DATA，把「联系方式 / 营业时间 / 医师列表 /
   诊疗项目」渲染到页面上的 data-site 挂载点。
   必须在 main.js 之前加载：main.js 依赖渲染后的下拉选项。
   ========================================================= */
(function () {
  'use strict';

  var D = window.SITE_DATA;
  if (!D || !D.clinic) return;

  var C = D.clinic;
  var TODAY = new Date().getDay(); // 0 = 周日

  /* ---------- 工具 ---------- */
  function all(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }
  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function pendingText(value, fallback) {
    return value ? esc(value) : esc(fallback);
  }
  function timeRange(day) {
    return esc(day.open) + ' – ' + esc(day.close);
  }

  var ICON = {
    pin: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 6-9 12-9 12s-9-6-9-12a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    phone: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8.1 9.7a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.9 2.2z"/></svg>',
    mail: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 7l-10 6L2 7"/></svg>',
    qr: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3z"/><path d="M20 14v3M14 20h3M20 20h1"/></svg>',
    doc: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h4"/><path d="M7 13h7"/><path d="M7 17h5"/></svg>',
    person: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M5 21c0-3.9 3.1-7 7-7s7 3.1 7 7"/></svg>'
  };

  /* ---------- 1. 电话：统一 href 与可见号码 ---------- */
  function renderPhone() {
    all('a[href^="tel:"]').forEach(function (a) {
      a.setAttribute('href', 'tel:' + C.phone.tel);
      // 链接文本只有号码时整体替换；含「电话咨询」等前缀的只替换号码部分
      var text = a.textContent;
      if (/^[\s\d\-+]+$/.test(text)) {
        a.textContent = C.phone.display;
      }
    });
    all('[data-site="phone-text"]').forEach(function (node) {
      node.textContent = C.phone.display;
    });
  }

  /* ---------- 2. 地址 ---------- */
  function renderAddress() {
    var full = C.address.city + '（' + C.address.note + '）';
    all('[data-site="address-line"]').forEach(function (node) {
      node.innerHTML = esc(C.address.city) + ' <strong>（' + esc(C.address.note) + '）</strong>';
    });
    all('[data-site="address-plain"]').forEach(function (node) {
      node.textContent = full;
    });
    all('[data-site="address-city"]').forEach(function (node) {
      node.textContent = C.address.city;
    });
    all('[data-site="address-detail"]').forEach(function (node) {
      node.textContent = C.address.line1 || '详细地址待填充';
    });
    all('[data-site="address-map"]').forEach(function (node) {
      node.innerHTML = esc(C.address.city) + ' · ' + (C.address.line1 ? esc(C.address.line1) : '详细门牌待填充');
    });
  }

  /* ---------- 3. 营业时间 ---------- */
  function hoursSummary() {
    var days = C.hours.days;
    var uniform = days.every(function (d) { return d.open === days[0].open && d.close === days[0].close; });
    if (uniform) return '周一至周日 ' + timeRange(days[0]);
    return '以门诊排班为准';
  }

  function renderHours() {
    all('[data-site="hours-line"]').forEach(function (node) {
      node.textContent = hoursSummary() + '（' + C.hours.holidayNote + '）';
    });
    all('[data-site="hours-plain"]').forEach(function (node) {
      node.textContent = '每日 ' + timeRange(C.hours.days[0]);
    });
    all('[data-site="hours-note"]').forEach(function (node) {
      node.textContent = C.hours.holidayNote;
    });
    all('[data-site="hours-caption"]').forEach(function (node) {
      node.textContent = C.hours.caption || '';
    });

    // 表格主体
    all('[data-hours-body]').forEach(function (tbody) {
      tbody.innerHTML = C.hours.days.map(function (day) {
        var isToday = day.weekday === TODAY;
        return '<tr data-weekday="' + day.weekday + '"' + (isToday ? ' class="is-today"' : '') + '>' +
          '<th scope="row">' + esc(day.label) + '</th>' +
          '<td>' + timeRange(day) + '</td>' +
          '<td>' + esc(day.note || '') + '</td>' +
          '</tr>';
      }).join('');
    });
  }

  /* ---------- 4. 页脚联系区 ---------- */
  function renderFooterContact() {
    var html =
      '<li><a href="tel:' + esc(C.phone.tel) + '">' + esc(C.phone.display) + '</a></li>' +
      '<li>' + esc(C.address.city) + '（' + esc(C.address.note) + '）</li>' +
      '<li>每日 ' + timeRange(C.hours.days[0]) + '</li>';
    all('[data-site="footer-contact"]').forEach(function (ul) {
      ul.innerHTML = html;
    });
    all('[data-site="footer-demo"]').forEach(function (node) {
      node.textContent = C.demoNotice;
    });
  }

  /* ---------- 5. 联系我们信息卡 ---------- */
  function renderContactCards() {
    all('[data-contact-cards]').forEach(function (grid) {
      var qrInner = C.wechat.qr
        ? '<img class="qr-img" src="' + esc(C.wechat.qr) + '" alt="' + esc(C.wechat.label + '二维码') + '" width="88" height="88">'
        : '<div class="qr-placeholder" role="img" aria-label="' + esc(C.wechat.label + '二维码占位，待补充') + '"><span>二维码<br>待填充</span></div>';

      grid.innerHTML = [
        '<div class="card contact-card reveal">' +
          '<span class="icon-box" aria-hidden="true">' + ICON.pin + '</span>' +
          '<p class="label">门诊地址</p>' +
          '<p class="value">' + esc(C.address.city) + '</p>' +
          '<p class="extra">' + (C.address.line1 ? esc(C.address.line1) : '详细门牌待填充') + '</p>' +
        '</div>',
        '<div class="card contact-card reveal">' +
          '<span class="icon-box icon-box--green" aria-hidden="true">' + ICON.phone + '</span>' +
          '<p class="label">预约电话</p>' +
          '<p class="value"><a href="tel:' + esc(C.phone.tel) + '">' + esc(C.phone.display) + '</a></p>' +
          '<p class="extra">接诊时间内有人接听，急诊请直接致电</p>' +
        '</div>',
        '<div class="card contact-card reveal">' +
          '<span class="icon-box" aria-hidden="true">' + ICON.mail + '</span>' +
          '<p class="label">咨询邮箱</p>' +
          '<p class="value"><a href="mailto:' + esc(C.email.address) + '">' + esc(C.email.address) + '</a></p>' +
          '<p class="extra">' + esc(C.email.note) + '</p>' +
        '</div>',
        '<div class="card contact-card reveal">' +
          '<span class="icon-box icon-box--green" aria-hidden="true">' + ICON.qr + '</span>' +
          '<p class="label">' + esc(C.wechat.label) + '</p>' +
          qrInner +
          '<p class="extra">' + esc(C.wechat.note) + '</p>' +
        '</div>'
      ].join('');
    });
  }

  /* ---------- 6. 医师卡片 ---------- */
  function avatarChar(name) {
    return esc((name || '医').trim().charAt(0));
  }

  function photoBlock(doc) {
    if (doc.photo) {
      return '<div class="doctor-photo">' +
        '<img class="doctor-img" src="' + esc(doc.photo) + '" alt="' +
        esc(doc.name + '，' + doc.dept + doc.title + '，门诊出诊医师照片') + '" loading="lazy">' +
        '</div>';
    }
    return '<div class="doctor-photo">' +
      '<span class="avatar" aria-hidden="true">' + avatarChar(doc.name) + '</span>' +
      '<span class="photo-note">照片待填充</span>' +
      '</div>';
  }

  function doctorFullCard(doc) {
    var years = esc(doc.years) + (doc.yearsPending ? '（待填充）' : '');
    var license = doc.license
      ? esc(doc.license)
      : '<span class="is-todo">执业医师证书编号 待填充</span>';
    var schedule = esc(doc.schedule) + (doc.schedulePending ? '（待填充）' : '');

    return '<article class="card doctor-card doctor-card--full reveal">' +
      photoBlock(doc) +
      '<div class="doctor-body">' +
        '<h3>' + esc(doc.name) + '</h3>' +
        '<p class="doctor-title">' + esc(doc.dept) + ' · ' + esc(doc.title) + '</p>' +
        '<p class="doctor-desc">' + esc(doc.intro) + '</p>' +
        '<div class="chip-row">' + doc.tags.map(function (t) {
          return '<span class="chip">' + esc(t) + '</span>';
        }).join('') + '</div>' +
        '<dl class="doctor-meta">' +
          '<div><dt>从业年限</dt><dd>' + years + '</dd></div>' +
          '<div><dt>执业资质</dt><dd>' + license + '</dd></div>' +
          '<div><dt>出诊时间</dt><dd>' + schedule + '</dd></div>' +
        '</dl>' +
        '<div class="doctor-cta">' +
          '<a class="btn btn--primary btn--sm" href="appointment.html?doctor=' + esc(doc.id) + '">预约该医师</a>' +
        '</div>' +
      '</div>' +
    '</article>';
  }

  function doctorPreviewCard(doc) {
    return '<article class="card doctor-card reveal">' +
      photoBlock(doc) +
      '<div class="doctor-body">' +
        '<h3>' + esc(doc.name) + '</h3>' +
        '<p class="doctor-title">' + esc(doc.dept) + ' · ' + esc(doc.title) + '</p>' +
        '<p class="doctor-desc">' + esc(doc.shortIntro || doc.intro) + '</p>' +
        '<div class="chip-row">' + doc.tags.slice(0, 2).map(function (t) {
          return '<span class="chip">' + esc(t) + '</span>';
        }).join('') + '</div>' +
      '</div>' +
    '</article>';
  }

  function renderDoctors() {
    all('[data-doctor-list]').forEach(function (grid) {
      grid.innerHTML = D.doctors.map(doctorFullCard).join('');
    });
    all('[data-doctor-preview]').forEach(function (grid) {
      var limit = parseInt(grid.getAttribute('data-limit'), 10) || 3;
      grid.innerHTML = D.doctors.slice(0, limit).map(doctorPreviewCard).join('');
    });
  }

  /* ---------- 7. 资质与证照 ---------- */
  function findLicense(rec) {
    return (C.licenses || []).filter(function (x) { return x && x.id === rec; })[0];
  }

  function renderLicenses() {
    // 7.1 资质说明行：证号缺失时渲染「待填充」，不写死任何编号
    all('[data-license-item]').forEach(function (li) {
      var rec = findLicense(li.getAttribute('data-license-item'));
      if (!rec) return;
      var no = rec.no
        ? esc(rec.noLabel) + '：' + esc(rec.no)
        : '<span class="is-todo">' + esc(rec.noLabel) + '待填充</span>';
      li.innerHTML = '<strong>' + esc(rec.label) + '：</strong>《' + esc(rec.title) + '》' +
        esc(rec.summary) + '（' + no + '）。';
    });

    // 7.2 扫描件位：有图用图，无图渲染虚线占位
    all('[data-license-slot]').forEach(function (box) {
      var rec = findLicense(box.getAttribute('data-license-slot'));
      if (!rec) return;
      if (rec.image) {
        box.classList.add('photo-slot--filled');
        box.innerHTML = '<img src="' + esc(rec.image) + '" alt="《' + esc(rec.title) +
          '》扫描件" loading="lazy">';
      } else {
        box.classList.remove('photo-slot--filled');
        box.innerHTML = (ICON[rec.icon] || ICON.doc) +
          '<span><strong>' + esc(rec.title) + '</strong>' + esc(rec.imageNote || '待补充') + '</span>';
      }
    });
  }

  /* ---------- 7.3 费用区间：数据来自 data.js，HTML 里不写死金额 ---------- */
  /* 为什么放在这里而不是写死在 services.html：
     套餐区间和订单计费用的是同一份数据（data.js 的 services[]），
     页面上改价却忘了改价格表，是这类演示站最常见的"两处不一致"。
     服务端启动时会校验 amount_cents 落在区间内，浏览器端只负责显示。 */
  function fmtYuan(cents) {
    var yuan = cents / 100;
    var text = Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2);
    return text.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function renderPriceBoxes() {
    all('[data-price-box]').forEach(function (box) {
      var id = box.getAttribute('data-price-box');
      var svc = null;
      (D.services || []).forEach(function (s) { if (s.id === id) svc = s; });
      if (!svc || !svc.price_range) return;

      var r = svc.price_range;
      var label = box.querySelector('[data-price-label]');
      var range = box.querySelector('[data-price-range]');
      var unit = box.querySelector('[data-price-unit]');

      if (label) label.textContent = r.label || '';
      if (range) range.textContent = '¥' + fmtYuan(r.min_cents) + ' – ' + fmtYuan(r.max_cents);
      if (unit) unit.textContent = '/ ' + r.unit + ' · ' + r.note;
    });
  }

  /* ---------- 8. 预约页下拉 ---------- */
  function renderSelects() {
    all('[data-doctor-select]').forEach(function (select) {
      select.innerHTML = '<option value="">不指定，由门诊安排</option>' +
        D.doctors.map(function (doc) {
          return '<option value="' + esc(doc.id) + '" data-dept="' + esc(doc.dept) +
            '" data-name="' + esc(doc.name) + '">' + esc(doc.name) + '（' + esc(doc.dept) + '）</option>';
        }).join('');
    });

    all('[data-service-select]').forEach(function (select) {
      select.innerHTML = '<option value="">请选择项目</option>' +
        D.services.map(function (svc) {
          return '<option value="' + esc(svc.id) + '" data-doctors="' + esc((svc.doctors || []).join(' ')) +
            '">' + esc(svc.label) + '</option>';
        }).join('');
    });
  }

  /* ---------- 执行 ---------- */
  renderPhone();
  renderAddress();
  renderHours();
  renderFooterContact();
  renderContactCards();
  renderDoctors();
  renderLicenses();
  renderPriceBoxes();
  renderSelects();

  // 暴露给其它脚本复用（main.js 的提交提示里会用到电话号码）
  window.SITE_RENDER = { phone: C.phone, address: C.address, hours: C.hours };
})();
