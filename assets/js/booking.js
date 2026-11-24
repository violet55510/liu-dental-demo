/* =========================================================
   assets/js/booking.js — 真实预约（第二期）
   ---------------------------------------------------------
   和 main.js 的分工：
     main.js     校验、?doctor= 预选、医师↔项目联动、日期范围、演示提交
     booking.js  仅在「已登录的病人」时接管：加载可约时段 + 调接口提交

   接管方式是设一个全局开关 window.LSD_BOOKING.active，
   main.js 的 submit 处理器看到它为真就直接返回。
   这样未登录时页面行为与第一阶段完全一致，回归脚本不受影响。

   两条约束：
     1. 可约时段必须来自 /api/schedules，不能在前端自己算。
     2. 提交结果的文案必须如实——写进库了就说写进库了，
        「演示站点」不等于「假装成功」。
   ========================================================= */
(function () {
  'use strict';

  var form = document.getElementById('appointment-form');
  if (!form) return;

  var bar = document.getElementById('booking-bar');
  var timeSelect = document.getElementById('f-time');
  var dateInput = document.getElementById('f-date');
  var doctorSelect = document.getElementById('f-doctor');
  var nameInput = document.getElementById('f-name');
  var phoneInput = document.getElementById('f-phone');
  var statusBox = document.getElementById('form-status');
  var timeHint = document.getElementById('time-hint');
  var consent = document.getElementById('f-consent');

  var doctorMap = {};        // slug（liu-ortho）→ 数据库 id
  var online = false;

  function setStatus(msg, kind) {
    if (!statusBox) return;
    statusBox.classList.remove('is-error', 'is-ok', 'is-visible');
    statusBox.textContent = '';
    if (!msg) return;

    var text = document.createElement('span');
    text.textContent = msg;                 // 纯文本，服务端消息也当文字
    statusBox.appendChild(text);
    statusBox.classList.add('is-visible');
    if (kind) statusBox.classList.add(kind === 'error' ? 'is-error' : 'is-ok');
  }

  function setBar(html, kind) {
    if (!bar) return;
    bar.hidden = false;
    bar.className = 'booking-bar' + (kind ? ' booking-bar--' + kind : '');
    bar.textContent = '';

    /* 只用固定的几段文本 + 真实元素拼，不把任何用户数据当 HTML */
    (html || []).forEach(function (part) {
      if (typeof part === 'string') {
        bar.appendChild(document.createTextNode(part));
      } else {
        bar.appendChild(part);
      }
    });
  }

  function link(href, text, cls) {
    var a = document.createElement('a');
    a.href = href;
    a.textContent = text;
    if (cls) a.className = cls;
    return a;
  }

  function setTimeOptions(list, placeholder) {
    if (!timeSelect) return;
    timeSelect.textContent = '';

    var first = document.createElement('option');
    first.value = '';
    first.textContent = placeholder;
    timeSelect.appendChild(first);

    list.forEach(function (s) {
      var opt = document.createElement('option');
      opt.value = String(s.id);
      opt.textContent = s.start_time + '–' + s.end_time + (s.taken ? '（已约）' : '');
      if (s.taken || !s.open) opt.disabled = true;
      timeSelect.appendChild(opt);
    });
  }

  function resetTime(placeholder) {
    setTimeOptions([], placeholder);
    if (timeHint) timeHint.textContent = '时段由门诊排班实时决定';
  }

  /* ---------- 加载某医师某天的可约时段 ---------- */
  var reqToken = 0;
  async function loadSlots() {
    if (!online) return;

    var slug = doctorSelect ? doctorSelect.value : '';
    var date = dateInput ? dateInput.value : '';

    if (!slug) { resetTime('请先选择医师'); return; }
    if (!date) { resetTime('请先选择日期'); return; }

    var dbId = doctorMap[slug];
    if (!dbId) { resetTime('该医师暂未开放线上号源'); return; }

    var token = ++reqToken;
    setTimeOptions([], '正在加载可约时段…');

    try {
      var res = await fetch('/api/schedules?doctor_id=' + encodeURIComponent(dbId) + '&date=' + encodeURIComponent(date), {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      var data = await res.json();

      if (token !== reqToken) return;      // 期间用户又改了医生/日期，丢弃旧响应

      if (!res.ok) { resetTime(data.error || '时段加载失败'); return; }

      var slots = data.slots || [];
      if (!slots.length) {
        resetTime('当日没有排班，请换一天');
        return;
      }

      var free = slots.filter(function (s) { return s.open && !s.taken; });
      if (!free.length) {
        setTimeOptions(slots, '当日已约满，请换一天');
        if (timeHint) timeHint.textContent = '当日时段均已被预约';
        return;
      }

      setTimeOptions(slots, '请选择时段');
      if (timeHint) timeHint.textContent = '共 ' + free.length + ' 个可约时段，提交后占用';
    } catch (e) {
      if (token === reqToken) resetTime('无法连接后端');
    }
  }

  /* ---------- 提交 ---------- */
  async function submitOnline(e) {
    e.preventDefault();

    var serviceSelect = document.getElementById('f-service');
    var slotId = Number(timeSelect && timeSelect.value);
    var name = (nameInput && nameInput.value || '').trim();
    var phone = (phoneInput && phoneInput.value || '').trim();
    var note = (document.getElementById('f-message') || {}).value || '';

    if (!name) { setStatus('请填写姓名', 'error'); nameInput && nameInput.focus(); return; }
    if (!/^1[3-9]\d{9}$/.test(phone.replace(/[\s-]/g, ''))) {
      setStatus('请输入 11 位手机号', 'error');
      phoneInput && phoneInput.focus();
      return;
    }
    if (!serviceSelect || !serviceSelect.value) {
      setStatus('请选择预约项目', 'error'); serviceSelect && serviceSelect.focus(); return;
    }
    if (!doctorSelect || !doctorSelect.value) { setStatus('请选择医师', 'error'); doctorSelect && doctorSelect.focus(); return; }
    if (!slotId) { setStatus('请选择就诊时段', 'error'); timeSelect && timeSelect.focus(); return; }
    if (!consent || !consent.checked) { setStatus('请先勾选隐私说明', 'error'); consent && consent.focus(); return; }

    /* 第五期：项目单独落库（appointments.service），不再拼进备注。
       备注是给人看的自由文本；项目要拿去计费，必须是一个可校验的 id。
       服务端会再校验一次这个 id 是否在价格表里。 */
    var serviceId = serviceSelect.value;
    var finalNote = note.trim().slice(0, 200);

    var btn = form.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = '提交中…'; }
    setStatus('正在提交…');

    try {
      var res = await fetch('/api/appointments', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ schedule_id: slotId, service: serviceId, note: finalNote || undefined })
      });
      var data = await res.json();

      if (res.status === 201) {
        var a = data.appointment;
        setStatus('已提交：' + a.date + ' ' + a.start_time + '–' + a.end_time +
          '，状态「待确认」。可在「我的控制台」查看或取消。', 'ok');
        form.reset();
        if (nameInput) nameInput.value = window.LSD_ME ? window.LSD_ME.name : '';
        if (phoneInput) phoneInput.value = window.LSD_ME ? (window.LSD_ME.phone || '') : '';
        resetTime('请选择医师与日期后加载');
        if (statusBox) statusBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }

      if (data && data.code === 'SLOT_TAKEN') {
        setStatus('这个时段刚被别人约走了，请换一个时段。', 'error');
        await loadSlots();
      } else {
        setStatus((data && data.error) || '提交失败，请稍后重试', 'error');
      }
    } catch (err) {
      setStatus('无法连接后端，请确认 npm start 已运行', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '提交预约'; }
    }
  }

  /* ---------- 入口 ---------- */
  (async function boot() {
    var me;
    try {
      var res = await fetch('/api/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      me = await res.json();
    } catch (e) {
      /* 没有后端（比如直接双击打开 html）：保持第一阶段的演示行为 */
      return;
    }

    var user = me && me.user;
    window.LSD_ME = user || null;

    if (!user) {
      var a = link('login.html?next=' + encodeURIComponent('appointment.html'), '登录');
      var b = link('register.html', '注册病人账号');
      setBar(['在线预约需要登录：', a, ' 或 ', b, '。未登录时字段仅演示校验，不会发送。'], 'info');
      return;
    }

    if (user.role !== 'patient') {
      setBar(['当前登录身份是' + (user.role === 'doctor' ? '医生' : '管理员') +
        '，在线预约只对病人账号开放。可切换病人账号，或直接致电门诊。'], 'warn');
      return;
    }

    /* ---- 已登录病人：进入在线预约 ---- */
    online = true;
    window.LSD_BOOKING = { active: true };

    if (nameInput) {
      nameInput.value = user.name;
      nameInput.readOnly = true;
      nameInput.setAttribute('aria-readonly', 'true');
    }
    if (phoneInput) {
      phoneInput.value = user.phone || '';
      phoneInput.readOnly = true;
      phoneInput.setAttribute('aria-readonly', 'true');
    }

    var dash = link('dashboard.html', '我的预约');
    setBar(['已登录：' + user.name + '（' + (user.phone || '') + '）。提交后会生成真实记录，可在 ', dash, ' 查看与取消。'], 'ok');

    /* 医生 slug → 数据库 id */
    try {
      var dres = await fetch('/api/doctors', { headers: { Accept: 'application/json' } });
      var ddata = await dres.json();
      (ddata.doctors || []).forEach(function (d) { doctorMap[d.slug] = d.id; });
    } catch (e) { /* 下面 loadSlots 会提示 */ }

    if (timeHint) timeHint.textContent = '选择医师与日期后加载可约时段';

    timeSelect && timeSelect.addEventListener('change', function () {
      if (timeSelect.value) setStatus('');
    });
    doctorSelect && doctorSelect.addEventListener('change', loadSlots);
    dateInput && dateInput.addEventListener('change', loadSlots);

    /* 打开页面时如果已经带 ?doctor= 并选了日期，直接加载一次 */
    if (!doctorSelect || doctorSelect.value) loadSlots();

    form.addEventListener('submit', submitOnline);
  })();
})();
