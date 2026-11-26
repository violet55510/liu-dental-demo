/* =========================================================
   pages/doctors/doctors.js — 医师团队（4 位）
   ---------------------------------------------------------
   接口不返回执业证号与邮箱（见 server/routes/public.js 的收窄说明），
   所以页面上也不会出现「证书编号」这种看起来像资质公示、
   实际却拿不到数据的字段。

   years_pending / schedule_pending 为 true 时，界面会加「待核对」。
   这两个标记来自 data.js，不是前端猜的 —— 演示数据不该冒充已核实信息。
   ========================================================= */
const api = require('../../utils/api');
const request = require('../../utils/request');

Page({
  data: {
    loading: true,
    error: '',
    errorHint: '',
    doctors: []
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

    return api.getDoctors()
      .then(function (doctors) {
        that.setData({ loading: false, doctors: doctors });
        console.log('[医生] 已加载 ' + doctors.length + ' 位：' +
          doctors.map(function (d) { return d.name + '(' + d.dept + ')'; }).join('、'));
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

  goAppointment: function () {
    wx.switchTab({ url: '/pages/appointment/appointment' });
  }
});
