/* =========================================================
   pages/services/services.js — 服务项目列表（8 项）
   ---------------------------------------------------------
   列表只显示「名称 + 简介 + 价格区间文本」，
   价格是服务端格式化好的字符串（price_text），前端不做任何换算。
   ========================================================= */
const api = require('../../utils/api');
const request = require('../../utils/request');

Page({
  data: {
    loading: true,
    error: '',
    errorHint: '',
    services: []
  },

  onLoad: function () {
    return this.load();
  },

  onPullDownRefresh: function () {
    return this.load(true);
  },

  load: function (fromPull) {
    const that = this;
    this.setData({ loading: true, error: '' });

    return api.listServices()
      .then(function (services) {
        that.setData({ loading: false, services: services });
        console.log('[服务] 已加载 ' + services.length + ' 个项目：' +
          services.map(function (s) { return s.label; }).join('、'));
        if (fromPull) wx.stopPullDownRefresh();
      })
      .catch(function (err) {
        that.setData({
          loading: false,
          error: err.message || '加载失败，请稍后重试',
          errorHint: request.backendHint()
        });
        if (fromPull) wx.stopPullDownRefresh();
      });
  },

  reload: function () {
    return this.load();
  },

  openService: function (e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/service-detail/service-detail?id=' + id });
  }
});
