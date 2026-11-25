/* =========================================================
   scripts/miniprogram-check.mjs — 小程序工程静态体检
   ---------------------------------------------------------
   为什么需要它：
     微信开发者工具跑不了 CI，也没有 npm test。
     但「页面少了一个 .json」「WXML 里写了 <img>」「把电话写死在页面里」
     这类问题根本不需要真机就能发现 —— 用文件扫描就够了。

   它检查的是「约束」，不是「渲染效果」：
     结构是否完整、有没有用 DOM API、有没有外部请求、有没有硬编码诊所信息。
     真正的渲染效果必须在开发者工具里看（README §18.2）。

   运行：npm run test:mp      退出码 0 全过 / 2 有失败
   ========================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MP = path.join(ROOT, 'miniprogram');

const results = [];
let GROUP = '';
function group(name) { GROUP = name; }
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '', group: GROUP });
}

function read(rel) {
  return fs.readFileSync(path.join(MP, rel), 'utf8');
}
function exists(rel) {
  return fs.existsSync(path.join(MP, rel));
}
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
/* WXML 注释 <!-- --> 里可能写着「不要用 <img>」这类说明，
   扫描前必须去掉，否则体检脚本会把注释当成代码判红 */
function stripHtmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, '');
}
function walk(dir, ext, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full, ext, out);
    else if (name.endsWith(ext)) out.push(full);
  }
  return out;
}

/* ---------- 1. 结构 ---------- */
group('1. 目录与配置');

let app = null;
try {
  app = JSON.parse(read('app.json'));
  check('app.json 可解析', true);
} catch (e) {
  check('app.json 可解析', false, e.message);
}

const pages = (app && app.pages) || [];
check('声明 9 个页面（5 个 tab + 服务详情 + 我的预约 + 登录 + 注册）', pages.length === 9,
  'pages=' + pages.join(','));

const missing = [];
for (const p of pages) {
  for (const ext of ['js', 'json', 'wxml', 'wxss']) {
    if (!exists(p + '.' + ext)) missing.push(p + '.' + ext);
  }
}
check('每个页面都有 js / json / wxml / wxss 四件套', missing.length === 0, missing.join(','));

const tabList = (app && app.tabBar && app.tabBar.list) || [];
const tabTexts = tabList.map((t) => t.text).join('/');
check('tabBar 5 项，顺序为 首页/服务/医生/预约/我的', tabList.length === 5 && tabTexts === '首页/服务/医生/预约/我的',
  tabTexts);

check('tabBar 的 pagePath 都在 pages 里，且详情页不进 tabBar',
  tabList.every((t) => pages.indexOf(t.pagePath) >= 0) &&
  tabList.every((t) => t.pagePath !== 'pages/service-detail/service-detail'),
  tabList.map((t) => t.pagePath).join(','));

/* 登录 / 注册 / 我的预约都是「二级页」：不进 tabBar，
   靠 switchTab 之外的方式进入（navigateTo / reLaunch）。
   混进 tabBar 会让每次切 tab 都触发一次 401 跳转。 */
const SECONDARY = ['pages/login/login', 'pages/register/register', 'pages/my-appointments/my-appointments'];
check('登录 / 注册 / 我的预约都不在 tabBar 里',
  SECONDARY.every((p) => pages.indexOf(p) >= 0) &&
  SECONDARY.every((p) => tabList.every((t) => t.pagePath !== p)),
  tabList.map((t) => t.pagePath).join(','));

let proj = {};
try {
  proj = JSON.parse(read('project.config.json'));
  check('project.config.json 可解析', true);
} catch (e) {
  check('project.config.json 可解析', false, e.message);
}
check('project.config.json：urlCheck=false（不校验合法域名）、appid 非空、miniprogramRoot 指向自身',
  proj.setting && proj.setting.urlCheck === false &&
  typeof proj.appid === 'string' && proj.appid.length > 0 &&
  proj.miniprogramRoot === './',
  JSON.stringify({ urlCheck: proj.setting && proj.setting.urlCheck, appid: proj.appid, root: proj.miniprogramRoot }));

check('app.wxss 存在且给 page 设了背景色（不是白底裸奔）',
  exists('app.wxss') && /page\s*\{[\s\S]*?background/.test(read('app.wxss')), '');

/* ---------- 2. 代码约束 ---------- */
group('2. 没有 DOM、没有第三方库');

const pageJs = pages.map((p) => ({ rel: p + '.js', src: stripComments(read(p + '.js')) }));
const pageWxml = pages.map((p) => ({ rel: p + '.wxml', src: stripHtmlComments(read(p + '.wxml')) }));
const pageAll = pageJs.concat(pageWxml);

check('每个页面都用 Page({ ... }) 注册（不是自定义组件或裸函数）',
  pageJs.every((f) => /Page\s*\(\s*\{/.test(f.src)),
  pageJs.filter((f) => !/Page\s*\(\s*\{/.test(f.src)).map((f) => f.rel).join(','));

const domHits = [];
for (const f of pageJs) {
  for (const api of ['document.', 'window.', 'localStorage', 'sessionStorage', 'querySelector', 'innerHTML', 'addEventListener']) {
    if (f.src.indexOf(api) >= 0) domHits.push(f.rel + ':' + api);
  }
}
check('页面 JS 不含 DOM / BOM API（document / window / innerHTML …）', domHits.length === 0, domHits.join(','));

const directReq = pageJs.filter((f) => /wx\.request\s*\(/.test(f.src)).map((f) => f.rel);
check('页面不直接调 wx.request（统一走 utils/request.js）', directReq.length === 0, directReq.join(','));

/* token 只允许在 utils/request.js 里读写。
   页面自己 setStorageSync('token') 就会绕过「401 时清 token」这条唯一出口，
   早晚出现「token 改了但拦截器不知道」的情况。 */
const storageHits = pageJs.filter((f) => /wx\.(set|get|remove)StorageSync/.test(f.src)).map((f) => f.rel);
check('页面不直接读写 storage（token 的存取只在 utils/request.js）',
  storageHits.length === 0, storageHits.join(','));

const htmlTags = [];
for (const f of pageWxml) {
  if (/<img[\s>]/.test(f.src)) htmlTags.push(f.rel + ':img');
  if (/<\/?(div|span|p|section|article|a)[\s>]/.test(f.src)) htmlTags.push(f.rel + ':html-tag');
}
check('WXML 不使用 HTML 标签（img / div / span / p …）', htmlTags.length === 0, htmlTags.join(','));

const thirdParty = [];
for (const f of pageAll.concat([{ rel: 'app.js', src: read('app.js') }])) {
  if (/require\(['"](weui|@vant|vant|tdesign|lin-ui)/.test(f.src)) thirdParty.push(f.rel);
}
check('没有引入第三方 UI 库（weui / vant / tdesign / lin-ui）', thirdParty.length === 0, thirdParty.join(','));

/* ---------- 3. 数据来源 ---------- */
group('3. 数据只从接口来');

const DATA_PAGES = ['pages/index/index', 'pages/services/services', 'pages/service-detail/service-detail',
  'pages/doctors/doctors', 'pages/appointment/appointment'];
const noApi = DATA_PAGES.filter((p) => read(p + '.js').indexOf("require('../../utils/api')") < 0);
check('5 个取数页面都通过 utils/api.js 取数', noApi.length === 0, noApi.join(','));

const HARDCODE = ['0731', '8888', '岳麓', '刘主任', '刘医生', '×× 路', '139', '188'];
const hardHits = [];
for (const f of pageAll) {
  for (const s of HARDCODE) {
    if (f.src.indexOf(s) >= 0) hardHits.push(f.rel + ':' + s);
  }
}
check('页面里没有硬编码电话 / 地址 / 医师姓名 / 手机号（必须来自接口或用户输入）', hardHits.length === 0, hardHits.join(','));

const extHits = [];
for (const f of pageAll) {
  const found = f.src.match(/https?:\/\/[^\s'"`)]+/g) || [];
  for (const url of found) {
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)) extHits.push(f.rel + ':' + url);
  }
}
check('页面不含外部域名（没有 CDN / 字体 / 统计脚本）', extHits.length === 0, extHits.join(','));

/* ---------- 4. 网络层 ---------- */
group('4. 网络层封装与 token');

const req = read('utils/request.js');
/* 域名从第九期起放在 miniprogram/config.js（唯一环境配置），
   request.js 只 require 它。断言的本意没变：地址只能有一个来源。 */
const cfg = read('config.js');
/* 先剥掉注释：config.js 的注释里举例了云端地址，不剥会把示例当成真值 */
const cfgCode = cfg.replace(/\/\*[\s\S]*?\*\//g, '');
const baseHits = cfgCode.match(/BASE_URL:\s*'[^']+'/g) || [];
const baseValue = baseHits.length ? baseHits[0].replace(/^BASE_URL:\s*'|'$/g, '') : '';
check('地址只在 config.js 声明一次且是带端口的完整 URL；request.js 从它读取、不硬编码域名',
  baseHits.length === 1 &&
  /^https?:\/\/[^\s'"]+:\d+$/.test(baseValue) &&
  /require\('\.\.\/config'\)/.test(req) &&
  !/const BASE_URL = 'https?:/.test(req),
  baseValue || '未找到');
check('token 的 storage 键名就是 token（和后端约定一致）',
  /const TOKEN_KEY = 'token'/.test(req), '');
check('withAuth 请求自动带 Authorization: Bearer（不是每个页面自己拼头）',
  /header\.Authorization = 'Bearer ' \+ token/.test(req) && /if \(withAuth\)/.test(req), '');
check('setToken / clearToken / isLoggedIn 都从网络层导出（页面不做 storage 操作）',
  /setToken: setToken/.test(req) && /clearToken: clearToken/.test(req) && /isLoggedIn: isLoggedIn/.test(req), '');
check('401 统一处理：清 token + reLaunch 到登录页',
  /function handleUnauthorized/.test(req) &&
  /clearToken\(\)/.test(req) &&
  /wx\.reLaunch\(\{[\s\S]{0,80}url: LOGIN_PAGE/.test(req), '');
check('已在登录页 / 正在跳转时不重复跳（避免 401 死循环）',
  /currentRoute\(\) === LOGIN_PAGE/.test(req) && /redirectingToLogin/.test(req), '');
check('登录接口自己的 401 不跳转（skipAuthRedirect），否则登录失败会刷页面',
  /skipAuthRedirect/.test(req) && /opts\.withAuth && !opts\.skipAuthRedirect/.test(req), '');
check('网络层只存 token，不存密码（源码里没有 password 存储）',
  !/setStorageSync\([^)]*password/i.test(req), '');
check('统一错误处理：normalizeError + toastError 都已导出',
  /function normalizeError/.test(req) && /toastError: toastError/.test(req), '');
check('拒绝完整域名请求（只接受 / 开头的站内路径）',
  /function assertLocalPath/.test(req) && /charAt\(0\) !== '\/'/.test(req), '');
check('云托管通道存在，开关是布尔值，且关掉即可回退 wx.request',
  /CLOUD:\s*\{[\s\S]{0,240}enabled:\s*(true|false)/.test(cfgCode) &&
  /wx\.cloud\.callContainer/.test(req) &&
  /CLOUD_ENABLED/.test(req), '');
check('云通道只在 env 与 service 都填了才生效（配错不弄挂本地开发）',
  /CLOUD\.enabled && CLOUD\.env && CLOUD\.service/.test(req), '');
check('云托管初始化在 app.js 的 onLaunch，且未开启时直接返回',
  /wx\.cloud\.init/.test(read('app.js')) && /if \(!cloud\.enabled \|\| !cloud\.env\) return;/.test(read('app.js')), '');

/* ---------- 5. 认证与预约页结构 ---------- */
group('5. 登录 / 注册 / 预约 / 我的预约');

const loginJs = stripComments(read('pages/login/login.js'));
const loginWxml = stripHtmlComments(read('pages/login/login.wxml'));
const regJs = stripComments(read('pages/register/register.js'));
const regWxml = stripHtmlComments(read('pages/register/register.wxml'));
const bookJs = stripComments(read('pages/appointment/appointment.js'));
const bookWxml = stripHtmlComments(read('pages/appointment/appointment.wxml'));
const myJs = stripComments(read('pages/my-appointments/my-appointments.js'));
const myWxml = stripHtmlComments(read('pages/my-appointments/my-appointments.wxml'));

check('登录页调 /api/login（经 utils/api），不自己拼 URL',
  /api\.login\(/.test(loginJs) && loginJs.indexOf('/api/login') < 0, '');
check('登录页只有手机号 + 密码两个输入，没有角色选择',
  /onAccountInput/.test(loginJs) && /onPasswordInput/.test(loginJs) &&
  !/role/i.test(loginJs) && !/role/i.test(loginWxml), '');
check('登录成功后按 redirect 回原页面，否则回「我的」',
  /that\.data\.redirect/.test(loginJs) && /wx\.reLaunch/.test(loginJs) && /wx\.switchTab/.test(loginJs), '');

check('注册页调 /api/register，且请求体只有 name / phone / password',
  /api\.register\(/.test(regJs) && /register: register/.test(read('utils/api.js')), '');
check('注册页没有角色选择器（服务端硬编码 patient）',
  !/role/i.test(regWxml) && !/picker/.test(regWxml), '');
check('注册页在本地也校验手机号 / 密码长度（少一次无效往返）',
  /PHONE_RE/.test(regJs) && /8/.test(regJs), '');

check('预约页未登录时给出登录引导（needLogin + 去登录按钮）',
  /needLogin/.test(bookJs) && /needLogin/.test(bookWxml) && /goLogin/.test(bookWxml), '');
check('预约页登录引导带 redirect 参数（登录后回到预约页）',
  /redirect=/.test(bookJs) && /encodeURIComponent\('\/pages\/appointment\/appointment'\)/.test(bookJs), '');
check('预约页用 booking_id 拉时段（不是 data.js 的 slug）',
  /doctor\.booking_id/.test(bookJs) && !/doctor_id: *doctor\.id/.test(bookJs), '');
check('日期用 picker mode="date"（不是自己算字符串）',
  /mode="date"/.test(bookWxml) && /bindchange="onDateChange"/.test(bookWxml), '');
check('时段来自 /api/schedules（经 api.getSchedules），不在前端造',
  /api\.getSchedules\(/.test(bookJs), '');
check('提交走 api.createAppointment，并带 service（计费依据）',
  /api\.createAppointment\(/.test(bookJs) && /service: this\.data\.serviceId/.test(bookJs), '');
check('提交成功的文案是「待确认」，不是「预约成功」',
  /待确认/.test(bookWxml) && !/预约成功|已约上|预约已确认/.test(bookWxml), '');

check('我的预约页用 wx.showModal 二次确认后才取消',
  /wx\.showModal\(/.test(myJs) && /res\.confirm/.test(myJs) && /api\.cancelAppointment\(/.test(myJs), '');
check('取消按钮只按服务端 cancellable 显示（前端不自己算 24 小时）',
  /item\.canCancel/.test(myWxml) && !/24 \* 60|86400000|CANCEL_WINDOW/.test(myJs), '');
check('未登录访问我的预约 → 登录引导，不静默空白',
  /needLogin/.test(myJs) && /needLogin/.test(myWxml) && /goLogin/.test(myWxml), '');

/* ---------- 6. 样式 ---------- */
group('6. WXSS 约束');

const wxssFiles = walk(MP, '.wxss');
const focusHits = wxssFiles.filter((f) => stripComments(fs.readFileSync(f, 'utf8')).indexOf(':focus-visible') >= 0)
  .map((f) => path.relative(MP, f));
check('WXSS 不使用 :focus-visible（小程序没有这套焦点语义）', focusHits.length === 0, focusHits.join(','));

let pxHits = [];
for (const f of wxssFiles) {
  const src = stripComments(read(path.relative(MP, f)));
  const m = src.match(/(?<!r)px\b/g);
  if (m) pxHits.push(path.relative(MP, f) + '×' + m.length);
}
check('WXSS 尺寸统一用 rpx（没有裸 px，避免机型缩放不一致）', pxHits.length === 0, pxHits.join(','));

/* ---------- 输出 ---------- */
let pass = 0;
const groups = [];
for (const r of results) {
  if (r.pass) pass++;
  if (!groups.length || groups[groups.length - 1].name !== r.group) groups.push({ name: r.group, items: [] });
  groups[groups.length - 1].items.push(r);
}

console.log('\n===== 小程序静态体检 =====');
for (const r of results) {
  console.log((r.pass ? '✅ PASS' : '❌ FAIL') + '  ' + r.name + (r.pass || !r.detail ? '' : '\n        → ' + r.detail));
}

console.log('\n===== 按组汇总 =====');
for (const g of groups) {
  const ok = g.items.filter((i) => i.pass).length;
  console.log(`${g.name}  ${ok}/${g.items.length}  ${ok === g.items.length ? '✅' : '❌'}`);
}
console.log(`\n合计 ${pass}/${results.length} 条断言通过，共 ${groups.length} 组`);

process.exit(pass === results.length ? 0 : 2);
