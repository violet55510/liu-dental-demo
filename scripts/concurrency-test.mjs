/* =========================================================
   scripts/concurrency-test.mjs — 「同一时段只成功一个」的血腥验证
   ---------------------------------------------------------
   为什么要单独一个脚本：
   api-test.mjs 里的 Promise.all 是「两个并行 HTTP 请求」，
   但服务端是 Node 单线程 + better-sqlite3 同步驱动，
   两个请求其实是排队执行的——不能证明「真有竞态时也不会双订」。

   这个脚本做两层更硬的验证：

   阶段 A：同一进程内 8 个并行请求打同一个 slot
            → 期望 1 个 201、7 个 409 SLOT_TAKEN

   阶段 B：两个独立操作系统进程，各自持有一条 SQLite 连接，
            都执行「读：有没有被占」→ 故意等 400ms →「写：INSERT」
            这是教科书式 TOCTOU。两个进程都会读到「空」，
            但只有一个 INSERT 能活下来——活下来的原因是
            ux_appt_active_slot 这个部分唯一索引，不是应用层判断。

   用法：npm run test:race        或    node scripts/concurrency-test.mjs
   退出码：0 全通过 / 2 有失败 / 1 环境问题
   ========================================================= */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.RACE_PORT || 3102);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = path.join(ROOT, '.workbuddy');
const DB_FILE = path.join(TMP, 'race.db');
const LOG_FILE = path.join(TMP, 'race-server.log');

fs.mkdirSync(TMP, { recursive: true });
for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
  try { fs.unlinkSync(f); } catch { /* ignore */ }
}

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'app.js')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DB_FILE, SESSION_SECRET: 'race-test-secret-0123456789abcdef', NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stdout.pipe(logStream);
server.stderr.pipe(logStream);

let up = false;
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(BASE + '/api/health')).ok) { up = true; break; } } catch { /* wait */ }
  await sleep(200);
}
if (!up) {
  console.error('服务没起来，看 ' + LOG_FILE);
  server.kill();
  process.exit(1);
}

/* ---------- 断言 ---------- */
const results = [];
let GROUP = '';
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail, group: GROUP });
}

function client() {
  let cookie = '';
  return {
    async req(method, url, body) {
      const headers = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(BASE + url, {
        method, headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const first = c.split(';')[0];
        if (first.startsWith('lsd.sid=')) cookie = first;
      }
      let json = null;
      try { json = JSON.parse(await res.text()); } catch { /* ignore */ }
      return { status: res.status, json };
    },
    get(u) { return this.req('GET', u); },
    post(u, b) { return this.req('POST', u, b); }
  };
}

function ymd(offset) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  const p = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* ---------- 准备账号与时段 ---------- */
const doctors = (await (await fetch(BASE + '/api/doctors')).json()).doctors;
const doctor = doctors[0];

const pA = client();
await pA.post('/api/register', { name: '并发甲', phone: '13933330001', password: 'Race@1234' });
await pA.post('/api/login', { account: '13933330001', password: 'Race@1234' });

const dbRO = new Database(DB_FILE, { readonly: true });
const patientId = dbRO.prepare("SELECT id FROM users WHERE phone = '13933330001'").get().id;

/* 挑一个 8 天后的可约时段（避开今天的过期问题） */
const date = ymd(8);
const slotRes = await pA.get(`/api/schedules?doctor_id=${doctor.id}&date=${date}`);
const free = (slotRes.json.slots || []).filter((s) => s.open && !s.taken);

if (!free.length) {
  console.error('没有可用时段，种子排班异常');
  server.kill();
  process.exit(1);
}

/* =======================================================
   阶段 A：8 个并行 HTTP 请求抢同一个 slot
   ======================================================= */
GROUP = 'A. 同一进程 8 个并行请求';
const target = free[0].id;
const parallel = await Promise.all(
  Array.from({ length: 8 }, () => pA.post('/api/appointments', { schedule_id: target }))
);
const okCount = parallel.filter((r) => r.status === 201).length;
const conflictCount = parallel.filter((r) => r.status === 409).length;

check('8 个并行请求里只有 1 个成功', okCount === 1, '成功=' + okCount + ' 失败=' + conflictCount + ' 状态=' + parallel.map(r => r.status).join(','));
check('其余 7 个都是 409（不是 500、也不是静默成功）', conflictCount === 7, '冲突=' + conflictCount);

const rowA = dbRO.prepare(
  "SELECT COUNT(*) AS n FROM appointments WHERE schedule_id = ? AND status <> 'cancelled'"
).get(target);
check('库里该时段只有 1 条未取消预约', rowA.n === 1, 'n=' + rowA.n);

/* =======================================================
   阶段 B：两个独立进程，TOCTOU（读 → 等 → 写）
   ======================================================= */
GROUP = 'B. 两个独立进程 TOCTOU（读 → 延迟 → 写）';

const raceSlot = free[1].id;
const worker = path.join(ROOT, 'scripts', 'race-worker.cjs');

function runWorker(delay) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      worker, DB_FILE, String(raceSlot), String(patientId), String(doctor.id), String(delay)
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('close', () => {
      const lines = out.trim().split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return { raw: l }; }
      });
      resolve(lines);
    });
  });
}

/* 两个进程同时启动，都在 400ms 后才写 —— 两边都读到了「空」 */
const [w1, w2] = await Promise.all([runWorker(400), runWorker(400)]);

const read1 = w1.find((x) => x.phase === 'read');
const read2 = w2.find((x) => x.phase === 'read');
const ins1 = w1.find((x) => x.phase === 'insert');
const ins2 = w2.find((x) => x.phase === 'insert');

check('两个进程都读到了「该时段空闲」（竞态窗口确实存在）',
  read1 && read2 && read1.seenTaken === false && read2.seenTaken === false,
  JSON.stringify({ w1: read1, w2: read2 }));

const insertOk = [ins1, ins2].filter((x) => x && x.ok).length;
const insertFail = [ins1, ins2].filter((x) => x && !x.ok).length;

check('两个进程都执行了 INSERT，只有 1 个成功', insertOk === 1, '成功=' + insertOk + ' 失败=' + insertFail);
check('失败的那一个是唯一约束（SQLITE_CONSTRAINT_UNIQUE），不是业务判断',
  [ins1, ins2].some((x) => x && x.code === 'SQLITE_CONSTRAINT_UNIQUE'),
  JSON.stringify([ins1, ins2]));

const rowB = dbRO.prepare(
  "SELECT COUNT(*) AS n FROM appointments WHERE schedule_id = ? AND status <> 'cancelled'"
).get(raceSlot);
check('库里该时段仍然只有 1 条未取消预约', rowB.n === 1, 'n=' + rowB.n);

/* ---------- 收尾 ---------- */
dbRO.close();
server.kill();
await sleep(300);
logStream.end();
for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
  try { fs.unlinkSync(f); } catch { /* ignore */ }
}

/* ---------- 输出 ---------- */
let pass = 0;
const groups = [];
for (const r of results) {
  if (r.pass) pass++;
  if (!groups.length || groups[groups.length - 1].name !== r.group) groups.push({ name: r.group, items: [] });
  groups[groups.length - 1].items.push(r);
}

console.log('\n===== 并发抢位结果 =====');
for (const r of results) {
  console.log((r.pass ? '✅ PASS' : '❌ FAIL') + '  ' + r.name + (r.pass ? '' : '\n        → ' + r.detail));
}

console.log('\n===== 按组汇总 =====');
for (const g of groups) {
  const ok = g.items.filter((i) => i.pass).length;
  console.log(`${g.name}  ${ok}/${g.items.length}  ${ok === g.items.length ? '✅' : '❌'}`);
}
console.log(`\n合计 ${pass}/${results.length} 条断言通过，共 ${groups.length} 组`);

process.exit(pass === results.length ? 0 : 2);
