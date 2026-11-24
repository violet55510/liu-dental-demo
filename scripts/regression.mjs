/* 刘氏口腔 · 回归验证脚本（真实浏览器）
   ---------------------------------------------------------
   依赖：Node ≥ 22（内置 WebSocket）、本机 Edge 或 Chrome。无需 npm install。
   运行（在项目根目录）：
     node scripts/regression.mjs            只看结果
     node scripts/regression.mjs --json     同时写 scripts/regression-result.json
   可选环境变量：
     EDGE_PATH   指定浏览器可执行文件
     CDP_PORT    调试端口，默认 9333（被占用时改这里）
   退出码：0 = 全部通过，2 = 有失败项，1 = 浏览器没起来。
   --------------------------------------------------------- */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 项目根目录 = 本文件所在目录的上一级；用 file:// URL 打开，不需要起服务器
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = pathToFileURL(ROOT).href + '/';
const PORT = Number(process.env.CDP_PORT || 9333);
const WRITE_JSON = process.argv.includes('--json');

const BROWSER_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

const BROWSER = BROWSER_CANDIDATES.find(p => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
});
if (!BROWSER) {
  console.error('找不到浏览器。请设置 EDGE_PATH 指向 msedge.exe / chrome.exe。');
  process.exit(1);
}

const userData = path.join(os.tmpdir(), 'edge-regression-' + Date.now());

const proc = spawn(BROWSER, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + userData,
  'about:blank'
], { stdio: 'ignore', detached: false });

let wsUrl = null;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    const j = await r.json();
    wsUrl = j.webSocketDebuggerUrl;
    if (wsUrl) break;
  } catch { /* not ready */ }
  await sleep(250);
}
if (!wsUrl) { console.error('无法连接浏览器调试端口 ' + PORT + '，可换 CDP_PORT 重试'); proc.kill(); process.exit(1); }

// 取一个空白页 target
let target = null;
for (let i = 0; i < 40; i++) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  target = list.find(t => t.type === 'page');
  if (target) break;
  await sleep(200);
}
if (!target) { console.error('没有可用的 page target'); proc.kill(); process.exit(1); }

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

async function evaluate(expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  });
  if (r.exceptionDetails) throw new Error('JS 异常: ' + JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

async function goto(url) {
  await cdp.send('Page.navigate', { url });
  for (let i = 0; i < 80; i++) {
    await sleep(100);
    try {
      const st = await evaluate('document.readyState');
      if (st === 'complete') { await sleep(250); return; }
    } catch { /* navigating */ }
  }
  throw new Error('页面加载超时: ' + url);
}

const results = [];
let GROUP = '';
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail, group: GROUP });
}

/* ===== 1. 医生页 → 预约页 ?doctor= 预选 ===== */
GROUP = '1. 医生页「预约该医师」→ ?doctor= 预选';
await goto(BASE + 'doctors.html');
const doctorCards = await evaluate(`(() => {
  return Array.from(document.querySelectorAll('[data-doctor-list] article')).map(a => ({
    name: (a.querySelector('h3') || {}).textContent,
    href: (a.querySelector('.doctor-cta a') || {}).getAttribute && a.querySelector('.doctor-cta a').getAttribute('href')
  }));
})()`);

const orthoCard = doctorCards.find(c => c.href && c.href.includes('doctor=liu-ortho'));
check('医生页存在指向 liu-ortho 的「预约该医师」链接',
  !!orthoCard, orthoCard ? orthoCard.href : '未找到');

if (orthoCard) {
  await goto(BASE + orthoCard.href);
  const pre = await evaluate(`(() => {
    const sel = document.getElementById('f-doctor');
    const note = document.getElementById('doctor-preselect-note');
    const opt = sel.options[sel.selectedIndex];
    return {
      value: sel.value,
      text: opt ? opt.textContent.trim() : null,
      dept: opt ? opt.getAttribute('data-dept') : null,
      noteHidden: note ? note.hidden : null
    };
  })()`);
  check('?doctor=liu-ortho 自动选中「刘医生（正畸科）」',
    pre.value === 'liu-ortho' && pre.text === '刘医生（正畸科）',
    JSON.stringify(pre));
  check('预选提示条可见（doctor-preselect-note 未 hidden）',
    pre.noteHidden === false, 'hidden=' + pre.noteHidden);
}

/* ===== 2. 期望日期「今天」琥珀提示 ===== */
GROUP = '2. 期望日期「今天」琥珀提示';
const dateRes = await evaluate(`(() => {
  const d = document.getElementById('f-date');
  const hint = document.getElementById('date-today-hint');
  const out = {};
  out.min = d.min;
  out.max = d.max;

  d.value = d.min;
  d.dispatchEvent(new Event('change', { bubbles: true }));
  out.todayHidden = hint.hidden;
  out.todayText = hint.textContent.trim();

  const later = new Date(new Date(d.min + 'T00:00:00').getTime() + 3 * 86400000);
  const p = n => (n < 10 ? '0' : '') + n;
  d.value = later.getFullYear() + '-' + p(later.getMonth() + 1) + '-' + p(later.getDate());
  d.dispatchEvent(new Event('change', { bubbles: true }));
  out.otherHidden = hint.hidden;

  d.value = '';
  d.dispatchEvent(new Event('change', { bubbles: true }));
  out.clearedHidden = hint.hidden;
  return out;
})()`);
check('选「今天」时琥珀提示出现', dateRes.todayHidden === false,
  'hidden=' + dateRes.todayHidden + '，文案=' + dateRes.todayText);
check('改选其他日期时提示收起', dateRes.otherHidden === true, 'hidden=' + dateRes.otherHidden);
check('清空日期时提示收起', dateRes.clearedHidden === true, 'hidden=' + dateRes.clearedHidden);

/* ===== 3. 医师→项目星标 / 项目→医师建议 ===== */
GROUP = '3. 医师↔项目联动（★ 星标 / 建议提示）';
const linkRes = await evaluate(`(() => {
  const dSel = document.getElementById('f-doctor');
  const sSel = document.getElementById('f-service');
  const note = document.getElementById('project-doctor-note');
  const sugg = document.getElementById('doctor-suggest');
  const out = {};

  // 选刘医生（正畸科），清空项目
  dSel.value = 'liu-ortho';
  sSel.value = '';
  dSel.dispatchEvent(new Event('change', { bubbles: true }));
  out.starred = Array.from(sSel.options).filter(o => o.textContent.indexOf('★') === 0).map(o => o.textContent.trim());
  out.noteHidden = note.hidden;
  out.noteText = note.textContent.trim();

  // 反复切换两次，确认 ★ 不会叠加
  sSel.value = 'ortho';
  sSel.dispatchEvent(new Event('change', { bubbles: true }));
  dSel.value = '';
  dSel.dispatchEvent(new Event('change', { bubbles: true }));
  dSel.value = 'liu-ortho';
  dSel.dispatchEvent(new Event('change', { bubbles: true }));
  out.starCountAfterToggle = Array.from(sSel.options).filter(o => o.textContent.indexOf('★ ★') === 0).length;
  out.doubleStarOptions = Array.from(sSel.options).filter(o => (o.textContent.match(/★/g) || []).length > 1).length;

  // 清空医师、只选项目 → 医师建议
  dSel.value = '';
  dSel.dispatchEvent(new Event('change', { bubbles: true }));
  sSel.value = 'implant';
  sSel.dispatchEvent(new Event('change', { bubbles: true }));
  out.suggestHidden = sugg.hidden;
  out.suggestText = sugg.textContent.trim();

  // 只选项目但不选医师时，说明行应隐藏
  out.noteHiddenWhenNoDoctor = note.hidden;

  // 复位
  sSel.value = '';
  sSel.dispatchEvent(new Event('change', { bubbles: true }));
  return out;
})()`);
check('选医师后项目下拉出现 ★ 星标', linkRes.starred.length > 0, JSON.stringify(linkRes.starred));
check('选医师后项目说明行可见且含擅长项',
  linkRes.noteHidden === false && linkRes.noteText.indexOf('擅长') > -1,
  'hidden=' + linkRes.noteHidden + '，' + linkRes.noteText);
check('反复切换医师后 ★ 不叠加', linkRes.doubleStarOptions === 0,
  '含多个★的选项数=' + linkRes.doubleStarOptions);
check('只选项目时出现医师建议提示',
  linkRes.suggestHidden === false && linkRes.suggestText.indexOf('建议选择') > -1,
  'hidden=' + linkRes.suggestHidden + '，' + linkRes.suggestText);

/* ===== 4. 表单四条校验 + aria-live 播报验证 ===== */
GROUP = '4. 表单校验与 aria-live 播报';
const valRes = await evaluate(`(() => {
  const form = document.getElementById('appointment-form');
  const status = document.getElementById('form-status');
  form.reset();
  if (status) status.classList.remove('is-visible');

  // 记录 aria-live 容器内的 DOM 变更，证明内容真的被更新（读屏会因此播报）
  window.__liveLog = [];
  const targets = Array.from(document.querySelectorAll('.error-msg[aria-live]'));
  const obs = new MutationObserver(muts => {
    muts.forEach(m => {
      const host = (m.target.nodeType === 1 ? m.target : m.target.parentElement);
      const box = host && host.closest ? host.closest('.error-msg') : null;
      window.__liveLog.push({
        id: box ? box.id : '(unknown)',
        live: box ? box.getAttribute('aria-live') : null,
        text: box ? box.textContent.trim() : ''
      });
    });
  });
  targets.forEach(t => obs.observe(t, { childList: true, characterData: true, subtree: true }));

  form.requestSubmit();

  return new Promise(resolve => setTimeout(() => {
    obs.disconnect();
    const errors = Array.from(document.querySelectorAll('.error-msg')).map(e => ({
      id: e.id,
      text: e.textContent.trim(),
      live: e.getAttribute('aria-live'),
      role: e.getAttribute('role'),
      visible: e.classList.contains('is-visible'),
      describedByOk: !!(document.getElementById(e.id) &&
        document.querySelector('[aria-describedby~="' + e.id + '"]'))
    }));
    const invalidFields = Array.from(form.querySelectorAll('[aria-invalid="true"]')).map(f => f.name);
    resolve({
      errors,
      invalidFields,
      liveLog: window.__liveLog,
      activeId: document.activeElement ? document.activeElement.id : null,
      liveRegionCount: targets.length
    });
  }, 400));
})()`);

const nonEmptyErrors = valRes.errors.filter(e => e.text);
check('空表单提交触发 4 条校验错误', nonEmptyErrors.length === 4,
  nonEmptyErrors.map(e => e.id + '=' + e.text).join(' | '));
check('4 条错误提示都带 aria-live="polite"',
  nonEmptyErrors.length === 4 && nonEmptyErrors.every(e => e.live === 'polite'),
  JSON.stringify(nonEmptyErrors.map(e => ({ id: e.id, live: e.live }))));
check('aria-live 区域在提交时真的发生了 DOM 更新（可被播报）',
  valRes.liveLog.length >= 4,
  '记录到 ' + valRes.liveLog.length + ' 次变更：' + JSON.stringify(valRes.liveLog.slice(0, 4)));
check('每个错误提示都被字段的 aria-describedby 关联',
  nonEmptyErrors.every(e => e.describedByOk),
  JSON.stringify(nonEmptyErrors.filter(e => !e.describedByOk).map(e => e.id)));
check('校验失败的字段带 aria-invalid="true"',
  valRes.invalidFields.length === 4, JSON.stringify(valRes.invalidFields));
check('焦点移到第一个错误字段', valRes.activeId === 'f-name', 'activeElement=' + valRes.activeId);

/* ===== 5. 联系页「今天」营业时间高亮 ===== */
GROUP = '5. 联系页「今天」营业时间高亮';
await goto(BASE + 'contact.html');
const hoursRes = await evaluate(`(() => {
  const rows = Array.from(document.querySelectorAll('[data-hours-body] tr'));
  const today = Array.from(document.querySelectorAll('[data-hours-body] tr.is-today'));
  const jsDay = new Date().getDay();
  const map = ['周日','周一','周二','周三','周四','周五','周六'];
  return {
    jsDay,
    expectedLabel: map[jsDay],
    rowCount: rows.length,
    todayCount: today.length,
    todayWeekday: today[0] ? today[0].getAttribute('data-weekday') : null,
    todayLabel: today[0] ? today[0].querySelector('th').textContent.trim() : null,
    todayTime: today[0] ? today[0].querySelectorAll('td')[0].textContent.trim() : null,
    // 高亮实际画在单元格上，不是 tr 上
    todayCellBg: today[0] ? getComputedStyle(today[0].querySelector('th')).backgroundColor : null,
    todayCellColor: today[0] ? getComputedStyle(today[0].querySelector('th')).color : null,
    otherCellBg: (() => {
      const other = rows.find(r => !r.classList.contains('is-today'));
      return other ? getComputedStyle(other.querySelector('th')).backgroundColor : null;
    })(),
    otherCellColor: (() => {
      const other = rows.find(r => !r.classList.contains('is-today'));
      return other ? getComputedStyle(other.querySelector('th')).color : null;
    })(),
    todayBadge: today[0] ? getComputedStyle(today[0].querySelector('th'), '::after').content : null,
    hoursTitle: (document.querySelector('.hours-table caption') || {}).textContent
  };
})()`);
check('营业时间表渲染 7 行', hoursRes.rowCount === 7, 'rows=' + hoursRes.rowCount);
check('「今天」行唯一且与系统星期一致',
  hoursRes.todayCount === 1 && String(hoursRes.todayWeekday) === String(hoursRes.jsDay)
  && hoursRes.todayLabel === hoursRes.expectedLabel,
  JSON.stringify({ jsDay: hoursRes.jsDay, weekday: hoursRes.todayWeekday, label: hoursRes.todayLabel, count: hoursRes.todayCount }));
check('「今天」行有区别于其他行的背景与文字色高亮',
  hoursRes.todayCellBg !== hoursRes.otherCellBg && hoursRes.todayCellColor !== hoursRes.otherCellColor,
  'today=' + hoursRes.todayCellBg + '/' + hoursRes.todayCellColor +
  ' other=' + hoursRes.otherCellBg + '/' + hoursRes.otherCellColor);
check('「今天」行带「今天」文字标记', hoursRes.todayBadge === '"今天"', 'content=' + hoursRes.todayBadge);

/* ===== 6. 附带：数据驱动渲染是否都成功 ===== */
GROUP = '6. 数据驱动渲染（首页 / 预约页 / 服务页）';
await goto(BASE + 'index.html');
const indexRes = await evaluate(`(() => ({
  doctors: document.querySelectorAll('[data-doctor-preview] article').length,
  phone: (document.querySelector('[data-site="phone-text"]') || {}).textContent,
  address: (document.querySelector('[data-site="address-line"]') || {}).textContent,
  hours: (document.querySelector('[data-site="hours-line"]') || {}).textContent,
  footerLinks: document.querySelectorAll('[data-site="footer-contact"] a[href^="tel:"]').length
}))()`);
check('首页医师预览渲染 3 张卡', indexRes.doctors === 3, 'cards=' + indexRes.doctors);
check('首页电话 / 地址 / 营业时间挂载点已填充',
  !!indexRes.phone && !!indexRes.address && !!indexRes.hours,
  JSON.stringify(indexRes));

await goto(BASE + 'appointment.html');
const apptRes = await evaluate(`(() => ({
  serviceOptions: document.getElementById('f-service').options.length,
  doctorOptions: document.getElementById('f-doctor').options.length,
  doctorLabels: Array.from(document.getElementById('f-doctor').options).slice(1).map(o => o.textContent.trim())
}))()`);
check('预约页项目下拉 9 项（含「请选择」）', apptRes.serviceOptions === 9, 'options=' + apptRes.serviceOptions);
check('预约页医师下拉为「姓名（科室）」格式',
  apptRes.doctorLabels.every(t => /（.+）$/.test(t)),
  JSON.stringify(apptRes.doctorLabels));

/* 服务页的费用区间同样由 data.js 渲染（HTML 里不再写死金额），
   顺带验证「展示区间」把「计费金额」框在里面。 */
await goto(BASE + 'services.html');
const priceRes = await evaluate(`(() => {
  const box = document.querySelector('[data-price-box="implant"]');
  const q = (sel) => box && box.querySelector(sel) ? box.querySelector(sel).textContent.trim() : '';
  const svc = (window.SITE_DATA.services || []).find(s => s.id === 'implant') || null;
  return {
    label: q('[data-price-label]'),
    range: q('[data-price-range]'),
    unit: q('[data-price-unit]'),
    amount: svc ? svc.amount_cents : null,
    min: svc && svc.price_range ? svc.price_range.min_cents : null,
    max: svc && svc.price_range ? svc.price_range.max_cents : null
  };
})()`);
check('服务页价格区间由 data.js 渲染（¥6,000 – 15,000，含说明文字）',
  priceRes.range === '¥6,000 – 15,000' && /参考区间/.test(priceRes.unit) && !!priceRes.label,
  JSON.stringify(priceRes));
check('区间与计费金额同源且自洽（680000 分落在 600000–1500000 内）',
  priceRes.amount === 680000 && priceRes.min === 600000 && priceRes.max === 1500000 &&
  priceRes.amount >= priceRes.min && priceRes.amount <= priceRes.max,
  JSON.stringify(priceRes));

/* ===== 7. 资质区数据化渲染 ===== */
GROUP = '7. 资质区数据化渲染';
await goto(BASE + 'doctors.html');
const licRes = await evaluate(`(() => {
  const items = Array.from(document.querySelectorAll('[data-license-item]')).map(li => ({
    key: li.getAttribute('data-license-item'),
    text: li.textContent.trim(),
    todo: !!li.querySelector('.is-todo')
  }));
  const slots = Array.from(document.querySelectorAll('[data-license-slot]')).map(b => ({
    key: b.getAttribute('data-license-slot'),
    hasSvg: !!b.querySelector('svg'),
    title: b.querySelector('strong') ? b.querySelector('strong').textContent.trim() : null,
    text: b.textContent.trim(),
    filled: b.classList.contains('photo-slot--filled')
  }));
  return {
    items,
    slots,
    emptyItems: items.filter(i => !i.text).length,
    dataLicenseCount: window.SITE_DATA.clinic.licenses.length,
    staticLeft: document.querySelectorAll('.photo-grid .photo-slot').length
  };
})()`);
check('资质说明 2 条由 data.js 渲染且非空',
  licRes.items.length === 2 && licRes.emptyItems === 0,
  JSON.stringify(licRes.items.map(i => i.text)));
check('证号为空时渲染「待填充」标记',
  licRes.items.every(i => i.todo && /待填充/.test(i.text)),
  JSON.stringify(licRes.items.map(i => i.todo)));
check('两张证照扫描件位渲染占位块（无图时）',
  licRes.slots.length === 2 && licRes.slots.every(s => s.hasSvg && !s.filled && /扫描件待补充/.test(s.text)),
  JSON.stringify(licRes.slots));
check('资质区块仍保留 4 个图片位', licRes.staticLeft === 4, 'slots=' + licRes.staticLeft);
check('data.js 中 clinic.licenses 为 2 条', licRes.dataLicenseCount === 2, 'count=' + licRes.dataLicenseCount);

/* ===== 输出：明细 + 按组汇总 ===== */
console.log('\n===== 回归明细 =====');
let pass = 0;
for (const r of results) {
  console.log((r.pass ? '✅ PASS' : '❌ FAIL') + '  ' + r.name + (r.pass ? '' : '\n        → ' + r.detail));
  if (r.pass) pass++;
}

// 按检查组汇总，避免「组数」和「断言数」混为一谈
const groups = [];
for (const r of results) {
  let g = groups.find(x => x.name === r.group);
  if (!g) { g = { name: r.group, total: 0, pass: 0 }; groups.push(g); }
  g.total++;
  if (r.pass) g.pass++;
}
console.log('\n===== 按组汇总 =====');
for (const g of groups) {
  console.log(`${g.name}  ${g.pass}/${g.total}` + (g.pass === g.total ? '  ✅' : '  ❌'));
}
console.log(`\n合计 ${pass}/${results.length} 条断言通过，共 ${groups.length} 组`);

if (WRITE_JSON) {
  const outFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'regression-result.json');
  fs.writeFileSync(outFile, JSON.stringify({
    at: new Date().toISOString(),
    groups: groups.map(g => ({ name: g.name, pass: g.pass, total: g.total })),
    total: results.length,
    passed: pass,
    results
  }, null, 2));
  console.log('结果已写入 ' + path.relative(ROOT, outFile));
}

cdp.close();
proc.kill();
process.exit(pass === results.length ? 0 : 2);
