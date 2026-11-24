/* =========================================================
   scripts/race-worker.cjs — 并发抢位测试的子进程
   ---------------------------------------------------------
   故意只做「读 → 等一会儿 → 写」这种经典 TOCTOU 写法：
     1. 读：这个 slot 有没有未取消的预约
     2. 睡 delay 毫秒（把竞态窗口拉大，确保两个进程都读到「空」）
     3. 写：INSERT

   如果唯一索引真的生效，两个进程里必然一个成功、一个撞
   SQLITE_CONSTRAINT_UNIQUE。如果只有应用层 if 判断，这里会双双插入成功。

   由 scripts/concurrency-test.mjs 调用，不手动运行。
   ========================================================= */
'use strict';

const Database = require('better-sqlite3');

const [, , dbFile, slotId, patientId, doctorId, delayMs] = process.argv;

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

let db;
try {
  db = new Database(dbFile);
  db.pragma('busy_timeout = 5000');

  const id = Number(slotId);

  /* ① 读：有没有人已经占了这个 slot */
  const taken = db.prepare(
    "SELECT id FROM appointments WHERE schedule_id = ? AND status <> 'cancelled'"
  ).get(id);

  emit({ phase: 'read', seenTaken: !!taken, at: Date.now() });

  /* ② 故意等一会儿，把 TOCTOU 的窗口撑开 */
  setTimeout(() => {
    /* ③ 写：不做任何二次判断，直接插 */
    try {
      const info = db.prepare(`
        INSERT INTO appointments (patient_id, doctor_id, schedule_id, status, note)
        VALUES (?, ?, ?, 'pending', 'race worker')
      `).run(Number(patientId), Number(doctorId), id);
      emit({ phase: 'insert', ok: true, id: Number(info.lastInsertRowid) });
    } catch (err) {
      emit({
        phase: 'insert',
        ok: false,
        code: err.code,
        message: String(err.message).split('\n')[0]
      });
    } finally {
      db.close();
    }
  }, Number(delayMs) || 0);
} catch (err) {
  emit({ phase: 'fatal', message: err.message });
  if (db) { try { db.close(); } catch { /* ignore */ } }
  process.exit(1);
}
