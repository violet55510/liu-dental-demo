/* =========================================================
   pages/mine/mine.js — 我的
   ---------------------------------------------------------
   阶段一这里是「登录占位」；阶段二接上真实账号：
     · 有 token → /api/me 校验一次（顺便验证 token 还没过期）；
     · 没 token → 显示「未登录」，登录按钮去真的登录页；
     · 退出登录 → 调接口（失败也算）→ 清本地 token → 回到未登录态。

   为什么不把 token 里的 role / id 解析出来当用户信息：
   token 只用来证明「我是谁」，资料一律以 /api/me 的返回为准 ——
   否则账号被改名/停用，界面上还挂着旧数据。
   ========================================================= */
const api = require('../../utils/api');
const request = require('../../utils/request');

const ROLE_LABEL = { patient: '就诊人', doctor: '医师', admin: '管理员' };

function maskPhone(phone) {
  const p = String(phone || '');
  if (p.length !== 11) return p || '未填写手机号';
  return p.slice(0, 3) + '****' + p.slice(7);
}

Page({
  data: {
    version: '0.2.0',
    stage: '阶段二 · 认证与预约',
    user: null,
    userInitial: '未',
    roleLabel: '',
    phoneMasked: '',
    loading: false,
    error: ''
  },

  onShow: function () {
    return this.syncUser();
  },

  syncUser: function () {
    const app = getApp();

    if (!request.isLoggedIn()) {
      if (app && app.clearUser) app.clearUser();
      this.setData({ user: null, userInitial: '未', roleLabel: '', phoneMasked: '', loading: false });
      return Promise.resolve();
    }

    /* 先用缓存把界面点亮，再回源校验，避免每次切 tab 都白屏 */
    const cached = app && app.getUser ? app.getUser() : null;
    if (cached) this.applyUser(cached);

    const that = this;
    this.setData({ loading: true, error: '' });

    return api.getMe()
      .then(function (user) {
        that.setData({ loading: false });
        if (!user) {
          /* token 还能验签，但库里已经没有这个账号（或状态不是 active） */
          request.clearToken();
          if (app && app.clearUser) app.clearUser();
          that.setData({ user: null, userInitial: '未', roleLabel: '', phoneMasked: '' });
          return;
        }
        if (app && app.setUser) app.setUser(user);
        that.applyUser(user);
        console.log('[我的] 已登录：' + user.name + '（' + user.role + '）');
      })
      .catch(function (err) {
        that.setData({ loading: false });
        /* needLogin 表示拦截器已经清 token 并跳登录页了，这里只负责把界面复位 */
        if (err && err.needLogin) {
          if (app && app.clearUser) app.clearUser();
          that.setData({ user: null, userInitial: '未', roleLabel: '', phoneMasked: '' });
          return;
        }
        that.setData({ error: (err && err.message) || '身份校验失败' });
      });
  },

  applyUser: function (user) {
    this.setData({
      user: user,
      userInitial: String(user.name || '我').slice(0, 1),
      roleLabel: ROLE_LABEL[user.role] || user.role,
      phoneMasked: maskPhone(user.phone)
    });
  },

  goLogin: function () {
    wx.navigateTo({ url: '/pages/login/login' });
  },

  goRegister: function () {
    wx.navigateTo({ url: '/pages/register/register' });
  },

  goAppointments: function () {
    if (!this.data.user) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      this.goLogin();
      return;
    }
    wx.navigateTo({ url: '/pages/my-appointments/my-appointments' });
  },

  /* 支付与订单没有迁到小程序（第五期的红线：不接真实支付通道，
     小程序端也不做收银台），所以这两项如实标注「官网端可用」。 */
  notReady: function () {
    wx.showToast({ title: '该项目前在官网页面上提供', icon: 'none', duration: 2200 });
  },

  logout: function () {
    const that = this;
    wx.showModal({
      title: '退出登录',
      content: '退出后需要重新输入手机号与密码才能预约。',
      confirmText: '退出',
      cancelText: '取消',
      success: function (res) {
        if (!res.confirm) return;
        api.logout().then(function () {
          const app = getApp();
          if (app && app.clearUser) app.clearUser();
          that.setData({ user: null, userInitial: '未', roleLabel: '', phoneMasked: '' });
          wx.showToast({ title: '已退出登录', icon: 'none', duration: 1400 });
          console.log('[我的] 已退出登录，本地 token 已清除');
        });
      }
    });
  }
});
