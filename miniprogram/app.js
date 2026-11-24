/* =========================================================
   app.js — 小程序全局入口
   ---------------------------------------------------------
   阶段一：只做展示页，onLaunch 不发任何请求。
   阶段二：加了登录态，但 onLaunch 仍然不发请求 ——
     token 由 utils/request.js 在第一次需要时从 storage 读（懒加载），
     身份由「我的」页在 onShow 时用 /api/me 校验。
     原因还是那个：一进来就并发 3 个请求，用户还在看启动图，
     而且 token 过期时会在启动瞬间被踢去登录页，体验很糟。
   ========================================================= */
App({
  globalData: {
    /* 首页拉到诊所信息后写一份，预约页直接读，
       读不到再自己发请求 —— 少一次往返，也不影响正确性。 */
    clinic: null,
    clinicLoadedAt: 0,
    /* 登录用户的公开信息（不含 token、不含密码）。
       token 只在 storage 与 request.js 里，不进 globalData：
       减少一份「内存里的凭证」，也避免被别的页面随手打日志打出来。 */
    user: null
  },

  onLaunch() {},

  /* 跨页共享的诊所信息缓存，带 5 分钟过期 */
  setClinic(clinic) {
    this.globalData.clinic = clinic;
    this.globalData.clinicLoadedAt = Date.now();
  },

  getClinic() {
    const fresh = Date.now() - this.globalData.clinicLoadedAt < 5 * 60 * 1000;
    return fresh ? this.globalData.clinic : null;
  },

  setUser(user) {
    this.globalData.user = user || null;
  },

  getUser() {
    return this.globalData.user;
  },

  clearUser() {
    this.globalData.user = null;
  }
});
