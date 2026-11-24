/* =========================================================
   pages/register/register.js — 注册（只能是病人）
   ---------------------------------------------------------
   服务端 /api/register 里写死了 role = 'patient'，
   并且**完全不读** body.role —— 所以这一页没有、也不该有角色选择。
   医生要走官网的入驻申请（pending → 管理员审核），不在这里。

   注册接口不下发 token，所以注册成功后：
     reLaunch 到登录页，并把手机号带过去，省用户再打一遍。
   这里也不做「自动登录」——多一步是刻意的，
   让用户确认自己刚才设的密码能用。
   ========================================================= */
const api = require('../../utils/api');

const PHONE_RE = /^1[3-9]\d{9}$/;

Page({
  data: {
    name: '',
    phone: '',
    password: '',
    submitting: false,
    error: ''
  },

  onNameInput: function (e) { this.setData({ name: e.detail.value, error: '' }); },
  onPhoneInput: function (e) { this.setData({ phone: e.detail.value, error: '' }); },
  onPasswordInput: function (e) { this.setData({ password: e.detail.value, error: '' }); },

  /* 前端校验只为了少一次往返；真正的规则以服务端为准，
     两边不一致时以服务端返回的 error 为准（这里会原样显示）。 */
  validate: function () {
    const name = String(this.data.name || '').trim();
    const phone = String(this.data.phone || '').trim();
    const password = String(this.data.password || '');

    if (name.length < 2 || name.length > 20) return '请填写 2–20 个字的姓名';
    if (!PHONE_RE.test(phone)) return '请输入 11 位有效的手机号';
    if (password.length < 8 || password.length > 72) return '密码长度需为 8–72 位';
    return '';
  },

  submit: function () {
    if (this.data.submitting) return Promise.resolve();

    const bad = this.validate();
    if (bad) { this.setData({ error: bad }); return Promise.resolve(); }

    const name = String(this.data.name || '').trim();
    const phone = String(this.data.phone || '').trim();
    const password = String(this.data.password || '');
    const that = this;

    this.setData({ submitting: true, error: '' });

    return api.register(name, phone, password)
      .then(function (body) {
        that.setData({ submitting: false, password: '' });
        wx.showToast({ title: '注册成功，请登录', icon: 'none', duration: 1600 });
        console.log('[注册] 成功：' + (body && body.user ? body.user.role : '?') + ' / ' + phone);
        wx.reLaunch({ url: '/pages/login/login?account=' + phone });
      })
      .catch(function (err) {
        that.setData({
          submitting: false,
          error: (err && err.message) || '注册失败，请稍后重试'
        });
        console.log('[注册] 失败：' + ((err && err.message) || '未知错误'));
      });
  },

  goLogin: function () {
    wx.navigateBack({
      fail: function () { wx.reLaunch({ url: '/pages/login/login' }); }
    });
  }
});
