/* =========================================================
   assets/js/dashboard.js — 控制台：按角色渲染不同视图
   ---------------------------------------------------------
   两条约束：

   1) 这里的 role 只用来「选哪块 DOM 显示」，不是权限。
      真正的权限在服务端：/api/patient/*、/api/doctor/*、/api/admin/*、
      /api/appointments/* 各自有 requireAuth + requireRole + 对象级校验，
      前端改 DOM 拿不到数据。

   2) 所有用户可控内容一律用 textContent 写入，不拼 innerHTML。
      姓名/邮箱/备注都来自用户输入，拼字符串就等于把 XSS 的门留着。
      这里连「先 escape 再 innerHTML」都不做——直接用 DOM 节点，
      省掉「某天忘了转义」的可能。
   ========================================================= */
(function () {
  'use strict';

  var ROLE_TEXT = { patient: '病人', doctor: '医生', admin: '管理员' };
  var ROLE_SUB = {
    patient: '查看自己的预约与详情，可自助取消（开始前 24 小时外）。',
    doctor: '确认、完成、标记未到诊或恢复误标记录，只作用于与自己有预约关系的患者。',
    admin: '审核医生入驻申请、停用异常账号。'
  };
  var STATUS_TEXT = {
    pending: '待确认',
    confirmed: '已确认',
    cancelled: '已取消',
    completed: '已完成',
    no_show: '未到诊'
  };

  var ORDER_TEXT = { unpaid: '待支付', paid: '已支付', refunded: '已退款' };

  var CANCEL_WINDOW_MS = 24 * 60 * 60 * 1000;

  /* 医生端只看支付状态，不做任何金额计算：
     text 与 kind 都来自服务端返回的 order 摘要。 */
  function paySummary(a) {
    if (!a.order) return { text: '未下单', kind: 'none' };
    if (a.order.status === 'paid') return { text: '已支付 ' + a.order.amount_text, kind: 'paid' };
    if (a.order.status === 'refunded') return { text: '已退款 ' + a.order.amount_text, kind: 'refunded' };
    return { text: '未支付', kind: 'unpaid' };
  }

  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  /* ---------- DOM 小工具：不带 innerHTML ---------- */
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function setStatus(node, msg, kind) {
    if (!node) return;
    node.classList.remove('is-visible', 'is-error', 'is-ok');
    node.textContent = msg || '';
    if (!msg) return;
    node.classList.add('is-visible');
    if (kind === 'error') node.classList.add('is-error');
    if (kind === 'ok') node.classList.add('is-ok');
  }

  function showGuest(note) {
    $('#dash-loading').hidden = true;
    $('#dash-guest').hidden = false;
    if (note) {
      var p = $('#dash-guest p');
      if (p) p.textContent = note;      // 纯文本，不解析 HTML
    }
  }

  /* ---------- 时间处理 ---------- */
  /* 后端返回 date=YYYY-MM-DD、start=HH:MM，按本地时间拼成时间戳 */
  function slotStart(appt) {
    var t = new Date(appt.date + 'T' + appt.start_time + ':00');
    return isNaN(t.getTime()) ? null : t.getTime();
  }

  function fmtWhen(appt) {
    return appt.date + ' ' + appt.start_time + '–' + appt.end_time;
  }

  function hoursLeft(appt) {
    var t = slotStart(appt);
    if (t === null) return null;
    return (t - Date.now()) / 3600000;
  }

  /* ---------- 预约列表（病人 / 医生共用渲染器） ----------
     两边列表长得像，差别只在「右侧按钮组」：
     病人是「详情 + 取消」，医生是「确认 / 完成 / 未到诊」。
     所以把按钮交给 opts.buildActions 生成，主干逻辑只写一份。 */
  function renderAppts(container, rows, opts) {
    clear(container);

    if (!rows.length) {
      container.appendChild(el('p', 'dash-empty', opts.emptyText));
      return;
    }

    rows.forEach(function (a) {
      var item = el('div', 'appt-item');
      /* 卡片带上预约 id：一是方便自动化测试稳定定位（终端状态没有按钮可当锚点），
         二是排查问题时能直接从 DOM 读出这条是哪个预约 */
      item.setAttribute('data-appt-id', String(a.id));

      var main = el('div', 'appt-main');
      var top = el('div', 'appt-top');
      top.appendChild(el('strong', 'appt-when', fmtWhen(a)));

      var badge = el('span', 'appt-status', STATUS_TEXT[a.status] || a.status);
      badge.setAttribute('data-status', a.status);
      top.appendChild(badge);
      main.appendChild(top);

      /* 医生看病人名；病人看医生名与科室 */
      var who = opts.viewerRole === 'doctor'
        ? '患者：' + (a.patient_name || '—')
        : '医师：' + (a.doctor_name || '—') + (a.doctor_dept ? '（' + a.doctor_dept + '）' : '');
      main.appendChild(el('p', 'appt-meta', who));

      /* 病人侧还要看到「约的是什么项目、多少钱」——金额来自服务端价格表，
         前端只负责展示，不参与计算（第五期支付） */
      if (opts.viewerRole === 'patient') {
        main.appendChild(el('p', 'appt-meta',
          a.service ? '项目：' + a.service.label + ' · ' + a.service.amount_text : '项目：未记录'));
      }

      /* 医生侧看「这单收没收到钱」。纯展示：
         没有按钮、没有操作入口，金额也只读订单表里已经落库的值。 */
      if (opts.viewerRole === 'doctor') {
        var pay = paySummary(a);
        var payRow = el('p', 'appt-pay');
        payRow.appendChild(el('span', 'appt-pay-label', '支付：'));
        var chip = el('span', 'appt-paid', pay.text);
        chip.setAttribute('data-order-status', pay.kind);
        payRow.appendChild(chip);
        main.appendChild(payRow);
      }

      if (a.note) main.appendChild(el('p', 'appt-note', '备注：' + a.note));

      item.appendChild(main);

      var actions = el('div', 'appt-actions');
      if (opts.buildActions) opts.buildActions(actions, a, item);
      if (actions.childNodes.length) item.appendChild(actions);

      /* 病人侧：不能自助取消时说明原因，而不是让按钮消失得没头没尾 */
      if (opts.explainUncancellable && (a.status === 'pending' || a.status === 'confirmed')) {
        var left = hoursLeft(a);
        if (!(left !== null && left >= 24)) {
          item.appendChild(el('p', 'appt-lock',
            left === null ? '不可取消' : '距开始不足 24 小时，请电话联系门诊'));
        }
      }

      container.appendChild(item);
    });
  }

  /* 二次确认做成行内两步，不用 window.confirm：
     第一次点击 → 变成「确认取消 / 再想想」，第二次点击才真的发请求。 */
  function buildCancelButton(id, opts) {
    var btn = el('button', 'btn btn--ghost btn--sm', '取消预约');
    btn.type = 'button';
    btn.setAttribute('data-cancel-id', String(id));

    var confirming = false;
    var box = el('span', 'appt-confirm');

    btn.addEventListener('click', function () {
      if (confirming) return;

      confirming = true;
      btn.disabled = true;
      btn.hidden = true;          // 确认区展开时把原按钮收起来，避免两行按钮打架
      clear(box);

      var ask = el('span', 'appt-confirm-text', '确认取消这次预约？');
      var yes = el('button', 'btn btn--danger btn--sm', '确认取消');
      var no = el('button', 'btn btn--ghost btn--sm', '再想想');
      yes.type = 'button';
      no.type = 'button';
      yes.setAttribute('data-cancel-confirm', String(id));
      no.setAttribute('data-cancel-abort', String(id));

      yes.addEventListener('click', function () {
        yes.disabled = true;
        no.disabled = true;
        opts.onCancel(id);
      });

      no.addEventListener('click', function () {
        confirming = false;
        btn.disabled = false;
        btn.hidden = false;
        clear(box);
      });

      box.appendChild(ask);
      box.appendChild(yes);
      box.appendChild(no);
      btn.parentNode.appendChild(box);
    });

    return btn;
  }

  /* ---------- 病人：预约详情（就地展开，不跳页） ----------
     数据来自 GET /api/patient/appointments/:id。
     详情里的「能不能取消、还差几小时」由服务端算好（cancel_rule），
     前端只负责翻译成人话——避免前后端各算一遍、算得不一样。 */
  function cancelRuleText(rule) {
    if (!rule) return '—';
    if (rule.reason === 'OK') {
      return '距开始约 ' + rule.hours_left + ' 小时，可自助取消（需在开始前 24 小时以上）';
    }
    if (rule.reason === 'TOO_LATE_TO_CANCEL') {
      return '距开始不足 24 小时（约 ' + rule.hours_left + ' 小时），请电话联系门诊';
    }
    if (rule.reason === 'ALREADY_CANCELLED') return '已取消，无需再次操作';
    return '该状态不可取消';
  }

  /* ---------- 病人：去支付 / 已支付 ----------
     只对「待确认 / 已确认」的预约显示入口。
     已经有订单且不是 unpaid（已支付、已退款）时不再给按钮，
     改成一行状态说明 —— 避免用户点进去发现什么也做不了。

     注意这里只是体验层：真正的金额与状态都在服务端，
     手工拼一个 payment.html?appointment=别人的id 也只会拿到 403。 */
  function buildPayAction(actions, a) {
    if (a.status !== 'pending' && a.status !== 'confirmed') return;

    if (a.order && a.order.status !== 'unpaid') {
      actions.appendChild(el('span', 'appt-paid',
        (ORDER_TEXT[a.order.status] || a.order.status) + ' ' + a.order.amount_text));
      return;
    }

    var link = document.createElement('a');
    link.className = 'btn btn--primary btn--sm';
    link.href = 'payment.html?appointment=' + encodeURIComponent(a.id);
    link.setAttribute('data-pay-id', String(a.id));
    link.textContent = a.order ? '继续支付' : '去支付';
    actions.appendChild(link);
  }

  function buildDetailButton(id, statusEl) {
    var btn = el('button', 'btn btn--ghost btn--sm', '预约详情');
    btn.type = 'button';
    btn.setAttribute('data-detail-id', String(id));
    btn.setAttribute('aria-expanded', 'false');

    btn.addEventListener('click', function () {
      var item = btn.closest('.appt-item');
      if (!item) return;

      var box = item.querySelector('.appt-detail');
      if (box) {
        var show = box.hidden;
        box.hidden = !show;
        btn.setAttribute('aria-expanded', show ? 'true' : 'false');
        btn.textContent = show ? '收起详情' : '预约详情';
        return;
      }

      btn.disabled = true;
      btn.textContent = '读取中…';

      fetch('/api/patient/appointments/' + encodeURIComponent(id), {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      }).then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, data: data }; });
      }).then(function (r) {
        if (!r.ok) {
          setStatus(statusEl, r.data.error || '详情读取失败', 'error');
          btn.disabled = false;
          btn.textContent = '预约详情';
          return;
        }

        var a = r.data.appointment;
        var dl = el('dl', 'appt-detail');
        function row(k, v) {
          dl.appendChild(el('dt', null, k));
          dl.appendChild(el('dd', null, v));
        }
        row('医师', a.doctor.name + (a.doctor.dept ? '（' + a.doctor.dept + '）' : ''));
        row('时段', a.date + ' ' + a.start_time + '–' + a.end_time);
        row('状态', a.status_label || STATUS_TEXT[a.status] || a.status);
        row('项目', a.service ? a.service.label : '未记录项目（无法计费）');
        row('金额', a.service ? a.service.amount_text + '（演示金额）' : '—');
        row('订单', a.order ? (ORDER_TEXT[a.order.status] || a.order.status) + ' ' + a.order.amount_text : '未创建');
        row('取消规则', cancelRuleText(a.cancel_rule));
        row('提交时间', String(a.created_at || '').replace('T', ' '));
        if (a.cancelled_at) row('取消时间', String(a.cancelled_at).replace('T', ' '));
        if (a.note) row('备注', a.note);

        item.appendChild(dl);
        btn.disabled = false;
        btn.textContent = '收起详情';
        btn.setAttribute('aria-expanded', 'true');
      }).catch(function () {
        setStatus(statusEl, '无法连接后端', 'error');
        btn.disabled = false;
        btn.textContent = '预约详情';
      });
    });

    return btn;
  }

  /* ---------- 医生：状态流转按钮 ----------
     按状态只给「合法的那一个 / 两个」按钮：
       pending   → 确认
       confirmed → 完成 / 患者未到
       no_show   → 恢复为已确认（点错了能改回来；此时号源可能已被别人重约，
                   所以按钮只是入口，真正的冲突由服务端 409 SLOT_REBOOKED 拦）
       completed / cancelled 是终态，不给按钮。
     这属于体验层的「不给你点错的机会」，真正的拦截在服务端 409 BAD_STATE。 */
  var DOCTOR_BUTTONS = {
    pending: [{ action: 'confirm', text: '确认预约', cls: 'btn--primary' }],
    confirmed: [
      { action: 'complete', text: '标记完成', cls: 'btn--primary' },
      { action: 'no-show', text: '患者未到', cls: 'btn--ghost' }
    ],
    no_show: [{ action: 'reopen', text: '恢复为已确认', cls: 'btn--ghost' }]
  };

  function buildDoctorActions(actions, a, opts) {
    var list = DOCTOR_BUTTONS[a.status] || [];
    list.forEach(function (cfg) {
      var btn = el('button', 'btn ' + cfg.cls + ' btn--sm', cfg.text);
      btn.type = 'button';
      btn.setAttribute('data-appt-id', String(a.id));
      btn.setAttribute('data-appt-action', cfg.action);
      btn.addEventListener('click', function () { opts.onAction(a.id, cfg.action); });
      actions.appendChild(btn);
    });
  }

  /* ---------- 病人：我的预约 ---------- */
  async function loadPatientAppointments(statusEl, note) {
    var box = $('#p-appts');
    if (!box) return;

    try {
      var res = await fetch('/api/patient/appointments', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      var data = await res.json();
      if (!res.ok) {
        clear(box);
        box.appendChild(el('p', 'dash-empty', data.error || '读取失败'));
        return;
      }

      renderAppts(box, data.appointments || [], {
        viewerRole: 'patient',
        explainUncancellable: true,
        emptyText: '还没有预约。点右上角「新建预约」选一个可约时段。',
        buildActions: function (actions, a) {
          /* 详情任何状态都能看；支付只在「待确认 / 已确认 且未支付」时出现；
             取消只在「待确认 / 已确认 且距开始 ≥24h」时出现 */
          actions.appendChild(buildDetailButton(a.id, statusEl));
          buildPayAction(actions, a);

          var left = hoursLeft(a);
          var cancellable = (a.status === 'pending' || a.status === 'confirmed') &&
                            left !== null && left >= 24;
          if (cancellable) actions.appendChild(buildCancelButton(a.id, {
            onCancel: function (id) { cancelAppointment(id, statusEl); }
          }));
        }
      });

      if (note) setStatus(statusEl, note, 'ok');
    } catch (e) {
      clear(box);
      box.appendChild(el('p', 'dash-empty', '无法连接后端'));
    }
  }

  async function cancelAppointment(id, statusEl) {
    setStatus(statusEl, '正在取消…');
    try {
      var res = await fetch('/api/appointments/' + encodeURIComponent(id) + '/cancel', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      var data = await res.json();

      if (!res.ok) {
        setStatus(statusEl, data.error || '取消失败', 'error');
        await loadPatientAppointments(null);
        return;
      }
      await loadPatientAppointments(statusEl, '已取消。该时段已重新放出。');
    } catch (e) {
      setStatus(statusEl, '无法连接后端', 'error');
      await loadPatientAppointments(null);
    }
  }

  /* ---------- 医生：我的患者预约（可操作） ---------- */
  async function loadDoctorAppointments(statusEl, note) {
    var box = $('#d-appts');
    if (!box) return;

    try {
      var res = await fetch('/api/doctor/appointments', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      var data = await res.json();
      if (!res.ok) {
        clear(box);
        box.appendChild(el('p', 'dash-empty', data.error || '读取失败'));
        return;
      }

      var rows = data.appointments || [];
      renderAppts(box, rows, {
        viewerRole: 'doctor',
        emptyText: '还没有患者预约你。',
        buildActions: function (actions, a) {
          buildDoctorActions(actions, a, {
            onAction: function (id, action) { doctorAction(id, action, statusEl); }
          });
        }
      });

      /* 顶部小结：一眼看出还有几条待处理，不用自己数 */
      var summary = $('#d-summary');
      if (summary) {
        var pending = rows.filter(function (a) { return a.status === 'pending'; }).length;
        var confirmed = rows.filter(function (a) { return a.status === 'confirmed'; }).length;
        summary.textContent = pending || confirmed
          ? '待确认 ' + pending + ' · 已确认 ' + confirmed
          : '暂无待处理';
      }

      if (note) setStatus(statusEl, note, 'ok');
    } catch (e) {
      clear(box);
      box.appendChild(el('p', 'dash-empty', '无法连接后端'));
    }
  }

  var ACTION_LABEL = { confirm: '确认', complete: '完成', 'no-show': '未到诊', reopen: '恢复为已确认' };

  /* 操作后只重拉列表（局部刷新），不刷新整页：
     整页刷新会丢滚动位置、也会让顶部提示消失。 */
  async function doctorAction(id, action, statusEl) {
    var label = ACTION_LABEL[action] || action;

    /* 先锁住所有按钮，避免连点造成两次请求（服务端也会拦，这里只是省一次 409） */
    $all('#d-appts button').forEach(function (b) { b.disabled = true; });
    setStatus(statusEl, '正在提交「' + label + '」…');

    try {
      var res = await fetch(
        '/api/doctor/appointments/' + encodeURIComponent(id) + '/' + action,
        { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' } }
      );
      var data = await res.json();

      if (!res.ok) {
        setStatus(statusEl, data.error || '操作失败', 'error');
        await loadDoctorAppointments(null);
        return;
      }

      await loadDoctorAppointments(statusEl, '已' + label + '。');
    } catch (e) {
      setStatus(statusEl, '无法连接后端', 'error');
      await loadDoctorAppointments(null);
    }
  }

  /* ---------- 管理员：待审核 / 已停用 ---------- */
  async function loadAdmin(status, tbody, emptyText, actionText, actionKind) {
    clear(tbody);
    var loading = el('tr');
    var td0 = el('td', 'dash-empty', '正在加载…');
    td0.colSpan = 4;
    loading.appendChild(td0);
    tbody.appendChild(loading);

    try {
      var res = await fetch('/api/admin/users?status=' + status, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      var data = await res.json();

      clear(tbody);
      if (!res.ok) {
        var errRow = el('tr');
        var errTd = el('td', 'dash-empty', data.error || '读取失败');
        errTd.colSpan = 4;
        errRow.appendChild(errTd);
        tbody.appendChild(errRow);
        return;
      }
      if (!data.users.length) {
        var emptyRow = el('tr');
        var emptyTd = el('td', 'dash-empty', emptyText);
        emptyTd.colSpan = 4;
        emptyRow.appendChild(emptyTd);
        tbody.appendChild(emptyRow);
        return;
      }

      data.users.forEach(function (u) {
        var tr = el('tr');
        tr.appendChild(el('td', null, u.name));                  // textContent
        tr.appendChild(el('td', null, u.email || u.phone || '—'));
        tr.appendChild(el('td', null, (u.created_at || '').replace('T', ' ')));

        var td = el('td');
        var btn = el('button', 'btn btn--ghost btn--sm', actionText);
        btn.type = 'button';
        btn.setAttribute('data-user-id', String(u.id));
        btn.setAttribute('data-action', actionKind);
        td.appendChild(btn);
        tr.appendChild(td);

        tbody.appendChild(tr);
      });
    } catch (e) {
      clear(tbody);
      var row = el('tr');
      var td = el('td', 'dash-empty', '无法连接后端');
      td.colSpan = 4;
      row.appendChild(td);
      tbody.appendChild(row);
    }
  }

  async function loadDisabledList() {
    var list = $('#admin-disabled');
    if (!list) return;

    clear(list);
    list.appendChild(el('li', 'dash-empty', '正在加载…'));

    try {
      var res = await fetch('/api/admin/users?status=disabled', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      var data = await res.json();

      clear(list);
      if (!res.ok || !data.users.length) {
        list.appendChild(el('li', 'dash-empty', res.ok ? '暂无已停用账号' : (data.error || '读取失败')));
        return;
      }

      data.users.forEach(function (u) {
        var li = el('li');
        li.appendChild(el('span', null, u.name + ' · ' + (u.email || u.phone || '')));

        var btn = el('button', 'btn btn--ghost btn--sm', '恢复');
        btn.type = 'button';
        btn.setAttribute('data-user-id', String(u.id));
        btn.setAttribute('data-action', 'activate');
        li.appendChild(btn);

        list.appendChild(li);
      });
    } catch (e) {
      clear(list);
      list.appendChild(el('li', 'dash-empty', '无法连接后端'));
    }
  }

  async function doAdminAction(id, action, statusEl) {
    try {
      var res = await fetch('/api/admin/users/' + encodeURIComponent(id) + '/' + action, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      var data = await res.json();
      if (!res.ok) {
        setStatus(statusEl, data.error || '操作失败', 'error');
        return false;
      }
      setStatus(statusEl, action === 'activate' ? '已激活，对方现在可以登录。' : '已停用，对方的会话会立即失效。', 'ok');
      return true;
    } catch (e) {
      setStatus(statusEl, '无法连接后端', 'error');
      return false;
    }
  }

  function initAdmin() {
    var pendingBody = $('#admin-tbody');
    var statusEl = $('#admin-status');

    function reload() {
      loadAdmin('pending', pendingBody, '暂无待审核的申请', '激活', 'activate');
      loadDisabledList();
    }

    document.addEventListener('click', async function (e) {
      var btn = e.target.closest('[data-user-id]');
      if (!btn) return;
      btn.disabled = true;
      var ok = await doAdminAction(btn.getAttribute('data-user-id'), btn.getAttribute('data-action'), statusEl);
      if (ok) reload();
      else btn.disabled = false;
    });

    var refresh = $('#admin-refresh');
    if (refresh) refresh.addEventListener('click', function () {
      setStatus(statusEl, '');
      reload();
    });

    reload();
  }

  /* ---------- 入口 ---------- */
  (async function boot() {
    var data;
    try {
      var res = await fetch('/api/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      data = await res.json();
    } catch (e) {
      showGuest('没有连上后端。请先在项目目录运行 npm start，再访问 http://localhost:3000/dashboard.html');
      return;
    }

    if (!data || !data.user) {
      showGuest();
      return;
    }

    var user = data.user;

    $('#dash-loading').hidden = true;
    $('#dash-app').hidden = false;

    /* 全部 textContent：姓名里带 < 也只当文字 */
    $('#dash-title').textContent = user.name + '，你好';
    $('#dash-sub').textContent = ROLE_SUB[user.role] || '';
    $('#dash-role').textContent = ROLE_TEXT[user.role] || user.role;
    $('#dash-role').setAttribute('data-role', user.role);
    $('#dash-account').textContent = user.phone ? ('手机号 ' + user.phone) : ('邮箱 ' + (user.email || '—'));

    if (user.role === 'patient') {
      $('#panel-patient').hidden = false;
      $('#p-name').textContent = user.name;
      $('#p-phone').textContent = user.phone || '—';
      loadPatientAppointments($('#p-status'));
    } else if (user.role === 'doctor') {
      $('#panel-doctor').hidden = false;
      $('#d-name').textContent = user.name;
      $('#d-email').textContent = user.email || '—';
      $('#d-dept').textContent = user.dept || '—';
      loadDoctorAppointments($('#d-status'));
    } else if (user.role === 'admin') {
      $('#panel-admin').hidden = false;
      initAdmin();
    } else {
      showGuest('未知角色，请联系管理员');
    }

    /* 顶栏的「登录/退出」由 session.js 统一渲染，这里不重复 */
    $all('[data-auth-slot]').forEach(function (node) { node.classList.add('is-current'); });
  })();
})();
