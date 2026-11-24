/* =========================================================
   pages/service-detail/service-detail.js — 项目详情
   ---------------------------------------------------------
   本期没有「单个项目」接口（只有 3 个公开接口，不为一个页面加第 4 个），
   所以详情页拉的是列表，再按 id 取一条。
   多花一次列表请求，换接口面收敛到 3 个 —— 这是有意的取舍（README §18.6）。

   医师一栏是「擅长该项目的医师」，由 doctors[].services 过滤得来；
   医师接口挂了不影响项目本身展示。
   ========================================================= */
const api = require('../../utils/api');
const request = require('../../utils/request');

Page({
  data: {
    loading: true,
    error: '',
    service: null,
    doctors: []
  },

  onLoad: function (options) {
    this.serviceId = (options && options.id) || '';
    return this.load();
  },

  load: function () {
    const that = this;
    const id = this.serviceId;

    if (!id) {
      this.setData({ loading: false, error: '缺少项目参数，请从列表进入' });
      return Promise.resolve();
    }

    this.setData({ loading: true, error: '' });

    return api.listServices()
      .then(function (list) {
        let service = null;
        for (let i = 0; i < list.length; i++) {
          if (list[i].id === id) { service = list[i]; break; }
        }
        if (!service) {
          throw request.createError('NOT_FOUND', '没有找到这个项目（id=' + id + '）');
        }

        that.setData({ loading: false, service: service });
        wx.setNavigationBarTitle({ title: service.label });
        console.log('[项目详情] ' + service.label + '｜' + service.price_text);

        /* 医师是附加信息：失败了也只是少一块，不把整页变成错误页 */
        return api.getDoctors()
          .then(function (doctors) {
            const related = doctors.filter(function (d) {
              return (d.services || []).indexOf(id) >= 0;
            });
            that.setData({ doctors: related });
          })
          .catch(function () {
            that.setData({ doctors: [] });
          });
      })
      .catch(function (err) {
        that.setData({ loading: false, error: err.message || '加载失败，请稍后重试' });
      });
  },

  reload: function () {
    return this.load();
  },

  goServices: function () {
    wx.switchTab({ url: '/pages/services/services' });
  },

  goAppointment: function () {
    wx.switchTab({ url: '/pages/appointment/appointment' });
  },

  callClinic: function () {
    const that = this;
    const app = getApp();
    const cached = app && app.getClinic ? app.getClinic() : null;

    const dial = function (clinic) {
      const tel = clinic && clinic.phone && clinic.phone.tel;
      if (!tel) {
        wx.showToast({ title: '电话获取失败，请稍后重试', icon: 'none' });
        return;
      }
      wx.makePhoneCall({ phoneNumber: tel, fail: function () {} });
    };

    if (cached) {
      dial(cached);
      return;
    }

    /* 首页没进过就直接进详情页时会走到这里：补一次诊所请求 */
    api.getClinic()
      .then(function (clinic) {
        if (app && app.setClinic) app.setClinic(clinic);
        dial(clinic);
      })
      .catch(function (err) {
        request.toastError(err);
      });
  }
});
