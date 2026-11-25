/* =========================================================
   utils/request.js — 网络层（全小程序唯一的出口）
   ---------------------------------------------------------
   为什么必须收成一层：
     小程序里散落 20 个 wx.request，就会出现 20 种错误处理方式，
     以后换域名、加 token、加重试，要改 20 个地方。
     这里统一五件事：baseURL / 凭证 / 请求头 / 错误归一化 / 401 处理。

   ★ 第八期的变化：真的开始带 token 了 ★
     · 存：wx.setStorageSync('token', ...)  —— 只存 token，不存密码；
     · 带：withAuth: true 的请求自动加 Authorization: Bearer <token>；
     · 401：统一在这里清 token + reLaunch('/pages/login/login')，
       页面不用各自判断「是不是过期了」——那样必然会有人漏写。

   一个硬约束：只允许相对路径。
     写成 'http://...' 全地址的请求会被直接拒绝 —— 因为那样绕过 baseURL，
     换个环境（真机 / 局域网）就漏改了。见 assertLocalPath()。
   ========================================================= */

/* 后端地址不写在这里：
   它在 utils/../config.js（小程序端唯一的环境配置），改地址只改那个文件。
   本文件只负责「怎么发请求」，不负责「发给谁」——
   这样换环境（本地 / 真机 / 云端）不需要动网络层逻辑。 */
const config = require('../config');

if (!config || typeof config.BASE_URL !== 'string' || !config.BASE_URL) {
  /* 配置缺失时立刻报清楚，而不是拼出 '/api/xxx' 这种相对地址让请求静默失败 */
  throw new Error('miniprogram/config.js 缺少 BASE_URL（例如 http://localhost:3000）');
}

const BASE_URL = config.BASE_URL;

/* ★ 双通道：HTTP（本地/局域网/穿透） 或 云托管 ★
   config.CLOUD.enabled = true 且 env / service 都填了，才切到云托管；
   任一缺失就保持原来的 wx.request 行为 —— 配错不会把本地开发弄挂。 */
const CLOUD = config.CLOUD || {};
const CLOUD_ENABLED = !!(CLOUD.enabled && CLOUD.env && CLOUD.service);

/* 报错文案里显示「连的是哪儿」，两种通道说法不同 */
function backendLabel() {
  return CLOUD_ENABLED ? ('微信云托管「' + CLOUD.service + '」') : BASE_URL;
}

/* callContainer 在部分基础库里把响应体给成字符串，统一解一次 */
function parseBody(data) {
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data);
  } catch (e) {
    return data;
  }
}

const DEFAULT_TIMEOUT = 8000;

/* storage 的键名就叫 token（和后端约定的一致），不叫 access_token、
   也不加前缀 —— 键越少，越不容易在同名键上踩坑。 */
const TOKEN_KEY = 'token';
const LOGIN_PAGE = '/pages/login/login';

let authToken = '';
let tokenHydrated = false;
let redirectingToLogin = false;

function hydrateToken() {
  if (tokenHydrated) return authToken;
  try {
    authToken = wx.getStorageSync(TOKEN_KEY) || '';
  } catch (e) {
    authToken = '';
  }
  tokenHydrated = true;
  return authToken;
}

/* 唯一写 token 的地方。传空串等于清除。 */
function setToken(token) {
  authToken = token || '';
  tokenHydrated = true;
  try {
    if (authToken) wx.setStorageSync(TOKEN_KEY, authToken);
    else wx.removeStorageSync(TOKEN_KEY);
  } catch (e) {
    /* 存储失败不影响本次会话内的请求 */
  }
}

function getToken() {
  return hydrateToken();
}

function clearToken() {
  setToken('');
}

function isLoggedIn() {
  return !!getToken();
}

/* 统一错误对象：{ code, message, statusCode, body, needLogin }
   page 只认 message（给人看）和 code（给逻辑判断），不直接碰 res。 */
function createError(code, message, extra) {
  return Object.assign({ code: code, message: message, statusCode: 0, body: null }, extra || {});
}

function normalizeError(statusCode, body) {
  const code = (body && (body.code || body.error_code)) || 'HTTP_' + statusCode;
  let message = (body && (body.error || body.message)) || '';

  if (!message) {
    if (statusCode === 401) message = '登录状态已失效，请重新登录';
    else if (statusCode === 403) message = '没有权限访问该内容';
    else if (statusCode === 404) message = '请求的内容不存在';
    else if (statusCode === 429) message = '请求过于频繁，请稍后再试';
    else if (statusCode >= 500) message = '服务暂时不可用，请稍后再试';
    else message = '请求失败（HTTP ' + statusCode + '）';
  }

  return createError(code, message, { statusCode: statusCode, body: body || null });
}

/* 只接受以 / 开头的站内路径，避免有人手滑写成全地址而绕过 BASE_URL */
function assertLocalPath(url) {
  if (typeof url !== 'string' || url.charAt(0) !== '/') {
    throw createError('BAD_URL', '请求路径必须以 / 开头（不要写完整域名）：' + url);
  }
}

function buildHeader(withAuth) {
  const header = { 'content-type': 'application/json' };
  if (withAuth) {
    const token = getToken();
    if (token) header.Authorization = 'Bearer ' + token;
  }
  return header;
}

/* 当前页面路径。用来避免「已经在登录页了还 reLaunch 到登录页」的死循环。 */
function currentRoute() {
  try {
    if (typeof getCurrentPages !== 'function') return '';
    const pages = getCurrentPages() || [];
    if (!pages.length) return '';
    const last = pages[pages.length - 1];
    return '/' + (last.route || last.__route__ || '');
  } catch (e) {
    return '';
  }
}

/* ★ 401 的唯一出口 ★
   清 token → 跳登录页。
   两种情况不跳：
     1) 已经在登录页（否则登录失败会自己刷自己）；
     2) 上一次跳转还没完成（连发 3 个请求同时 401，只跳一次）。 */
function handleUnauthorized() {
  clearToken();

  if (currentRoute() === LOGIN_PAGE) return false;
  if (redirectingToLogin) return true;

  redirectingToLogin = true;
  wx.reLaunch({
    url: LOGIN_PAGE,
    complete: function () { redirectingToLogin = false; }
  });
  return true;
}

function request(options) {
  const opts = options || {};
  const url = opts.url;
  assertLocalPath(url);

  return new Promise(function (resolve, reject) {
    const method = opts.method || 'GET';
    const timeout = opts.timeout || DEFAULT_TIMEOUT;
    const header = buildHeader(!!opts.withAuth);

    function onSuccess(res) {
      const status = res.statusCode;
      const body = parseBody(res.data);

      if (status >= 200 && status < 300) {
        resolve(body);
        return;
      }

      const err = normalizeError(status, body);

      /* 只有「需要登录的请求」拿到 401 才跳登录。
         登录接口自己的 401 是「账号或密码不正确」，
         那种情况必须留在页面上给用户改密码（api.login 会显式关掉跳转）。 */
      if (status === 401 && opts.withAuth && !opts.skipAuthRedirect) {
        err.needLogin = true;
        err.redirected = handleUnauthorized();
      }

      reject(err);
    }

    function onFail(err) {
      /* 连不上后端时最常见的原因：
         HTTP 模式 —— 服务没启动 / 手机与电脑不同网段 / 没勾「不校验合法域名」；
         云托管模式 —— 服务没部署成功 / 服务名填错 / 环境 ID 填错。 */
      const hint = CLOUD_ENABLED
        ? '请确认云托管服务已部署且状态为「运行中」，并核对 config.js 里的 env 与 service。'
        : '请确认 npm start 已运行，并已勾选「不校验合法域名」。';
      reject(createError('NETWORK', '连接不上后端（' + backendLabel() + '）。' + hint, { body: err }));
    }

    if (CLOUD_ENABLED) {
      if (typeof wx.cloud === 'undefined' || typeof wx.cloud.callContainer !== 'function') {
        reject(createError(
          'NO_CLOUD',
          '当前微信版本不支持云托管调用（需要基础库 2.23.0 及以上），请升级微信或改用 HTTP 通道。'
        ));
        return;
      }

      /* 云托管调用：path 只写路径，不用拼域名；X-WX-SERVICE 指定服务名。
         这条路不受「request 合法域名」限制，也不需要开「开发调试」。 */
      wx.cloud.callContainer({
        config: { env: CLOUD.env },
        path: url,
        method: method,
        data: opts.data || undefined,
        header: Object.assign({}, header, { 'X-WX-SERVICE': CLOUD.service }),
        timeout: timeout,
        success: onSuccess,
        fail: onFail
      });
      return;
    }

    wx.request({
      url: BASE_URL + url,
      method: method,
      data: opts.data || undefined,
      header: header,
      timeout: timeout,
      success: onSuccess,
      fail: onFail
    });
  });
}

function get(url, data, extra) {
  return request(Object.assign({ url: url, method: 'GET', data: data }, extra || {}));
}

function post(url, data, extra) {
  return request(Object.assign({ url: url, method: 'POST', data: data }, extra || {}));
}

/* 统一的错误提示：页面自己决定要不要调，不要在每个 catch 里各写一套。
   已经因为 401 跳走的那种错误不再弹 toast —— 用户看到的是登录页，
   再弹一句「登录状态已失效」只是噪音。 */
function toastError(err) {
  if (err && err.needLogin) return;
  const message = (err && err.message) || '操作失败，请稍后再试';
  wx.showToast({ title: message, icon: 'none', duration: 2600 });
}

module.exports = {
  BASE_URL: BASE_URL,
  CLOUD_ENABLED: CLOUD_ENABLED,
  backendLabel: backendLabel,
  TOKEN_KEY: TOKEN_KEY,
  LOGIN_PAGE: LOGIN_PAGE,
  request: request,
  get: get,
  post: post,
  setToken: setToken,
  getToken: getToken,
  clearToken: clearToken,
  isLoggedIn: isLoggedIn,
  createError: createError,
  toastError: toastError
};
