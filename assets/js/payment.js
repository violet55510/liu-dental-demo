/* =========================================================
   assets/js/payment.js — 第五期：模拟支付页
   ---------------------------------------------------------
   ⚠️ 这一页不接任何真实支付通道，也不发任何外部请求。
      本文件里所有 fetch 都是相对路径（/api/...），
      Network 面板里只会出现本站地址。

   页面上的数字全部来自服务端：
     - 金额：order.amount_text（服务端按价格表算好）
     - 状态：order.status
   前端不做任何金额计算，也不相信 URL 里的任何金额参数
   （本页根本不读这类参数）。

   所有文本都用 textContent 写入，不拼 innerHTML。
   ========================================================= */
(function () {
  'use strict';

  var ORDER_TEXT = { unpaid: '待支付', paid: '已支付', refunded: '已退款' };
  var orderId = null;

  function $(id) { return document.getElementById(id); }

  function setStatus(msg, kind) {
    var box = $('pay-status');
    if (!box) return;
    box.classList.remove('is-visible', 'is-error', 'is-ok');
    box.textContent = msg || '';
    if (!msg) return;
    box.classList.add('is-visible');
    if (kind === 'error') box.classList.add('is-error');
    if (kind === 'ok') box.classList.add('is-ok');
  }

  function showGuest(title, text) {
    $('pay-loading').hidden = true;
    $('pay-app').hidden = true;
    $('pay-guest').hidden = false;
    if (title) $('pay-guest-title').textContent = title;
    if (text) $('pay-guest-text').textContent = text;
  }

  /* 预约信息（订单还没建出来时也要能显示：已取消、缺项目都走这条路） */
  function fillAppointment(appt) {
    $('pay-when').textContent = appt.date + ' ' + appt.start_time + '–' + appt.end_time;
    $('pay-doctor').textContent = appt.doctor.name + (appt.doctor.dept ? '（' + appt.doctor.dept + '）' : '');
    $('pay-service').textContent = appt.service ? appt.service.label : '未记录项目（无法计费）';
    if (appt.service) $('pay-amount').textContent = appt.service.amount_text;
  }

  function renderOrder(order) {
    orderId = order.id;

    $('pay-order-no').textContent = '订单 #' + order.id + ' · 预约 #' + order.appointment_id;
    $('pay-badge').textContent = ORDER_TEXT[order.status] || order.status;
    $('pay-badge').setAttribute('data-order-status', order.status);

    $('pay-amount').textContent = order.amount_text;
    if (order.service && order.service.label) $('pay-service').textContent = order.service.label;
    $('pay-state').textContent = (ORDER_TEXT[order.status] || order.status) + '（模拟）';
    $('pay-paid-at').textContent = order.paid_at || '—';
    $('pay-refunded-at').textContent = order.refunded_at || '—';

    var cancelled = order.appointment && order.appointment.status === 'cancelled';
    var payBtn = $('pay-btn');
    var refundBtn = $('refund-btn');

    /* 已取消 / 未到诊的预约不提供支付入口（服务端也会 409），
       避免"点了才知道不行"。两种状态都没有发生诊疗，没有收费依据。 */
    var apptStatus = order.appointment && order.appointment.status;
    var blocked = apptStatus === 'cancelled' || apptStatus === 'no_show';
    payBtn.hidden = order.status !== 'unpaid' || blocked;
    if (!payBtn.hidden) payBtn.textContent = '支付 ' + order.amount_text + '（模拟）';
    refundBtn.hidden = order.status !== 'paid';

    if (blocked && order.status === 'unpaid') {
      setStatus(
        apptStatus === 'no_show'
          ? '这条预约已标记「未到诊」，订单不能支付。'
          : '这条预约已取消，订单不能支付。',
        'error'
      );
    }
  }

  async function act(kind) {
    if (!orderId) return;
    var btns = [$('pay-btn'), $('refund-btn')];
    btns.forEach(function (b) { b.disabled = true; });
    setStatus(kind === 'pay' ? '正在模拟支付…' : '正在模拟退款…');

    try {
      var res = await fetch('/api/patient/orders/' + encodeURIComponent(orderId) + '/' + kind, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      var data = await res.json();

      if (!res.ok) {
        /* 409 也把服务端返回的最新订单展示出来：用户看到的永远是真实状态 */
        setStatus(data.error || '操作失败', 'error');
        if (data.order) renderOrder(data.order);
        return;
      }

      renderOrder(data.order);
      setStatus(
        kind === 'pay'
          ? '模拟支付成功：订单已标记为「已支付」，未发生真实扣款。'
          : '模拟退款成功：订单已标记为「已退款」，未发生真实资金往来。',
        'ok'
      );
    } catch (e) {
      setStatus('无法连接后端，请确认服务已启动', 'error');
    } finally {
      btns.forEach(function (b) { b.disabled = false; });
    }
  }

  /* ---------- 入口 ---------- */
  (async function boot() {
    var params = new URLSearchParams(location.search);
    var apptId = Number(params.get('appointment'));

    var back = location.pathname.split('/').pop() + location.search;
    var login = $('pay-login');
    if (login) login.href = 'login.html?next=' + encodeURIComponent(back);

    var me;
    try {
      var mres = await fetch('/api/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      me = await mres.json();
    } catch (e) {
      showGuest('没有连上后端', '请先在项目目录运行 npm start，再访问 http://localhost:3000/payment.html');
      return;
    }

    if (!me || !me.user) { showGuest(); return; }

    if (me.user.role !== 'patient') {
      showGuest('当前账号不能支付', '在线支付只对病人账号开放。请切换病人账号，或直接致电门诊。');
      return;
    }

    if (!Number.isInteger(apptId) || apptId <= 0) {
      showGuest('缺少预约参数', '请从「我的预约」里点「去支付」进入本页。');
      return;
    }

    /* 1) 预约详情：先确认这条预约是本人的（服务端 403 才算数） */
    var appt;
    try {
      var dres = await fetch('/api/patient/appointments/' + encodeURIComponent(apptId), {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      var ddata = await dres.json();
      if (!dres.ok) {
        showGuest('打不开这条预约', ddata.error || '请返回控制台后重试。');
        return;
      }
      appt = ddata.appointment;
    } catch (e) {
      showGuest('无法连接后端', '请确认服务已启动后重试。');
      return;
    }

    fillAppointment(appt);

    /* 先把按钮挂上：即使下面下单失败，按钮也不会变成"点了没反应"的空壳 */
    $('pay-btn').addEventListener('click', function () { act('pay'); });
    $('refund-btn').addEventListener('click', function () { act('refund'); });

    /* 这里**故意不显示** #pay-app。
       之前是拿到预约详情就显示，结果订单还没回的那一瞬间，
       用户看到的是状态「—」、两个按钮都没有，像页面坏了。
       改成「订单渲染完再一起显示」：加载期只有 #pay-loading。 */

    /* 2) 创建或取回订单（幂等：重复进入不会多出一单） */
    try {
      var ores = await fetch('/api/patient/appointments/' + encodeURIComponent(apptId) + '/order', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      var odata = await ores.json();

      if (!ores.ok) {
        $('pay-order-no').textContent = '预约 #' + apptId + ' · 未创建订单';
        $('pay-badge').textContent = '无法下单';
        $('pay-badge').setAttribute('data-order-status', 'none');
        $('pay-state').textContent = '未创建';
        setStatus(odata.error || '无法创建订单', 'error');
        /* 失败也要把页面放出来，否则用户只看到一直转圈 */
        $('pay-loading').hidden = true;
        $('pay-app').hidden = false;
        return;
      }

      renderOrder(odata.order);
      $('pay-sub').textContent = odata.created
        ? '已根据这条预约生成订单。金额由服务端按项目价格表计算。'
        : '这条预约已经有订单，直接沿用（重复进入不会重复下单）。';

      /* 订单、金额、状态、按钮都就位了，再一次性显示 */
      $('pay-loading').hidden = true;
      $('pay-app').hidden = false;
    } catch (e) {
      setStatus('无法连接后端，请确认服务已启动', 'error');
      $('pay-loading').hidden = true;
      $('pay-app').hidden = false;
    }
  })();
})();
