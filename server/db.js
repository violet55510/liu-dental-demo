/* =========================================================
   server/db.js — SQLite 连接、建表与种子数据
   ---------------------------------------------------------
   - 首次运行自动建 data/app.db 并写入表结构
   - 种子账号只在「该邮箱/手机号不存在」时插入，重复启动不会重复创建
   - 所有 SQL 走 better-sqlite3 的 prepare()，参数化绑定，不做字符串拼接

   第二期新增两张表：schedules（医生可约时段）、appointments（预约）。
   防重复预订靠的是数据库层的「部分唯一索引」，不是应用层的 if 判断：
     CREATE UNIQUE INDEX ux_appt_active_slot
       ON appointments (schedule_id) WHERE status NOT IN ('cancelled', 'no_show');
   一个时段最多只能有一条「占着号源」的预约，两个并发请求里必然有一个
   撞 SQLITE_CONSTRAINT，应用层把约束错误翻译成 409 即可。

   为什么 no_show 也要排除（第四期修正）：
   第二期的条件是 status <> 'cancelled'，于是被标「未到诊」的时段永久占号——
   病人约不了、医生也改不回来，是个死胡同。no_show 的语义是「这次没来」，
   不是「这个时段被用掉了」，所以它必须释放号源；同时补 reopen 接口
   让医生能把误标的记录改回 confirmed。
   ========================================================= */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { hashPasswordSync } = require('./password');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

/* 数据库位置（按优先级）：
     ① DB_PATH  —— 部署用（render.yaml 里显式设为 data/app.db；换挂载盘就改这里）
     ② DB_FILE  —— 回归脚本用（api-test / e2e / mock 各自指临时库）
     ③ 默认     —— data/app.db
   相对路径一律按仓库根解析，绝对路径原样使用。
   目录不存在会就地创建：云端 data/ 不进 git（.gitignore 排除），
   首次启动时这个目录其实不存在，靠下一行 mkdir 建出来。 */
const DB_FILE = path.resolve(ROOT, process.env.DB_PATH || process.env.DB_FILE || path.join('data', 'app.db'));

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
/* 并发写入时不要立刻抛 SQLITE_BUSY，先等一会儿（毫秒） */
db.pragma('busy_timeout = 5000');

/* ---------- 0. 空库自举（云端部署必需） ----------
   Render 免费层没有持久磁盘：重新部署或冷启动后容器文件系统是干净的，
   data/app.db 不存在。本文件下面全部语句都是可重复执行的
   （CREATE ... IF NOT EXISTS；种子按邮箱 / 排班条数判重），
   所以「文件不存在」和「文件在但表是空的」两种情况，都会在同一次启动里
   走完「建表 → 写种子账号 → 生成未来 14 天排班」。

   ★ 不要在这里再抄一份建表 / 播种逻辑 ★
   重置库的 reset-db.js 也是「DROP 掉表 → 重新 require 本文件」，
   种子与结构始终只有这一份定义。 */

/* ---------- 1. 表结构 ---------- */
/* role 决定用哪个登录标识：
     patient  → phone
     doctor   → email
     admin    → email
   表级 CHECK 把它焊死在数据库层，代码写错了也插不进去。
   status 三态：pending 待审核 / active 正常 / disabled 停用。          */
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    role          TEXT    NOT NULL CHECK (role IN ('patient', 'doctor', 'admin')),
    phone         TEXT    UNIQUE,
    email         TEXT    UNIQUE,
    password_hash TEXT    NOT NULL,
    name          TEXT    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'active', 'disabled')),
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    CHECK (
      (role = 'patient'               AND phone IS NOT NULL AND email IS NULL)
      OR
      (role IN ('doctor', 'admin')    AND email IS NOT NULL AND phone IS NULL)
    )
  );

  CREATE INDEX IF NOT EXISTS idx_users_role   ON users (role);
  CREATE INDEX IF NOT EXISTS idx_users_status ON users (status);
`);

/* ---------- 1.1 轻量迁移：给老库补 dept 列 ---------- */
/* 第二期要按科室区分四位同名「刘医生」，所以给 users 加一列 dept。
   SQLite 没有 ADD COLUMN IF NOT EXISTS，只能先查 PRAGMA 再决定加不加。
   这个写法可以重复执行——迁移过一次之后再跑就什么都不做。 */
(function migrateDept() {
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('dept')) {
    db.exec('ALTER TABLE users ADD COLUMN dept TEXT');
  }
})();

/* ---------- 1.2 排班与预约 ---------- */
/* 第三期把状态机补完：pending → confirmed → completed，
   以及 confirmed → no_show（病人没来）。共五个状态：
     pending    待确认  —— 病人提交后
     confirmed  已确认  —— 医生确认
     completed  已完成  —— 医生完成（终态）
     no_show    未到诊  —— 医生标记（终态）
     cancelled  已取消  —— 病人取消（终态）
   注意这里只声明「合法取值」，具体谁能从哪个状态转到哪个状态在路由里判断；
   CHECK 负责兜住「写进一个不存在的状态」这种更底层的错。 */
const APPT_STATUS_IN = "('pending', 'confirmed', 'cancelled', 'completed', 'no_show')";

db.exec(`
  CREATE TABLE IF NOT EXISTS schedules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    doctor_id   INTEGER NOT NULL REFERENCES users(id),
    date        TEXT    NOT NULL,                 -- YYYY-MM-DD
    start_time  TEXT    NOT NULL,                 -- HH:MM
    end_time    TEXT    NOT NULL,                 -- HH:MM
    status      TEXT    NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'closed')),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    CHECK (start_time GLOB '[0-9][0-9]:[0-9][0-9]'),
    CHECK (start_time < end_time),
    UNIQUE (doctor_id, date, start_time)
  );

  CREATE INDEX IF NOT EXISTS idx_schedules_lookup
    ON schedules (doctor_id, date, status);

  CREATE TABLE IF NOT EXISTS appointments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id   INTEGER NOT NULL REFERENCES users(id),
    doctor_id    INTEGER NOT NULL REFERENCES users(id),
    schedule_id  INTEGER NOT NULL REFERENCES schedules(id),
    /* service 是服务项目 id（implant / cleaning …），第五期加。
       第五期之前预约的项目只拼在 note 里（"项目：洗牙｜…"），
       那是给人看的字符串，不能作为计费依据，所以单独补一列。
       允许 NULL：老预约没有这一项，它们的订单会被明确拒绝，
       而不是被"猜"一个价格出来。 */
    service      TEXT,
    status       TEXT    NOT NULL DEFAULT 'pending'
                         CHECK (status IN ${APPT_STATUS_IN}),
    note         TEXT,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    cancelled_at TEXT,
    /* 取消必须有时间戳，没取消就不许有 —— 防止出现「status=cancelled 但 cancelled_at 为 null」
       这种让 24 小时规则和统计都对不上的脏数据 */
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
  );

  /* ★ 防双重预订的唯一防线 ★
     部分索引：只对「占着号源」的预约生效。
     cancelled（病人取消）和 no_show（没来）都不占用时段，
     所以这两类行不进索引，时段自动重新可约。
     同一 schedule_id 最多只能存在一条 pending / confirmed / completed 的记录。 */
  CREATE UNIQUE INDEX IF NOT EXISTS ux_appt_active_slot
    ON appointments (schedule_id) WHERE status NOT IN ('cancelled', 'no_show');

  CREATE INDEX IF NOT EXISTS idx_appt_patient ON appointments (patient_id, status);
  CREATE INDEX IF NOT EXISTS idx_appt_doctor  ON appointments (doctor_id, status);
`);

/* ---------- 1.3 迁移：给老库的 status CHECK 补上 no_show ---------- */
/* SQLite 不支持 ALTER TABLE 改 CHECK，只能「建新表 → 拷数据 → 删旧表 → 重建索引」。
   判定方式是读 sqlite_master 里的建表语句：没有 no_show 就需要重建。
   这段可以重复执行——迁移过一次之后 sql 里就有 no_show，直接 return。 */
(function migrateNoShow() {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'appointments'"
  ).get();
  if (!row || /no_show/.test(row.sql)) return;

  db.pragma('foreign_keys = OFF');
  const rebuild = db.transaction(() => {
    /* ★ 必须先删索引 ★
       ALTER TABLE RENAME 不会改名索引，旧索引会跟着旧表走。
       于是新表上的 CREATE UNIQUE INDEX IF NOT EXISTS 会因为「索引名已存在」被跳过，
       随后 DROP TABLE 把旧索引一起带走 —— 结果新表上一条唯一索引都没有，
       防双订静默失效。这里是第四期复查时发现的，回归里加了对应夹具。 */
    db.exec(`
      DROP INDEX IF EXISTS ux_appt_active_slot;
      DROP INDEX IF EXISTS idx_appt_patient;
      DROP INDEX IF EXISTS idx_appt_doctor;

      ALTER TABLE appointments RENAME TO appointments_legacy;

      CREATE TABLE appointments (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        patient_id   INTEGER NOT NULL REFERENCES users(id),
        doctor_id    INTEGER NOT NULL REFERENCES users(id),
        schedule_id  INTEGER NOT NULL REFERENCES schedules(id),
        service      TEXT,
        status       TEXT    NOT NULL DEFAULT 'pending'
                             CHECK (status IN ${APPT_STATUS_IN}),
        note         TEXT,
        created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
        cancelled_at TEXT,
        CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
      );

      /* 只拷"老表一定有的列"：service 是第五期才加的，老表可能没有。
         新表里它会保持 NULL —— 这正是我们想要的结果（历史预约没有项目，
         订单接口会明确拒绝，而不是猜一个价格）。 */
      INSERT INTO appointments (id, patient_id, doctor_id, schedule_id, status, note, created_at, cancelled_at)
        SELECT id, patient_id, doctor_id, schedule_id, status, note, created_at, cancelled_at
        FROM appointments_legacy;

      DROP TABLE appointments_legacy;

      CREATE UNIQUE INDEX IF NOT EXISTS ux_appt_active_slot
        ON appointments (schedule_id) WHERE status NOT IN ('cancelled', 'no_show');
      CREATE INDEX IF NOT EXISTS idx_appt_patient ON appointments (patient_id, status);
      CREATE INDEX IF NOT EXISTS idx_appt_doctor  ON appointments (doctor_id, status);
    `);
  });
  rebuild();
  db.pragma('foreign_keys = ON');
})();

/* ---------- 1.4 迁移：把防双订索引的过滤条件补上 no_show ---------- */
/* CREATE UNIQUE INDEX IF NOT EXISTS 在索引已存在时什么都不做，
   所以光改建表语句改不动老库的索引。这里读 sqlite_master 里的索引定义：
   不含 no_show 就 DROP 重建。
   放宽条件不会让已有数据冲突（原来最多一条非 cancelled，现在允许更多），
   所以重建不会失败，也不需要清数据。可以重复执行。 */
(function migrateSlotIndex() {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'ux_appt_active_slot'"
  ).get();
  if (row && /no_show/.test(row.sql)) return;   // 已是最新条件

  /* 索引存在但条件旧 → 重建；索引干脆不存在 → 直接补一条（防双订不能缺） */
  db.exec(`
    DROP INDEX IF EXISTS ux_appt_active_slot;
    CREATE UNIQUE INDEX ux_appt_active_slot
      ON appointments (schedule_id) WHERE status NOT IN ('cancelled', 'no_show');
  `);
})();

/* ---------- 1.5 迁移：给老库的 appointments 补 service 列 ---------- */
/* 第五期计费需要知道"约的是哪个项目"，而第四期之前的库里没有这一列。
   SQLite 的 ADD COLUMN 不能带 IF NOT EXISTS，所以先查 PRAGMA。
   可重复执行。 */
(function migrateService() {
  const cols = db.prepare('PRAGMA table_info(appointments)').all().map((c) => c.name);
  if (!cols.includes('service')) {
    db.exec('ALTER TABLE appointments ADD COLUMN service TEXT');
  }
})();

/* ---------- 1.6 订单表（第五期：模拟支付） ----------
   放在所有 appointments 迁移之后建，顺序有讲究：
   migrateNoShow 会 ALTER TABLE appointments RENAME TO appointments_legacy，
   而 SQLite（3.25+，legacy_alter_table 关闭时）会顺手把**其它表**里指向
   appointments 的外键改成指向 appointments_legacy。
   如果 orders 先建好，迁移后它的外键就指向一张随后被 DROP 的表，
   下次插订单会报 "no such table: main.appointments_legacy"。
   所以：先迁移，再建引用它的表。

   金额与状态约束见下面注释；一句话：整数分 + 状态与时间戳强一致。
   ⚠️ 本系统不接入真实支付通道，这里的记录只是本地演示数据。 */
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    appointment_id INTEGER NOT NULL UNIQUE REFERENCES appointments(id),
    patient_id     INTEGER NOT NULL REFERENCES users(id),
    amount_cents   INTEGER NOT NULL CHECK (amount_cents > 0),
    status         TEXT    NOT NULL DEFAULT 'unpaid'
                           CHECK (status IN ('unpaid', 'paid', 'refunded')),
    paid_at        TEXT,
    refunded_at    TEXT,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    CHECK ((status <> 'unpaid') = (paid_at IS NOT NULL)),
    CHECK ((status = 'refunded') = (refunded_at IS NOT NULL))
  );

  CREATE INDEX IF NOT EXISTS idx_orders_patient ON orders (patient_id, status);
`);

/* ---------- 2. 种子数据 ---------- */
/* 仅演示用：初始密码统一 Demo@1234，真实项目绝不可这样预置账号。 */
const SEED_PASSWORD = 'Demo@1234';

const SEED_USERS = [
  { role: 'admin',  email: 'admin@demo.local',       name: '门诊管理员', dept: null },
  { role: 'doctor', email: 'liu-implant@demo.local', name: '刘主任',     dept: '种植科' },
  { role: 'doctor', email: 'liu-ortho@demo.local',   name: '刘医生',     dept: '正畸科' },
  { role: 'doctor', email: 'liu-general@demo.local', name: '刘医生',     dept: '综合与牙周' },
  { role: 'doctor', email: 'liu-kid@demo.local',     name: '刘医生',     dept: '儿童齿科' }
];

const ROUNDS = Number(process.env.BCRYPT_ROUNDS || 10);

/* 审核与演示用的病人账号：小程序必须登录才能进「我的预约」，
   审核员不方便用自己的号注册，所以预置一个，密码同样是 Demo@1234。
   用手机号做幂等键（病人账号的 CHECK 要求 phone 非空、email 为空）。 */
const SEED_PATIENTS = [
  { phone: '13800138001', name: '张三' }
];

function seed() {
  const exists = db.prepare('SELECT 1 FROM users WHERE email = ?');
  const insert = db.prepare(`
    INSERT INTO users (role, email, password_hash, name, status, dept)
    VALUES (?, ?, ?, ?, 'active', ?)
  `);
  const setDept = db.prepare('UPDATE users SET dept = ? WHERE email = ? AND (dept IS NULL OR dept = \'\')');

  const created = [];
  const run = db.transaction(() => {
    for (const u of SEED_USERS) {
      if (!exists.get(u.email)) {
        insert.run(u.role, u.email, hashPasswordSync(SEED_PASSWORD, ROUNDS), u.name, u.dept);
        created.push(u.email);
      } else if (u.dept) {
        /* 老库里已有账号但没有科室：补上，不覆盖手工改过的值 */
        setDept.run(u.dept, u.email);
      }
    }
  });
  run();
  return created;
}

const seededNow = seed();

/* 种子病人单独一段：上面的 seed() 按 email 判重，病人账号没有 email。
   只在手机号不存在时插入，不覆盖用户自己注册/改过的账号。 */
function seedPatients() {
  const exists = db.prepare('SELECT 1 FROM users WHERE phone = ?');
  const insert = db.prepare(`
    INSERT INTO users (role, phone, password_hash, name, status)
    VALUES ('patient', ?, ?, ?, 'active')
  `);
  const created = [];
  const run = db.transaction(() => {
    for (const p of SEED_PATIENTS) {
      if (!exists.get(p.phone)) {
        insert.run(p.phone, hashPasswordSync(SEED_PASSWORD, ROUNDS), p.name);
        created.push(p.phone);
      }
    }
  });
  run();
  return created;
}

const seededPatients = seedPatients();

/* ---------- 2.1 种子排班：4 位医生 × 未来 14 天 × 每天 3–4 个时段 ---------- */
const SLOT_TEMPLATES = [
  ['09:00', '10:00'],
  ['10:30', '11:30'],
  ['14:00', '15:00'],
  ['15:30', '16:30']
];
const SEED_DAYS = 14;

function ymd(d) {
  const p = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* 只在「该医生一条排班都没有」时生成，避免每次启动重复插。
   每天 3 还是 4 个时段由 (日序 + 医生序) 决定，保证可预期、便于测试。 */
function seedSchedules() {
  const doctors = db.prepare(`
    SELECT id FROM users WHERE role = 'doctor' AND status = 'active' ORDER BY id
  `).all();

  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM schedules WHERE doctor_id = ?');
  const insert = db.prepare(`
    INSERT INTO schedules (doctor_id, date, start_time, end_time, status)
    VALUES (?, ?, ?, ?, 'open')
  `);

  let added = 0;
  const run = db.transaction(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    doctors.forEach((doc, di) => {
      if (countStmt.get(doc.id).n > 0) return;      // 已有排班就不动

      for (let day = 0; day < SEED_DAYS; day++) {
        const d = new Date(today.getTime() + day * 86400000);
        const take = 3 + ((day + di) % 2);          // 3 或 4
        for (let k = 0; k < take; k++) {
          const t = SLOT_TEMPLATES[k];
          insert.run(doc.id, ymd(d), t[0], t[1]);
          added++;
        }
      }
    });
  });
  run();
  return added;
}

const seededSchedules = seedSchedules();

/* ---------- 3. 查询封装（全部参数化） ---------- */
const stmts = {
  byPhone: db.prepare('SELECT * FROM users WHERE phone = ?'),
  byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  byId: db.prepare('SELECT * FROM users WHERE id = ?'),
  insertPatient: db.prepare(`
    INSERT INTO users (role, phone, password_hash, name, status)
    VALUES ('patient', ?, ?, ?, 'active')
  `),
  insertDoctorPending: db.prepare(`
    INSERT INTO users (role, email, password_hash, name, status)
    VALUES ('doctor', ?, ?, ?, 'pending')
  `),
  setStatus: db.prepare('UPDATE users SET status = ? WHERE id = ?'),
  listByStatus: db.prepare(`
    SELECT id, role, phone, email, name, status, created_at
    FROM users WHERE status = ? ORDER BY created_at DESC, id DESC
  `),
  countByRole: db.prepare('SELECT role, COUNT(*) AS n FROM users GROUP BY role'),

  /* 对外可见的医生清单（不含密码、不含邮箱） */
  listDoctors: db.prepare(`
    SELECT id, name, dept, email FROM users
    WHERE role = 'doctor' AND status = 'active' ORDER BY id
  `),
  doctorById: db.prepare(`
    SELECT id, name, dept, email FROM users WHERE id = ? AND role = 'doctor'
  `),

  /* 某医生某天的可约时段：LEFT JOIN「占着号源」的预约，a.id 为空即可约。
     过滤条件必须和 ux_appt_active_slot 完全一致：
     少了 no_show，就会出现「索引已放号、列表仍显示已占用」的矛盾。 */
  slotsForDoctorDate: db.prepare(`
    SELECT s.id, s.date, s.start_time, s.end_time, s.status,
           a.id AS appointment_id
    FROM schedules s
    LEFT JOIN appointments a
      ON a.schedule_id = s.id AND a.status NOT IN ('cancelled', 'no_show')
    WHERE s.doctor_id = ? AND s.date = ?
    ORDER BY s.start_time
  `),

  scheduleById: db.prepare('SELECT * FROM schedules WHERE id = ?'),

  insertAppointment: db.prepare(`
    INSERT INTO appointments (patient_id, doctor_id, schedule_id, service, status, note)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `),

  appointmentById: db.prepare(`
    SELECT a.*, s.date, s.start_time, s.end_time
    FROM appointments a JOIN schedules s ON s.id = a.schedule_id
    WHERE a.id = ?
  `),

  /* 详情用：一次带出病人、医生、时段，病人端和医生端共用。
     第五期加两样东西：
       - a.service：订单金额的取值依据（服务端价格表按它查）
       - o.*      ：订单信息，前端据此决定显示「去支付」还是「已支付」 */
  appointmentDetail: db.prepare(`
    SELECT a.id, a.patient_id, a.doctor_id, a.schedule_id, a.service, a.status, a.note,
           a.created_at, a.cancelled_at,
           s.date, s.start_time, s.end_time,
           d.name AS doctor_name, d.dept AS doctor_dept,
           p.name AS patient_name, p.phone AS patient_phone,
           o.id AS order_id, o.status AS order_status,
           o.amount_cents AS order_amount_cents, o.paid_at AS order_paid_at
    FROM appointments a
    JOIN schedules s ON s.id = a.schedule_id
    JOIN users d     ON d.id = a.doctor_id
    JOIN users p     ON p.id = a.patient_id
    LEFT JOIN orders o ON o.appointment_id = a.id
    WHERE a.id = ?
  `),

  cancelAppointment: db.prepare(`
    UPDATE appointments
    SET status = 'cancelled', cancelled_at = datetime('now')
    WHERE id = ? AND patient_id = ? AND status IN ('pending', 'confirmed')
  `),

  /* ---------- 医生端状态流转 ----------
     WHERE 里同时带 id、doctor_id 和「原状态」三件事：
       - doctor_id  → 对象级权限（SQL 层再挡一次，不只靠 JS 的 if）
       - status     → 状态机，防止「pending 直接完成」这类非法转换
     changes === 0 说明这三条里有一条不成立，调用方已经分别判过 403 / 409，
     走到这里只可能是并发下状态被别人改了。 */
  confirmAppointment: db.prepare(`
    UPDATE appointments SET status = 'confirmed'
    WHERE id = ? AND doctor_id = ? AND status = 'pending'
  `),

  completeAppointment: db.prepare(`
    UPDATE appointments SET status = 'completed'
    WHERE id = ? AND doctor_id = ? AND status = 'confirmed'
  `),

  noShowAppointment: db.prepare(`
    UPDATE appointments SET status = 'no_show'
    WHERE id = ? AND doctor_id = ? AND status = 'confirmed'
  `),

  /* 纠错用：把误标的「未到诊」改回「已确认」。
     这是全表唯一一处「终态回退」——no_show 并不真的占用号源，
     它更像一个「标记错了」的备注。如果时段已经被别人重新约走，
     这条 UPDATE 会撞 ux_appt_active_slot，路由层翻译成 409 SLOT_REBOOKED。 */
  reopenAppointment: db.prepare(`
    UPDATE appointments SET status = 'confirmed'
    WHERE id = ? AND doctor_id = ? AND status = 'no_show'
  `),

  /* 撤销「完成」：把误标的 completed 退回 confirmed。
     和 reopen 一样是纠错入口，WHERE 里仍带 doctor_id 与原状态，
     保证「只能动自己的」和「只能从 completed 退」。 */
  revertCompleteAppointment: db.prepare(`
    UPDATE appointments SET status = 'confirmed'
    WHERE id = ? AND doctor_id = ? AND status = 'completed'
  `),

  listByPatient: db.prepare(`
    SELECT a.id, a.service, a.status, a.note, a.created_at, a.cancelled_at,
           s.date, s.start_time, s.end_time,
           d.name AS doctor_name, d.dept AS doctor_dept,
           o.id AS order_id, o.status AS order_status, o.amount_cents AS order_amount_cents
    FROM appointments a
    JOIN schedules s ON s.id = a.schedule_id
    JOIN users d     ON d.id = a.doctor_id
    LEFT JOIN orders o ON o.appointment_id = a.id
    WHERE a.patient_id = ?
    ORDER BY s.date ASC, s.start_time ASC
  `),

  /* 医生端的患者预约列表。
     第六期加订单信息（只读）：医生需要知道这单收没收到钱，
     但不给任何支付操作入口 —— 收款是病人侧的动作，
     医生端点改了就是越权（订单接口只认 patient 会话）。 */
  listByDoctor: db.prepare(`
    SELECT a.id, a.status, a.note, a.created_at,
           s.date, s.start_time, s.end_time,
           p.name AS patient_name, p.phone AS patient_phone,
           o.id AS order_id, o.status AS order_status, o.amount_cents AS order_amount_cents
    FROM appointments a
    JOIN schedules s ON s.id = a.schedule_id
    JOIN users p     ON p.id = a.patient_id
    LEFT JOIN orders o ON o.appointment_id = a.id
    WHERE a.doctor_id = ?
    ORDER BY s.date ASC, s.start_time ASC
  `),

  /* 医生看自己的排班（含已被占用的） */
  schedulesByDoctorDate: db.prepare(`
    SELECT s.id, s.date, s.start_time, s.end_time, s.status,
           a.id AS appointment_id, a.status AS appointment_status,
           p.name AS patient_name
    FROM schedules s
    LEFT JOIN appointments a
      ON a.schedule_id = s.id AND a.status NOT IN ('cancelled', 'no_show')
    LEFT JOIN users p ON p.id = a.patient_id
    WHERE s.doctor_id = ? AND s.date = ?
    ORDER BY s.start_time
  `),

  /* ---------- 订单（第五期：模拟支付） ----------
     orderById / orderByAppointment 都带上预约与医生信息：
     支付页要显示"给谁、哪天、哪个项目"，这样不用再发一次详情请求。 */
  orderById: db.prepare(`
    SELECT o.*, a.service AS service, a.status AS appointment_status,
           s.date, s.start_time, s.end_time,
           d.name AS doctor_name, d.dept AS doctor_dept
    FROM orders o
    JOIN appointments a ON a.id = o.appointment_id
    JOIN schedules s    ON s.id = a.schedule_id
    JOIN users d        ON d.id = a.doctor_id
    WHERE o.id = ?
  `),

  orderByAppointment: db.prepare(`
    SELECT o.*, a.service AS service, a.status AS appointment_status,
           s.date, s.start_time, s.end_time,
           d.name AS doctor_name, d.dept AS doctor_dept
    FROM orders o
    JOIN appointments a ON a.id = o.appointment_id
    JOIN schedules s    ON s.id = a.schedule_id
    JOIN users d        ON d.id = a.doctor_id
    WHERE o.appointment_id = ?
  `),

  insertOrder: db.prepare(`
    INSERT INTO orders (appointment_id, patient_id, amount_cents)
    VALUES (?, ?, ?)
  `),

  /* 支付/退款的 UPDATE 同时带三件事：
       id          → 定位
       patient_id  → 对象级权限（SQL 层再挡一次，不只靠路由的 if）
       status      → 状态机（只有 unpaid 能付、只有 paid 能退）
     changes === 0 说明其中一条不成立，路由已分别判过 403 / 409，
     走到这里只可能是并发下状态被别人改了。 */
  markOrderPaid: db.prepare(`
    UPDATE orders SET status = 'paid', paid_at = datetime('now')
    WHERE id = ? AND patient_id = ? AND status = 'unpaid'
  `),

  markOrderRefunded: db.prepare(`
    UPDATE orders SET status = 'refunded', refunded_at = datetime('now')
    WHERE id = ? AND patient_id = ? AND status = 'paid'
  `),

  listOrdersByPatient: db.prepare(`
    SELECT o.*, a.service AS service, a.status AS appointment_status,
           s.date, s.start_time, s.end_time,
           d.name AS doctor_name, d.dept AS doctor_dept
    FROM orders o
    JOIN appointments a ON a.id = o.appointment_id
    JOIN schedules s    ON s.id = a.schedule_id
    JOIN users d        ON d.id = a.doctor_id
    WHERE o.patient_id = ?
    ORDER BY o.id DESC
  `)
};

/* 登录账号可能是手机号，也可能是邮箱：先按手机号查，再按邮箱查。 */
function findUserByAccount(account) {
  return stmts.byPhone.get(account) || stmts.byEmail.get(account) || null;
}

function findUserById(id) {
  return stmts.byId.get(id) || null;
}

module.exports = {
  db,
  DB_FILE,
  SEED_PASSWORD,
  SEED_USERS,
  SEED_PATIENTS,
  seededNow,
  seededPatients,
  seededSchedules,
  findUserByAccount,
  findUserById,
  stmts
};
