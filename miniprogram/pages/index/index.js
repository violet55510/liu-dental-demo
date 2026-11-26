/* =========================================================
   pages/index/index.js — 首页
   ---------------------------------------------------------
   三块内容，全部来自 /api/public/*：
     1) 诊所信息卡：名称、今日门诊、地址、电话（点击直接拨号）
     2) 服务入口：8 项里的前 6 项，点进去是详情页
     3) 医师预览：前 3 位，点「查看全部」切到医生 tab

   注意：这里没有 document / window / innerHTML。
   所有渲染都是 setData 改 data，WXML 负责映射成视图。
   ========================================================= */
const api = require('../../utils/api');
const request = require('../../utils/request');

Page({
  data: {
    loading: true,
    error: '',
    errorHint: '',
    clinic: null,
    today: null,
    services: [],
    serviceTotal: 0,
    doctors: [],
    doctorTotal: 0
  },

  /* onLoad 返回 Promise 是给 scripts/miniprogram-mock.mjs 用的：
     真实运行时框架会忽略返回值，测试脚本则能 await 到「数据已到位」。
     不写 return 也能跑，只是模拟脚本要多等一会儿。 */
  onLoad: function () {
    return this.load();
  },

  onPullDownRefresh: function () {
    return this.load(true);
  },

  load: function (fromPull) {
    const that = this;
    this.setData({ loading: true, error: '' });

    return Promise.all([api.getClinic(), api.getDoctors(), api.listServices()])
      .then(function (res) {
        const clinic = res[0];
        const doctors = res[1];
        const services = res[2];

        /* 顺手缓存给「预约」「我的」两页用，少一次往返 */
        const app = getApp();
        if (app && app.setClinic) app.setClinic(clinic);

        that.setData({
          loading: false,
          clinic: clinic,
          today: clinic.hours ? clinic.hours.today : null,
          services: services.slice(0, 6),
          serviceTotal: services.length,
          doctors: doctors.slice(0, 3),
          doctorTotal: doctors.length
        });

        /* 这行是给开发者工具 Console 看的：
           学员一眼就能确认「数据真的从后端来了」，而不是写死在页面里 */
        console.log('[首页] 诊所=' + clinic.name +
          '，电话=' + clinic.phone.display +
          '，今日=' + (clinic.hours.today ? clinic.hours.today.open + '–' + clinic.hours.today.close : '未知') +
          '，服务=' + services.length + ' 项，医师=' + doctors.length + ' 位');

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

  /* ---------- 交互 ---------- */
  goServices: function () {
    wx.switchTab({ url: '/pages/services/services' });
  },

  goDoctors: function () {
    wx.switchTab({ url: '/pages/doctors/doctors' });
  },

  goAppointment: function () {
    wx.switchTab({ url: '/pages/appointment/appointment' });
  },

  openService: function (e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/service-detail/service-detail?id=' + id });
  },

  callClinic: function () {
    const clinic = this.data.clinic;
    const tel = clinic && clinic.phone && clinic.phone.tel;
    if (!tel) {
      wx.showToast({ title: '电话获取失败，请稍后重试', icon: 'none' });
      return;
    }
    wx.makePhoneCall({
      phoneNumber: tel,
      fail: function () {
        /* 用户点「取消」也会走 fail，这不是错误，不弹提示 */
      }
    });
  }
});
