/* =========================================================
   pages/login/login.js — 登录（手机号 + 密码）
   ---------------------------------------------------------
   和 Web 共用同一个接口：POST /api/login。
     · 返回 { user, token, ... }，token 由 utils/api.js 存进 storage；
     · 这里不碰 storage，也不碰 Authorization 头 —— 那是网络层的事。
     · 登录失败的 401 不能触发「跳登录页」：所以 api.login 关掉了自动跳转，
       错误直接显示在密码框下方。

   进页面时可能带两个参数：
     ?account=139…   注册成功后回填手机号
     ?redirect=/pages/appointment/appointment   登录后回原页面
   ========================================================= */
const api = require('../../utils/api');

Page({
  data: {
    account: '',
    password: '',
    redirect: '',
    submitting: false,
    error: ''
  },

  onLoad: function (options) {
    const opt = options || {};
    this.setData({
      account: typeof opt.account === 'string' ? opt.account : '',
      redirect: opt.redirect ? decodeURIComponent(opt.redirect) : ''
    });
  },

  onAccountInput: function (e) {
    this.setData({ account: e.detail.value, error: '' });
  },

  onPasswordInput: function (e) {
    this.setData({ password: e.detail.value, error: '' });
  },

  submit: function () {
    if (this.data.submitting) return Promise.resolve();

    const account = String(this.data.account || '').trim();
    const password = String(this.data.password || '');

    if (!account) { this.setData({ error: '请输入手机号' }); return Promise.resolve(); }
    if (!password) { this.setData({ error: '请输入密码' }); return Promise.resolve(); }

    const that = this;
    this.setData({ submitting: true, error: '' });

    return api.login(account, password)
      .then(function (body) {
        const app = getApp();
        if (app && app.setUser) app.setUser(body.user);
        that.setData({ submitting: false, password: '' });
        wx.showToast({ title: '登录成功', icon: 'success', duration: 1200 });

        /* 回到用户本来想去的页面；没有指定就回「我的」 */
        if (that.data.redirect) wx.reLaunch({ url: that.data.redirect });
        else wx.switchTab({ url: '/pages/mine/mine' });

        console.log('[登录] 成功，身份=' + (body.user && body.user.name) + '，已保存 token');
        return body;
      })
      .catch(function (err) {
        /* 密码错、账号停用、网络失败都在这里：留在页面上，不跳转 */
        that.setData({
          submitting: false,
          error: (err && err.message) || '登录失败，请稍后重试'
        });
        console.log('[登录] 失败：' + ((err && err.message) || '未知错误'));
      });
  },

  goRegister: function () {
    wx.navigateTo({ url: '/pages/register/register' });
  },

  goHome: function () {
    wx.switchTab({ url: '/pages/index/index' });
  }
});
