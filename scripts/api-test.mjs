/* =========================================================
   scripts/api-test.mjs — 第二阶段接口回归（真实 HTTP 请求）
   ---------------------------------------------------------
   依赖：Node ≥ 22（内置 fetch）。不需要装测试框架。
   运行：npm run test:api     或     node scripts/api-test.mjs

   做法：
   1. 用临时数据库（.workbuddy/test.db）另起一个服务进程，端口 3101
   2. 用带 cookie 罐的 fetch 依次请求接口，断言状态码与响应体
   3. 关键的「角色」断言不只看响应，还直接查库核对 role 列
   4. 结束时关进程、删临时库

   退出码：0 全通过 / 2 有失败 / 1 环境问题（起不来服务）。
   ========================================================= */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireCjs = createRequire(import.meta.url);
const PORT = Number(process.env.TEST_PORT || 3101);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP_DIR = path.join(ROOT, '.workbuddy');
const DB_FILE = path.join(TMP_DIR, 'test.db');
const LOG_FILE = path.join(TMP_DIR, 'api-test-server.log');

fs.mkdirSync(TMP_DIR, { recursive: true });
for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
  try { fs.unlinkSync(f); } catch {}
}

/* ---------- 老库夹具 ----------
   先手工造一张「第三期之前」的 appointments 表：status 的 CHECK 里没有 no_show，
   再塞一条记录。服务启动时 db.js 会做「建新表→拷数据→删旧表」的迁移，
   下面第 16 组断言迁移后这条记录还在、CHECK 已经接受 no_show。
   这样迁移一旦写错（比如漏了 INSERT ... SELECT），回归会直接红，而不是等用户丢数据。 */
const LEGACY_APPT_ID = 4242;
(function buildLegacyDb() {
  const conn = new Database(DB_FILE);
  conn.exec(`
    CREATE TABLE appointments (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id   INTEGER NOT NULL,
      doctor_id    INTEGER NOT NULL,
      schedule_id  INTEGER NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed')),
      note         TEXT,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      cancelled_at TEXT,
      CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
    );
  `);
  conn.prepare(`
    INSERT INTO appointments (id, patient_id, doctor_id, schedule_id, status, note)
    VALUES (?, 999, 999, 99999, 'pending', '迁移前就存在的记录')
  `).run(LEGACY_APPT_ID);

  /* ★ 老库的索引也要造出来 ★
     只造表不造索引，会漏掉一个真实的迁移 bug：
     ALTER TABLE RENAME 之后旧索引还叫 ux_appt_active_slot（跟在旧表上），
     新表的 CREATE INDEX IF NOT EXISTS 就被跳过，DROP 旧表时索引一起没了。
     这里补上旧条件的索引，第 16 组才能验出「迁移后索引确实存在且条件已更新」。 */
  conn.exec(`
    CREATE UNIQUE INDEX ux_appt_active_slot
      ON appointments (schedule_id) WHERE status <> 'cancelled';
    CREATE INDEX idx_appt_patient ON appointments (patient_id, status);
    CREATE INDEX idx_appt_doctor  ON appointments (doctor_id, status);
  `);
  conn.close();
})();

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });

/* 故意清掉 JWT_SECRET / JWT_REQUIRE_ENV：
   否则开发机上恰好设了这两个变量，下面「从会话密钥派生」的断言就会假红。
   本组要用固定密钥验签，就必须让服务端的密钥来源可预测。 */
const baseEnv = { ...process.env };
delete baseEnv.JWT_SECRET;
delete baseEnv.JWT_REQUIRE_ENV;

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'app.js')], {
  cwd: ROOT,
  env: { ...baseEnv, PORT: String(PORT), DB_FILE, SESSION_SECRET: 'test-only-secret-0123456789abcdef', NODE_ENV: 'test' },
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

/* ---------- 极简 cookie 客户端 ---------- */
function makeClient() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async req(method, url, body) {
      const headers = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;

      const res = await fetch(BASE + url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });

      const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of setCookie) {
        const first = c.split(';')[0];
        if (first.startsWith('lsd.sid=')) cookie = first;
      }

      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, json, text, setCookie, headers: res.headers };
    },
    post(url, body) { return this.req('POST', url, body); },
    get(url) { return this.req('GET', url); }
  };
}

/* ---------- 起一个一次性 node 进程（用于验证「启动即迁移」） ---------- */
function runNodeOnce(code, extraEnv) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['-e', code], {
      cwd: ROOT,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    p.stderr.on('data', (b) => { stderr += String(b); });
    p.on('error', reject);
    p.on('exit', (codeNum) => resolve({ code: codeNum, stderr }));
  });
}

/* ---------- 断言收集 ---------- */
const results = [];
let GROUP = '';
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail, group: GROUP });
}

const db = new Database(DB_FILE, { readonly: true });
function roleInDb(phoneOrEmail) {
  const row = db.prepare('SELECT role, status, password_hash FROM users WHERE phone = ? OR email = ?')
    .get(phoneOrEmail, phoneOrEmail);
  return row || null;
}

const guest = makeClient();

/* =======================================================
   1. 注册：客户端指定 role 无效
   ======================================================= */
GROUP = '1. 注册：角色不可由客户端指定';
const evil = makeClient();
const r1 = await evil.post('/api/register', {
  name: '越权测试', phone: '13911110001', password: 'Test@1234',
  role: 'admin', status: 'active', isAdmin: true
});
check('注册时带 role=admin → 仍然创建成功（不报错、不 500）', r1.status === 201, 'status=' + r1.status + ' body=' + r1.text);
check('响应体里的 role 是 patient', r1.json && r1.json.user && r1.json.user.role === 'patient', JSON.stringify(r1.json));
check('响应体里的 status 是服务端固定的 active', r1.json && r1.json.user && r1.json.user.status === 'active', JSON.stringify(r1.json));

const dbRow = roleInDb('13911110001');
check('直接查数据库：role 列 = patient（不是 admin）', dbRow && dbRow.role === 'patient', JSON.stringify(dbRow));
check('密码字段是 bcrypt 哈希，不是明文', !!dbRow && /^\$2[aby]\$\d{2}\$/.test(dbRow.password_hash) && !dbRow.password_hash.includes('Test@1234'), dbRow ? dbRow.password_hash.slice(0, 7) : 'null');
check('响应体不含 password_hash / 哈希串', !/\$2[aby]\$|password_hash/i.test(r1.text), r1.text.slice(0, 120));

const r2 = await evil.post('/api/register', {
  name: '越权测试二', phone: '13911110002', password: 'Test@1234', role: 'doctor', email: 'evil@demo.local'
});
check('注册时带 role=doctor + email → role 仍是 patient', r2.status === 201 && r2.json.user.role === 'patient', 'status=' + r2.status + ' role=' + (r2.json && r2.json.user && r2.json.user.role));
check('病人注册不会写入 email 列（库里 email 为 null）', roleInDb('13911110002') && roleInDb('13911110002').role === 'patient', JSON.stringify(roleInDb('13911110002')));

/* =======================================================
   2. 注册校验
   ======================================================= */
GROUP = '2. 注册字段校验';
const v1 = await guest.post('/api/register', { name: '张三', phone: '12345', password: 'Test@1234' });
check('手机号格式错误 → 400', v1.status === 400, 'status=' + v1.status + ' ' + v1.text);

const v2 = await guest.post('/api/register', { name: '张三', phone: '13911110003', password: '1234567' });
check('密码 7 位 → 400（提示至少 8 位）', v2.status === 400 && /8\s*位/.test(v2.json.error || ''), v2.text);

const v3 = await guest.post('/api/register', { name: '张', phone: '13911110003', password: 'Test@1234' });
check('姓名 1 个字 → 400', v3.status === 400, v3.text);

const v4 = await guest.post('/api/register', { name: '重复手机号', phone: '13911110001', password: 'Test@1234' });
check('重复手机号 → 409', v4.status === 409, v4.text);

/* =======================================================
   3. 登录
   ======================================================= */
GROUP = '3. 登录与会话 cookie';
const patient = makeClient();
const login1 = await patient.post('/api/login', { account: '13911110001', password: 'Test@1234' });
check('病人用手机号登录 → 200，role=patient', login1.status === 200 && login1.json.user.role === 'patient', login1.text);
check('登录响应不含 password_hash', !/password_hash|\$2[aby]\$/i.test(login1.text), login1.text.slice(0, 120));

const cookieHeader = login1.setCookie.join(' | ');
check('Set-Cookie 带 HttpOnly', /HttpOnly/i.test(cookieHeader), cookieHeader);
check('Set-Cookie 带 SameSite=Lax', /SameSite=Lax/i.test(cookieHeader), cookieHeader);
check('会话 cookie 名为 lsd.sid', /lsd\.sid=/.test(cookieHeader), cookieHeader);

const wrongPwd = await makeClient().post('/api/login', { account: '13911110001', password: 'WrongPass1' });
const noUser = await makeClient().post('/api/login', { account: '13999999999', password: 'WrongPass1' });
check('密码错误 → 401', wrongPwd.status === 401, wrongPwd.text);
check('账号不存在 → 401，且与密码错误的提示文案完全一致（不泄露账号是否存在）',
  noUser.status === 401 && noUser.json.error === wrongPwd.json.error,
  `wrong="${wrongPwd.json.error}" / none="${noUser.json.error}"`);

const inject = await makeClient().post('/api/login', { account: "' OR '1'='1", password: 'x' });
check('登录账号传 SQL 注入串 → 401（参数化查询，不是 500）', inject.status === 401, 'status=' + inject.status + ' ' + inject.text);

/* =======================================================
   4. 权限：服务端拦截
   ======================================================= */
GROUP = '4. 权限拦截（服务端）';
const anon = await makeClient().get('/api/patient/appointments');
check('未登录访问 /api/patient/appointments → 401', anon.status === 401, anon.text);

const pDoctor = await patient.get('/api/doctor/appointments');
check('病人会话访问 /api/doctor/appointments → 403', pDoctor.status === 403, 'status=' + pDoctor.status + ' ' + pDoctor.text);

const pAdmin = await patient.get('/api/admin/users');
check('病人会话访问 /api/admin/users → 403', pAdmin.status === 403, 'status=' + pAdmin.status + ' ' + pAdmin.text);

const pOwn = await patient.get('/api/patient/appointments');
check('病人访问自己的 /api/patient/appointments → 200 且返回 appointments 数组',
  pOwn.status === 200 && Array.isArray(pOwn.json.appointments), pOwn.text);

const doctorSeed = makeClient();
const loginDoc = await doctorSeed.post('/api/login', { account: 'liu-ortho@demo.local', password: 'Demo@1234' });
check('种子医生 liu-ortho@demo.local 登录 → 200，role=doctor', loginDoc.status === 200 && loginDoc.json.user.role === 'doctor', loginDoc.text);

const dPatient = await doctorSeed.get('/api/patient/appointments');
check('医生会话访问 /api/patient/appointments → 403（反向也拦）', dPatient.status === 403, 'status=' + dPatient.status);

const dOwn = await doctorSeed.get('/api/doctor/appointments');
check('医生访问 /api/doctor/appointments → 200', dOwn.status === 200, dOwn.text);

/* =======================================================
   5. 医生入驻申请与 pending 流程
   ======================================================= */
GROUP = '5. 医生申请 → 待审核 → 激活';
const apply = await guest.post('/api/doctor/apply', { name: '王医生', email: 'wang-demo@demo.local', password: 'Doctor@1234' });
check('提交医生申请 → 201，status=pending', apply.status === 201 && apply.json.user.status === 'pending', apply.text);
check('库里该医生 role=doctor、status=pending', (() => {
  const row = roleInDb('wang-demo@demo.local');
  return row && row.role === 'doctor' && row.status === 'pending';
})(), JSON.stringify(roleInDb('wang-demo@demo.local')));

const pendingLogin = await makeClient().post('/api/login', { account: 'wang-demo@demo.local', password: 'Doctor@1234' });
check('待审核账号登录 → 403，提示含「待审核」', pendingLogin.status === 403 && /待审核/.test(pendingLogin.json.error || ''), pendingLogin.text);

const dupApply = await guest.post('/api/doctor/apply', { name: '王医生', email: 'wang-demo@demo.local', password: 'Doctor@1234' });
check('同邮箱重复申请 → 409', dupApply.status === 409, dupApply.text);

const admin = makeClient();
const loginAdmin = await admin.post('/api/login', { account: 'admin@demo.local', password: 'Demo@1234' });
check('管理员登录 → 200，role=admin', loginAdmin.status === 200 && loginAdmin.json.user.role === 'admin', loginAdmin.text);

const pendingList = await admin.get('/api/admin/users?status=pending');
const hasWang = (pendingList.json.users || []).some(u => u.email === 'wang-demo@demo.local');
check('管理员能看到待审核列表，含 wang-demo@demo.local', pendingList.status === 200 && hasWang, pendingList.text.slice(0, 200));
check('待审核列表不返回 password_hash 字段', !/password_hash/i.test(pendingList.text), pendingList.text.slice(0, 160));

const wangId = (pendingList.json.users || []).find(u => u.email === 'wang-demo@demo.local');
const activate = await admin.post(`/api/admin/users/${wangId ? wangId.id : 0}/activate`);
check('管理员激活该医生 → 200', activate.status === 200, activate.text);

const doctorAfter = makeClient();
const loginAfter = await doctorAfter.post('/api/login', { account: 'wang-demo@demo.local', password: 'Doctor@1234' });
check('激活后同一账号可登录 → 200，role=doctor', loginAfter.status === 200 && loginAfter.json.user.role === 'doctor', loginAfter.text);

/* =======================================================
   6. 停用即时生效 + 登出
   ======================================================= */
GROUP = '6. 停用与登出';
const beforeDisable = await doctorAfter.get('/api/doctor/appointments');
check('停用前医生会话可用 → 200', beforeDisable.status === 200, String(beforeDisable.status));

const disable = await admin.post(`/api/admin/users/${wangId ? wangId.id : 0}/disable`);
check('管理员停用该医生 → 200', disable.status === 200, disable.text);

const afterDisable = await doctorAfter.get('/api/doctor/appointments');
check('停用后同一会话立刻 403（不依赖前端）', afterDisable.status === 403, 'status=' + afterDisable.status + ' ' + afterDisable.text);

const disabledLogin = await makeClient().post('/api/login', { account: 'wang-demo@demo.local', password: 'Doctor@1234' });
check('已停用账号登录 → 403，提示含「停用」', disabledLogin.status === 403 && /停用/.test(disabledLogin.json.error || ''), disabledLogin.text);

const logout = await patient.post('/api/logout');
const meAfter = await patient.get('/api/me');
check('登出 → 200', logout.status === 200, logout.text);
check('登出后 /api/me → user 为 null', meAfter.json && meAfter.json.user === null, meAfter.text);

/* =======================================================
   7. 静态资源不可访问
   -------------------------------------------------------
   之前的实现是 express.static(根目录) + 黑名单，漏了 README.md（里面写着
   演示账号密码）。现在改成白名单：只有白名单页面和 /assets 可读。
   这一组把「曾经漏过的」和「以后可能漏的」都钉住。
   ======================================================= */
GROUP = '7. 静态资源不可访问';

const SECRET_PATHS = [
  ['/data/app.db', '数据库文件'],
  ['/data/.session-secret', '会话密钥（data 下）'],
  ['/.session-secret', '会话密钥（根目录）'],
  ['/server/app.js', '后端源码'],
  ['/server/db.js', '后端源码'],
  ['/package.json', '依赖清单'],
  ['/package-lock.json', '依赖锁文件'],
  ['/.git/config', 'git 配置'],
  ['/.gitignore', 'gitignore'],
  ['/README.md', 'README（含演示账号密码）'],
  ['/scripts/api-test.mjs', '测试脚本'],
  ['/node_modules/express/package.json', 'node_modules'],
  ['/.env', '.env']
];

for (const [p, label] of SECRET_PATHS) {
  const r = await fetch(BASE + p);
  const text = await r.text();
  check(`GET ${p} → 404（${label}）`, r.status === 404 && !/password_hash|\$2[aby]\$|Demo@1234/.test(text),
    'status=' + r.status + ' body=' + text.slice(0, 80));
}

/* 白名单不能把正常页面误伤：9 个页面 + /assets 必须仍然 200 */
const PUBLIC_OK = ['/', '/index.html', '/services.html', '/doctors.html', '/appointment.html',
  '/contact.html', '/login.html', '/register.html', '/dashboard.html', '/payment.html',
  '/assets/css/style.css', '/assets/js/data.js', '/assets/js/dashboard.js', '/assets/js/payment.js'];
const badPublic = [];
for (const p of PUBLIC_OK) {
  const r = await fetch(BASE + p);
  if (r.status !== 200) badPublic.push(p + '=' + r.status);
}
check('白名单未误伤：9 个页面 + assets 全部 200', badPublic.length === 0, badPublic.join(', '));

const unknown = await fetch(BASE + '/api/not-exist');
check('未知接口 → 404 且是 JSON', unknown.status === 404 && /接口不存在/.test(await unknown.text()), 'status=' + unknown.status);

/* =======================================================
   8. 预约：可约时段与提交
   ======================================================= */
GROUP = '8. 预约：可约时段与提交';

const p1 = makeClient();
const p2 = makeClient();
const l1 = await p1.post('/api/login', { account: '13911110001', password: 'Test@1234' });
const l2 = await p2.post('/api/login', { account: '13911110002', password: 'Test@1234' });
check('两个病人账号都能登录', l1.status === 200 && l2.status === 200, l1.text + ' / ' + l2.text);

const doctorList = await (await fetch(BASE + '/api/doctors')).json();
const implant = doctorList.doctors.find(d => d.slug === 'liu-implant');
check('GET /api/doctors 公开可访问，返回 slug 供前端映射',
  !!implant && implant.slug === 'liu-implant' && !!implant.dept, JSON.stringify(implant));
check('/api/doctors 不泄露邮箱与密码', !/@demo\.local|password/i.test(JSON.stringify(doctorList)), JSON.stringify(doctorList).slice(0, 120));

function ymd(offset) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  const p = n => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

const d3 = ymd(3);
const schedRes = await p1.get(`/api/schedules?doctor_id=${implant.id}&date=${d3}`);
check('GET /api/schedules 返回该医生该日时段', schedRes.status === 200 && Array.isArray(schedRes.json.slots) && schedRes.json.slots.length >= 3,
  'status=' + schedRes.status + ' n=' + (schedRes.json && schedRes.json.slots ? schedRes.json.slots.length : '?'));

const freeSlots = (schedRes.json.slots || []).filter(s => s.open && !s.taken);
check('种子排班里有可约时段', freeSlots.length > 0, 'free=' + freeSlots.length);

/* 医生不能调病人的查时段接口 */
const doc1 = makeClient();
await doc1.post('/api/login', { account: 'liu-implant@demo.local', password: 'Demo@1234' });
const docQuery = await doc1.get(`/api/schedules?doctor_id=${implant.id}&date=${d3}`);
check('医生调 /api/schedules（病人接口）→ 403', docQuery.status === 403, 'status=' + docQuery.status);

const slotA = freeSlots[0].id;
const bookA = await p1.post('/api/appointments', { schedule_id: slotA, note: '首次咨询种植' });
check('病人提交预约 → 201，status=pending', bookA.status === 201 && bookA.json.appointment.status === 'pending', bookA.text);
const apptA = bookA.json.appointment.id;

const afterBook = await p1.get(`/api/schedules?doctor_id=${implant.id}&date=${d3}`);
const slotNow = (afterBook.json.slots || []).find(s => s.id === slotA);
check('该时段在可约列表里变成 taken', !!slotNow && slotNow.taken === true, JSON.stringify(slotNow));

const dupBook = await p2.post('/api/appointments', { schedule_id: slotA });
check('同一时段再订 → 409 SLOT_TAKEN', dupBook.status === 409 && dupBook.json.code === 'SLOT_TAKEN', dupBook.text);

const badSlot = await p1.post('/api/appointments', { schedule_id: 999999 });
check('不存在的时段 → 404 SLOT_NOT_FOUND', badSlot.status === 404 && badSlot.json.code === 'SLOT_NOT_FOUND', badSlot.text);

const longNote = await p1.post('/api/appointments', { schedule_id: freeSlots[1].id, note: 'x'.repeat(201) });
check('备注超 200 字 → 400', longNote.status === 400 && longNote.json.code === 'NOTE_TOO_LONG', longNote.text);

/* =======================================================
   9. 并发下只成功一个（靠数据库唯一索引，不靠应用层 if）
   ======================================================= */
GROUP = '9. 并发防重：同一时段只成功一个';

const raceSlot = await p1.get(`/api/schedules?doctor_id=${implant.id}&date=${ymd(4)}`);
const raceFree = (raceSlot.json.slots || []).filter(s => s.open && !s.taken);
const target = raceFree[0].id;

/* 两个请求同时发出，目标同一 slot */
const [raceA, raceB] = await Promise.all([
  p1.post('/api/appointments', { schedule_id: target }),
  p2.post('/api/appointments', { schedule_id: target })
]);

const raceCodes = [raceA.status, raceB.status].sort();
check('并发两个请求：恰好一个 201、一个 409',
  raceCodes[0] === 201 && raceCodes[1] === 409,
  'A=' + raceA.status + ' B=' + raceB.status);
check('失败方的错误码是 SLOT_TAKEN',
  [raceA, raceB].some(r => r.json && r.json.code === 'SLOT_TAKEN'),
  raceA.text + ' | ' + raceB.text);

/* 直接查库：该 slot 只有一条未取消的预约 */
const winners = db.prepare(
  `SELECT COUNT(*) AS n FROM appointments WHERE schedule_id = ? AND status <> 'cancelled'`
).get(target);
check('库里该时段只有 1 条未取消预约', winners.n === 1, 'n=' + winners.n);

/* ★ 关键：绕过应用层，用独立连接直接 INSERT，验证最后一道防线是数据库 ★ */
const writer = new Database(DB_FILE);
const p1Id = db.prepare('SELECT id FROM users WHERE phone = ?').get('13911110001').id;
let rawErr = null;
try {
  writer.prepare(`
    INSERT INTO appointments (patient_id, doctor_id, schedule_id, status, note)
    VALUES (?, ?, ?, 'pending', 'raw insert bypassing route')
  `).run(p1Id, implant.id, target);
} catch (e) {
  rawErr = e;
}
check('绕过接口直接 INSERT 同一 slot → 被唯一索引拒绝（不靠应用层判断）',
  !!rawErr && /UNIQUE constraint failed/i.test(rawErr.message),
  rawErr ? rawErr.message.split('\n')[0] : '❌ 竟然插入成功');

/* 取消后，同一 slot 应该能重新预订（部分索引只约束非 cancelled） */
const cancelWinner = await (raceA.status === 201 ? p1 : p2).get('/api/patient/appointments');
const winnerId = (cancelWinner.json.appointments || []).find(a => a.date === ymd(4))?.id;
if (winnerId) {
  const free = await (raceA.status === 201 ? p1 : p2).post(`/api/appointments/${winnerId}/cancel`);
  const again = await (raceA.status === 201 ? p1 : p2).get(`/api/schedules?doctor_id=${implant.id}&date=${ymd(4)}`);
  const slotAgain = (again.json.slots || []).find(s => s.id === target);
  check('取消后该时段重新变为可约（部分索引排除 cancelled）',
    free.status === 200 && !!slotAgain && slotAgain.taken === false,
    'cancel=' + free.status + ' taken=' + (slotAgain && slotAgain.taken));
}

writer.close();

/* =======================================================
   10. 对象级权限：病人 A 不能动病人 B 的预约
   ======================================================= */
GROUP = '10. 对象级越权';

/* p1 在 5 天后订一个时段，拿到预约 id */
const d5 = ymd(5);
const s5 = await p1.get(`/api/schedules?doctor_id=${implant.id}&date=${d5}`);
const free5 = (s5.json.slots || []).filter(s => s.open && !s.taken);
const ownBook = await p1.post('/api/appointments', { schedule_id: free5[0].id, note: '越权测试用' });
const ownId = ownBook.json.appointment.id;
check('p1 预约成功，拿到预约 id', ownBook.status === 201 && !!ownId, ownBook.text);

/* p2 拿 p1 的预约 id 去取消 */
const steal = await p2.post(`/api/appointments/${ownId}/cancel`);
check('病人 B 取消病人 A 的预约 → 403 NOT_OWNER', steal.status === 403 && steal.json.code === 'NOT_OWNER', steal.text);

/* 确认这条预约没被改动 */
const stillThere = db.prepare('SELECT status FROM appointments WHERE id = ?').get(ownId);
check('越权尝试后 A 的预约状态仍是 pending（没被改）', stillThere.status === 'pending', JSON.stringify(stillThere));

/* p2 的列表里看不到 p1 的预约 */
const p2List = await p2.get('/api/patient/appointments');
const leaked = (p2List.json.appointments || []).some(a => a.id === ownId);
check('B 的「我的预约」里看不到 A 的预约', p2List.status === 200 && !leaked, p2List.text.slice(0, 160));

/* 医生 A 不能看医生 B 的排班：doctor_id 只从 session 取 */
const ortho = makeClient();
await ortho.post('/api/login', { account: 'liu-ortho@demo.local', password: 'Demo@1234' });
const orthoSlots = await ortho.get(`/api/doctor/schedules?date=${d5}`);
const orthoSlotsSpoof = await ortho.get(`/api/doctor/schedules?date=${d5}&doctor_id=${implant.id}`);
const sameResult = JSON.stringify(orthoSlots.json.slots) === JSON.stringify(orthoSlotsSpoof.json.slots);
check('医生查排班传别人的 doctor_id 无效（结果完全相同）', sameResult,
  'own=' + (orthoSlots.json.slots || []).length + ' spoof=' + (orthoSlotsSpoof.json.slots || []).length);

const orthoAppts = await ortho.get('/api/doctor/appointments');
const seesOthers = (orthoAppts.json.appointments || []).some(a => a.id === ownId);
check('正畸医生看不到种植科医生的那条约诊', orthoAppts.status === 200 && !seesOthers,
  'count=' + (orthoAppts.json.appointments || []).length);

const implantAppts = await doc1.get('/api/doctor/appointments');
const seesOwn = (implantAppts.json.appointments || []).some(a => a.id === ownId);
check('种植科医生能看到属于自己的那条（正向也验）', implantAppts.status === 200 && seesOwn,
  'count=' + (implantAppts.json.appointments || []).length);

/* =======================================================
   11. 取消规则：24 小时窗口 + 状态机
   ======================================================= */
GROUP = '11. 取消与 24 小时规则';

/* 用可写连接插入两个可控时段，避免依赖运行时刻 */
const w2 = new Database(DB_FILE);
function addSlot(doctorId, date, start, end) {
  /* INSERT OR IGNORE + 回查 id：种子里已经有这个点也不至于把测试跑挂 */
  w2.prepare(`
    INSERT OR IGNORE INTO schedules (doctor_id, date, start_time, end_time, status)
    VALUES (?, ?, ?, ?, 'open')
  `).run(doctorId, date, start, end);
  return w2.prepare(
    'SELECT id FROM schedules WHERE doctor_id = ? AND date = ? AND start_time = ?'
  ).get(doctorId, date, start).id;
}

const now = new Date();
/* 18:00 不在种子模板（09:00 / 10:30 / 14:00 / 15:30）里，避免撞车 */
const nearDate = now.getHours() >= 18 ? ymd(1) : ymd(0);
const nearSlotId = addSlot(implant.id, nearDate, '18:00', '19:00');
const farSlotId = addSlot(implant.id, ymd(6), '11:00', '12:00');

const nearBook = await p1.post('/api/appointments', { schedule_id: nearSlotId });
const farBook = await p2.post('/api/appointments', { schedule_id: farSlotId });
check('插入「24 小时内」与「24 小时外」两个时段并各订一单',
  nearBook.status === 201 && farBook.status === 201,
  nearBook.status + ' / ' + farBook.status + ' ' + nearBook.text + nearBook.text);

const nearCancel = await p1.post(`/api/appointments/${nearBook.json.appointment.id}/cancel`);
check('24 小时内取消 → 409 TOO_LATE_TO_CANCEL', nearCancel.status === 409 && nearCancel.json.code === 'TOO_LATE_TO_CANCEL', nearCancel.text);
check('错误里带剩余小时数，前端可直接展示', typeof nearCancel.json.hours_left === 'number', nearCancel.text);

const farCancel = await p2.post(`/api/appointments/${farBook.json.appointment.id}/cancel`);
check('24 小时外取消 → 200，status=cancelled', farCancel.status === 200 && farCancel.json.status === 'cancelled', farCancel.text);

const cancelTwice = await p2.post(`/api/appointments/${farBook.json.appointment.id}/cancel`);
check('重复取消 → 409 ALREADY_CANCELLED', cancelTwice.status === 409 && cancelTwice.json.code === 'ALREADY_CANCELLED', cancelTwice.text);

/* 状态机兜底：cancelled 必须有 cancelled_at，且取消后不能回到 pending */
const cancelledRow = db.prepare('SELECT status, cancelled_at FROM appointments WHERE id = ?')
  .get(farBook.json.appointment.id);
check('取消后 cancelled_at 有值（CHECK 约束保证状态与时间戳一致）',
  cancelledRow.status === 'cancelled' && !!cancelledRow.cancelled_at, JSON.stringify(cancelledRow));

w2.close();

/* =======================================================
   12. 医生端状态流转：确认 → 完成 / 未到诊
   ======================================================= */
GROUP = '12. 医生状态流转：确认 → 完成 / 未到诊';

function statusOf(id) {
  const r = db.prepare('SELECT status FROM appointments WHERE id = ?').get(id);
  return r ? r.status : null;
}

/* ownId 是第 10 组留下的 pending 预约（医生 = 种植科，病人 = p1），直接推进 */
const cf = await doc1.post(`/api/doctor/appointments/${ownId}/confirm`);
check('医生确认自己名下的 pending 预约 → 200, status=confirmed',
  cf.status === 200 && cf.json.appointment.status === 'confirmed', cf.text);
check('确认后库里是 confirmed', statusOf(ownId) === 'confirmed', 'status=' + statusOf(ownId));
check('响应带 status_label（前端不用自己映射中文）',
  cf.json.appointment.status_label === '已确认', JSON.stringify(cf.json));

const cp = await doc1.post(`/api/doctor/appointments/${ownId}/complete`);
check('confirmed → 标记完成 → 200, status=completed',
  cp.status === 200 && cp.json.appointment.status === 'completed', cp.text);
check('完成后库里是 completed', statusOf(ownId) === 'completed', 'status=' + statusOf(ownId));

/* 第二条走「未到诊」分支 */
const d9 = ymd(9);
const s9 = await p1.get(`/api/schedules?doctor_id=${implant.id}&date=${d9}`);
const free9 = (s9.json.slots || []).filter(s => s.open && !s.taken);
const nsBook = await p1.post('/api/appointments', { schedule_id: free9[0].id, note: '未到诊用例' });
const nsId = nsBook.json.appointment.id;
const nsConfirm = await doc1.post(`/api/doctor/appointments/${nsId}/confirm`);
const nsMark = await doc1.post(`/api/doctor/appointments/${nsId}/no-show`);
check('pending → confirmed → no_show 一路走通',
  nsConfirm.status === 200 && nsMark.status === 200 && nsMark.json.appointment.status === 'no_show',
  nsConfirm.text + ' / ' + nsMark.text);
check('未到诊后库里是 no_show', statusOf(nsId) === 'no_show', 'status=' + statusOf(nsId));

/* 状态变更对病人可见 */
const p1AfterComplete = await p1.get('/api/patient/appointments');
const seenCompleted = (p1AfterComplete.json.appointments || []).find(a => a.id === ownId);
check('病人侧能看到医生推进后的状态（completed）',
  !!seenCompleted && seenCompleted.status === 'completed', JSON.stringify(seenCompleted));

/* =======================================================
   13. 非法状态转换：每一次都必须被拒绝
   ======================================================= */
GROUP = '13. 非法状态转换：全部拒绝';

const d10 = ymd(10);
const s10 = await p1.get(`/api/schedules?doctor_id=${implant.id}&date=${d10}`);
const free10 = (s10.json.slots || []).filter(s => s.open && !s.taken);
const pendBook = await p1.post('/api/appointments', { schedule_id: free10[0].id, note: '非法转换用例' });
const pendId = pendBook.json.appointment.id;
check('准备好一条 pending 预约用于非法转换测试', pendBook.status === 201, pendBook.text);

const cancelledId = farBook.json.appointment.id;   // 第 11 组取消的那条（医生 = 种植科）
const completedId = ownId;                        // 第 12 组完成的
const noShowId = nsId;                            // 第 12 组标记未到诊的

const illegalCases = [
  [pendId, 'complete', '待确认 → 完成'],
  [pendId, 'no-show', '待确认 → 未到诊'],
  [cancelledId, 'confirm', '已取消 → 确认'],
  [cancelledId, 'complete', '已取消 → 完成'],
  [completedId, 'confirm', '已完成 → 确认'],
  [completedId, 'complete', '已完成 → 完成'],
  [noShowId, 'confirm', '未到诊 → 确认'],
  [noShowId, 'complete', '未到诊 → 完成']
];

let firstIllegal = null;
for (const [id, action, label] of illegalCases) {
  const r = await doc1.post(`/api/doctor/appointments/${id}/${action}`);
  if (!firstIllegal) firstIllegal = r;
  check(`${label} → 409 BAD_STATE`, r.status === 409 && r.json.code === 'BAD_STATE',
    'status=' + r.status + ' ' + r.text);
}

check('8 种非法转换跑完后，三条预约的状态一个都没被改',
  statusOf(pendId) === 'pending' && statusOf(cancelledId) === 'cancelled' && statusOf(completedId) === 'completed',
  [statusOf(pendId), statusOf(cancelledId), statusOf(completedId)].join(','));

check('409 响应里带当前状态与期望状态，前端不用猜',
  !!firstIllegal && firstIllegal.json.status === 'pending' && firstIllegal.json.expected === 'confirmed',
  firstIllegal ? firstIllegal.text : '');

/* 跨医生：角色对但资源不是自己的 */
const wrongDoctorConfirm = await ortho.post(`/api/doctor/appointments/${pendId}/confirm`);
check('别的医生确认我的预约 → 403 NOT_OWNER',
  wrongDoctorConfirm.status === 403 && wrongDoctorConfirm.json.code === 'NOT_OWNER', wrongDoctorConfirm.text);

/* 跨角色：病人拿医生接口 */
const patientCallDoctorApi = await p1.post(`/api/doctor/appointments/${pendId}/confirm`);
check('病人调医生状态接口 → 403（角色层先拦）',
  patientCallDoctorApi.status === 403, patientCallDoctorApi.text);

/* 不存在的 id */
const ghostConfirm = await doc1.post('/api/doctor/appointments/999999/confirm');
check('不存在的预约 → 404 NOT_FOUND', ghostConfirm.status === 404, ghostConfirm.text);

/* =======================================================
   14. 病人预约详情（对象级权限）
   ======================================================= */
GROUP = '14. 病人预约详情';

const detail = await p1.get(`/api/patient/appointments/${nsId}`);
const det = detail.json && detail.json.appointment;
check('查自己的详情 → 200', detail.status === 200 && !!det, detail.text);
check('详情含医生姓名与科室', !!det && det.doctor.name === '刘主任' && det.doctor.dept === '种植科',
  det ? JSON.stringify(det.doctor) : '');
check('详情含时段与状态', !!det && !!det.date && !!det.start_time && !!det.end_time && det.status === 'no_show',
  det ? det.date + ' ' + det.start_time + ' ' + det.status : '');
check('详情含取消规则：窗口 24 小时 + 距开始小时数',
  !!det && det.cancel_rule.window_hours === 24 && typeof det.cancel_rule.hours_left === 'number',
  det ? JSON.stringify(det.cancel_rule) : '');
check('未到诊的预约 → 不可取消，原因码 NOT_CANCELLABLE',
  !!det && det.cancel_rule.cancellable === false && det.cancel_rule.reason === 'NOT_CANCELLABLE',
  det ? JSON.stringify(det.cancel_rule) : '');

const foreignDetail = await p2.get(`/api/patient/appointments/${nsId}`);
check('病人 B 查病人 A 的详情 → 403 NOT_OWNER',
  foreignDetail.status === 403 && foreignDetail.json.code === 'NOT_OWNER', foreignDetail.text);

const ghostDetail = await p1.get('/api/patient/appointments/999999');
check('不存在的预约 → 404', ghostDetail.status === 404, ghostDetail.text);

const badDetailId = await p1.get('/api/patient/appointments/abc');
check('非数字 id → 400 BAD_ID', badDetailId.status === 400 && badDetailId.json.code === 'BAD_ID', badDetailId.text);

const pendingDetail = await p1.get(`/api/patient/appointments/${pendId}`);
check('pending 且距开始 >24h → cancellable=true, reason=OK',
  pendingDetail.status === 200 &&
  pendingDetail.json.appointment.cancel_rule.cancellable === true &&
  pendingDetail.json.appointment.cancel_rule.reason === 'OK',
  pendingDetail.text);

/* =======================================================
   15. 补漏复核：过去时段 / 取消幂等 / 医生审核链路
   ======================================================= */
GROUP = '15. 补漏复核：过去时段 / 取消幂等 / 医生审核';

const w3 = new Database(DB_FILE);
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function addSlot3(doctorId, date, start, end) {
  w3.prepare(`
    INSERT OR IGNORE INTO schedules (doctor_id, date, start_time, end_time, status)
    VALUES (?, ?, ?, ?, 'open')
  `).run(doctorId, date, start, end);
  return w3.prepare(
    'SELECT id FROM schedules WHERE doctor_id = ? AND date = ? AND start_time = ?'
  ).get(doctorId, date, start).id;
}

/* 15.1 过去时段：昨天 / 今天已过去的时刻 */
const pastSlot = addSlot3(implant.id, ymd(-1), '09:00', '10:00');
const pastBook = await p1.post('/api/appointments', { schedule_id: pastSlot, note: '过去时段' });
check('预约「昨天」的时段 → 400 SLOT_IN_PAST',
  pastBook.status === 400 && pastBook.json.code === 'SLOT_IN_PAST', pastBook.text);
check('过去时段没有生成任何预约记录',
  db.prepare('SELECT COUNT(*) AS n FROM appointments WHERE schedule_id = ?').get(pastSlot).n === 0, '');

const pastHour = new Date();
pastHour.setHours(pastHour.getHours() - 1, 0, 0, 0);
const phStr = pad2(pastHour.getHours()) + ':00';
const peStr = pad2(pastHour.getHours() + 1) + ':00';
const todayPastSlot = addSlot3(implant.id, ymd(0), phStr, peStr);
const todayPastBook = await p1.post('/api/appointments', { schedule_id: todayPastSlot });
check(`预约「今天 ${phStr}」这个已开始的时刻 → 400 SLOT_IN_PAST`,
  todayPastBook.status === 400 && todayPastBook.json.code === 'SLOT_IN_PAST', todayPastBook.text);

/* 15.2 取消幂等：连续的第二次、第三次 */
const beforeCancel = db.prepare('SELECT status, cancelled_at FROM appointments WHERE id = ?').get(cancelledId);
const secondCancel = await p2.post(`/api/appointments/${cancelledId}/cancel`);
const thirdCancel = await p2.post(`/api/appointments/${cancelledId}/cancel`);
const afterCancel = db.prepare('SELECT status, cancelled_at FROM appointments WHERE id = ?').get(cancelledId);

check('第 2 次取消 → 409 ALREADY_CANCELLED',
  secondCancel.status === 409 && secondCancel.json.code === 'ALREADY_CANCELLED', secondCancel.text);
check('第 3 次取消仍是 409（幂等，不因次数改变）',
  thirdCancel.status === 409 && thirdCancel.json.code === 'ALREADY_CANCELLED', thirdCancel.text);
check('重复取消没有改状态、也没有刷新 cancelled_at',
  beforeCancel.status === afterCancel.status && beforeCancel.cancelled_at === afterCancel.cancelled_at,
  JSON.stringify(afterCancel));

/* 15.3 医生申请 → 管理员审核 → 可登录 */
const applicant = makeClient();
const applyRes = await applicant.post('/api/doctor/apply', {
  name: '审核链路医生', email: 'review-flow@demo.local', password: 'Test@1234', dept: '儿童齿科'
});
check('医生提交入驻申请 → 201, status=pending',
  applyRes.status === 201 && applyRes.json.user.status === 'pending', applyRes.text);

const loginBeforeReview = await applicant.post('/api/login', {
  account: 'review-flow@demo.local', password: 'Test@1234'
});
check('未审核通过前不能登录 → 403 待审核',
  loginBeforeReview.status === 403 && /待审核/.test(loginBeforeReview.json.error || ''), loginBeforeReview.text);

const adminClient = makeClient();
await adminClient.post('/api/login', { account: 'admin@demo.local', password: 'Demo@1234' });
const reviewList = await adminClient.get('/api/admin/users?status=pending');
const reviewTarget = (reviewList.json.users || []).find(u => u.email === 'review-flow@demo.local');
check('管理员待审列表里能看到这条申请（审核页的数据源）', !!reviewTarget, reviewList.text.slice(0, 200));

const approve = await adminClient.post(`/api/admin/users/${reviewTarget.id}/activate`);
check('管理员点「通过」→ 200, status=active',
  approve.status === 200 && approve.json.user.status === 'active', approve.text);

const loginAfterReview = await applicant.post('/api/login', {
  account: 'review-flow@demo.local', password: 'Test@1234'
});
check('审核通过后可以登录，role=doctor',
  loginAfterReview.status === 200 && loginAfterReview.json.user.role === 'doctor', loginAfterReview.text);

const dashHtml = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
check('审核入口确实有 UI：dashboard.html 有待审表格与刷新按钮',
  /id="admin-tbody"/.test(dashHtml) && /id="admin-refresh"/.test(dashHtml), '');

w3.close();

/* =======================================================
   16. 老库迁移：CHECK 补 no_show，且不丢数据
   ======================================================= */
GROUP = '16. 老库迁移（no_show）';

const schemaRow = db.prepare(
  "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'appointments'"
).get();
check('启动后建表语句里已经包含 no_show', !!schemaRow && /no_show/.test(schemaRow.sql),
  schemaRow ? schemaRow.sql.replace(/\s+/g, ' ').slice(0, 120) : 'no table');

const legacyRow = db.prepare('SELECT id, note FROM appointments WHERE id = ?').get(LEGACY_APPT_ID);
check('迁移前就存在的那条记录还在（INSERT ... SELECT 没漏）',
  !!legacyRow && legacyRow.note === '迁移前就存在的记录', JSON.stringify(legacyRow));

const idxRow = db.prepare(
  "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'ux_appt_active_slot'"
).get();
check('迁移后防双订唯一索引还在（重建索引没漏）', !!idxRow, JSON.stringify(idxRow));
check('迁移后的索引条件已放宽到 no_show（不是老库留下的 status <> cancelled）',
  !!idxRow && /no_show/.test(idxRow.sql || ''),
  idxRow ? String(idxRow.sql).replace(/\s+/g, ' ') : 'no index');

const w4 = new Database(DB_FILE);
let bogusErr = null;
try {
  w4.prepare(`
    INSERT INTO appointments (patient_id, doctor_id, schedule_id, status)
    VALUES (1, 1, 1, 'bogus_status')
  `).run();
} catch (e) { bogusErr = e; }
check('CHECK 仍然拦非法状态值（不是把所有值都放开）',
  !!bogusErr && /CHECK/i.test(bogusErr.message), bogusErr ? bogusErr.message.split('\n')[0] : '竟然插入成功');

w4.prepare('DELETE FROM appointments WHERE id = ?').run(LEGACY_APPT_ID);
w4.close();
check('迁移夹具已清理，不影响后续统计',
  !db.prepare('SELECT 1 FROM appointments WHERE id = ?').get(LEGACY_APPT_ID), '');

/* 16.6 「索引整个丢了」也要能自愈（第四期 latent bug 的兜底）
   ---------------------------------------------------------
   上一轮的坑是：迁移时索引跟着旧表被 DROP，而 CREATE INDEX IF NOT EXISTS
   被同名旧索引挡住 → 新表一条唯一索引都没有，防双订静默失效。
   这一条专门造一个「已经升级过（CHECK 里有 no_show）、但索引被手工删掉」的库，
   起一次服务端进程，验证 migrateSlotIndex() 会补建 ——
   它不是只修「索引条件旧」，也修「索引根本不存在」。 */
const HEAL_DB = path.join(TMP_DIR, 'idx-heal.db');
for (const f of [HEAL_DB, HEAL_DB + '-wal', HEAL_DB + '-shm']) { try { fs.unlinkSync(f); } catch {} }

const hSeed = new Database(HEAL_DB);
hSeed.exec(`
  CREATE TABLE appointments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id   INTEGER NOT NULL,
    doctor_id    INTEGER NOT NULL,
    schedule_id  INTEGER NOT NULL,
    status       TEXT    NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','confirmed','cancelled','completed','no_show')),
    note         TEXT,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    cancelled_at TEXT,
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
  );
`);
hSeed.close();

const healRun = await runNodeOnce("require('./server/db').db.close()",
  { DB_FILE: HEAL_DB, BCRYPT_ROUNDS: '4', NODE_ENV: 'test' });

const hCheck = new Database(HEAL_DB, { readonly: true });
const healedIdx = hCheck.prepare(
  "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'ux_appt_active_slot'"
).get();
hCheck.close();

check('索引整个缺失时启动即自愈：migrateSlotIndex 会补建（不依赖 migrateNoShow 触发）',
  healRun.code === 0 && !!healedIdx, healRun.stderr.slice(0, 200) || '启动失败且没有索引');
check('自愈补出来的索引条件是最新的（排除 cancelled + no_show）',
  !!healedIdx && /no_show/.test(healedIdx.sql || ''),
  healedIdx ? healedIdx.sql.replace(/\s+/g, ' ') : 'no index');

for (const f of [HEAL_DB, HEAL_DB + '-wal', HEAL_DB + '-shm']) { try { fs.unlinkSync(f); } catch {} }

/* =======================================================
   17. no_show 释放号源 + reopen 纠错（第四期修复死胡同）
   ======================================================= */
GROUP = '17. no_show 释放号源与 reopen';

/* 17.0 旧条件 vs 新条件的 A/B 复现。
   不去改生产库，用内存库把两种索引条件各建一次：
   同一个 slot，先放一条 no_show，再插一条 pending。
   旧条件（status <> 'cancelled'）应当拒绝 → 这就是死胡同的根因；
   新条件（NOT IN ('cancelled','no_show')）应当放行 → 号源确实释放。
   比「观察接口返回」更直接：它证明的是索引本身，而不是某段代码的判断。 */
(function reproduceDeadlock() {
  const mem = new Database(':memory:');
  mem.exec(`
    CREATE TABLE a (schedule_id INTEGER, status TEXT);
    CREATE UNIQUE INDEX old_idx ON a (schedule_id) WHERE status <> 'cancelled';
  `);
  mem.prepare('INSERT INTO a VALUES (1, ?)').run('no_show');
  let oldErr = null;
  try {
    mem.prepare('INSERT INTO a VALUES (1, ?)').run('pending');
  } catch (e) { oldErr = e; }

  mem.exec(`
    DROP INDEX old_idx;
    CREATE UNIQUE INDEX new_idx ON a (schedule_id) WHERE status NOT IN ('cancelled', 'no_show');
  `);
  let newErr = null;
  let newOk = false;
  try {
    mem.prepare('INSERT INTO a VALUES (1, ?)').run('pending');
    newOk = true;
  } catch (e) { newErr = e; }
  mem.close();

  check('旧索引条件下 no_show 的时段插不进第二条（复现死胡同）',
    !!oldErr && /UNIQUE/i.test(oldErr.message), oldErr ? oldErr.message.split('\n')[0] : '竟然插进去了');
  check('新索引条件下同一时段可以插入（号源真的释放）',
    newOk && !newErr, newErr ? newErr.message.split('\n')[0] : '插入成功');
})();

const nsRow = db.prepare(`
  SELECT a.schedule_id, s.date, s.start_time
  FROM appointments a JOIN schedules s ON s.id = a.schedule_id
  WHERE a.id = ?
`).get(nsId);
const nsSlotId = nsRow.schedule_id;

/* 17.1 no_show 之后这个时段必须重新出现在可约列表里。
   注意「索引放宽」和「查询条件放宽」是两件事：
   只改索引会出现「能插入但列表仍显示已占用」，所以这条要查接口而不是查索引。 */
const nsSlots = await p2.get(`/api/schedules?doctor_id=${implant.id}&date=${nsRow.date}`);
const nsSlotNow = (nsSlots.json.slots || []).find(s => s.id === nsSlotId);
check('no_show 之后该时段在可约列表里回到「未占用」',
  !!nsSlotNow && nsSlotNow.open === true && nsSlotNow.taken === false,
  nsSlotNow ? JSON.stringify(nsSlotNow) : '(列表里找不到该时段)');

/* 17.2 最终证明：另一个病人真的能把它约走 */
const rebook = await p2.post('/api/appointments', { schedule_id: nsSlotId, note: 'no_show 释放后重约' });
check('no_show 释放的时段可被另一个病人重新预约 → 201',
  rebook.status === 201 && rebook.json.appointment.status === 'pending', rebook.text);

/* 17.3 号源被重约后，原来那条 no_show 不能强行恢复（否则同槽两条有效记录） */
const reopenBlocked = await doc1.post(`/api/doctor/appointments/${nsId}/reopen`);
check('时段已被重约时 reopen → 409 SLOT_REBOOKED（不静默改状态）',
  reopenBlocked.status === 409 && reopenBlocked.json.code === 'SLOT_REBOOKED', reopenBlocked.text);
check('被拒绝的 reopen 没有改动原记录', statusOf(nsId) === 'no_show', 'status=' + statusOf(nsId));

/* 17.4 正常纠错路径：no_show → confirmed，并确认号源被重新占住 */
async function firstFreeSlot(date) {
  const r = await p1.get(`/api/schedules?doctor_id=${implant.id}&date=${date}`);
  return (r.json.slots || []).find(s => s.open && !s.taken) || null;
}
let fixDate = null;
let fixSlot = null;
for (const day of [11, 12]) {
  fixSlot = await firstFreeSlot(ymd(day));
  if (fixSlot) { fixDate = ymd(day); break; }
}
check('找到一条可用于 reopen 的空闲时段', !!fixSlot, fixDate || '');

const fixBook = await p1.post('/api/appointments', { schedule_id: fixSlot.id, note: 'reopen 用例' });
const fixId = fixBook.json.appointment.id;
await doc1.post(`/api/doctor/appointments/${fixId}/confirm`);
const fixNoShow = await doc1.post(`/api/doctor/appointments/${fixId}/no-show`);
check('准备好一条 no_show 预约（confirm → no-show）',
  fixNoShow.status === 200 && statusOf(fixId) === 'no_show', fixNoShow.text);

const reopened = await doc1.post(`/api/doctor/appointments/${fixId}/reopen`);
check('医生纠错：no_show → confirmed → 200',
  reopened.status === 200 && reopened.json.appointment.status === 'confirmed', reopened.text);
check('reopen 后库里是 confirmed', statusOf(fixId) === 'confirmed', 'status=' + statusOf(fixId));

const fixSlots = await p1.get(`/api/schedules?doctor_id=${implant.id}&date=${fixDate}`);
const fixSlotNow = (fixSlots.json.slots || []).find(s => s.id === fixSlot.id);
check('reopen 之后该时段重新被占住（索引确实收回了号源）',
  !!fixSlotNow && fixSlotNow.taken === true, fixSlotNow ? JSON.stringify(fixSlotNow) : '');

const reopenAgain = await doc1.post(`/api/doctor/appointments/${fixId}/reopen`);
check('已 confirmed 的再 reopen → 409 BAD_STATE',
  reopenAgain.status === 409 && reopenAgain.json.code === 'BAD_STATE', reopenAgain.text);

/* 17.5 权限与边界：对象级 > 状态机，先判归属再判状态 */
const reopenByOther = await ortho.post(`/api/doctor/appointments/${nsId}/reopen`);
check('别的医生 reopen 我的 no_show → 403 NOT_OWNER',
  reopenByOther.status === 403 && reopenByOther.json.code === 'NOT_OWNER', reopenByOther.text);
check('越权尝试后原记录仍是 no_show', statusOf(nsId) === 'no_show', 'status=' + statusOf(nsId));

const reopenByPatient = await p1.post(`/api/doctor/appointments/${nsId}/reopen`);
check('病人调 reopen 接口 → 403（角色层先拦）', reopenByPatient.status === 403, reopenByPatient.text);

const reopenGhost = await doc1.post('/api/doctor/appointments/999999/reopen');
check('reopen 不存在的预约 → 404 NOT_FOUND', reopenGhost.status === 404, reopenGhost.text);

const reopenPending = await doc1.post(`/api/doctor/appointments/${pendId}/reopen`);
check('reopen 一条 pending（不是 no_show）→ 409 BAD_STATE',
  reopenPending.status === 409 && reopenPending.json.code === 'BAD_STATE', reopenPending.text);

/* =======================================================
   18. 日志里不能有明文密码
   ======================================================= */
GROUP = '18. 日志与密码';
await sleep(300);
const logText = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
check('服务端日志不含任何明文密码（Demo@1234 / Test@1234 / Doctor@1234）',
  !/Demo@1234|Test@1234|Doctor@1234/.test(logText),
  logText.slice(0, 200) || '(空)');
check('服务端日志不含 bcrypt 哈希串', !/\$2[aby]\$\d{2}\$/.test(logText), logText.slice(0, 200) || '(空)');
check('服务端日志不含 session 密钥（连测试密钥也不该出现）',
  !logText.includes('test-only-secret-0123456789abcdef'), '日志里出现了密钥原文');

/* =======================================================
   19. 模拟支付：金额只由服务端算 / 幂等 / 归属（第五期）
   ======================================================= */
GROUP = '19. 模拟支付：金额、幂等与归属';

const w5 = new Database(DB_FILE);
function addSlot5(doctorId, date, start, end) {
  w5.prepare(`
    INSERT OR IGNORE INTO schedules (doctor_id, date, start_time, end_time, status)
    VALUES (?, ?, ?, ?, 'open')
  `).run(doctorId, date, start, end);
  return w5.prepare(
    'SELECT id FROM schedules WHERE doctor_id = ? AND date = ? AND start_time = ?'
  ).get(doctorId, date, start).id;
}

/* 支付相关的用例统一种在 ymd(8)，用自建时段避开前面几组占用的槽位 */
const payDate = ymd(8);
const slotClean = addSlot5(implant.id, payDate, '08:00', '09:00');
const slotImplant = addSlot5(implant.id, payDate, '12:00', '13:00');
const slotCancel = addSlot5(implant.id, payDate, '17:00', '18:00');

/* 19.1 预约时把服务项目落库（第五期新增列） */
const payBook = await p1.post('/api/appointments', { schedule_id: slotClean, service: 'cleaning', note: '支付用例' });
const payApptId = payBook.json && payBook.json.appointment ? payBook.json.appointment.id : 0;
check('预约时可以带服务项目 → 201，响应回显 service',
  payBook.status === 201 && payBook.json.appointment.service === 'cleaning', payBook.text);
check('服务项目真的落库（不是只拼在备注里）',
  (db.prepare('SELECT service FROM appointments WHERE id = ?').get(payApptId) || {}).service === 'cleaning',
  'appt=' + payApptId);

const badSvc = await p1.post('/api/appointments', { schedule_id: slotCancel, service: 'free-lunch' });
check('不存在的服务项目 → 400 BAD_SERVICE（不能被当成自选价格）',
  badSvc.status === 400 && badSvc.json.code === 'BAD_SERVICE', badSvc.text);
check('被拒的预约没有留下任何记录',
  db.prepare('SELECT COUNT(*) AS n FROM appointments WHERE schedule_id = ?').get(slotCancel).n === 0, '');

/* 19.2 创建订单：金额来自服务端价格表 */
const ord1 = await p1.post(`/api/patient/appointments/${payApptId}/order`);
const order1 = ord1.json && ord1.json.order;
check('创建订单 → 201, created=true, 状态 unpaid',
  ord1.status === 201 && ord1.json.created === true && order1.status === 'unpaid', ord1.text);
check('金额来自价格表：洗牙 = 28000 分，且是整数',
  order1.amount_cents === 28000 && Number.isInteger(order1.amount_cents), JSON.stringify(order1 && order1.amount_cents));
check('展示金额与 cents 一致：¥280.00',
  order1.amount_text === '¥280.00', String(order1 && order1.amount_text));
check('响应显式标记 simulated=true（前端不用写死"模拟"文案）',
  order1.simulated === true, ord1.text.slice(0, 120));
const orderId1 = order1.id;

/* 幂等：同一预约再下一次单，返回已有订单而不是第二单 */
const ord1Again = await p1.post(`/api/patient/appointments/${payApptId}/order`);
check('同一预约重复下单 → 200 + created=false + 同一订单号（幂等）',
  ord1Again.status === 200 && ord1Again.json.created === false &&
  ord1Again.json.order.id === orderId1, ord1Again.text);
check('库里该预约只有 1 张订单（UNIQUE(appointment_id) 兜底）',
  db.prepare('SELECT COUNT(*) AS n FROM orders WHERE appointment_id = ?').get(payApptId).n === 1, '');

/* 19.3 前端篡改金额：请求体里的 amount 一律不参与计算 */
const tamperBook = await p1.post('/api/appointments', { schedule_id: slotImplant, service: 'implant' });
const tamperOrder = await p1.post(
  `/api/patient/appointments/${tamperBook.json.appointment.id}/order`,
  { amount: 1, amount_cents: 1, price: 1, total: 0.01 }
);
check('请求体带 amount:1 下单 → 服务端仍按价格表算 680000 分',
  tamperOrder.status === 201 && tamperOrder.json.order.amount_cents === 680000, tamperOrder.text);
check('库里存的也是 680000（前端改不动金额）',
  db.prepare('SELECT amount_cents FROM orders WHERE id = ?')
    .get(tamperOrder.json.order.id).amount_cents === 680000, '');
const tamperOrderId = tamperOrder.json.order.id;

/* 19.4 未登录 / 越权 */
const anonOrder = await makeClient().post(`/api/patient/appointments/${payApptId}/order`);
check('未登录创建订单 → 401', anonOrder.status === 401, anonOrder.text);

const foreignOrder = await p2.post(`/api/patient/appointments/${payApptId}/order`);
check('病人 B 给病人 A 的预约下单 → 403 NOT_OWNER',
  foreignOrder.status === 403 && foreignOrder.json.code === 'NOT_OWNER', foreignOrder.text);

const anonPay = await makeClient().post(`/api/patient/orders/${orderId1}/pay`);
check('未登录支付 → 401', anonPay.status === 401, anonPay.text);

const foreignPay = await p2.post(`/api/patient/orders/${orderId1}/pay`);
check('病人 B 付病人 A 的订单 → 403 NOT_OWNER',
  foreignPay.status === 403 && foreignPay.json.code === 'NOT_OWNER', foreignPay.text);
check('越权尝试后订单仍是 unpaid（没被改）',
  db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId1).status === 'unpaid', '');

/* 19.5 支付 + 重复支付 */
const pay1 = await p1.post(`/api/patient/orders/${orderId1}/pay`);
const paidAt1 = (db.prepare('SELECT paid_at FROM orders WHERE id = ?').get(orderId1) || {}).paid_at;
check('模拟支付 → 200，状态 paid，paid_at 有值',
  pay1.status === 200 && pay1.json.order.status === 'paid' && !!paidAt1, pay1.text);
check('支付响应带 simulated=true 与「未发生真实扣款」说明',
  pay1.json.simulated === true && /未发生真实扣款/.test(pay1.json.note || ''), pay1.text);

/* 等 1.1 秒：datetime('now') 只精确到秒，不等的话"没被改"可能只是同一秒 */
await sleep(1100);
const payAgain = await p1.post(`/api/patient/orders/${orderId1}/pay`);
const paidAt2 = (db.prepare('SELECT paid_at FROM orders WHERE id = ?').get(orderId1) || {}).paid_at;
check('连续第二次支付 → 409 ALREADY_PAID',
  payAgain.status === 409 && payAgain.json.code === 'ALREADY_PAID', payAgain.text);
check('第二次支付没有改写 paid_at（对账时间点不变）',
  !!paidAt1 && paidAt1 === paidAt2, paidAt1 + ' → ' + paidAt2);

/* 19.6 退款 + 退款幂等 */
const refund1 = await p1.post(`/api/patient/orders/${orderId1}/refund`);
const refundedAt1 = (db.prepare('SELECT refunded_at FROM orders WHERE id = ?').get(orderId1) || {}).refunded_at;
check('模拟退款 → 200，状态 refunded，refunded_at 有值',
  refund1.status === 200 && refund1.json.order.status === 'refunded' && !!refundedAt1, refund1.text);

await sleep(1100);
const refundAgain = await p1.post(`/api/patient/orders/${orderId1}/refund`);
const refundedAt2 = (db.prepare('SELECT refunded_at FROM orders WHERE id = ?').get(orderId1) || {}).refunded_at;
check('重复退款 → 409 ALREADY_REFUNDED',
  refundAgain.status === 409 && refundAgain.json.code === 'ALREADY_REFUNDED', refundAgain.text);
check('重复退款没有刷新 refunded_at', refundedAt1 === refundedAt2, refundedAt1 + ' → ' + refundedAt2);

const payAfterRefund = await p1.post(`/api/patient/orders/${orderId1}/pay`);
check('已退款订单再支付 → 409 ALREADY_REFUNDED（不能复活）',
  payAfterRefund.status === 409 && payAfterRefund.json.code === 'ALREADY_REFUNDED', payAfterRefund.text);

const refundUnpaid = await p1.post(`/api/patient/orders/${tamperOrderId}/refund`);
check('未支付订单退款 → 409 NOT_PAID（没有可退的钱）',
  refundUnpaid.status === 409 && refundUnpaid.json.code === 'NOT_PAID', refundUnpaid.text);

/* 19.7 预约状态与订单的关系 */
const cancelledOrder = await p2.post(`/api/patient/appointments/${cancelledId}/order`);
check('已取消的预约不能创建订单 → 409 APPOINTMENT_NOT_PAYABLE',
  cancelledOrder.status === 409 && cancelledOrder.json.code === 'APPOINTMENT_NOT_PAYABLE', cancelledOrder.text);

const noSvcOrder = await p1.post(`/api/patient/appointments/${pendId}/order`);
check('没有服务项目的历史预约 → 409 SERVICE_MISSING（不猜价格）',
  noSvcOrder.status === 409 && noSvcOrder.json.code === 'SERVICE_MISSING', noSvcOrder.text);

/* 先下单、再取消预约 → 订单还在，但不能再支付 */
const cancelFlowBook = await p1.post('/api/appointments', { schedule_id: slotCancel, service: 'extraction' });
const cancelFlowOrder = await p1.post(`/api/patient/appointments/${cancelFlowBook.json.appointment.id}/order`);
const cancelFlowCancel = await p1.post(`/api/appointments/${cancelFlowBook.json.appointment.id}/cancel`);
check('先建订单、再取消预约 → 取消成功',
  cancelFlowOrder.status === 201 && cancelFlowCancel.status === 200, cancelFlowOrder.text + ' / ' + cancelFlowCancel.text);

const payCancelled = await p1.post(`/api/patient/orders/${cancelFlowOrder.json.order.id}/pay`);
check('预约已取消后支付 → 409 APPOINTMENT_NOT_PAYABLE',
  payCancelled.status === 409 && payCancelled.json.code === 'APPOINTMENT_NOT_PAYABLE', payCancelled.text);

/* 19.7b no_show 与 cancelled 同等对待（第六期修正）
   ① 未到诊的预约不能新开订单；
   ② 已经存在的订单，在预约被标为未到诊后也不能支付。
   这两条是上一轮的业务漏洞：no_show 会释放号源，
   如果还能付款，同一个时段可能既被下一个人约走、又给爽约的人记一笔账。 */
const nsPaySlot1 = addSlot5(implant.id, payDate, '19:00', '20:00');
const nsPaySlot2 = addSlot5(implant.id, payDate, '20:00', '21:00');

const nsBook1 = await p1.post('/api/appointments', { schedule_id: nsPaySlot1, service: 'cleaning' });
const nsId1 = nsBook1.json.appointment.id;
await doc1.post(`/api/doctor/appointments/${nsId1}/confirm`);
const nsDone1 = await doc1.post(`/api/doctor/appointments/${nsId1}/no-show`);
const nsOrder1 = await p1.post(`/api/patient/appointments/${nsId1}/order`);
check('no_show 预约创建订单 → 409 APPOINTMENT_NOT_PAYABLE',
  nsDone1.status === 200 && statusOf(nsId1) === 'no_show' &&
  nsOrder1.status === 409 && nsOrder1.json.code === 'APPOINTMENT_NOT_PAYABLE',
  nsDone1.text + ' / ' + nsOrder1.text);
check('被拒的 no_show 预约没有生成订单（不是先建后拦）',
  db.prepare('SELECT COUNT(*) AS n FROM orders WHERE appointment_id = ?').get(nsId1).n === 0, '');

const nsBook2 = await p1.post('/api/appointments', { schedule_id: nsPaySlot2, service: 'cleaning' });
const nsId2 = nsBook2.json.appointment.id;
await doc1.post(`/api/doctor/appointments/${nsId2}/confirm`);
const nsOrder2 = await p1.post(`/api/patient/appointments/${nsId2}/order`);
const nsDone2 = await doc1.post(`/api/doctor/appointments/${nsId2}/no-show`);
const nsPay2 = await p1.post(`/api/patient/orders/${nsOrder2.json.order.id}/pay`);
check('已下单、随后标 no_show：支付 → 409 APPOINTMENT_NOT_PAYABLE',
  nsOrder2.status === 201 && nsDone2.status === 200 &&
  nsPay2.status === 409 && nsPay2.json.code === 'APPOINTMENT_NOT_PAYABLE', nsPay2.text);
check('被拒的 no_show 支付没有改订单状态（仍是 unpaid）',
  db.prepare('SELECT status FROM orders WHERE id = ?').get(nsOrder2.json.order.id).status === 'unpaid', '');

/* 19.8 我的订单：只看得见自己的 */
const myOrders = await p1.get('/api/patient/orders');
const orderIds1 = (myOrders.json.orders || []).map(o => o.id);
check('GET /api/patient/orders 返回本人订单（含已退款那张）',
  myOrders.status === 200 && orderIds1.indexOf(orderId1) >= 0, myOrders.text.slice(0, 200));

const p2Orders = await p2.get('/api/patient/orders');
const leakedOrder = (p2Orders.json.orders || []).some(o => o.id === orderId1);
check('病人 B 的订单列表里看不到病人 A 的订单', p2Orders.status === 200 && !leakedOrder, p2Orders.text.slice(0, 160));

/* 19.9 医生端：只读的支付状态（第六期）
   医生要知道这单收没收到钱，但不需要、也不允许有支付操作入口。
   这里同时验「有订单的行」与「还没下单的行」，前端据此显示
   已支付 / 未支付 / 未下单。 */
const docPaySlot = addSlot5(implant.id, payDate, '21:00', '22:00');
const plainSlot = addSlot5(implant.id, payDate, '07:00', '08:00');

const docPayBook = await p1.post('/api/appointments', { schedule_id: docPaySlot, service: 'filling' });
const docPayOrder = await p1.post(`/api/patient/appointments/${docPayBook.json.appointment.id}/order`);
await p1.post(`/api/patient/orders/${docPayOrder.json.order.id}/pay`);
const plainBook = await p1.post('/api/appointments', { schedule_id: plainSlot, service: 'cleaning' });

const docPayList = await doc1.get('/api/doctor/appointments');
const docPayRow = (docPayList.json.appointments || []).find(a => a.id === docPayBook.json.appointment.id);
const docPlainRow = (docPayList.json.appointments || []).find(a => a.id === plainBook.json.appointment.id);

check('医生端列表带 order：已支付 + 金额 ¥380.00（补牙）',
  !!docPayRow && !!docPayRow.order && docPayRow.order.status === 'paid' &&
  docPayRow.order.amount_text === '¥380.00', JSON.stringify(docPayRow && docPayRow.order));
check('还没下单的预约在医生端 order 为 null（前端显示「未下单」）',
  !!docPlainRow && docPlainRow.order === null, JSON.stringify(docPlainRow && docPlainRow.order));

/* 19.10 数据库层兜底：唯一约束与一致性 CHECK（绕过接口也要挡住） */
const w6 = new Database(DB_FILE);
let dupOrderErr = null;
try {
  w6.prepare(`INSERT INTO orders (appointment_id, patient_id, amount_cents) VALUES (?, ?, 1)`)
    .run(payApptId, 1);
} catch (e) { dupOrderErr = e; }
check('绕过接口直接给同一预约插第二张订单 → 被 UNIQUE 拒绝',
  !!dupOrderErr && /UNIQUE constraint failed/i.test(dupOrderErr.message),
  dupOrderErr ? dupOrderErr.message.split('\n')[0] : '❌ 竟然插入成功');

let paidNoTimeErr = null;
try {
  w6.prepare(`UPDATE orders SET status = 'paid' WHERE id = ?`).run(tamperOrderId);
} catch (e) { paidNoTimeErr = e; }
check('status=paid 但不写 paid_at → 被 CHECK 拒绝',
  !!paidNoTimeErr && /CHECK/i.test(paidNoTimeErr.message),
  paidNoTimeErr ? paidNoTimeErr.message.split('\n')[0] : '❌ 竟然改成功');

let badStatusErr = null;
try {
  w6.prepare(`UPDATE orders SET status = 'bogus' WHERE id = ?`).run(tamperOrderId);
} catch (e) { badStatusErr = e; }
check('非法订单状态值 → 被 CHECK 拒绝',
  !!badStatusErr && /CHECK/i.test(badStatusErr.message),
  badStatusErr ? badStatusErr.message.split('\n')[0] : '❌ 竟然改成功');
w6.close();
w5.close();

/* 19.11 前端自检：支付页不含任何外部地址（Network 只应有本站请求） */
const payHtml = fs.readFileSync(path.join(ROOT, 'payment.html'), 'utf8');
const payJs = fs.readFileSync(path.join(ROOT, 'assets/js/payment.js'), 'utf8');
const externalUrl = /(?:src|href)\s*=\s*["']https?:\/\/|fetch\(\s*["'`]https?:\/\//i;
check('payment.html 没有外链脚本/样式/图片', !externalUrl.test(payHtml), '发现外部地址');
check('payment.js 里没有绝对地址的 fetch', !externalUrl.test(payJs), '发现外部地址');
check('支付页明确写「不产生真实扣款」',
  /不产生真实扣款/.test(payHtml) && /不接入支付宝、微信支付、银联、Stripe/.test(payHtml), '');
check('预约列表带 order 字段（前端据此决定是否显示「去支付」）',
  Array.isArray(myOrders.json.orders) && myOrders.json.orders.every(o => !!o.appointment),
  myOrders.text.slice(0, 120));

/* =======================================================
   20. 价格单一来源：服务页展示与订单计价读同一份数据（第六期）
   ======================================================= */
GROUP = '20. 价格单一来源（展示 = 计价）';

const pricing = requireCjs(path.join(ROOT, 'server', 'pricing.js'));
const pricingList = pricing.listServices();
const apiSvc = await guest.get('/api/services');
const apiList = (apiSvc.json && apiSvc.json.services) || [];

check('GET /api/services 与 pricing.js 完全一致（没有第二份价格表）',
  apiSvc.status === 200 && JSON.stringify(apiList) === JSON.stringify(pricingList),
  JSON.stringify(apiList).slice(0, 160));

check('价格表 8 个项目，金额都是正整数（单位：分）',
  pricingList.length === 8 && pricingList.every(s => Number.isInteger(s.amount_cents) && s.amount_cents > 0),
  JSON.stringify(pricingList.map(s => s.id + ':' + s.amount_cents)));

const impSvc = pricing.getService('implant');
check('种植牙：计费 680000 分落在展示区间 ¥6,000–15,000 内',
  !!impSvc && impSvc.amount_cents === 680000 &&
  impSvc.price_range.min_cents === 600000 && impSvc.price_range.max_cents === 1500000,
  JSON.stringify(impSvc));

const servicesHtml = fs.readFileSync(path.join(ROOT, 'services.html'), 'utf8');
check('services.html 里没有硬编码金额（区间由 data.js 渲染，不存在双源）',
  !/¥\s?\d/.test(servicesHtml), (servicesHtml.match(/¥[^<]*/g) || []).join(' | '));

const dataSrc = fs.readFileSync(path.join(ROOT, 'assets/js/data.js'), 'utf8');
check('data.js 是唯一价格来源：services[] 里带 amount_cents 与 price_range',
  /amount_cents\s*:\s*680000/.test(dataSrc) && /price_range\s*:/.test(dataSrc), '');

/* =======================================================
   21. 小程序公开接口（第七期）
   -------------------------------------------------------
   三个接口的共同要求：免登录、只读、字段收窄、限流。
   这里既验「给对了」，也验「没多给」——多给的字段在小程序里等于公开。
   ======================================================= */
GROUP = '21. 小程序公开接口（免登录 / 字段收窄 / 限流）';

const { siteData } = requireCjs(path.join(ROOT, 'server', 'site-data.js'));

/* --- 21.1 诊所信息 --- */
const pubClinic = await guest.get('/api/public/clinic');
const clinic = pubClinic.json && pubClinic.json.clinic;

check('GET /api/public/clinic 免登录 200，含电话 / 地址 / 营业时间',
  pubClinic.status === 200 && !!clinic && !!clinic.phone.display && !!clinic.address.full && !!clinic.hours.caption,
  pubClinic.text.slice(0, 160));

check('诊所信息与 data.js 同源（服务端没有第二份诊所数据）',
  !!clinic &&
  clinic.phone.display === siteData.clinic.phone.display &&
  clinic.phone.tel === siteData.clinic.phone.tel &&
  clinic.address.full === (siteData.clinic.address.city + ' ' + siteData.clinic.address.line1) &&
  clinic.hours.caption === siteData.clinic.hours.caption &&
  clinic.demo_notice === siteData.clinic.demoNotice,
  JSON.stringify({ api: clinic && clinic.phone, data: siteData.clinic.phone }));

check('营业时间 7 天，today 若存在则必在 days[] 内且时间一致',
  !!clinic && clinic.hours.days.length === 7 &&
  (!clinic.hours.today || clinic.hours.days.some(d =>
    d.weekday === clinic.hours.today.weekday &&
    d.open === clinic.hours.today.open &&
    d.close === clinic.hours.today.close)),
  JSON.stringify(clinic && clinic.hours.today));

check('公开接口不写会话 cookie（未登录访问也不产生会话）',
  pubClinic.setCookie.length === 0, pubClinic.setCookie.join(' | '));

/* --- 21.2 医师公开信息 --- */
const pubDoctors = await guest.get('/api/public/doctors');
const docList = (pubDoctors.json && pubDoctors.json.doctors) || [];

check('GET /api/public/doctors 返回 4 位医师，total 与数组长度一致',
  pubDoctors.status === 200 && docList.length === 4 && pubDoctors.json.total === 4,
  'status=' + pubDoctors.status + ' len=' + docList.length);

check('医师字段齐全：姓名 / 科室 / 职称 / 擅长 / 简介 / 标签',
  docList.every(d => d.name && d.dept && d.title && d.intro && d.short_intro && Array.isArray(d.tags) && d.tags.length > 0),
  JSON.stringify(docList.map(d => d.name + '/' + d.title)));

check('医师不返回执业证号与邮箱（响应里没有 license / email 字段）',
  !/"license"/.test(pubDoctors.text) && !/"email"/.test(pubDoctors.text),
  pubDoctors.text.slice(0, 200));

check('医师公开信息与 data.js 同源（id / 姓名 / 科室顺序一致）',
  JSON.stringify(docList.map(d => d.id + '|' + d.name + '|' + d.dept)) ===
  JSON.stringify(siteData.doctors.map(d => d.id + '|' + d.name + '|' + d.dept)),
  JSON.stringify(docList.map(d => d.id)));

/* --- 21.3 诊疗项目 --- */
const pubServices = await guest.get('/api/public/services');
const svcList = (pubServices.json && pubServices.json.services) || [];

check('GET /api/public/services 返回 8 个项目，每个都有名称 / 简介 / 价格文本',
  pubServices.status === 200 && svcList.length === 8 &&
  svcList.every(s => s.id && s.label && s.desc && s.price_text && s.price_note),
  'len=' + svcList.length + ' 缺简介=' +
    svcList.filter(s => !s.desc).map(s => s.id).join(','));

check('价格文本由 pricing.js 派生（洗牙 = 「¥280.00 起」，没有第二份数字）',
  (svcList.find(s => s.id === 'cleaning') || {}).price_text === '¥280.00 起' &&
  (svcList.find(s => s.id === 'implant') || {}).price_text === '¥6,000.00 – ¥15,000.00 / 颗',
  JSON.stringify(svcList.map(s => s.id + '=' + s.price_text)));

check('项目不下发 amount_cents（金额口径只留在服务端，前端不参与计价）',
  !/amount_cents/.test(pubServices.text), pubServices.text.slice(0, 160));

/* --- 21.4 接口面与限流 --- */
const pubUnknown = await guest.get('/api/public/nothing');
check('公开接口只有 3 个：未知路径返回 404 JSON，不落到静态页',
  pubUnknown.status === 404 && !!pubUnknown.json,
  'status=' + pubUnknown.status + ' body=' + pubUnknown.text.slice(0, 80));

check('限流配额按 60 次/分钟下发（X-RateLimit-Limit 响应头）',
  pubClinic.headers.get('x-ratelimit-limit') === '60',
  'header=' + pubClinic.headers.get('x-ratelimit-limit'));

/* 用一个「配额只有 5」的独立进程验证 429：
   不能在主服务上真发 61 次 —— 会把后面用例的配额吃光，
   而且窗口边界不可控，断言会忽红忽绿。 */
const RL_PORT = PORT + 4;
const RL_DB = path.join(TMP_DIR, 'test-rate.db');
for (const f of [RL_DB, RL_DB + '-wal', RL_DB + '-shm']) {
  try { fs.unlinkSync(f); } catch {}
}
const rlLog = fs.createWriteStream(path.join(TMP_DIR, 'public-rate-server.log'), { flags: 'w' });
const rlServer = spawn(process.execPath, [path.join(ROOT, 'server', 'app.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(RL_PORT),
    DB_FILE: RL_DB,
    SESSION_SECRET: 'test-only-secret-0123456789abcdef',
    NODE_ENV: 'test',
    PUBLIC_RATE_MAX: '5'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
rlServer.stdout.pipe(rlLog);
rlServer.stderr.pipe(rlLog);

let rlUp = false;
for (let i = 0; i < 80; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${RL_PORT}/api/health`);
    if (r.ok) { rlUp = true; break; }
  } catch {}
  await sleep(200);
}

const rlCodes = [];
let rlLimitBody = null;
let rlRetryAfter = null;
if (rlUp) {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`http://127.0.0.1:${RL_PORT}/api/public/clinic`);
    rlCodes.push(r.status);
    if (r.status === 429) {
      rlRetryAfter = r.headers.get('retry-after');
      rlLimitBody = await r.json();
    }
  }
}

check('限流：配额 5 时前 5 次 200、第 6 次 429',
  rlUp && rlCodes.length === 6 && rlCodes.slice(0, 5).every(c => c === 200) && rlCodes[5] === 429,
  'codes=' + rlCodes.join(',') + (rlUp ? '' : '（服务未起来）'));

check('429 响应带 Retry-After 与 code=RATE_LIMITED，前端可据此提示',
  !!rlLimitBody && rlLimitBody.code === 'RATE_LIMITED' &&
  Number(rlRetryAfter) > 0 && !!rlLimitBody.error,
  JSON.stringify({ retry_after: rlRetryAfter, body: rlLimitBody }));

rlServer.kill();
await sleep(300);
rlLog.end();
for (const f of [RL_DB, RL_DB + '-wal', RL_DB + '-shm']) {
  try { fs.unlinkSync(f); } catch {}
}

/* =======================================================
   22. Bearer token 通道（第八期：小程序认证）
   -------------------------------------------------------
   这一组只问两个问题：
     ① 同一套业务接口换一种凭证，还认不认？
     ② 凭证被改过 / 过期 / 用错密钥签，是不是一定不认？

   刻意不另开 /api/mp/* 这类「小程序专用接口」：
   接口一分叉，权限逻辑就会分叉，最后两边判断不一致。
   小程序调的就是 Web 调的那几个 URL，只是把 cookie 换成了 Bearer。

   密钥口径（测试端自己算，不读服务端内存）：
     SESSION_SECRET 固定 → HMAC-SHA256(session, 'lsd/jwt/v1') → 派生密钥。
     服务端没配 JWT_SECRET 时用的就是它，所以测试可以自己签出
     「过期」和「用错密钥」的 token 来做反向验证。
   ======================================================= */
GROUP = '22. Bearer 通道：小程序认证与预约';

const jwtLib = requireCjs('jsonwebtoken');
const HS = 'HS256';
const SESSION_SECRET = 'test-only-secret-0123456789abcdef';
const DERIVED = crypto.createHmac('sha256', SESSION_SECRET).update('lsd/jwt/v1').digest('hex');

function authHeader(token) {
  return { authorization: 'Bearer ' + token };
}
async function rawFetch(url, init) {
  const r = await fetch(BASE + url, init || {});
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, setCookie: r.headers.getSetCookie ? r.headers.getSetCookie() : [] };
}

/* --- 22.1 用 token 走完「查时段 → 下单 → 列表 → 取消」（全程不带 cookie） --- */
const TOKEN_PHONE = '13911110009';
await guest.post('/api/register', { name: '令牌病人', phone: TOKEN_PHONE, password: 'Test@1234' });

const tkLogin = await rawFetch('/api/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ account: TOKEN_PHONE, password: 'Test@1234' })
});
const token = tkLogin.json && tkLogin.json.token;

check('登录响应同时给出 token / token_type / expires_in（cookie 仍照常下发）',
  tkLogin.status === 200 && typeof token === 'string' && token.split('.').length === 3 &&
  tkLogin.json.token_type === 'Bearer' && tkLogin.json.expires_in === 7200 &&
  tkLogin.setCookie.some((c) => c.startsWith('lsd.sid=')),
  'status=' + tkLogin.status + ' keys=' + Object.keys(tkLogin.json || {}).join(',') +
  ' cookie=' + tkLogin.setCookie.length);

const parts = String(token || '').split('.');
let tokenPayload = null;
try { tokenPayload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch {}

check('payload 只有 id / role（外加 JWT 标准声明 iat / exp / iss）',
  !!tokenPayload && JSON.stringify(Object.keys(tokenPayload).sort()) === JSON.stringify(['exp', 'iat', 'id', 'iss', 'role']),
  JSON.stringify(tokenPayload));
check('payload 里没有姓名 / 手机号 / 密码哈希',
  !!tokenPayload && !/name|phone|email|password|hash/i.test(JSON.stringify(tokenPayload)),
  JSON.stringify(tokenPayload));
check('有效期 = 7200 秒（2 小时），与 Web 会话 maxAge 一致',
  !!tokenPayload && tokenPayload.exp - tokenPayload.iat === 7200,
  tokenPayload ? String(tokenPayload.exp - tokenPayload.iat) : 'null');
check('token 里没有 bcrypt 哈希串', !/\$2[aby]\$/.test(String(token)), String(token).slice(0, 40));

const meBearer = await rawFetch('/api/me', { headers: authHeader(token) });
check('GET /api/me 认 Bearer：返回同一身份，auth=bearer',
  meBearer.status === 200 && meBearer.json.user && meBearer.json.user.phone === TOKEN_PHONE &&
  meBearer.json.auth === 'bearer',
  meBearer.text.slice(0, 160));

/* 公开医师清单要带 booking_id：小程序用 data.js 的 slug 展示，
   但拉排班必须传数据库 id。这一步在服务端算好，前端不用自己拼映射。 */
const pubDocs2 = await rawFetch('/api/public/doctors');
const pubImplant = ((pubDocs2.json && pubDocs2.json.doctors) || []).find((d) => d.id === 'liu-implant');
check('公开医师带 booking_id（整数，可直接用于 /api/schedules）',
  !!pubImplant && Number.isInteger(pubImplant.booking_id) && pubImplant.booking_id > 0,
  JSON.stringify(pubImplant && { id: pubImplant.id, booking_id: pubImplant.booking_id }));

const bookDate = ymd(4);
const tkSched = await rawFetch(`/api/schedules?doctor_id=${pubImplant.booking_id}&date=${bookDate}`, { headers: authHeader(token) });
const tkFree = ((tkSched.json && tkSched.json.slots) || []).filter((s) => s.open && !s.taken);
check('带 token 查可约时段 → 200（病人接口走 Bearer 通道）',
  tkSched.status === 200 && tkFree.length > 0,
  'status=' + tkSched.status + ' free=' + tkFree.length);

const tkCreate = await rawFetch('/api/appointments', {
  method: 'POST',
  headers: { ...authHeader(token), 'Content-Type': 'application/json' },
  body: JSON.stringify({ schedule_id: tkFree[0].id, service: 'cleaning', note: '小程序 Bearer 用例' })
});
const tkApptId = tkCreate.json && tkCreate.json.appointment && tkCreate.json.appointment.id;
check('带 token 提交预约 → 201，预约项目落库',
  tkCreate.status === 201 && !!tkApptId && tkCreate.json.appointment.service === 'cleaning',
  tkCreate.text.slice(0, 200));

const tkList = await rawFetch('/api/patient/appointments', { headers: authHeader(token) });
check('带 token 拉我的预约 → 200，且能看到刚提交的那条',
  tkList.status === 200 && ((tkList.json && tkList.json.appointments) || []).some((a) => a.id === tkApptId),
  'status=' + tkList.status);

const tkCancel = await rawFetch(`/api/appointments/${tkApptId}/cancel`, { method: 'POST', headers: authHeader(token) });
check('带 token 取消预约 → 200，状态改为 cancelled',
  tkCancel.status === 200 && tkCancel.json.status === 'cancelled',
  tkCancel.text.slice(0, 160));

/* --- 22.2 角色：token 只是凭证，角色仍然回库查 --- */
const tkDoctorList = await rawFetch('/api/doctor/appointments', { headers: authHeader(token) });
check('病人 token 调医生接口 → 403（requireRole 仍然生效）',
  tkDoctorList.status === 403, 'status=' + tkDoctorList.status + ' ' + tkDoctorList.text.slice(0, 100));

const tkAdmin = await rawFetch('/api/admin/users', { headers: authHeader(token) });
check('病人 token 调管理员接口 → 403', tkAdmin.status === 403, 'status=' + tkAdmin.status);

/* --- 22.3 伪造与过期：三种「不认」 --- */
const tamperedPayload = Buffer.from(JSON.stringify({ ...tokenPayload, role: 'doctor' })).toString('base64url');
const tampered = parts[0] + '.' + tamperedPayload + '.' + parts[2];
const tamperRes = await rawFetch('/api/doctor/appointments', { headers: authHeader(tampered) });
check('把 payload 里的 role 改成 doctor（保留原签名）→ 401 TOKEN_INVALID',
  tamperRes.status === 401 && tamperRes.json.code === 'TOKEN_INVALID',
  'status=' + tamperRes.status + ' ' + tamperRes.text.slice(0, 120));

const tamperRole = await rawFetch('/api/patient/appointments', { headers: authHeader(tampered) });
check('篡改后的 token 连病人接口也进不去（不是只挡了医生接口）',
  tamperRole.status === 401, 'status=' + tamperRole.status);

const wrongKey = jwtLib.sign({ id: tokenPayload.id, role: 'patient' }, 'z'.repeat(48), { algorithm: HS, expiresIn: 3600 });
const wrongKeyRes = await rawFetch('/api/patient/appointments', { headers: authHeader(wrongKey) });
check('用别的密钥签出来的 token → 401 TOKEN_INVALID（签名不是摆设）',
  wrongKeyRes.status === 401 && wrongKeyRes.json.code === 'TOKEN_INVALID',
  'status=' + wrongKeyRes.status + ' ' + wrongKeyRes.text.slice(0, 120));

const rawSessionSigned = jwtLib.sign({ id: tokenPayload.id, role: 'patient' }, SESSION_SECRET, { algorithm: HS, expiresIn: 3600 });
const rawSessionRes = await rawFetch('/api/patient/appointments', { headers: authHeader(rawSessionSigned) });
check('直接用会话密钥签（而不是派生密钥）→ 401（证明真的走了派生，没有复用会话密钥）',
  rawSessionRes.status === 401, 'status=' + rawSessionRes.status);

const expired = jwtLib.sign({ id: tokenPayload.id, role: 'patient' }, DERIVED, { algorithm: HS, expiresIn: -10 });
const expiredRes = await rawFetch('/api/patient/appointments', { headers: authHeader(expired) });
check('过期 token → 401 TOKEN_EXPIRED（前端据此清 token 跳登录）',
  expiredRes.status === 401 && expiredRes.json.code === 'TOKEN_EXPIRED',
  'status=' + expiredRes.status + ' ' + expiredRes.text.slice(0, 120));

const noBearer = await rawFetch('/api/patient/appointments', { headers: { authorization: token } });
check('Authorization 头缺 Bearer 前缀 → 401 BAD_AUTH_HEADER（不当作「没带凭证」）',
  noBearer.status === 401 && noBearer.json.code === 'BAD_AUTH_HEADER',
  'status=' + noBearer.status + ' ' + noBearer.text.slice(0, 120));

const emptyBearer = await rawFetch('/api/patient/appointments', { headers: { authorization: 'Bearer ' } });
check('Bearer 后面为空 → 401（不会退化成匿名）',
  emptyBearer.status === 401, 'status=' + emptyBearer.status);

/* --- 22.4 有 cookie 也不许「坏 token 静默通过」 --- */
const cookieOwner = makeClient();
await cookieOwner.post('/api/login', { account: '13911110001', password: 'Test@1234' });

const cookieOnly = await rawFetch('/api/patient/appointments', { headers: { Cookie: cookieOwner.cookie } });
check('对照组：只带 cookie 仍然 200（Web 通道没被改坏）',
  cookieOnly.status === 200, 'status=' + cookieOnly.status);

const cookiePlusBadToken = await rawFetch('/api/patient/appointments', {
  headers: { Cookie: cookieOwner.cookie, authorization: 'Bearer ' + tampered }
});
check('好 cookie + 坏 Bearer → 401（出现 Authorization 就只认它，不回落 cookie）',
  cookiePlusBadToken.status === 401 && cookiePlusBadToken.json.code === 'TOKEN_INVALID',
  'status=' + cookiePlusBadToken.status + ' ' + cookiePlusBadToken.text.slice(0, 120));

check('Bearer 请求不会被写会话 cookie（无状态通道不产生会话）',
  meBearer.setCookie.length === 0, meBearer.setCookie.join(' | '));

/* --- 22.4.1 平台网关注入的第三方 Bearer 不许误伤 cookie ---
   托管平台（WorkBuddy 应用托管）会在反代层给每个请求塞一条自己的
   `Authorization: Bearer <平台 JWT>`（iss=cloudstudio.net），并覆盖客户端带的那条。
   它签不出我们的密钥，验签必然失败；如果不按签发方区分，结果是
   「线上所有登录态接口都 401」。这里固化三条边界：
     · 外来 token 单独出现 → 当匿名（200 + null），不是 401
     · 外来 token + 有效 cookie → 回落 cookie，照常 200
     · 自己的坏 token + 有效 cookie → 仍然 401（上一组那条不许被放宽） */
const foreignToken = jwtLib.sign({ iss: 'cloudstudio.net', user_id: '999', region: 'bj10' },
  'platform-gateway-signed', { algorithm: HS, expiresIn: 3600 });

const foreignMe = await rawFetch('/api/me', { headers: authHeader(foreignToken) });
check('平台注入的第三方 Bearer 被忽略：/api/me → 200 + user:null（不是 401）',
  foreignMe.status === 200 && foreignMe.json.user === null,
  'status=' + foreignMe.status + ' ' + foreignMe.text.slice(0, 120));

const foreignPlusCookie = await rawFetch('/api/patient/appointments', {
  headers: { Cookie: cookieOwner.cookie, authorization: 'Bearer ' + foreignToken }
});
check('第三方 Bearer + 有效 cookie → 200（回落 cookie，线上登录态不被网关打死）',
  foreignPlusCookie.status === 200,
  'status=' + foreignPlusCookie.status + ' ' + foreignPlusCookie.text.slice(0, 120));

/* --- 22.5 停用账号：token 还有 2 小时也不管用（回库查 status） --- */
const w7 = new Database(DB_FILE);
w7.prepare("UPDATE users SET status = 'disabled' WHERE phone = ?").run(TOKEN_PHONE);
const disabledRes = await rawFetch('/api/patient/appointments', { headers: authHeader(token) });
check('账号被停用后，未过期的 token 立刻 403（JWT 无状态，靠回库校验兜住）',
  disabledRes.status === 403 && disabledRes.json.status === 'disabled',
  'status=' + disabledRes.status + ' ' + disabledRes.text.slice(0, 120));

w7.prepare("UPDATE users SET status = 'active' WHERE phone = ?").run(TOKEN_PHONE);
const restoredRes = await rawFetch('/api/patient/appointments', { headers: authHeader(token) });
check('恢复账号后同一个 token 又能用（没有误伤正常路径）',
  restoredRes.status === 200, 'status=' + restoredRes.status);
w7.close();

/* --- 22.6 启动期密钥策略：不许有默认值 --- */
const BOOT_DB = path.join(TMP_DIR, 'test-boot.db');
for (const f of [BOOT_DB, BOOT_DB + '-wal', BOOT_DB + '-shm']) {
  try { fs.unlinkSync(f); } catch {}
}

function bootForFailure(extraEnv) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'server', 'app.js')], {
      cwd: ROOT,
      env: {
        ...baseEnv,
        PORT: String(PORT + 5),
        DB_FILE: BOOT_DB,
        SESSION_SECRET: SESSION_SECRET,
        NODE_ENV: 'test',
        ...extraEnv
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (b) => { out += String(b); });
    p.stderr.on('data', (b) => { err += String(b); });
    const timer = setTimeout(() => p.kill(), 8000);
    p.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, err }); });
  });
}

const shortJwt = await bootForFailure({ JWT_SECRET: 'too-short' });
check('JWT_SECRET 少于 32 字符 → 拒绝启动（退出码 1，不自动降级去派生）',
  shortJwt.code === 1 && /JWT_SECRET 太短/.test(shortJwt.err),
  'code=' + shortJwt.code + ' stderr=' + shortJwt.err.trim().split('\n').pop());

const missingJwt = await bootForFailure({ JWT_REQUIRE_ENV: '1' });
check('JWT_REQUIRE_ENV=1 却没配 JWT_SECRET → 拒绝启动（严格模式不接受派生）',
  missingJwt.code === 1 && /没有配置 JWT_SECRET/.test(missingJwt.err),
  'code=' + missingJwt.code + ' stderr=' + missingJwt.err.trim().split('\n').pop());

for (const f of [BOOT_DB, BOOT_DB + '-wal', BOOT_DB + '-shm']) {
  try { fs.unlinkSync(f); } catch {}
}

/* 正面用例：显式配置 JWT_SECRET 时，密钥来源必须是它 ——
   派生密钥签出来的 token 在这台服务上应当无效。
   （这也是「换来换去到底用的哪把钥匙」唯一能自证的方式。） */
const JWT_PORT = PORT + 5;
const JWT_DB = path.join(TMP_DIR, 'test-jwt.db');
for (const f of [JWT_DB, JWT_DB + '-wal', JWT_DB + '-shm']) {
  try { fs.unlinkSync(f); } catch {}
}
const DIRECT_SECRET = 'direct-jwt-secret-0123456789abcdefghij';
const jwtLog = fs.createWriteStream(path.join(TMP_DIR, 'jwt-server.log'), { flags: 'w' });
const jwtServer = spawn(process.execPath, [path.join(ROOT, 'server', 'app.js')], {
  cwd: ROOT,
  env: {
    ...baseEnv, PORT: String(JWT_PORT), DB_FILE: JWT_DB,
    SESSION_SECRET: SESSION_SECRET, JWT_SECRET: DIRECT_SECRET, NODE_ENV: 'test'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
jwtServer.stdout.pipe(jwtLog);
jwtServer.stderr.pipe(jwtLog);

let jwtUp = false;
for (let i = 0; i < 80; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${JWT_PORT}/api/health`);
    if (r.ok) { jwtUp = true; break; }
  } catch {}
  await sleep(200);
}

let jwtToken = null;
if (jwtUp) {
  const r = await fetch(`http://127.0.0.1:${JWT_PORT}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'admin@demo.local', password: 'Demo@1234' })
  });
  const body = await r.json().catch(() => null);
  jwtToken = body && body.token;
}
check('配了 JWT_SECRET 时服务正常启动，并签发 token', jwtUp && !!jwtToken, jwtUp ? '' : '服务未起来');

let directVerifyOk = false;
try {
  const p = jwtLib.verify(jwtToken, DIRECT_SECRET, { algorithms: [HS] });
  directVerifyOk = Number.isInteger(p.id);
} catch {}
check('下发的 token 能用 JWT_SECRET 验签（密钥来源 = 环境变量，不是派生）',
  directVerifyOk, '');

let derivedOnDirect = 0;
if (jwtUp) {
  /* 未过期、但用「派生密钥」签：如果这台服务认了它，说明密钥来源判断写成了一团 */
  const derivedFresh = jwtLib.sign({ id: 1, role: 'admin' }, DERIVED, { algorithm: HS, expiresIn: 3600 });
  const r = await fetch(`http://127.0.0.1:${JWT_PORT}/api/admin/users`, { headers: authHeader(derivedFresh) });
  derivedOnDirect = r.status;
}
check('派生密钥签的 token 在这台服务上 401（两把钥匙不会互相认）',
  jwtUp && derivedOnDirect === 401, 'status=' + derivedOnDirect);

jwtServer.kill();
await sleep(300);
jwtLog.end();
for (const f of [JWT_DB, JWT_DB + '-wal', JWT_DB + '-shm']) {
  try { fs.unlinkSync(f); } catch {}
}

/* ---------- 收尾 ---------- */
db.close();
server.kill();
await sleep(300);
logStream.end();
for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) {
  try { fs.unlinkSync(f); } catch {}
}

/* ---------- 输出 ---------- */
let pass = 0;
const groups = [];
for (const r of results) {
  if (r.pass) pass++;
  if (!groups.length || groups[groups.length - 1].name !== r.group) groups.push({ name: r.group, items: [] });
  groups[groups.length - 1].items.push(r);
}

console.log('\n===== 接口回归明细 =====');
for (const r of results) {
  console.log((r.pass ? '✅ PASS' : '❌ FAIL') + '  ' + r.name + (r.pass ? '' : '\n        → ' + r.detail));
}

console.log('\n===== 按组汇总 =====');
for (const g of groups) {
  const ok = g.items.filter(i => i.pass).length;
  console.log(`${g.name}  ${ok}/${g.items.length}  ${ok === g.items.length ? '✅' : '❌'}`);
}
console.log(`\n合计 ${pass}/${results.length} 条断言通过，共 ${groups.length} 组`);

process.exit(pass === results.length ? 0 : 2);
