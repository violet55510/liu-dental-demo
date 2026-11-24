/* =========================================================
   scripts/capture-payment.mjs — 支付页截图 + Network 请求清单
   ---------------------------------------------------------
   为什么要这个脚本：
   「Network 面板里没有外部请求」这句话，光靠嘴说不可验证。
   headless 浏览器没法截 DevTools 面板的 UI，所以拆成两半：
     1. 用 CDP 的 Network.requestWillBeSent 把**每一个**请求记下来，
        写成一份清单（含"外部请求 0 条"的结论）；
     2. 截支付页与支付成功两张图，证明页面本身长什么样。
   两者合起来，比一张模糊的面板截图更可核对。

   输出：
     .workbuddy/shots/payment-unpaid.png
     .workbuddy/shots/payment-paid.png
     .workbuddy/shots/network-log.md
     .workbuddy/shots/order-row.json
   ！这些是审查用产物，不进版本库（.workbuddy 已在 .gitignore 内）。
   ========================================================= */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SHOT_PORT || 3103);
const CDP_PORT = Number(process.env.SHOT_CDP_PORT || 9455);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(ROOT, '.workbuddy', 'shots');
const DB_FILE = path.join(ROOT, '.workbuddy', 'pay-shot.db');
const LOG_FILE = path.join(ROOT, '.workbuddy', 'pay-shot-server.log');

fs.mkdirSync(OUT, { recursive: true });
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
    SESSION_SECRET: 'shot-only-secret-0123456789abcdef',
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
if (!up) { console.error('服务没起来，看 ' + LOG_FILE); server.kill(); process.exit(1); }

function ymd(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const p = (n) => (n < 10 ? '0' : '') + n;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ---------- 造数据：一个病人 + 一条带服务项目的预约 ---------- */
function makeClient() {
  let cookie = '';
  async function req(method, url, body) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    const r = await fetch(BASE + url, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body)
    });
    for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) {
      const kv = c.split(';')[0];
      if (kv.startsWith('lsd.sid=')) cookie = kv;
    }
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  }
  return { get: (u) => req('GET', u), post: (u, b) => req('POST', u, b === undefined ? {} : b) };
}

const PATIENT = { phone: '13900002001', password: 'Shot@12345', name: '截图病人' };
const api = makeClient();
const reg = await api.post('/api/register', PATIENT);
if (reg.status !== 201) { console.error('注册失败 ' + reg.text); server.kill(); process.exit(1); }
await api.post('/api/login', { account: PATIENT.phone, password: PATIENT.password });

const docs = await api.get('/api/doctors');
const implant = (docs.json.doctors || []).find((d) => d.slug === 'liu-implant');
const sched = await api.get(`/api/schedules?doctor_id=${implant.id}&date=${ymd(5)}`);
const slot = (sched.json.slots || []).find((s) => s.open && !s.taken);
const book = await api.post('/api/appointments', { schedule_id: slot.id, service: 'cleaning', note: '截图用例' });
if (book.status !== 201) { console.error('建预约失败 ' + book.text); server.kill(); process.exit(1); }
const appt = book.json.appointment;

/* ---------- 浏览器 ---------- */
const BROWSER = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].filter(Boolean).find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
if (!BROWSER) { console.error('找不到浏览器，设置 EDGE_PATH'); server.kill(); process.exit(1); }

const userData = path.join(os.tmpdir(), 'edge-shot-' + Date.now());
const browser = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars',
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
if (!target) { console.error('连不上 CDP'); browser.kill(); server.kill(); process.exit(1); }

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
    if (msg.method === 'Network.requestWillBeSent') {
      netUrls.push({ method: msg.params.request.method, url: msg.params.request.url, type: msg.params.type });
    }
  });
  function send(method, params = {}) {
    const mid = ++id;
    return new Promise((resolve, reject) => {
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
      setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('timeout ' + method)); } }, 20000);
    });
  }
  return { ready, send, close: () => ws.close() };
})();

await cdp.ready;
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Network.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false
});

async function evaluate(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function nav(url) {
  await cdp.send('Page.navigate', { url });
  for (let i = 0; i < 100; i++) {
    try { if (await evaluate('document.readyState === "complete"')) return; } catch {}
    await sleep(100);
  }
}
async function waitFor(expr, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await evaluate(expr)) return true; } catch {}
    await sleep(120);
  }
  throw new Error('等待超时: ' + expr);
}
async function shot(name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
}

/* ---------- 走一遍真实流程 ---------- */
await nav(`${BASE}/login.html`);
await waitFor('!!document.querySelector("#login-form")');
await evaluate(`(function(){
  document.querySelector('#f-account').value = ${JSON.stringify(PATIENT.phone)};
  document.querySelector('#f-password').value = ${JSON.stringify(PATIENT.password)};
  document.querySelector('#login-form').requestSubmit();
  return true;
})()`);
await waitFor('location.pathname.endsWith("dashboard.html")');
await waitFor(`!!document.querySelector('a[data-pay-id="${appt.id}"]')`);

const netBefore = netUrls.length;

await nav(`${BASE}/payment.html?appointment=${appt.id}`);
await waitFor('!document.querySelector("#pay-app").hidden');
await sleep(400);
const shot1 = await shot('payment-unpaid.png');

await evaluate('document.querySelector("#pay-btn").click()');
await waitFor(`document.querySelector('#pay-badge').getAttribute('data-order-status') === 'paid'`);
await sleep(300);
const shot2 = await shot('payment-paid.png');

const pageState = await evaluate(`({
  notice: document.querySelector('#pay-notice').textContent.replace(/\\s+/g, ' ').trim(),
  amount: document.querySelector('#pay-amount').textContent.trim(),
  badge: document.querySelector('#pay-badge').textContent.trim(),
  status: document.querySelector('#pay-status').textContent.trim()
})`);

/* ---------- 订单落库核对 ---------- */
const db = new Database(DB_FILE, { readonly: true });
const order = db.prepare('SELECT * FROM orders WHERE appointment_id = ?').get(appt.id);
db.close();
fs.writeFileSync(path.join(OUT, 'order-row.json'), JSON.stringify(order, null, 2), 'utf8');

/* ---------- 写 Network 清单 ---------- */
const httpCalls = netUrls.filter((r) => /^https?:/i.test(r.url));
const external = httpCalls.filter((r) => !(r.url === BASE || r.url.startsWith(BASE + '/')));
const payCalls = netUrls.slice(netBefore).filter((r) => /^https?:/i.test(r.url));

const lines = [];
lines.push('# 支付流程 · Network 请求清单');
lines.push('');
lines.push('由 `scripts/capture-payment.mjs` 用 CDP 的 `Network.requestWillBeSent` 抓取，');
lines.push('记录的是浏览器**实际发出**的每一个请求（不是人工回忆）。');
lines.push('');
lines.push('## 结论');
lines.push('');
lines.push(`- 整场会话共 ${httpCalls.length} 条 http(s) 请求`);
lines.push(`- 其中指向本站以外（第三方 / 支付通道 / CDN）的请求：**${external.length} 条**`);
lines.push(`- 从打开支付页到支付完成共 ${payCalls.length} 条请求，全部在 \`${BASE}\` 下`);
lines.push('');
lines.push('## 从打开支付页到支付完成的请求');
lines.push('');
lines.push('| # | 方法 | 类型 | URL |');
lines.push('| --- | --- | --- | --- |');
payCalls.forEach((r, i) => {
  lines.push(`| ${i + 1} | ${r.method} | ${r.type} | ${r.url.replace(BASE, '')} |`);
});
lines.push('');
lines.push('## 断言口径');
lines.push('');
lines.push('`npm run test:e2e` 的第 7 组会用同一份 Network 事件流做断言：');
lines.push('- 整场会话没有一条外部请求');
lines.push('- 支付页期间所有请求都是本站地址');
lines.push('- 点「支付」只发出 1 个 `POST /api/patient/orders/:id/pay`');
lines.push('');
fs.writeFileSync(path.join(OUT, 'network-log.md'), lines.join('\n'), 'utf8');

console.log('页面状态：' + JSON.stringify(pageState, null, 2));
console.log('订单行：' + JSON.stringify(order));
console.log('http 请求 ' + httpCalls.length + ' 条，外部 ' + external.length + ' 条');
console.log('支付页期间 ' + payCalls.length + ' 条：');
for (const r of payCalls) console.log('  ' + r.method + ' ' + r.url.replace(BASE, ''));
console.log('截图：' + shot1 + ' / ' + shot2);

cdp.close();
browser.kill();
server.kill();
await sleep(400);
logStream.end();
for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
  try { fs.unlinkSync(f); } catch {}
}
try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
process.exit(0);
