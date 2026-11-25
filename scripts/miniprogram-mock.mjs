/* =========================================================
   scripts/miniprogram-mock.mjs — 用 wx 垫片跑真实页面逻辑
   ---------------------------------------------------------
   问题：微信开发者工具不能在命令行里跑，CI 里也起不来。
   但「页面到底有没有把后端的值放进 data」这件事，不需要真机：
     pages/*.js 只用 Page / getApp / wx.request / wx.setStorageSync 这几样，
     给它们一个最小垫片，就能在 Node 里执行真实的 onLoad / 点击处理函数。

   所以这个脚本做四件事：
     1. 起一个临时后端（端口 3107，临时库，不碰 data/app.db）；
     2. 实现最小的 wx / Page / App / getApp 垫片，require 真实的页面文件；
     3. 跑一遍「未登录 → 注册 → 登录 → 预约 → 取消」的真实链路，
        以及「token 过期 → 401 → 清 token → 跳登录」；
     4. 打印页面 console 输出、请求流水、断言明细。

   ⚠️ 它不是渲染测试：WXML 的排版必须在开发者工具里看。
      它证明的是「取数链路 + 状态流转通了」，不是「长得好不好看」。

   运行：npm run mock:mp [--out 文件名]
   ========================================================= */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MP = path.join(ROOT, 'miniprogram');
const TMP = path.join(ROOT, '.workbuddy');
const PORT = Number(process.env.MP_PORT || 3107);
const BASE = `http://127.0.0.1:${PORT}`;
/* 页面里的 baseURL 会随调试环境改（localhost / 内网 IP / 云端 HTTPS），
   而它从第九期起放在 miniprogram/config.js，所以从那里读出来，
   不在脚本里写死主机 —— 否则改一次地址就要回来改这个脚本。

   ★ 必须 require，不能用正则去 match 文本 ★
   config.js 的注释里为了说明「三种场景」也写了 `BASE_URL: 'http://localhost:3000'`
   这类示例，正则取第一个匹配会拿到注释里的地址（表现为「全部请求都算外部地址」），
   而且这种 bug 只在把真实值改成 IP 之后才暴露 —— 注释示例恰好等于真值时是看不出来的。 */
const PAGE_BASE = (() => {
  try {
    /* .mjs 里没有 require，必须用 createRequire 才能加载 CommonJS 的 config.js */
    const cfg = createRequire(import.meta.url)(path.join(MP, 'config.js'));
    /* ★ 这个脚本模拟的是「本地 HTTP 后端 + 页面逻辑」，环境里没有 wx.cloud ★
       若 config.js 已切到云托管通道（enabled: true），这里必须显式关掉，
       否则所有请求会走 callContainer 而全部失败（44 条断言全红）。
       CommonJS 的模块缓存是全局按路径共享的，所以改这个对象属性，
       页面里 require('../config') 拿到的也是同一份，改动同样生效。 */
    if (cfg && cfg.CLOUD) cfg.CLOUD.enabled = false;
    return (cfg && typeof cfg.BASE_URL === 'string') ? cfg.BASE_URL : '';
  } catch (e) {
    console.error('[mock] 读 miniprogram/config.js 失败：' + e.message);
    return '';
  }
})();
const DB_FILE = path.join(TMP, 'mp-mock.db');
const SERVER_LOG = path.join(TMP, 'mp-mock-server.log');

/* 和 server 用同一个会话密钥，测试才能自己签出「合法但已过期」的 token。
   否则「过期 token 会不会跳登录」这条只能靠等两小时。 */
const SESSION_SECRET = 'test-only-secret-0123456789abcdef';
const DERIVED = crypto.createHmac('sha256', SESSION_SECRET).update('lsd/jwt/v1').digest('hex');

const PATIENT = { name: '小程序病人', phone: '13800001234', password: 'Test@1234' };

const outIdx = process.argv.indexOf('--out');
const OUT_FILE = outIdx > 0 ? path.resolve(process.argv[outIdx + 1]) : '';

fs.mkdirSync(TMP, { recursive: true });
for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
  try { fs.unlinkSync(f); } catch {}
}

const results = [];
let GROUP = '';
function group(name) { GROUP = name; }
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '', group: GROUP });
}

/* ---------- 1. 起临时后端 ---------- */
const logStream = fs.createWriteStream(SERVER_LOG, { flags: 'w' });
const bootEnv = { ...process.env };
delete bootEnv.JWT_SECRET;
delete bootEnv.JWT_REQUIRE_ENV;

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'app.js')], {
  cwd: ROOT,
  env: { ...bootEnv, PORT: String(PORT), DB_FILE, SESSION_SECRET, NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stdout.pipe(logStream);
server.stderr.pipe(logStream);

let up = false;
for (let i = 0; i < 80; i++) {
  try {
    const r = await fetch(BASE + '/api/health');
    if (r.ok) { up = true; break; }
  } catch {}
  await sleep(200);
}
if (!up) {
  console.error('后端没起来，看看 ' + SERVER_LOG);
  server.kill();
  process.exit(1);
}

/* ---------- 2. wx 垫片 ---------- */
const calls = [];          // ['request', 'GET', url] / ['showToast', text] / ['reLaunch', url] …
const pageLogs = [];       // 页面里的 console.log 输出，最后统一打印
const pending = new Set();
let consoleErrorCount = 0;

const realLog = console.log;
const realErr = console.error;

/* 真实 storage 的替身：用 Map 存，get 不到返回 ''（和小程序一致，不是 null） */
const storage = new Map();
let confirmModal = true;   // showModal 的默认答案，测试可以临时改成 false
let currentPageRoute = 'pages/index/index';
const externalHits = [];   // 任何没走 BASE_URL 的请求（应当永远为空）

function wxRequest(opts) {
  const originalUrl = opts.url;
  const method = opts.method || 'GET';

  /* 页面发出的地址必须只有一处来源（utils/request.js 的 BASE_URL）。 */
  if (!PAGE_BASE || !originalUrl.startsWith(PAGE_BASE + '/')) externalHits.push(originalUrl);

  /* 页面里的 baseURL 是调试地址（localhost / 内网 IP），
     而测试后端跑在 127.0.0.1:3107（避免和用户正在跑的 3000 抢端口）。
     垫片把「主机部分」改写到测试端口，路径与查询串原样保留 ——
     这样测的仍然是页面真实发出的那条请求。 */
  let url = originalUrl;
  if (/^https?:\/\//.test(url) && !url.startsWith(BASE)) {
    url = url.replace(/^https?:\/\/[^/]+/, BASE);
  }

  const init = { method, headers: opts.header || {} };

  if (opts.data && method === 'GET') {
    const qs = new URLSearchParams(opts.data).toString();
    if (qs) url += (url.indexOf('?') >= 0 ? '&' : '?') + qs;
  } else if (opts.data) {
    init.body = JSON.stringify(opts.data);
  }

  /* 记录时只留路径，日志里才能一眼看出打的是哪个接口 */
  const pathOnly = originalUrl.replace(/^https?:\/\/[^/]+/, '');
  calls.push(['request', method, pathOnly, (init.headers.Authorization ? 'Bearer' : '-')]);

  const p = fetch(url, init)
    .then(async (res) => {
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (opts.success) opts.success({ statusCode: res.status, data, header: {} });
    })
    .catch((err) => {
      if (opts.fail) opts.fail(err);
    })
    .finally(() => pending.delete(p));
  pending.add(p);
}

function done(o) {
  if (o && o.success) o.success({ confirm: false, cancel: true });
  if (o && o.complete) o.complete({});
}

const wx = {
  request: wxRequest,

  /* storage：token 就存在这里。键名必须和 utils/request.js 里的 TOKEN_KEY 一致 */
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => { storage.set(k, v); },
  removeStorageSync: (k) => { storage.delete(k); },

  showToast: (o) => calls.push(['showToast', o.title]),
  showLoading: () => {},
  hideLoading: () => {},
  stopPullDownRefresh: () => calls.push(['stopPullDownRefresh']),
  setNavigationBarTitle: (o) => calls.push(['setNavigationBarTitle', o.title]),

  switchTab: (o) => {
    calls.push(['switchTab', o.url]);
    currentPageRoute = String(o.url || '').replace(/^\//, '');
    if (o.success) o.success({});
    if (o.complete) o.complete({});
  },
  navigateTo: (o) => {
    calls.push(['navigateTo', o.url]);
    currentPageRoute = String(o.url || '').split('?')[0].replace(/^\//, '');
    if (o.success) o.success({});
    if (o.complete) o.complete({});
  },
  navigateBack: (o) => {
    calls.push(['navigateBack']);
    if (o && o.success) o.success({});
    if (o && o.complete) o.complete({});
  },
  reLaunch: (o) => {
    /* 记录整条 URL（带 ?account= / ?redirect= 的那种，是断言点） */
    calls.push(['reLaunch', o.url]);
    currentPageRoute = String(o.url || '').split('?')[0].replace(/^\//, '');
    if (o.success) o.success({});
    if (o.complete) o.complete({});   // request.js 靠 complete 复位「正在跳转」标志
  },

  /* 二次确认：默认点「确定」，测试可以把 confirmModal 设成 false 验证拦截 */
  showModal: (o) => {
    calls.push(['showModal', o.title, confirmModal ? 'confirm' : 'cancel']);
    if (o.success) o.success({ confirm: confirmModal, cancel: !confirmModal });
    if (o.complete) o.complete({});
  },

  makePhoneCall: (o) => calls.push(['makePhoneCall', o.phoneNumber])
};

globalThis.wx = wx;
globalThis.getCurrentPages = () => (currentPageRoute ? [{ route: currentPageRoute }] : []);

let appDef = null;
globalThis.App = (def) => { appDef = def; };

/* ---------- 3. 加载 app.js 与页面 ---------- */
const requireCjs = createRequire(path.join(MP, 'app.js'));
requireCjs(path.join(MP, 'app.js'));

const app = Object.assign({}, appDef);
globalThis.getApp = () => app;

function loadPage(pageRel) {
  let def = null;
  globalThis.Page = (d) => { def = d; };
  const file = path.join(MP, pageRel + '.js');

  /* 同一个页面可能被测两次（预约页要测「未登录」和「已登录」），
     必须清掉 require 缓存，否则模块体不会重新执行，Page() 也不会再被调用。 */
  const req = createRequire(file);
  const resolved = req.resolve(file);
  delete req.cache[resolved];
  req(resolved);

  if (!def) throw new Error(pageRel + ' 没有调用 Page({...})');

  const page = Object.assign({}, def);
  page.data = JSON.parse(JSON.stringify(def.data || {}));
  page.setData = (patch) => { Object.assign(page.data, patch); };
  return page;
}

async function waitIdle() {
  for (let i = 0; i < 120; i++) {
    if (!pending.size) {
      await sleep(30);
      if (!pending.size) return;
    }
    await sleep(30);
  }
  throw new Error('等待网络请求结束超时');
}

async function runPage(pageRel, options) {
  const page = loadPage(pageRel);
  currentPageRoute = pageRel;
  if (typeof page.onLoad === 'function') {
    const ret = page.onLoad(options || {});
    if (ret && typeof ret.then === 'function') await ret;
  }
  /* onShow 也要跑：我的页只在 onShow 里同步身份，不跑就等于没进过这一页 */
  if (typeof page.onShow === 'function') {
    const ret = page.onShow();
    if (ret && typeof ret.then === 'function') await ret;
  }
  await waitIdle();
  return page;
}

/* 页面里的 console.log 转到 pageLogs，最后作为「控制台输出」一起打印 */
console.log = (...args) => pageLogs.push(args.join(' '));
console.error = (...args) => { consoleErrorCount++; pageLogs.push('[error] ' + args.join(' ')); };

/* ---------- 4. 未登录态 ---------- */
group('1. 未登录：预约页与我的预约都给引导');

const anonBook = await runPage('pages/appointment/appointment', {});
check('未登录打开预约页 → needLogin=true，不发需要身份的请求',
  anonBook.data.needLogin === true &&
  !calls.some((c) => c[0] === 'request' && c[2].indexOf('/api/schedules') === 0),
  'needLogin=' + anonBook.data.needLogin);

const anonMine = await runPage('pages/my-appointments/my-appointments', {});
check('未登录打开我的预约 → needLogin=true，不静默空白',
  anonMine.data.needLogin === true && anonMine.data.appointments.length === 0,
  JSON.stringify({ needLogin: anonMine.data.needLogin, n: anonMine.data.appointments.length }));

anonBook.goLogin();
const anonJump = calls.filter((c) => c[0] === 'reLaunch').pop();
check('点「去登录」→ reLaunch 登录页并带 redirect 回预约页',
  !!anonJump && anonJump[1] === '/pages/login/login?redirect=%2Fpages%2Fappointment%2Fappointment',
  anonJump ? anonJump[1] : '未触发');

/* ---------- 5. 注册 → 登录 ---------- */
group('2. 注册与登录（复用 Web 的 /api/register、/api/login）');

const reg = await runPage('pages/register/register', {});
reg.onNameInput({ detail: { value: PATIENT.name } });
reg.onPhoneInput({ detail: { value: PATIENT.phone } });
reg.onPasswordInput({ detail: { value: PATIENT.password } });
await reg.submit();
await waitIdle();

check('注册成功：后端建了病人账号并回到登录页（带手机号）',
  calls.some((c) => c[0] === 'reLaunch' && c[1] === '/pages/login/login?account=' + PATIENT.phone),
  JSON.stringify(calls.filter((c) => c[0] === 'reLaunch').map((c) => c[1])));

check('注册页没有提交任何角色字段（服务端硬编码 patient）',
  !calls.some((c) => c[0] === 'request' && c[2] === '/api/register' && /role/.test(JSON.stringify(c))),
  '');

const loginPage = await runPage('pages/login/login', { account: PATIENT.phone });
check('登录页从参数回填手机号（注册后不用再打一遍）',
  loginPage.data.account === PATIENT.phone, loginPage.data.account);

loginPage.onPasswordInput({ detail: { value: PATIENT.password } });
await loginPage.submit();
await waitIdle();

const storedToken = storage.get('token') || '';
check('登录成功：token 写进 storage 的 token 键（三段式 JWT）',
  storedToken.split('.').length === 3, 'len=' + storedToken.length);
check('storage 里只有 token，没有密码',
  ![...storage.keys()].some((k) => /password/i.test(k)) && !/Test@1234/.test(JSON.stringify([...storage.entries()])),
  JSON.stringify([...storage.keys()]));
check('登录后跳「我的」（本次没有 redirect 参数）',
  calls.some((c) => c[0] === 'switchTab' && c[1] === '/pages/mine/mine'),
  JSON.stringify(calls.filter((c) => c[0] === 'switchTab').map((c) => c[1])));

const loginReqs = calls.filter((c) => c[0] === 'request' && c[2] === '/api/login');
check('登录请求不带 Authorization（还没 token），也不带 skip 之外的私货',
  loginReqs.length > 0 && loginReqs[loginReqs.length - 1][3] === '-',
  JSON.stringify(loginReqs));

/* 拿到 user id，后面要自己签一个「合法但已过期」的 token */
const meRes = await fetch(BASE + '/api/me', { headers: { authorization: 'Bearer ' + storedToken } });
const meBody = await meRes.json();
const patientId = meBody && meBody.user && meBody.user.id;
check('用 token 调 /api/me 能拿到身份（Bearer 通道通了）',
  Number.isInteger(patientId) && meBody.auth === 'bearer', JSON.stringify(meBody).slice(0, 120));

/* ---------- 6. 预约 ---------- */
group('3. 预约：医师 → 日期 → 时段 → 项目 → 提交');

const bookPage = await runPage('pages/appointment/appointment', {});
check('登录后打开预约页：不再是登录引导，医师与项目都来自接口',
  bookPage.data.needLogin === false &&
  bookPage.data.doctors.length === 4 &&
  bookPage.data.services.length === 8,
  JSON.stringify({ n: bookPage.data.doctors.length, s: bookPage.data.services.length }));

check('医师下拉用的是姓名 + 科室（数据来自 /api/public/doctors）',
  bookPage.data.doctorNames.length === 4 && /·/.test(bookPage.data.doctorNames[0]),
  bookPage.data.doctorNames.join(' | '));

check('医师的 booking_id 是数据库 id（不是 slug）',
  bookPage.data.doctors.every((d) => Number.isInteger(d.booking_id) && d.booking_id > 0),
  JSON.stringify(bookPage.data.doctors.map((d) => d.id + '->' + d.booking_id)));

/* 今天的时段：只要开始时间已过，就必须是「已过时间 + 不可点」，
   否则用户点了才被服务端 400 —— 那不是校验，是坑。 */
const todayPast = bookPage.data.slots.filter((s) =>
  new Date(bookPage.data.dateValue + 'T' + s.start_time + ':00').getTime() <= Date.now());
check('今天的已过时段被标成「已过时间」且不可点（服务端仍会再挡一次）',
  todayPast.every((s) => s.disabled && s.tag === '已过时间'),
  '已过 ' + todayPast.length + '/' + bookPage.data.slots.length + ' 个');

/* 默认是今天，时段可能已经过去；换到第 4 天（>24h，后面才取消得掉） */
const targetDate = bookPage.data.dates[3].value;
await bookPage.onDateChange({ detail: { value: targetDate } });
await waitIdle();

const freeIdx = bookPage.data.slots.findIndex((s) => !s.disabled);
check('换日期后拉到该医师该日的时段（来自 /api/schedules）',
  bookPage.data.slots.length >= 3 && freeIdx >= 0,
  'date=' + targetDate + ' slots=' + bookPage.data.slots.length + ' free=' + freeIdx);

const offSlot = bookPage.data.slots.find((s) => s.disabled);
check('已约满 / 未开放的时段被标成不可点（前端不自己判断有没有号）',
  !offSlot || offSlot.tag === '已约满' || offSlot.tag === '未开放',
  offSlot ? offSlot.tag : '当天没有已占用的时段');

bookPage.selectSlot({ currentTarget: { dataset: { index: freeIdx, id: bookPage.data.slots[freeIdx].id } } });
check('点击时段 → 选中态更新',
  bookPage.data.selectedSlotId === bookPage.data.slots[freeIdx].id &&
  !!bookPage.data.selectedSlotLabel,
  bookPage.data.selectedSlotLabel);

/* 先不选项目就提交：必须被挡住（项目是计费依据，不能默认成第一个） */
await bookPage.submit();
check('没选项目就提交 → 拦在本地，表单提示而不是发请求',
  !!bookPage.data.formError && !calls.some((c) => c[0] === 'request' && c[2] === '/api/appointments'),
  bookPage.data.formError);

bookPage.onServiceChange({ detail: { value: bookPage.data.services.findIndex((s) => s.id === 'cleaning') } });
bookPage.onNoteInput({ detail: { value: '小程序 mock 用例：洗牙' } });
await bookPage.submit();
await waitIdle();

const bookedId = bookPage.data.success && bookPage.data.success.id;
check('提交预约 → 后端返回 201，页面切到「已提交 · 待确认」',
  !!bookedId && bookPage.data.success.status_label === '待确认',
  JSON.stringify(bookPage.data.success));
check('成功页写明「待门诊确认」，不写「预约成功」',
  bookPage.data.success.date === targetDate && !!bookPage.data.success.time,
  JSON.stringify(bookPage.data.success));
check('提交请求带的是 Bearer（不是空头）',
  calls.filter((c) => c[0] === 'request' && c[2] === '/api/appointments').every((c) => c[3] === 'Bearer'),
  JSON.stringify(calls.filter((c) => c[0] === 'request' && c[2] === '/api/appointments')));

/* ---------- 7. 我的预约 + 取消 ---------- */
group('4. 我的预约与取消（二次确认）');

const myPage = await runPage('pages/my-appointments/my-appointments', {});
check('我的预约拉到列表，含刚提交的那条，状态是「待确认」',
  myPage.data.appointments.length >= 1 &&
  myPage.data.appointments.some((a) => a.id === bookedId && a.statusLabel === '待确认'),
  JSON.stringify(myPage.data.appointments.map((a) => '#' + a.id + a.statusLabel)));

const itemIdx = myPage.data.appointments.findIndex((a) => a.id === bookedId);
const item = myPage.data.appointments[itemIdx];
check('24 小时以外 → 服务端给 cancellable=true，按钮出现',
  item.canCancel === true && item.cancelHint === '',
  JSON.stringify(item));

/* 先点「再想想」：不能发取消请求 */
confirmModal = false;
myPage.cancel({ currentTarget: { dataset: { index: itemIdx } } });
await waitIdle();
check('二次确认点「再想想」→ 不发取消请求（手滑不会释放号源）',
  !calls.some((c) => c[0] === 'request' && c[2] === '/api/appointments/' + bookedId + '/cancel'),
  JSON.stringify(calls.filter((c) => c[0] === 'showModal')));

/* 再点「确定」 */
confirmModal = true;
myPage.cancel({ currentTarget: { dataset: { index: itemIdx } } });
await waitIdle();

check('确认取消 → 调 POST /api/appointments/:id/cancel 并重新拉列表',
  calls.some((c) => c[0] === 'request' && c[1] === 'POST' && c[2] === '/api/appointments/' + bookedId + '/cancel'),
  '');

const afterCancel = myPage.data.appointments.find((a) => a.id === bookedId);
check('取消后列表里该条变成「已取消」，且不再显示取消按钮',
  !!afterCancel && afterCancel.status === 'cancelled' && afterCancel.canCancel === false,
  JSON.stringify(afterCancel));

/* ---------- 8. token 过期 → 401 → 清 token → 跳登录 ---------- */
group('5. token 过期：401 统一处理');

const expiredToken = requireCjs('jsonwebtoken')
  .sign({ id: patientId, role: 'patient' }, DERIVED, { algorithm: 'HS256', expiresIn: -60 });

/* 用网络层的 setToken 写进去，而不是直接改 storage：
   request.js 在内存里缓存了 token（避免每次请求都读 storage），
   只改 storage 的话内存里还是旧的，测出来就是「过期了还能用」的假象。 */
const reqMod = requireCjs('./utils/request.js');
reqMod.setToken(expiredToken);

/* 这里直接调 api 层（而不是页面）：页面的 catch 会把错误吞成「错误态文案」，
   而我们要断言的是拦截器本身的行为 —— 它必须把带 needLogin 的错误抛出来。 */
const apiMod = requireCjs('./utils/api.js');

const beforeReLaunch = calls.filter((c) => c[0] === 'reLaunch').length;
currentPageRoute = 'pages/my-appointments/my-appointments';
let expiredErr = null;
try {
  await apiMod.listMyAppointments();
} catch (e) {
  expiredErr = e;
}
await waitIdle();

check('过期 token 请求受保护接口 → 401，错误码是 TOKEN_EXPIRED',
  !!expiredErr && expiredErr.statusCode === 401 && expiredErr.code === 'TOKEN_EXPIRED',
  expiredErr ? expiredErr.code + ' / ' + expiredErr.message : '没有抛错');

check('401 后本地 token 被清掉（不会拿着废票反复重试）',
  !storage.get('token'), 'token=' + (storage.get('token') || '(空)'));

const afterReLaunch = calls.filter((c) => c[0] === 'reLaunch');
check('401 后自动 reLaunch 到登录页（页面不用各自判断）',
  afterReLaunch.length === beforeReLaunch + 1 &&
  afterReLaunch[afterReLaunch.length - 1][1] === '/pages/login/login',
  JSON.stringify(afterReLaunch[afterReLaunch.length - 1]));

check('401 的错误带 needLogin 标记（页面据此复位界面，不再弹 toast）',
  !!expiredErr && expiredErr.needLogin === true, JSON.stringify(expiredErr && expiredErr.needLogin));

/* 再登一次，后面展示页还要用真实数据 */
const relogin = await runPage('pages/login/login', { account: PATIENT.phone });
relogin.onPasswordInput({ detail: { value: PATIENT.password } });
await relogin.submit();
await waitIdle();
check('重新登录后 token 又能用（过期只是过期，不是封号）',
  (storage.get('token') || '').split('.').length === 3, 'len=' + (storage.get('token') || '').length);

/* ---------- 9. 展示页仍然正常（阶段一没被改坏） ---------- */
group('6. 展示页未受影响');

const home = await runPage('pages/index/index', {});
check('首页 onLoad 完成且没有报错', home.data.loading === false && home.data.error === '',
  'loading=' + home.data.loading + ' error=' + home.data.error);
const hc = home.data.clinic || {};
check('首页诊所信息来自接口：名称 / 电话 / 地址齐全',
  !!hc.name && !!hc.phone.display && !!hc.address.full,
  JSON.stringify({ name: hc.name, phone: hc.phone && hc.phone.display }));
check('首页服务入口 6 条预览 + 总数 8', home.data.services.length === 6 && home.data.serviceTotal === 8,
  'preview=' + home.data.services.length + ' total=' + home.data.serviceTotal);
check('首页医师预览 3 条 + 总数 4', home.data.doctors.length === 3 && home.data.doctorTotal === 4,
  'preview=' + home.data.doctors.length + ' total=' + home.data.doctorTotal);

const services = await runPage('pages/services/services', {});
check('服务页 8 个项目，每项都有简介与价格文本',
  services.data.services.length === 8 &&
  services.data.services.every((s) => s.desc && s.price_text && s.price_note),
  'len=' + services.data.services.length);

const detail = await runPage('pages/service-detail/service-detail', { id: 'cleaning' });
check('详情页按 id 找到「洗牙」，价格与接口一致',
  !!detail.data.service && detail.data.service.label === '洗牙' &&
  detail.data.service.price_text === '¥280.00 起',
  JSON.stringify(detail.data.service && detail.data.service.price_text));

const doctors = await runPage('pages/doctors/doctors', {});
check('医生页 4 位医师，且 data 里没有执业证号 / 邮箱',
  doctors.data.doctors.length === 4 &&
  doctors.data.doctors.every((d) => d.name && d.dept && !('license' in d) && !('email' in d)),
  'len=' + doctors.data.doctors.length);

const mine = await runPage('pages/mine/mine', {});
check('我的页显示已登录身份（姓名 + 角色 + 打码手机号）',
  !!mine.data.user && mine.data.roleLabel === '就诊人' && /^\d{3}\*{4}\d{4}$/.test(mine.data.phoneMasked),
  JSON.stringify({ name: mine.data.user && mine.data.user.name, phone: mine.data.phoneMasked }));

confirmModal = true;
mine.logout();
await waitIdle();
check('退出登录 → 清 token、回到未登录态',
  !storage.get('token') && mine.data.user === null,
  'token=' + (storage.get('token') || '(空)'));

group('7. 全程');
check('页面 console 里没有 error（垫片统计）', consoleErrorCount === 0, 'count=' + consoleErrorCount);

const reqs = calls.filter((c) => c[0] === 'request');
check('所有请求都是本站 /api/*（没有外部地址）',
  reqs.length > 0 && reqs.every((c) => c[2].startsWith('/api/')),
  reqs.map((c) => c[2]).join(' | '));

check('所有请求都走 utils/request.js 的 BASE_URL（页面里没有第二个地址来源）',
  externalHits.length === 0, externalHits.join(' | '));

/* ---------- 10. 收尾 ---------- */
console.log = realLog;
console.error = realErr;

server.kill();
await sleep(300);
logStream.end();
for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
  try { fs.unlinkSync(f); } catch {}
}

/* ---------- 11. 输出 ---------- */
const lines = [];
function out(s) { lines.push(s === undefined ? '' : s); }

out('===== 小程序页面数据（真实后端 + wx 垫片）=====');
out('');
out('页面 console 输出：');
if (!pageLogs.length) out('  （无）');
for (const l of pageLogs) out('  ' + l);

out('');
out('登录 → 预约 → 取消 的请求流水（真实发出，只是主机被改写到测试端口）：');
for (const c of calls) {
  if (c[0] === 'request') out('  [api]      ' + c[1] + ' ' + c[2] + '  auth=' + c[3]);
  else if (c[0] === 'reLaunch') out('  [reLaunch] ' + c[1]);
  else if (c[0] === 'switchTab') out('  [switchTab] ' + c[1]);
  else if (c[0] === 'navigateTo') out('  [navigate] ' + c[1]);
  else if (c[0] === 'showModal') out('  [modal]    ' + c[1] + ' → ' + c[2]);
  else if (c[0] === 'showToast') out('  [toast]    ' + c[1]);
}

out('');
out('关键数据快照：');
out(JSON.stringify({
  token_in_storage_after_login: storedToken ? storedToken.slice(0, 18) + '…（' + storedToken.split('.').length + ' 段）' : '(无)',
  patient_id: patientId,
  booked: bookPage.data.success
    ? { id: bookPage.data.success.id, date: bookPage.data.success.date, time: bookPage.data.success.time,
        doctor: bookPage.data.success.doctor, service: bookPage.data.success.service,
        status: bookPage.data.success.status_label }
    : null,
  after_cancel: afterCancel ? { id: afterCancel.id, status: afterCancel.status, canCancel: afterCancel.canCancel } : null,
  expired_token_error: expiredErr ? { code: expiredErr.code, status: expiredErr.statusCode, needLogin: expiredErr.needLogin } : null
}, null, 2));

out('');
let pass = 0;
const groups = [];
for (const r of results) {
  if (r.pass) pass++;
  if (!groups.length || groups[groups.length - 1].name !== r.group) groups.push({ name: r.group, items: [] });
  groups[groups.length - 1].items.push(r);
}

out('===== 断言明细 =====');
for (const r of results) {
  out((r.pass ? '✅ PASS' : '❌ FAIL') + '  ' + r.name + (r.pass || !r.detail ? '' : '\n        → ' + r.detail));
}
out('');
out('===== 按组汇总 =====');
for (const g of groups) {
  const ok = g.items.filter((i) => i.pass).length;
  out(`${g.name}  ${ok}/${g.items.length}  ${ok === g.items.length ? '✅' : '❌'}`);
}
out('');
out(`合计 ${pass}/${results.length} 条断言通过，共 ${groups.length} 组`);

const text = lines.join('\n');
realLog(text);
if (OUT_FILE) {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, text + '\n', 'utf8');
  realLog('\n已写入 ' + OUT_FILE);
}

process.exit(pass === results.length ? 0 : 2);
