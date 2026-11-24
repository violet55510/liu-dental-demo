/* =========================================================
   pages/my-appointments/my-appointments.js — 我的预约
   ---------------------------------------------------------
   只做两件事：列出自己的预约、取消自己的预约。

   取消用 wx.showModal 二次确认（不是点了就取消）：
   取消会释放号源，手滑一次别人就能约走，必须确认。

   24 小时规则不在前端算：
   服务端返回 cancellable + cancel_rule.reason，
   前端只按这个布尔值决定按钮能不能点。
   前端自己算一遍一定会和服务器差几个小时（时区 / 时钟）。
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

function toView(a) {
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
    canCancel: !!a.cancellable,
    cancelHint: a.cancellable ? '' : '开始前 24 小时内需电话联系门诊取消或改期',
    orderLabel: a.order ? ('订单 ' + a.order.status_label) : ''
  };
}

Page({
  data: {
    needLogin: false,
    loading: true,
    error: '',
    appointments: [],
    cancellingId: 0
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
        /* 失败常见原因：刚被别人改成 completed / 距开始不足 24 小时。
           重新拉一次列表，按钮状态就跟着服务端更新了。 */
        if (err && err.statusCode === 409) return that.load();
        return null;
      });
  }
});
