/* =========================================================
   pages/my-appointments/my-appointments.js — 我的预约
   ---------------------------------------------------------
   三件事：列出自己的预约、取消自己的预约、模拟支付 / 退款。

   取消用 wx.showModal 二次确认（不是点了就取消）：
   取消会释放号源，手滑一次别人就能约走，必须确认。

   24 小时规则不在前端算：
   服务端返回 cancellable + cancel_rule.reason，
   前端只按这个布尔值决定按钮能不能点。
   前端自己算一遍一定会和服务器差几个小时（时区 / 时钟）。

   ★ 支付同样不自己算金额 ★
   金额由服务端按「预约记录的服务项目 → 价格表」取，
   前端只负责把 order.amount_text 显示出来。
   这里也不判断「这条预约能不能付」的最终结论 ——
   canPay / canRefund 只决定按钮出不出现，
   真正能不能付由服务端在 pay 接口里判（409 带中文原因）。
   ========================================================= */
const api = require('../../utils/api');
const request = require('../../utils/request');

const STATUS_CLASS = {
  pending: 'warn',
  confirmed: 'ok',
  completed: 'muted',
  cancelled: 'muted',
  no_show: 'muted'
};

/* 已结束的预约不再有支付入口：服务端也会用 409 APPOINTMENT_NOT_PAYABLE 挡住，
   这里先不显示按钮，省得用户点了才被拒。 */
const SETTLED = { cancelled: true, no_show: true };

function toView(a) {
  const order = a.order || null;

  /* 已有订单 → 看订单状态；没有订单 → 只有 pending / confirmed 能新建订单
     （completed 的服务端不允许再开单，这是 ORDERABLE_APPT 的边界）。 */
  const canPay = !SETTLED[a.status] && (order
    ? order.status === 'unpaid'
    : (a.status === 'pending' || a.status === 'confirmed'));

  return {
    id: a.id,
    status: a.status,
    statusLabel: a.status_label || a.status,
    statusClass: STATUS_CLASS[a.status] || 'muted',
    date: a.date,
    time: a.start_time + '–' + a.end_time,
    doctor: a.doctor_name || '',
    dept: a.doctor_dept || '',
    serviceLabel: a.service ? a.service.label : '未记录项目',
    /* 有订单用订单金额，没订单用项目标价（真正下单时以服务端算的为准） */
    amountText: order ? order.amount_text : (a.service ? a.service.amount_text : ''),
    canCancel: !!a.cancellable,
    cancelHint: a.cancellable ? '' : '该时段已开始，需电话联系门诊取消或改期',
    orderLabel: order ? ('订单 ' + order.status_label) : '尚未生成订单',
    /* 退款要按订单 id 调接口，列表接口的 order 摘要里就带 id */
    orderId: order ? order.id : 0,
    canPay: canPay,
    canRefund: !!order && order.status === 'paid'
  };
}

Page({
  data: {
    needLogin: false,
    loading: true,
    error: '',
    appointments: [],
    cancellingId: 0,
    payingId: 0,
    refundingId: 0
  },

  onLoad: function () {
    return this.load();
  },

  /* 从预约页提交完回来时刷新一次（这时候列表应该多一条） */
  onShow: function () {
    if (this.data.needLogin && request.isLoggedIn()) return this.load();
    if (this._dirty) { this._dirty = false; return this.load(); }
    return Promise.resolve();
  },

  load: function () {
    if (!request.isLoggedIn()) {
      this.setData({ needLogin: true, loading: false });
      console.log('[我的预约] 未登录：显示登录引导');
      return Promise.resolve();
    }

    const that = this;
    this.setData({ needLogin: false, loading: true, error: '' });

    return api.listMyAppointments()
      .then(function (list) {
        that.setData({
          loading: false,
          appointments: list.map(toView)
        });
        console.log('[我的预约] ' + list.length + ' 条：' +
          list.map(function (a) { return '#' + a.id + a.status_label; }).join('、'));
      })
      .catch(function (err) {
        that.setData({
          loading: false,
          error: (err && err.message) || '加载失败，请稍后重试'
        });
      });
  },

  reload: function () {
    return this.load();
  },

  goLogin: function () {
    wx.reLaunch({
      url: '/pages/login/login?redirect=' + encodeURIComponent('/pages/my-appointments/my-appointments')
    });
  },

  goBook: function () {
    wx.switchTab({ url: '/pages/appointment/appointment' });
  },

  /* ---------- 取消（两步确认） ---------- */
  cancel: function (e) {
    const idx = Number(e.currentTarget.dataset.index);
    const item = this.data.appointments[idx];
    if (!item) return;
    if (!item.canCancel) {
      wx.showToast({ title: item.cancelHint || '该预约不能自助取消', icon: 'none', duration: 2600 });
      return;
    }

    const that = this;
    wx.showModal({
      title: '取消预约',
      content: '确定取消 ' + item.date + ' ' + item.time + ' 的预约吗？取消后该时段会释放给其他患者。',
      confirmText: '取消预约',
      cancelText: '再想想',
      success: function (res) {
        if (!res.confirm) {
          console.log('[我的预约] 用户放弃取消 #' + item.id);
          return;
        }
        that.doCancel(item.id);
      }
    });
  },

  doCancel: function (id) {
    const that = this;
    this.setData({ cancellingId: id });

    return api.cancelAppointment(id)
      .then(function (body) {
        that.setData({ cancellingId: 0 });
        wx.showToast({ title: '已取消', icon: 'success', duration: 1400 });
        console.log('[我的预约] 已取消 #' + id + ' → ' + (body && body.status));
        return that.load();
      })
      .catch(function (err) {
        that.setData({ cancellingId: 0 });
        request.toastError(err);
        console.log('[我的预约] 取消失败 #' + id + '：' + ((err && err.message) || '未知错误'));
        /* 失败常见原因：刚被别人改成 completed / 时段已经开始。
           重新拉一次列表，按钮状态就跟着服务端更新了。 */
        if (err && err.statusCode === 409) return that.load();
        return null;
      });
  },

  /* ---------- 模拟支付（两步：先确保订单存在，再确认金额） ----------
     顺序不能反：金额必须来自服务端算出的那张订单，
     先弹窗写死一个价格再下单，等于让前端决定收多少钱。 */
  pay: function (e) {
    const idx = Number(e.currentTarget.dataset.index);
    const item = this.data.appointments[idx];
    if (!item || !item.canPay) return;
    if (this.data.payingId) return;          // 连点保护

    const that = this;
    this.setData({ payingId: item.id });
    wx.showLoading({ title: '准备订单…', mask: true });

    api.ensureOrder(item.id)
      .then(function (order) {
        wx.hideLoading();
        that.setData({ payingId: 0 });

        const serviceLabel = (order.service && order.service.label) || item.serviceLabel;
        wx.showModal({
          title: '模拟支付',
          content: '项目：' + serviceLabel +
            '\n金额：' + order.amount_text +
            '\n\n这是演示用的模拟支付，不会产生任何真实扣款。',
          confirmText: '确认支付',
          cancelText: '再想想',
          success: function (res) {
            if (!res.confirm) {
              console.log('[我的预约] 用户放弃支付订单 #' + order.id);
              return;
            }
            that.doPay(order.id, item.id);
          }
        });
      })
      .catch(function (err) {
        wx.hideLoading();
        that.setData({ payingId: 0 });
        request.toastError(err);
        console.log('[我的预约] 建单失败 #' + item.id + '：' + ((err && err.message) || '未知错误'));
        /* 409 = 预约状态已变（例如刚被取消），刷新让按钮回到真实状态 */
        if (err && err.statusCode === 409) return that.load();
        return null;
      });
  },

  /* payingId 存的是「预约 id」而不是订单 id：
     按钮的 disabled 判断用的是 item.id（预约），两边必须同一个口径。 */
  doPay: function (orderId, apptId) {
    const that = this;
    this.setData({ payingId: apptId || orderId });

    return api.payOrder(orderId)
      .then(function (body) {
        that.setData({ payingId: 0 });
        wx.showToast({ title: '模拟支付完成', icon: 'success', duration: 1600 });
        console.log('[我的预约] 支付完成订单 #' + orderId + ' → ' +
          (body && body.order && body.order.status));
        return that.load();
      })
      .catch(function (err) {
        that.setData({ payingId: 0 });
        request.toastError(err);
        console.log('[我的预约] 支付失败 #' + orderId + '：' + ((err && err.message) || '未知错误'));
        if (err && err.statusCode === 409) return that.load();
        return null;
      });
  },

  /* ---------- 模拟退款 ----------
     退款是终态：退了就不能再付（服务端 409 ALREADY_REFUNDED），
     所以文案要把这一点说清楚，不能让人以为是「撤销一下还能再付」。 */
  refund: function (e) {
    const idx = Number(e.currentTarget.dataset.index);
    const item = this.data.appointments[idx];
    if (!item || !item.canRefund) return;
    if (this.data.refundingId) return;

    const that = this;
    wx.showModal({
      title: '模拟退款',
      content: '退回 ' + item.amountText + ' 的模拟支付款。\n退款后订单关闭，不能再支付。\n（演示功能，不涉及真实资金）',
      confirmText: '确认退款',
      cancelText: '再想想',
      success: function (res) {
        if (!res.confirm) {
          console.log('[我的预约] 用户放弃退款 #' + item.id);
          return;
        }
        that.doRefund(item);
      }
    });
  },

  doRefund: function (item) {
    const that = this;
    const orderId = item.orderId;
    if (!orderId) {
      request.toastError({ message: '订单信息不完整，请下拉刷新后重试' });
      return Promise.resolve();
    }

    this.setData({ refundingId: item.id });
    return api.refundOrder(orderId)
      .then(function (body) {
        that.setData({ refundingId: 0 });
        wx.showToast({ title: '已退款（模拟）', icon: 'success', duration: 1600 });
        console.log('[我的预约] 退款完成订单 #' + orderId + ' → ' +
          (body && body.order && body.order.status));
        return that.load();
      })
      .catch(function (err) {
        that.setData({ refundingId: 0 });
        request.toastError(err);
        console.log('[我的预约] 退款失败 #' + orderId + '：' + ((err && err.message) || '未知错误'));
        if (err && err.statusCode === 409) return that.load();
        return null;
      });
  }
});
