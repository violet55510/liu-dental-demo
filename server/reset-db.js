/* =========================================================
   server/reset-db.js — 重置演示数据库
   ---------------------------------------------------------
   用法：npm run reset-db（或 node server/reset-db.js）
   注意：会清空 users / schedules / appointments 里所有数据，
        包括自己注册的账号与预约。演示站可以这样，真实系统不行。

   为什么不用「删掉 data/app.db 再重建」：
   Windows 上只要还有任何进程（编辑器索引、杀毒扫描、上一次没退干净的
   子进程）持有这个文件的句柄，fs.unlinkSync 就会抛 EBUSY。
   上一个版本就是因此经常失败，报错还很不直观。

   现在改成用 SQL 把表 DROP 掉再让 db.js 重建：
   - 不需要删文件，绕开句柄问题
   - 表结构与种子逻辑仍然只有 db.js 一份（不在这里复制建表语句）
   - 可以连续跑多次，每次结果一致
   ========================================================= */
'use strict';

const path = require('node:path');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
/* 与 db.js 同一套优先级：DB_PATH（部署） → DB_FILE（回归脚本） → data/app.db。
   重置的是「当前环境在用的那个库」，不是写死的某一个。 */
const DB_FILE = path.resolve(ROOT, process.env.DB_PATH || process.env.DB_FILE || path.join('data', 'app.db'));

/* 第一步：用一条独立连接把表清掉。
   顺序按外键依赖倒着来（appointments → schedules → users）。
   DROP TABLE 会同时删掉该表的索引，所以 db.js 里的 CREATE INDEX 会重新建。 */
function dropAll() {
  const conn = new Database(DB_FILE);

  conn.pragma('foreign_keys = OFF');
  const run = conn.transaction(() => {
    conn.exec(`
      DROP TABLE IF EXISTS appointments;
      DROP TABLE IF EXISTS schedules;
      DROP TABLE IF EXISTS users;
    `);
  });
  run();
  conn.pragma('foreign_keys = ON');

  const left = conn.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  ).all().map((r) => r.name);
  conn.close();
  return left;
}

const left = dropAll();
if (left.length) {
  console.error('重建前仍有残留表：' + left.join(', ') + '（预期为空）');
  process.exit(1);
}

/* 第二步：重新 require db.js。它会建表、写种子账号、生成排班。
   必须放在 drop 之后 require：db.js 在模块顶层就执行建表与播种。 */
const { seededNow, seededSchedules, db, stmts } = require('./db');

const counts = {
  users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
  doctors: stmts.listDoctors.all().length,
  schedules: db.prepare('SELECT COUNT(*) AS n FROM schedules').get().n,
  appointments: db.prepare('SELECT COUNT(*) AS n FROM appointments').get().n
};

console.log('已重置 ' + path.basename(DB_FILE));
console.log('  种子账号 ' + counts.users + ' 个（新增 ' + (seededNow.length ? seededNow.join(', ') : '无') + '）');
console.log('  在职医生 ' + counts.doctors + ' 位');
console.log('  排班时段 ' + counts.schedules + ' 条（本次新增 ' + seededSchedules + '）');
console.log('  预约记录 ' + counts.appointments + ' 条');
console.log('所有账号初始密码：Demo@1234（仅演示用）');
