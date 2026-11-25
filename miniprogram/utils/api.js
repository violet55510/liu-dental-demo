/* =========================================================
   utils/api.js — 接口的语义封装
   ---------------------------------------------------------
   页面只调 getClinic() / login() / createAppointment()，
   不关心 URL、不关心响应外面裹的是 clinic 还是 appointments。
   以后接口加字段或改路径，只动这一个文件。

   两类接口，分得很清楚：
     公开（免登录）  /api/public/*            —— 阶段一那三个
     需要登录        withAuth: true           —— 走 Bearer token
   这里给每个需要登录的调用都显式写 withAuth: true，
   而不是「有 token 就全带上」：让「这条接口要不要身份」在代码里看得见。

   token 的保存/清除只发生在 request.js（setToken / clearToken），
   这一层不做 storage 操作 —— 存两处必然有一天不一致。
   ========================================================= */
const request = require('./request');

function unwrap(key) {
  return function (body) {
    const value = body && body[key];
    if (!value) {
      throw request.createError('BAD_RESPONSE', '接口返回的数据不完整（缺少 ' + key + '）');
    }
    return value;
  };
}

/* ---------- 公开接口（免登录） ---------- */

/* 诊所信息：电话、地址、营业时间 */
function getClinic() {
  return request.get('/api/public/clinic').then(unwrap('clinic'));
}

/* 医师公开信息：姓名 / 科室 / 职称 / 擅长 / 简介（不含证号、邮箱）
   注意 id 是 data.js 的 slug（liu-ortho），拉排班要用 booking_id。 */
function getDoctors() {
  return request.get('/api/public/doctors').then(unwrap('doctors'));
}

/* 8 个诊疗项目：名称 / 简介 / 价格区间文本 */
function listServices() {
  return request.get('/api/public/services').then(unwrap('services'));
}

/* ---------- 认证 ---------- */

/* 登录：Web 与小程序共用同一个接口（没有 /api/mp/login 这种东西）。
   skipAuthRedirect 是必须的：登录失败也是 401，
   如果让拦截器跳登录页，用户会看到页面闪一下再回来，密码框也空了。 */
function login(account, password) {
  return request.post(
    '/api/login',
    { account: account, password: password },
    { withAuth: false, skipAuthRedirect: true }
  ).then(function (body) {
    if (!body || !body.token) {
      throw request.createError('NO_TOKEN', '登录成功但没有拿到 token，请稍后重试');
    }
    request.setToken(body.token);
    return body;
  });
}

/* 注册：服务端硬编码 role=patient，这里不传任何角色字段。
   注册成功不自动登录（服务端注册接口不下发 token），
   页面负责跳回登录页并把手机号带过去。 */
function register(name, phone, password) {
  return request.post(
    '/api/register',
    { name: name, phone: phone, password: password },
    { withAuth: false, skipAuthRedirect: true }
  );
}

/* 当前身份：带 token 时返回 user，token 过期会 401（拦截器负责清 token 跳登录） */
function getMe() {
  return request.get('/api/me', undefined, { withAuth: true }).then(function (body) {
    return (body && body.user) || null;
  });
}

/* 登出：JWT 无状态，服务端没有会话可销毁，
   真正要做的是把本地那份删掉；请求失败也照删（否则用户退不出去）。 */
function logout() {
  return request.post('/api/logout', {}, { withAuth: true, skipAuthRedirect: true })
    .catch(function () { /* 网络失败也继续本地清理 */ })
    .then(function () {
      request.clearToken();
      return { ok: true };
    });
}

/* ---------- 预约（需要登录） ---------- */

/* 某医师某天的时段。doctorId 必须是数据库 id（医师对象的 booking_id），
   不是 slug —— 传 slug 会得到 400 BAD_DOCTOR_ID。 */
function getSchedules(doctorId, date) {
  return request.get(
    '/api/schedules',
    { doctor_id: doctorId, date: date },
    { withAuth: true }
  );
}

/* 提交预约：schedule_id 必填；service 是项目 id（计费用的，不能拼在备注里） */
function createAppointment(payload) {
  return request.post('/api/appointments', payload, { withAuth: true }).then(unwrap('appointment'));
}

/* 我的预约（服务端只查当前登录人，没有「传别人 id」的入口） */
function listMyAppointments() {
  return request.get('/api/patient/appointments', undefined, { withAuth: true })
    .then(unwrap('appointments'));
}

/* 取消预约：时段已开始会被服务端拒绝（409 ALREADY_STARTED），前端不自己算；
   若该预约已支付，服务端会在同一个事务里把订单一起退款，响应里带 refund。 */
function cancelAppointment(id) {
  return request.post('/api/appointments/' + id + '/cancel', {}, { withAuth: true });
}

module.exports = {
  getClinic: getClinic,
  getDoctors: getDoctors,
  listServices: listServices,
  login: login,
  register: register,
  getMe: getMe,
  logout: logout,
  getSchedules: getSchedules,
  createAppointment: createAppointment,
  listMyAppointments: listMyAppointments,
  cancelAppointment: cancelAppointment
};
