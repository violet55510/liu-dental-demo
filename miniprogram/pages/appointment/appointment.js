/* =========================================================
   pages/appointment/appointment.js — 在线预约（阶段二）
   ---------------------------------------------------------
   流程：选医师 → 选日期 → 拉时段 → 选时段 → 选项目 → 提交

   三条不能省的规矩：
   1. 时段必须来自 /api/schedules，不在前端自己算「几点有空」。
   2. 医师要传 booking_id（数据库 id），不是 data.js 的 slug；
      公开接口已经把这个映射算好，页面不做字符串拼接。
   3. 提交成功 ≠ 预约成功：状态是 pending，等门诊确认。
      文案必须这么写 —— 演示站点也不许把「已提交」说成「已约上」。

   未登录时不静默失败：直接换成「去登录」的引导块，
   登录后带 redirect 回到本页。
   ========================================================= */
const api = require('../../utils/api');
const request = require('../../utils/request');

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const BOOK_DAYS = 14;      // 与种子排班一致（未来 14 天）

function pad2(n) { return (n < 10 ? '0' : '') + n; }
function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

function buildDates() {
  const base = new Date();
  base.setHours(0, 0, 0, 0);

  const list = [];
  for (let i = 0; i < BOOK_DAYS; i++) {
    const d = new Date(base.getTime() + i * 86400000);
    let suffix = '';
    if (i === 0) suffix = '（今天）';
    else if (i === 1) suffix = '（明天）';
    list.push({
      value: ymd(d),
      label: (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WEEK[d.getDay()] + suffix
    });
  }
  return list;
}

Page({
  data: {
    needLogin: false,

    loading: true,
    loadError: '',

    doctors: [],
    doctorNames: [],
    doctorIndex: -1,
    doctorId: 0,

    dates: [],
    dateValue: '',
    dateLabel: '',
    dateStart: '',
    dateEnd: '',

    slots: [],
    slotsLoading: false,
    slotsLoaded: false,
    slotsError: '',
    selectedSlotId: 0,
    selectedSlotLabel: '',

    services: [],
    serviceNames: [],
    serviceIndex: -1,
    serviceId: '',

    note: '',
    submitting: false,
    formError: '',

    success: null,

    clinicPhone: '',
    clinicTel: ''
  },

  onLoad: function () {
    this._slotsToken = 0;
    this._loaded = false;

    const dates = buildDates();
    this.setData({
      dates: dates,
      dateValue: dates[0].value,
      dateLabel: dates[0].label,
      dateStart: dates[0].value,
      dateEnd: dates[BOOK_DAYS - 1].value
    });

    return this.gate();
  },

  /* 从登录页回来会触发 onShow：这时 token 已经有了，接着把表单拉起来 */
  onShow: function () {
    if (this.data.needLogin && request.isLoggedIn()) return this.gate();
    if (!this.data.needLogin && !this._loaded && !this._loading) return this.gate();
    return Promise.resolve();
  },

  gate: function () {
    if (!request.isLoggedIn()) {
      this.setData({ needLogin: true, loading: false });
      console.log('[预约] 未登录：显示登录引导，不发任何需要身份的请求');
      return Promise.resolve();
    }

    this.setData({ needLogin: false });
    return this.loadAll();
  },

  goLogin: function () {
    /* 带上 redirect，登录完直接回预约页，不用用户自己再点一次 */
    wx.reLaunch({
      url: '/pages/login/login?redirect=' + encodeURIComponent('/pages/appointment/appointment')
    });
  },

  loadAll: function () {
    if (this._loading) return Promise.resolve();
    this._loading = true;

    const that = this;
    this.setData({ loading: true, loadError: '' });

    return Promise.all([api.getDoctors(), api.listServices()])
      .then(function (res) {
        /* 只留「有数据库账号」的医师：没有 booking_id 的医师点进去也约不了，
           与其让用户选完再报错，不如先不列出（公开接口给了 null，这里如实过滤）。 */
        const doctors = (res[0] || []).filter(function (d) { return !!d.booking_id; });
        const services = res[1] || [];

        const app = getApp();
        const clinic = app && app.getClinic ? app.getClinic() : null;

        that.setData({
          loading: false,
          doctors: doctors,
          doctorNames: doctors.map(function (d) { return d.name + ' · ' + d.dept; }),
          doctorIndex: doctors.length ? 0 : -1,
          doctorId: doctors.length ? doctors[0].booking_id : 0,
          services: services,
          serviceNames: services.map(function (s) { return s.label + '（' + s.price_text + '）'; }),
          serviceIndex: -1,
          serviceId: '',
          clinicPhone: clinic && clinic.phone ? clinic.phone.display : '',
          clinicTel: clinic && clinic.phone ? clinic.phone.tel : ''
        });

        that._loaded = true;
        that._loading = false;
        console.log('[预约] 医师 ' + doctors.length + ' 位、项目 ' + services.length + ' 个');

        return that.loadSlots();
      })
      .catch(function (err) {
        that._loading = false;
        that.setData({
          loading: false,
          loadError: (err && err.message) || '加载失败，请稍后重试'
        });
      });
  },

  reload: function () {
    this._loaded = false;
    return this.gate();
  },

  /* ---------- 选医师 / 选日期 ---------- */
  onDoctorChange: function (e) {
    const idx = Number(e.detail.value);
    const doctor = this.data.doctors[idx];
    if (!doctor) return Promise.resolve();

    this.setData({ doctorIndex: idx, doctorId: doctor.booking_id });
    console.log('[预约] 选择医师：' + doctor.name + '（booking_id=' + doctor.booking_id + '）');
    return this.loadSlots();
  },

  onDateChange: function (e) {
    const value = e.detail.value;
    const hit = this.data.dates.find(function (d) { return d.value === value; });
    this.setData({
      dateValue: value,
      dateLabel: hit ? hit.label : value
    });
    return this.loadSlots();
  },

  /* ---------- 拉时段 ---------- */
  loadSlots: function () {
    const doctorId = this.data.doctorId;
    const date = this.data.dateValue;

    if (!doctorId || !date) {
      this.setData({ slots: [], slotsLoaded: true, selectedSlotId: 0, selectedSlotLabel: '' });
      return Promise.resolve();
    }

    /* 用户可能连着改医师/日期，早发出的请求晚回来会把新结果覆盖掉。
       用一个自增序号丢弃过期响应（和后端无关，纯前端竞态）。 */
    const token = ++this._slotsToken;
    const that = this;

    this.setData({
      slotsLoading: true,
      slotsError: '',
      selectedSlotId: 0,
      selectedSlotLabel: ''
    });

    return api.getSchedules(doctorId, date)
      .then(function (body) {
        if (token !== that._slotsToken) return;

        const slots = ((body && body.slots) || []).map(function (s) {
          /* 服务端返回的「可约」只代表没人占号，不代表时间还没过。
             今天的 09:00 在下午打开时仍然是 open+未占用，
             点进去提交才会被 400 SLOT_IN_PAST 拒绝 —— 那是很差的体验。
             这里按同样的本地时区口径先挡一道（提交时服务端仍会再校验）。 */
          const startMs = new Date(date + 'T' + s.start_time + ':00').getTime();
          const past = !isNaN(startMs) && startMs <= Date.now();
          const usable = s.open && !s.taken && !past;
          return {
            id: s.id,
            start_time: s.start_time,
            text: s.start_time + '–' + s.end_time,
            disabled: !usable,
            tag: past ? '已过时间' : (s.taken ? '已约满' : (s.open ? '可约' : '未开放'))
          };
        });

        that.setData({ slotsLoading: false, slotsLoaded: true, slots: slots });
        console.log('[预约] ' + date + '：' + slots.length + ' 个时段，可约 ' +
          slots.filter(function (s) { return !s.disabled; }).length + ' 个');
      })
      .catch(function (err) {
        if (token !== that._slotsToken) return;
        that.setData({
          slotsLoading: false,
          slotsLoaded: true,
          slots: [],
          slotsError: (err && err.message) || '时段加载失败'
        });
      });
  },

  selectSlot: function (e) {
    const idx = Number(e.currentTarget.dataset.index);
    const slot = this.data.slots[idx];
    if (!slot || slot.disabled) return;

    this.setData({
      selectedSlotId: slot.id,
      selectedSlotLabel: slot.text,
      formError: ''
    });
  },

  onServiceChange: function (e) {
    const idx = Number(e.detail.value);
    const svc = this.data.services[idx];
    if (!svc) return;

    this.setData({ serviceIndex: idx, serviceId: svc.id, formError: '' });
  },

  onNoteInput: function (e) {
    this.setData({ note: e.detail.value });
  },

  /* ---------- 提交 ---------- */
  submit: function () {
    if (this.data.submitting) return Promise.resolve();

    if (!this.data.selectedSlotId) {
      this.setData({ formError: '请先选择一个可约时段' });
      return Promise.resolve();
    }
    if (!this.data.serviceId) {
      this.setData({ formError: '请选择预约项目（到店后可按实际检查调整）' });
      return Promise.resolve();
    }

    const payload = {
      schedule_id: this.data.selectedSlotId,
      service: this.data.serviceId
    };
    const note = String(this.data.note || '').trim();
    if (note) payload.note = note;

    const that = this;
    this.setData({ submitting: true, formError: '' });

    return api.createAppointment(payload)
      .then(function (appt) {
        const doctor = that.data.doctors[that.data.doctorIndex] || {};
        const svc = that.data.services[that.data.serviceIndex] || {};

        that.setData({
          submitting: false,
          success: {
            id: appt.id,
            status_label: appt.status === 'pending' ? '待确认' : appt.status,
            date: appt.date,
            time: appt.start_time + '–' + appt.end_time,
            doctor: doctor.name || '',
            dept: doctor.dept || '',
            service: svc.label || ''
          }
        });

        console.log('[预约] 已提交 #' + appt.id + '（' + appt.date + ' ' + appt.start_time + '，待门诊确认）');
      })
      .catch(function (err) {
        that.setData({
          submitting: false,
          formError: (err && err.message) || '提交失败，请稍后重试'
        });
        console.log('[预约] 提交失败：' + ((err && err.message) || '未知错误'));
      });
  },

  /* 再约一个：清空选择并重新拉时段（刚才那个时段已经变成已约满） */
  again: function () {
    this.setData({
      success: null,
      selectedSlotId: 0,
      selectedSlotLabel: '',
      note: '',
      formError: ''
    });
    return this.loadSlots();
  },

  goMyAppointments: function () {
    wx.navigateTo({ url: '/pages/my-appointments/my-appointments' });
  },

  callClinic: function () {
    if (!this.data.clinicTel) {
      wx.showToast({ title: '电话获取失败，请稍后重试', icon: 'none' });
      return;
    }
    wx.makePhoneCall({
      phoneNumber: this.data.clinicTel,
      fail: function () { /* 用户取消拨号不算错误 */ }
    });
  }
});
