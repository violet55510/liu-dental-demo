/* =========================================================
   scripts/e2e.mjs — 真实浏览器端到端回归（第三/四期）
   ---------------------------------------------------------
   和另外两套脚本的分工：

     api-test.mjs        只打 HTTP，验证「接口行为 + 数据库状态」
     regression.mjs      用 file:// 打开五个展示页，验证「静态站交互没退化」
     e2e.mjs（本文件）   起真服务 + 真浏览器，验证「点按钮 → 界面变化 → 落库」
                         这一整条链路。接口全绿但按钮没接上、或前端没刷新，
                         只有这一套能发现。

   覆盖范围：
     1. 医生用登录页真实登录 → 控制台只显示医生面板
     2. 待确认卡片 → 点「确认预约」→ 状态与按钮联动、小结数字变化
     3. 点「标记完成」→ 终态、按钮消失、库里有 completed
     4. 另一条点「患者未到」→ no_show → 出现「恢复为已确认」→ 点回 confirmed
        （第四期新增：no_show 有出边，不是死胡同）
     5. 全程不整页刷新（用 window 上的哨兵变量证明是局部刷新）
     6. 病人登录 → 点「预约详情」就地展开 → aria-expanded 同步 → 再点收起
     7. 病人点「去支付」→ 支付页写明「模拟支付，不产生真实扣款」→
        点支付 → 订单变 paid → 点退款 → 变 refunded（第五期）
     8. 全程 Network 只出现本站地址（没有一条外部请求）
     9. 全程控制台无 error / 无未捕获异常

   依赖：Node ≥ 22（内置 fetch / WebSocket）、本机 Edge 或 Chrome。无需 npm install。
   运行：npm run test:e2e       或   node scripts/e2e.mjs
   可选环境变量：
     E2E_PORT       服务端口，默认 3102（避开 dev 的 3000 与 api-test 的 3101）
     E2E_CDP_PORT   浏览器调试端口，默认 9444
     EDGE_PATH      指定浏览器可执行文件

   退出码：0 全通过 / 2 有失败 / 1 环境问题。
   ========================================================= */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT || 3102);
const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9444);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP_DIR = path.join(ROOT, '.workbuddy');
const DB_FILE = path.join(TMP_DIR, 'e2e.db');
const LOG_FILE = path.join(TMP_DIR, 'e2e-server.log');

const PATIENT = { phone: '13900001001', password: 'E2e@12345', name: '端到端病人' };
const DOCTOR = { email: 'liu-implant@demo.local', password: 'Demo@1234' };

/* ---------- 结果收集 ---------- */
const results = [];
let GROUP = '';
function check(name, pass, detail) {
  results.push({ group: GROUP, name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
  console.log((pass ? '✅ PASS' : '❌ FAIL') + '  ' + name + (pass ? '' : '\n        → ' + detail));
}
function group(name) { GROUP = name; console.log('\n--- ' + name + ' ---'); }

/* ---------- 日期工具（与页面/服务端一致：本地时区） ---------- */
function ymd(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n) => (n < 10 ? '0' : '') + n;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ---------- 极简 cookie 客户端（造数据用，不参与界面断言） ---------- */
function makeClient() {
  let cookie = '';
  async function req(method, url, body) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    const r = await fetch(BASE + url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const set = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    for (const c of set) {
      const kv = c.split(';')[0];
      if (kv.startsWith('lsd.sid=')) cookie = kv;
    }
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  }
  return {
    get: (u) => req('GET', u),
    post: (u, b) => req('POST', u, b === undefined ? {} : b)
  };
}

/* =========================================================
   0. 起服务 + 造数据
   ========================================================= */
fs.mkdirSync(TMP_DIR, { recursive: true });
for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
  try { fs.unlinkSync(f); } catch {}
}

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'app.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    DB_FILE,
    SESSION_SECRET: 'e2e-only-secret-0123456789abcdef',
    NODE_ENV: 'test'
  },
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
  console.error('服务没起来，看看 ' + LOG_FILE);
  server.kill();
  process.exit(1);
}

/* 病人 + 两条预约（医生 = 种植科刘主任） */
const api = makeClient();
const reg = await api.post('/api/register', PATIENT);
if (reg.status !== 201) { console.error('注册失败：' + reg.text); server.kill(); process.exit(1); }
await api.post('/api/login', { account: PATIENT.phone, password: PATIENT.password });

const doctors = await api.get('/api/doctors');
const implant = (doctors.json.doctors || []).find((d) => d.slug === 'liu-implant');
if (!implant) { console.error('找不到种植科医生'); server.kill(); process.exit(1); }

async function bookOne(date) {
  const r = await api.get(`/api/schedules?doctor_id=${implant.id}&date=${date}`);
  const slot = (r.json.slots || []).find((s) => s.open && !s.taken);
  if (!slot) return null;
  const b = await api.post('/api/appointments', { schedule_id: slot.id, service: 'cleaning', note: 'E2E 用例' });
  return b.status === 201 ? b.json.appointment : null;
}
const appt1 = await bookOne(ymd(3));
const appt2 = await bookOne(ymd(4));
if (!appt1 || !appt2) {
  console.error('造预约失败（种子排班里没有空闲时段）');
  server.kill();
  process.exit(1);
}

/* =========================================================
   1. 起浏览器 + 连 CDP
   ========================================================= */
const BROWSER_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);
const BROWSER = BROWSER_CANDIDATES.find((p) => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
});
if (!BROWSER) {
  console.error('找不到浏览器。请设置 EDGE_PATH 指向 msedge.exe / chrome.exe。');
  server.kill();
  process.exit(1);
}

const userData = path.join(os.tmpdir(), 'edge-e2e-' + Date.now());
const browser = spawn(BROWSER, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--remote-debugging-port=' + CDP_PORT,
  '--user-data-dir=' + userData,
  'about:blank'
], { stdio: 'ignore' });

let target = null;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
    if (target) break;
  } catch {}
  await sleep(250);
}
if (!target) {
  console.error('无法连接浏览器调试端口 ' + CDP_PORT);
  browser.kill(); server.kill(); process.exit(1);
}

const consoleErrors = [];
/* 网络自检：把浏览器发起的每一个请求 URL 都记下来。
   最后断言「没有一条指向本站以外」——这就是 Network 面板那件事的机器证据，
   比口头说"我看过了"可靠。 */
const netUrls = [];
const cdp = (() => {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', rej);
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }
    /* 收集页面侧真实报错：未捕获异常 + console.error */
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      consoleErrors.push('exception: ' + (d.exception && d.exception.description ? d.exception.description : d.text));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push('console.error: ' + msg.params.args.map((a) => a.value || a.description || '').join(' '));
    }
    if (msg.method === 'Network.requestWillBeSent') {
      netUrls.push({
        url: msg.params.request.url,
        method: msg.params.request.method,
        type: msg.params.type
      });
    }
  });
  function send(method, params = {}) {
    const mid = ++id;
    return new Promise((resolve, reject) => {
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
      setTimeout(() => {
        if (pending.has(mid)) { pending.delete(mid); reject(new Error('timeout: ' + method)); }
      }, 15000);
    });
  }
  return { ready, send, close: () => ws.close() };
})();

await cdp.ready;
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Network.enable');   // 第五期：抓全部请求，证明没有外部调用

async function evaluate(expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  });
  if (r.exceptionDetails) throw new Error('页面 JS 异常: ' + JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

async function nav(url) {
  await cdp.send('Page.navigate', { url });
  /* 等 document.readyState 完整，再交给具体的 waitFor 等业务渲染 */
  for (let i = 0; i < 100; i++) {
    try {
      if (await evaluate('document.readyState === "complete"')) return;
    } catch {}
    await sleep(100);
  }
}

async function waitFor(expression, timeout = 8000, label = expression) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      if (await evaluate(expression)) return true;
    } catch {}
    await sleep(120);
  }
  throw new Error('等待超时：' + label);
}

async function click(selector) {
  const ok = await evaluate(`(function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!ok) throw new Error('找不到可点击元素：' + selector);
}

/* 统一取一条预约卡片的状态 / 按钮 / 徽标 */
function cardExpr(apptId) {
  return `(function(){
    var item = document.querySelector('.appt-item[data-appt-id="${apptId}"]');
    if (!item) return null;
    var badge = item.querySelector('.appt-status');
    return {
      badge: badge ? badge.getAttribute('data-status') : null,
      badgeText: badge ? badge.textContent.trim() : '',
      buttons: Array.prototype.map.call(item.querySelectorAll('button'), function(b){ return b.textContent.trim(); }),
      actions: Array.prototype.map.call(item.querySelectorAll('button'), function(b){ return b.getAttribute('data-appt-action'); })
    };
  })()`;
}

/* =========================================================
   2. 医生端：登录 → 确认 → 完成 / 未到诊 → 恢复
   ========================================================= */
let failed = false;
try {
  group('1. 医生登录与面板');

  await nav(`${BASE}/login.html`);
  await waitFor('!!document.querySelector("#login-form")', 8000, '登录表单渲染');
  await evaluate(`(function(){
    document.querySelector('#f-account').value = ${JSON.stringify(DOCTOR.email)};
    document.querySelector('#f-password').value = ${JSON.stringify(DOCTOR.password)};
    document.querySelector('#login-form').requestSubmit();
    return true;
  })()`);

  await waitFor('location.pathname.endsWith("dashboard.html")', 10000, '登录后跳转到控制台');
  await waitFor('!document.querySelector("#panel-doctor").hidden', 10000, '医生面板显示');

  const panels = await evaluate(`({
    doctor: !document.querySelector('#panel-doctor').hidden,
    patient: !document.querySelector('#panel-patient').hidden,
    admin: !document.querySelector('#panel-admin').hidden
  })`);
  check('登录后只显示医生面板，病人/管理员面板隐藏',
    panels.doctor && !panels.patient && !panels.admin, JSON.stringify(panels));

  const who = await evaluate(`({
    title: document.querySelector('#dash-title').textContent.trim(),
    name: document.querySelector('#d-name').textContent.trim(),
    dept: document.querySelector('#d-dept').textContent.trim()
  })`);
  check('顶部问候与医生资料来自会话（刘主任 / 种植科）',
    /刘主任/.test(who.title) && who.name === '刘主任' && who.dept === '种植科',
    JSON.stringify(who));

  group('2. 待确认 → 确认（界面 + 数据联动）');

  await waitFor(`!!document.querySelector('.appt-item[data-appt-id="${appt1.id}"]')`, 10000, '预约卡片渲染');

  const before = await evaluate(cardExpr(appt1.id));
  check('待确认卡片徽标是「待确认」', before && before.badge === 'pending' && before.badgeText === '待确认',
    JSON.stringify(before));
  check('待确认卡片只有一个操作按钮「确认预约」',
    before && before.buttons.length === 1 && before.buttons[0] === '确认预约', JSON.stringify(before && before.buttons));

  const summaryBefore = await evaluate('document.querySelector("#d-summary").textContent.trim()');
  check('小结显示「待确认 2 · 已确认 0」', /待确认\s*2/.test(summaryBefore) && /已确认\s*0/.test(summaryBefore),
    summaryBefore);

  /* 打一个哨兵：整页刷新会把它清掉，用来证明「操作后是局部刷新」 */
  await evaluate('window.__e2eNoReload = 1');

  await click(`.appt-item[data-appt-id="${appt1.id}"] button[data-appt-action="confirm"]`);
  await waitFor(`(function(){
    var el = document.querySelector('.appt-item[data-appt-id="${appt1.id}"] .appt-status');
    return !!el && el.getAttribute('data-status') === 'confirmed';
  })()`, 8000, '确认后状态变 confirmed');

  const afterConfirm = await evaluate(cardExpr(appt1.id));
  check('确认后徽标变「已确认」', afterConfirm.badge === 'confirmed' && afterConfirm.badgeText === '已确认',
    JSON.stringify(afterConfirm));
  check('确认后按钮换成「标记完成 / 患者未到」',
    afterConfirm.buttons.length === 2 &&
    afterConfirm.actions.indexOf('complete') >= 0 &&
    afterConfirm.actions.indexOf('no-show') >= 0,
    JSON.stringify(afterConfirm.buttons));

  const statusLine = await evaluate('document.querySelector("#d-status").textContent.trim()');
  check('卡片下方给出操作反馈「已确认」', /已确认/.test(statusLine), statusLine);

  const summaryAfter = await evaluate('document.querySelector("#d-summary").textContent.trim()');
  check('确认后小结变「待确认 1 · 已确认 1」',
    /待确认\s*1/.test(summaryAfter) && /已确认\s*1/.test(summaryAfter), summaryAfter);

  check('操作后页面没有整页刷新（哨兵变量还在）',
    await evaluate('window.__e2eNoReload === 1'), '哨兵被清空 → 发生了 reload');

  group('3. 已确认 → 完成');

  /* 时间闸门（第七期）：只有「时段已开始」才允许标记完成，
     否则医生可以把明天的预约今天标成完成（线上就是这么坏的）。
     这里先把这个时段挪到昨天，模拟「患者已经到诊」。 */
  {
    const w = new Database(DB_FILE);
    const sid = w.prepare('SELECT schedule_id FROM appointments WHERE id = ?').get(appt1.id).schedule_id;
    w.prepare(`
      UPDATE schedules SET date = date('now','-1 day'), start_time = '05:00', end_time = '06:00'
      WHERE id = ?
    `).run(sid);
    w.close();
  }

  await click(`.appt-item[data-appt-id="${appt1.id}"] button[data-appt-action="complete"]`);
  await waitFor(`(function(){
    var el = document.querySelector('.appt-item[data-appt-id="${appt1.id}"] .appt-status');
    return !!el && el.getAttribute('data-status') === 'completed';
  })()`, 8000, '完成后状态变 completed');

  const afterComplete = await evaluate(cardExpr(appt1.id));
  check('完成后徽标变「已完成」', afterComplete.badge === 'completed' && afterComplete.badgeText === '已完成',
    JSON.stringify(afterComplete));
  check('完成后卡片不再有操作按钮（终态）', afterComplete.buttons.length === 0,
    JSON.stringify(afterComplete.buttons));

  group('4. 未到诊 → 恢复（第四期新增出边）');

  await click(`.appt-item[data-appt-id="${appt2.id}"] button[data-appt-action="confirm"]`);
  await waitFor(`(function(){
    var el = document.querySelector('.appt-item[data-appt-id="${appt2.id}"] .appt-status');
    return !!el && el.getAttribute('data-status') === 'confirmed';
  })()`, 8000, '第二条确认');

  await click(`.appt-item[data-appt-id="${appt2.id}"] button[data-appt-action="no-show"]`);
  await waitFor(`(function(){
    var el = document.querySelector('.appt-item[data-appt-id="${appt2.id}"] .appt-status');
    return !!el && el.getAttribute('data-status') === 'no_show';
  })()`, 8000, '标记未到诊');

  const afterNoShow = await evaluate(cardExpr(appt2.id));
  check('标记后徽标变「未到诊」', afterNoShow.badge === 'no_show' && afterNoShow.badgeText === '未到诊',
    JSON.stringify(afterNoShow));
  check('未到诊卡片出现「恢复为已确认」按钮（不再是死胡同）',
    afterNoShow.buttons.length === 1 &&
    afterNoShow.buttons[0] === '恢复为已确认' &&
    afterNoShow.actions[0] === 'reopen',
    JSON.stringify(afterNoShow.buttons));

  await click(`.appt-item[data-appt-id="${appt2.id}"] button[data-appt-action="reopen"]`);
  await waitFor(`(function(){
    var el = document.querySelector('.appt-item[data-appt-id="${appt2.id}"] .appt-status');
    return !!el && el.getAttribute('data-status') === 'confirmed';
  })()`, 8000, '恢复为 confirmed');

  const afterReopen = await evaluate(cardExpr(appt2.id));
  check('恢复后徽标回到「已确认」', afterReopen.badge === 'confirmed' && afterReopen.badgeText === '已确认',
    JSON.stringify(afterReopen));
  check('恢复后按钮回到「标记完成 / 患者未到」',
    afterReopen.buttons.length === 2 && afterReopen.actions.indexOf('no-show') >= 0,
    JSON.stringify(afterReopen.buttons));

  group('5. 落库核对（界面说改了，库里也得改了）');

  const w = new Database(DB_FILE, { readonly: true });
  const row1 = w.prepare('SELECT status FROM appointments WHERE id = ?').get(appt1.id);
  const row2 = w.prepare('SELECT status FROM appointments WHERE id = ?').get(appt2.id);
  w.close();
  check('库里第一条是 completed', row1 && row1.status === 'completed', JSON.stringify(row1));
  check('库里第二条是 confirmed（no_show 已被 reopen 纠错）',
    row2 && row2.status === 'confirmed', JSON.stringify(row2));

  /* =========================================================
     3. 病人端：详情展开 / 收起
     ========================================================= */
  group('6. 病人登录与预约详情');

  /* 先真的走一次登出接口，再回登录页用病人身份登录 */
  await evaluate(`fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).then(function(){ return true; })`);
  await nav(`${BASE}/login.html`);
  await waitFor('!!document.querySelector("#login-form")', 8000, '登录表单（第二次）');
  await evaluate(`(function(){
    document.querySelector('#f-account').value = ${JSON.stringify(PATIENT.phone)};
    document.querySelector('#f-password').value = ${JSON.stringify(PATIENT.password)};
    document.querySelector('#login-form').requestSubmit();
    return true;
  })()`);

  await waitFor('!document.querySelector("#panel-patient").hidden', 10000, '病人面板显示');
  check('病人只看到病人面板',
    await evaluate(`!document.querySelector('#panel-patient').hidden
      && document.querySelector('#panel-doctor').hidden
      && document.querySelector('#panel-admin').hidden`), '');

  await waitFor(`!!document.querySelector('.appt-item[data-appt-id="${appt2.id}"]')`, 10000, '病人预约卡片');

  await click(`.appt-item[data-appt-id="${appt2.id}"] button[data-detail-id="${appt2.id}"]`);
  await waitFor(`!!document.querySelector('.appt-item[data-appt-id="${appt2.id}"] .appt-detail')`,
    8000, '详情区块展开');

  const detail = await evaluate(`(function(){
    var item = document.querySelector('.appt-item[data-appt-id="${appt2.id}"]');
    var dl = item.querySelector('.appt-detail');
    var btn = item.querySelector('button[data-detail-id="${appt2.id}"]');
    return {
      hidden: dl.hidden,
      rows: Array.prototype.map.call(dl.querySelectorAll('dt'), function(n){ return n.textContent.trim(); }),
      text: dl.textContent,
      expanded: btn.getAttribute('aria-expanded'),
      btnText: btn.textContent.trim()
    };
  })()`);
  check('详情就地展开（不是跳页），包含医师/时段/状态/取消规则/提交时间 5 项',
    !detail.hidden &&
    ['医师', '时段', '状态', '取消规则', '提交时间'].every((k) => detail.rows.indexOf(k) >= 0),
    JSON.stringify(detail.rows));
  check('详情里的医师带科室', /刘主任（种植科）/.test(detail.text), detail.text.slice(0, 80));
  check('展开后 aria-expanded=true、按钮文案变「收起详情」',
    detail.expanded === 'true' && detail.btnText === '收起详情',
    detail.expanded + ' / ' + detail.btnText);

  await click(`.appt-item[data-appt-id="${appt2.id}"] button[data-detail-id="${appt2.id}"]`);
  await waitFor(`(function(){
    var item = document.querySelector('.appt-item[data-appt-id="${appt2.id}"]');
    var btn = item.querySelector('button[data-detail-id="${appt2.id}"]');
    return btn && btn.getAttribute('aria-expanded') === 'false';
  })()`, 5000, '详情收起');

  const collapsed = await evaluate(`(function(){
    var item = document.querySelector('.appt-item[data-appt-id="${appt2.id}"]');
    return {
      hidden: item.querySelector('.appt-detail').hidden,
      btnText: item.querySelector('button[data-detail-id="${appt2.id}"]').textContent.trim()
    };
  })()`);
  check('再点一次收起：hidden=true、按钮文案回「预约详情」',
    collapsed.hidden === true && collapsed.btnText === '预约详情', JSON.stringify(collapsed));

  group('7. 模拟支付：去支付 → 支付 → 退款');

  const netBeforePay = netUrls.length;

  /* 卡片上的「去支付」是 <a>，点它会跳到 payment.html?appointment=<id> */
  await click(`a[data-pay-id="${appt2.id}"]`);
  await waitFor('location.pathname.endsWith("payment.html")', 10000, '跳转到支付页');
  /* 等「订单已渲染」而不是「订单区已显示」：
     页面先 show 再填内容的话，下面读到的 state 会是占位符「—」，
     断言会随机红——这是等待条件写得太松，不是产品行为变了。 */
  await waitFor(`(function(){
    var app = document.querySelector('#pay-app');
    var state = document.querySelector('#pay-state');
    return app && !app.hidden && state && state.textContent.trim().length > 1 &&
           state.textContent.indexOf('—') < 0;
  })()`, 10000, '支付页订单加载完成');

  const payPage = await evaluate(`(function(){
    var notice = document.querySelector('#pay-notice');
    return {
      search: location.search,
      notice: notice ? notice.textContent.replace(/\\s+/g, ' ').trim() : '',
      amount: document.querySelector('#pay-amount').textContent.trim(),
      state: document.querySelector('#pay-state').textContent.trim(),
      service: document.querySelector('#pay-service').textContent.trim(),
      payHidden: document.querySelector('#pay-btn').hidden,
      refundHidden: document.querySelector('#refund-btn').hidden
    };
  })()`);
  check('从「我的预约」可以跳到该预约的支付页（URL 带 appointment）',
    /appointment=/.test(payPage.search), payPage.search);
  check('支付页写明「模拟支付，不产生真实扣款」，并点名不接入真实通道',
    /模拟支付，不产生真实扣款/.test(payPage.notice) && /支付宝/.test(payPage.notice),
    payPage.notice.slice(0, 80));
  check('金额由服务端算出：¥280.00（洗牙）', payPage.amount === '¥280.00' && payPage.service === '洗牙',
    payPage.amount + ' / ' + payPage.service);
  check('订单初始「待支付」：支付按钮可见、退款按钮隐藏',
    /待支付/.test(payPage.state) && payPage.payHidden === false && payPage.refundHidden === true,
    JSON.stringify(payPage));

  await click('#pay-btn');
  await waitFor(`document.querySelector('#pay-badge').getAttribute('data-order-status') === 'paid'`,
    8000, '订单变 paid');

  const afterPay = await evaluate(`({
    badge: document.querySelector('#pay-badge').textContent.trim(),
    state: document.querySelector('#pay-state').textContent.trim(),
    line: document.querySelector('#pay-status').textContent.trim(),
    payHidden: document.querySelector('#pay-btn').hidden,
    refundHidden: document.querySelector('#refund-btn').hidden,
    paidAt: document.querySelector('#pay-paid-at').textContent.trim()
  })`);
  check('点「支付」后徽标变「已支付」', afterPay.badge === '已支付' && /已支付/.test(afterPay.state),
    JSON.stringify(afterPay));
  check('支付反馈写明「未发生真实扣款」', /未发生真实扣款/.test(afterPay.line), afterPay.line);
  check('支付后支付按钮隐藏、退款按钮出现',
    afterPay.payHidden === true && afterPay.refundHidden === false, JSON.stringify(afterPay));
  check('支付时间已回填（paid_at 非空）', afterPay.paidAt !== '—' && afterPay.paidAt.length > 0, afterPay.paidAt);

  await click('#refund-btn');
  await waitFor(`document.querySelector('#pay-badge').getAttribute('data-order-status') === 'refunded'`,
    8000, '订单变 refunded');

  const afterRefund = await evaluate(`({
    badge: document.querySelector('#pay-badge').textContent.trim(),
    line: document.querySelector('#pay-status').textContent.trim(),
    refundedAt: document.querySelector('#pay-refunded-at').textContent.trim(),
    payHidden: document.querySelector('#pay-btn').hidden
  })`);
  check('点「退款」后徽标变「已退款」', afterRefund.badge === '已退款', JSON.stringify(afterRefund));
  check('退款反馈写明「未发生真实资金往来」', /未发生真实资金往来/.test(afterRefund.line), afterRefund.line);
  check('退款后支付按钮不再出现（不能复活）', afterRefund.payHidden === true, JSON.stringify(afterRefund));
  check('退款时间已回填（refunded_at 非空）', afterRefund.refundedAt !== '—' && afterRefund.refundedAt.length > 0,
    afterRefund.refundedAt);

  /* 落库核对：界面上说退款了，库里也得是 refunded */
  const w2 = new Database(DB_FILE, { readonly: true });
  const oRow = w2.prepare(
    'SELECT status, amount_cents, paid_at, refunded_at FROM orders WHERE appointment_id = ?'
  ).get(appt2.id);
  w2.close();
  check('库里订单是 refunded、金额 28000 分、两个时间戳都在',
    !!oRow && oRow.status === 'refunded' && oRow.amount_cents === 28000 &&
    !!oRow.paid_at && !!oRow.refunded_at, JSON.stringify(oRow));

  /* 先把支付页期间的请求快照下来（下面还要跳页，跳页会继续往里加） */
  const payCalls = netUrls.slice(netBeforePay);

  /* 回控制台：卡片上应显示「已退款」，并且不再给支付入口 */
  await nav(`${BASE}/dashboard.html`);
  await waitFor(`!!document.querySelector('.appt-item[data-appt-id="${appt2.id}"]')`, 10000, '回到控制台');

  const cardAfter = await evaluate(`(function(){
    var item = document.querySelector('.appt-item[data-appt-id="${appt2.id}"]');
    var label = item.querySelector('.appt-paid');
    return {
      paidLabel: label ? label.textContent.trim() : '',
      payLink: !!item.querySelector('a[data-pay-id]')
    };
  })()`);
  check('控制台卡片显示「已退款 ¥280.00」，并撤掉「去支付」入口',
    /已退款/.test(cardAfter.paidLabel) && cardAfter.payLink === false, JSON.stringify(cardAfter));

  /* =========== 网络自检（Network 面板的机器证据） =========== */
  const external = netUrls.filter((r) => {
    const u = r.url;
    if (!/^https?:/i.test(u)) return false;              // data: / blob: / about: 不算网络请求
    return !(u === BASE || u.startsWith(BASE + '/'));
  });
  check('整场会话没有一条外部网络请求（Network 里只有本站）',
    external.length === 0,
    external.map((r) => r.method + ' ' + r.url).join(' | ').slice(0, 300) || '0 条');

  const payCallsHttp = payCalls.filter((r) => /^https?:/i.test(r.url));
  check('支付页期间的请求全部是本站地址（页面 / 静态资源 / 接口）',
    payCallsHttp.length > 0 && payCallsHttp.every((r) => r.url === BASE || r.url.startsWith(BASE + '/')),
    payCallsHttp.map((r) => r.method + ' ' + r.url.replace(BASE, '')).join(' | ').slice(0, 300));

  const payApis = payCalls.filter((r) => /\/api\//.test(r.url));
  check('其中接口请求都在本站 /api 下，没有网关/第三方的影子',
    payApis.length >= 3 && payApis.every((r) => r.url.startsWith(BASE + '/api/')),
    payApis.map((r) => r.method + ' ' + r.url.replace(BASE, '')).join(' | ').slice(0, 300));

  const payPosts = payCalls.filter((r) => r.method === 'POST' && /\/pay$/.test(r.url));
  check('点「支付」只发出 1 个本站 POST /api/patient/orders/:id/pay',
    payPosts.length === 1, payPosts.map((r) => r.url.replace(BASE, '')).join(' | ') || '0 个');

  const externalFromPayment = payCalls.filter((r) => {
    const u = r.url;
    if (!/^https?:/i.test(u)) return false;
    return !(u === BASE || u.startsWith(BASE + '/'));
  });
  check('支付页从打开到退款，没有任何外部请求（支付不碰通道）',
    externalFromPayment.length === 0,
    externalFromPayment.map((r) => r.url).join(' | ').slice(0, 300) || '0 条');

  group('8. 医生端支付状态（只读）');

  /* 换回医生账号：先登出，再走一次登录表单 */
  await evaluate(`fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).then(function () { return true; })`);
  await nav(`${BASE}/login.html`);
  await waitFor('!!document.querySelector("#login-form")', 8000, '登录表单（换医生）');
  await evaluate(`(function(){
    document.querySelector('#f-account').value = ${JSON.stringify(DOCTOR.email)};
    document.querySelector('#f-password').value = ${JSON.stringify(DOCTOR.password)};
    document.querySelector('#login-form').requestSubmit();
    return true;
  })()`);
  await waitFor('!document.querySelector("#panel-doctor").hidden', 10000, '医生面板（第二次）');
  await waitFor(`!!document.querySelector('.appt-item[data-appt-id="${appt2.id}"]')`, 10000, '医生端看到同一条预约');

  const docPayCard = await evaluate(`(function(){
    var item = document.querySelector('.appt-item[data-appt-id="${appt2.id}"]');
    if (!item) return null;
    var chip = item.querySelector('.appt-paid');
    return {
      label: item.querySelector('.appt-pay-label') ? item.querySelector('.appt-pay-label').textContent.trim() : '',
      chip: chip ? chip.textContent.trim() : '',
      status: chip ? chip.getAttribute('data-order-status') : '',
      payEntry: item.querySelectorAll('[data-pay-id], [data-pay-action]').length
    };
  })()`);
  check('医生端预约卡片显示支付状态（这张单已退款 ¥280.00）',
    !!docPayCard && docPayCard.label === '支付：' && /已退款/.test(docPayCard.chip) &&
    docPayCard.status === 'refunded', JSON.stringify(docPayCard));
  check('医生端只展示不操作：没有支付 / 退款入口',
    !!docPayCard && docPayCard.payEntry === 0, JSON.stringify(docPayCard));

  group('9. 页面无报错');
  check('全程没有未捕获异常 / console.error', consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | '));
} catch (err) {
  failed = true;
  console.error('\n[中断] ' + err.message);
}

/* =========================================================
   4. 收尾
   ========================================================= */
cdp.close();
browser.kill();
server.kill();
await sleep(400);
logStream.end();
for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
  try { fs.unlinkSync(f); } catch {}
}
try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}

const pass = results.filter((r) => r.pass).length;
const groups = [];
for (const r of results) {
  if (!groups.length || groups[groups.length - 1].name !== r.group) groups.push({ name: r.group, items: [] });
  groups[groups.length - 1].items.push(r);
}

console.log('\n===== 按组汇总 =====');
for (const g of groups) {
  const ok = g.items.filter((i) => i.pass).length;
  console.log(`${g.name}  ${ok}/${g.items.length}  ${ok === g.items.length ? '✅' : '❌'}`);
}
console.log(`\n合计 ${pass}/${results.length} 条断言通过，共 ${groups.length} 组`);

if (failed || pass !== results.length) process.exit(2);
process.exit(0);
