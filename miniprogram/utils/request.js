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

/* 云通道的运行时状态（只在内存里，不落 storage）：
     service —— 上一次成功的服务名，后续请求直接用它；
     down    —— 服务名/环境确认不通，本次启动不再尝试，免得每个请求都白等一轮。 */
const cloudState = { service: '', down: false };

/* X-WX-SERVICE 要填的是「服务名」，不是「服务名-版本号」。
   云托管控制台列表卡片显示 springboot-vaij，详情页里的 -001 是版本号；
   填成 springboot-vaij-001 会被网关判为不存在的 Host，报 -501000 / Invalid host。
   两种写法都留一份候选，前一个报 Host 错时自动换下一个，成功后记住 —— 
   这样不用你来回复制粘贴去试哪个是对的。 */
function cloudServices() {
  const list = [];
  function push(name) {
    if (name && list.indexOf(name) < 0) list.push(name);
  }
  push(cloudState.service);
  push(CLOUD.service);
  (CLOUD.serviceAliases || []).forEach(push);
  return list;
}

/* 网关的 Host / 服务名类错误：换一个候选服务名还有救，其它错误换了也白换 */
function isHostError(err) {
  const raw = String((err && (err.errMsg || err.message)) || '');
  return /INVALID_HOST|-501000|Host is invalid|service not found|Cannot find path|-606004/i.test(raw);
}

/* 「一个字节都没回来」且像是连接层的问题：超时、连接被拒/重置。
   这类失败在冷启动场景里最常见 —— 容器在启动，不是代码/配置错了，值得重试。 */
function isColdStartError(err) {
  const raw = String((err && (err.errMsg || err.message)) || '');
  return /timeout|timed out|ECONNRESET|ECONNREFUSED|ERR_CONNECTION|net::|超时/i.test(raw);
}

/* 重试的准入条件：只读方法、不是登录失效、且错误类型可自愈。
   5xx 也算：网关在容器没就绪时会先返回 502/503，等几秒就恢复。 */
function isRetryable(err, method) {
  if (!/^(GET|HEAD)$/i.test(String(method || 'GET'))) return false;
  if (!err || err.needLogin) return false;
  if (err.retryable) return true;
  return err.statusCode === 502 || err.statusCode === 503 || err.statusCode === 504;
}

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
/* callContainer 的 timeout 上限是 15 秒，超过会被忽略（官方限制）。
   云端最小实例为 0 时首次请求要等冷启动，所以云通道给足 15 秒，
   HTTP 通道保持原来的 8 秒 —— 本机后端不该等那么久。 */
const CLOUD_TIMEOUT_MAX = 15000;

/* 超时按「目标」分：本机后端 8 秒够了；云端（云托管或公网域名）可能正在冷启动，
   8 秒必然失败 —— 这不是慢，是容器还没起来。 */
function effectiveTimeout() {
  if (CLOUD_ENABLED) return CLOUD_TIMEOUT_MAX;
  return isRemoteBase() ? CLOUD_TIMEOUT_MAX : DEFAULT_TIMEOUT;
}

/* ★ 冷启动重试 ★
   微信云托管「最小实例数 0」时，版本连续 30 分钟无流量会缩容到 0，
   下一个请求要等容器重新起来（官方文档：可能有 30 秒服务延迟）。
   而 callContainer 的超时上限只有 15 秒 —— 客户端先超时，容器却还在启动。
   结果是「隔一段时间第一次打开，首页必定报超时」，审核员看到的正是这个。

   所以：只读请求（GET/HEAD）超时后按下面的间隔重发，累计等待约 53 秒，
   足够覆盖一次冷启动。写操作（下单、建预约、取消）不自动重试 ——
   网络超时无法判断服务端到底处理没有，重发可能产生重复数据。 */
const RETRY_DELAYS = [2000, 6000];

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

/* 云托管网关的报错是英文 + 错误码（INVALID_HOST、-501000 之类），
   直接甩到页面上没人看得懂，也没法照着做。这里换成可行动的中文。
   命中不了就返回空串，走原来的兜底文案。 */
function cloudErrorText(code, raw) {
  const text = String(raw || '') + ' ' + String(code || '');
  if (/INVALID_HOST|-501000/i.test(text)) {
    return '云托管通道没通（-501000 / Invalid host）：一是 X-WX-SERVICE 的服务名不对'
      + '（应填控制台列表卡片上的服务名，不带 -001 版本号），二是这个环境不属于当前小程序。'
      + '前者改 config.js 的 CLOUD.service；后者去云开发控制台把环境关联到本小程序（DEPLOY.md §12.8）。';
  }
  if (/ENDPOINT_VERSION_NOT_FOUND/i.test(text)) {
    return '云托管服务还没有可用版本：代码没发布成功，去控制台看构建/发布记录。';
  }
  if (/SERVICE_CHARGE_OVERDUE|ENV_SUSPENDED|ENV_ISOLATED/i.test(text)) {
    return '云托管环境已欠费或已停服，续费/恢复后重试。';
  }
  if (/REQUEST_SERVICE_FAILED/i.test(text)) {
    return '请求转发到容器失败：服务状态不是「运行中」，或容器启动即崩溃，去看云托管日志。';
  }
  return '';
}

/* 当前 BASE_URL 是不是「公网 HTTPS 后端」。
   本地（localhost / 局域网 IP）与云端，排查方向完全不同，
   提示语必须分开写，否则必然误导 —— 以前三页写死了「npm start，3000 端口」，
   后端搬到云端后，用户看到的是一句跟现状无关的话。 */
function isRemoteBase() {
  return !CLOUD_ENABLED && /^https:/i.test(BASE_URL);
}

/* wx.request 的 fail 是「一个字节都没收到」，errMsg 里通常已经点名了原因，
   但都是英文/技术味的。这里翻成能照着做的话（返回 '' 表示没命中）。 */
function transportErrorText(rawMsg, target) {
  const t = String(rawMsg || '');

  if (/url not in domain list/i.test(t)) {
    return target + ' 不在小程序的 request 合法域名里。'
      + '开发者工具：右上角「详情 → 本地设置」勾上「不校验合法域名…」；'
      + '手机：先开一次「开发调试」，或换一个已 ICP 备案的域名'
      + '（云托管默认域名永远加不进白名单，见 DEPLOY.md §12.8）。';
  }
  if (/timeout/i.test(t)) {
    return target + ' 响应超时：后端没起来，或网络不通。'
      + '已自动重试仍未成功。云托管「最小实例数 0」时，缩容后首次访问要等 10–30 秒冷启动，'
      + '再点一次「重新加载」通常就能进；想彻底消除，把最小实例数设为 1。';
  }
  if (/ssl|handshake|certificate/i.test(t)) {
    return 'HTTPS 证书校验失败：常见于自签证书、系统代理或抓包工具。'
      + '关掉代理后重试；正式环境必须用受信任证书。';
  }
  if (/ERR_NAME_NOT_RESOLVED|dns|resolve host/i.test(t)) {
    return '域名解析失败：config.js 里的地址拼错了，或本机 DNS / 代理异常。';
  }
  return '';
}

/* 「加载失败」时给用户看的一句下一步：说清现在连的是哪儿。
   写成函数而不是写死在 wxml 里，换环境时不用再改三个页面。 */
function backendHint() {
  if (CLOUD_ENABLED) {
    return '云托管通道：确认服务状态为「运行中」，服务名取列表卡片上的名字（不带 -001），'
      + '并在云开发控制台确认该环境已关联本小程序。'
      + '若「隔一段时间第一次打开」总是超时，是实例被缩容到 0 了：把「最小实例数」设为 1。';
  }
  if (isRemoteBase()) {
    return '云端后端：用浏览器打开 ' + BASE_URL + '/api/health 应返回 JSON；'
      + '手机首次使用需在右上角「…」里开一次「开发调试」。';
  }
  return '本机后端：确认 npm start 已运行，并在「详情 → 本地设置」勾选「不校验合法域名」。';
}

function normalizeError(statusCode, body) {
  const code = (body && (body.code || body.error_code)) || 'HTTP_' + statusCode;
  let message = (body && (body.error || body.message)) || '';

  /* 网关返回 4xx + 英文错误体时，先换成中文；换不到再走状态码兜底 */
  if (message) message = cloudErrorText(code, message) || message;

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

  const method = opts.method || 'GET';
  const timeout = opts.timeout || effectiveTimeout();
  const header = buildHeader(!!opts.withAuth);
  const data = opts.data || undefined;

  /* 重试间隔可被单个请求覆盖（页面需要「最多等 3 秒」时传 retryDelays: []） */
  const delays = Array.isArray(opts.retryDelays) ? opts.retryDelays : RETRY_DELAYS;
  const maxAttempts = delays.length + 1;

  /* 一次「尝试」= 走完一条通道（云通道失败可能还会试别名、或降级公网）。
     重试放在这一层：容器在启动时，换通道没有意义，等几秒再打才是对的。 */
  function attempt(n) {
    const isLast = n >= maxAttempts - 1;

    return new Promise(function (resolve, reject) {
      /* 云通道最后一次的原始错误：两条路都不通时优先报它，信息量更大 */
      let cloudError = null;

      /* 失败的唯一出口：可自愈且还有次数就重排，否则把错误抛给页面 */
      function finish(err) {
        if (!isLast && isRetryable(err, method)) {
          setTimeout(function () {
            attempt(n + 1).then(resolve, reject);
          }, delays[n]);
          return;
        }
        reject(err);
      }

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

        finish(err);
      }

      /* 把「一个字节都没收到」的错误翻成人话。
         云通道优先按网关错误码翻译（-501000 之类），其次才是白名单/超时/证书。 */
      function toNetworkError(err, channel) {
        const raw = String((err && (err.errMsg || err.message)) || '');
        const label = channel === 'cloud' ? ('微信云托管「' + CLOUD.service + '」') : BASE_URL;
        /* 冷启动/连接层失败标记为可重试，交给外层 attempt 决定要不要再发一次 */
        const retryable = isColdStartError(err);

        if (channel === 'cloud') {
          const gateway = cloudErrorText('', raw);
          if (gateway) return createError('CLOUD_GATEWAY', gateway, { body: err, detail: raw, retryable: retryable });
        }

        /* 这几类以前都被归进「请确认 npm start 已运行」，明明后端在云端，提示却在说本机 */
        const transport = transportErrorText(raw, label);
        if (transport) return createError('NETWORK', transport, { body: err, detail: raw, retryable: retryable });

        return createError('NETWORK', '连接不上后端（' + label + '）。' + backendHint(),
          { body: err, detail: raw, retryable: retryable });
      }

      /* ---------- 通道 A：公网域名（wx.request） ---------- */
      function callHttp() {
        wx.request({
          url: BASE_URL + url,
          method: method,
          data: data,
          header: header,
          timeout: timeout,
          success: onSuccess,
          fail: function (err) {
            finish(cloudError ? toNetworkError(cloudError, 'cloud') : toNetworkError(err, 'http'));
          }
        });
      }

      /* ---------- 通道 B：云托管（免域名、免备案、免「开发调试」） ---------- */
      function callCloud(service) {
        wx.cloud.callContainer({
          config: { env: CLOUD.env },
          path: url,
          method: method,
          data: data,
          header: Object.assign({}, header, { 'X-WX-SERVICE': service }),
          /* 云通道单独给超时：上限 15 秒，超过微信会忽略 */
          timeout: Math.min(opts.timeout || CLOUD_TIMEOUT_MAX, CLOUD_TIMEOUT_MAX),
          success: function (res) {
            /* 记住哪个写法通了，后面的请求直接用，不再逐个试 */
            cloudState.service = service;
            onSuccess(res);
          },
          fail: function (err) {
            cloudError = err;
            const list = cloudServices();
            const i = list.indexOf(service);

            /* 服务名写法不对（带不带 -001）：换下一个候选再试一次。
               这类错误发生在网关路由阶段，请求根本没进容器，重试不会重复提交。 */
            if (isHostError(err) && i >= 0 && i + 1 < list.length) {
              callCloud(list[i + 1]);
              return;
            }

            /* 确认是「服务名/环境」这类配置问题：本次启动不再尝试，免得每个请求都白等一轮 */
            if (isHostError(err)) cloudState.down = true;

            /* ★ 超时且还有重试次数：容器正在冷启动，这时改走公网域名只会把
               同样的等待（两个通道打的是同一个容器）再来一遍。
               交给外层等几秒再打，往往第二次就打到了刚起来的实例上。 */
            if (!isLast && isColdStartError(err) && !isHostError(err)) {
              finish(toNetworkError(err, 'cloud'));
              return;
            }

            /* 本环境确实调不通时，允许降级走公网域名（体验版开着「开发调试」时可用）；
               fallbackToHttp: false 就直接把原因报给用户，不掩盖问题。 */
            if (CLOUD.fallbackToHttp !== false) {
              callHttp();
              return;
            }
            finish(toNetworkError(err, 'cloud'));
          }
        });
      }

      if (CLOUD_ENABLED && !cloudState.down) {
        if (typeof wx.cloud === 'undefined' || typeof wx.cloud.callContainer !== 'function') {
          finish(createError(
            'NO_CLOUD',
            '当前微信版本不支持云托管调用（需要基础库 2.23.0 及以上），请升级微信或把 config.js 的 CLOUD.enabled 改回 false。'
          ));
          return;
        }

        /* 云托管调用：path 只写路径，不用拼域名；X-WX-SERVICE 指定服务名。
           这条路不受「request 合法域名」限制，也不需要开「开发调试」。 */
        callCloud(cloudServices()[0]);
        return;
      }

      callHttp();
    });
  }

  return attempt(0);
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
  backendHint: backendHint,
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
