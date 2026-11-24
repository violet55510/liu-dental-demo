/* =========================================================
   server/routes/appointments.js — 第二期：排班与预约
   ---------------------------------------------------------
   权限分两层，缺一层都不算做对：

   1) 角色层（requireRole）
      病人只能进 /patient/*、/appointments，医生只能进 /doctor/*。

   2) 对象层（资源归属）
      requireRole 只回答「你是不是病人」，回答不了「这条预约是不是你的」。
      病人 A 和病人 B 都是 patient，角色校验对两人都放行，
      所以每个涉及具体资源的接口都要再比一次 id：
        - 取消预约：WHERE id = ? AND patient_id = ?（SQL 里也带上，不只靠 if）
        - 我的预约：WHERE patient_id = req.user.id
        - 医生看患者：WHERE doctor_id = req.user.id
        - 医生看排班：WHERE doctor_id = req.user.id（doctor_id 不从 query 取）
      这一层最容易漏，也最容易被「把 id 改成别人」打穿。
   ========================================================= */
'use strict';

const express = require('express');
/* authenticate = cookie 或 Bearer 双通道（server/auth.js） */
const { authenticate, requireRole } = require('../auth');
const { stmts, db } = require('../db');
const { getService, formatCents } = require('../pricing');

const router = express.Router();

const CANCEL_WINDOW_MS = 24 * 60 * 60 * 1000;   // 开始前 24 小时内不可自助取消
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* 状态的中文标签只在这里维护一份，错误信息、详情响应都引用它 */
const STATUS_LABEL = {
  pending: '待确认',
  confirmed: '已确认',
  cancelled: '已取消',
  completed: '已完成',
  no_show: '未到诊'
};

/* 统一错误出口：带机器可读的 code，前端不用去匹配中文 */
function fail(res, status, code, message, extra) {
  return res.status(status).json(Object.assign({ error: message, code }, extra || {}));
}

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const d = new Date(s + 'T00:00:00');
  return isNaN(d.getTime()) ? null : s;
}

/* 本地时间拼出时段的开始时刻 */
function slotStartMs(date, startTime) {
  const t = new Date(date + 'T' + startTime + ':00').getTime();
  return isNaN(t) ? null : t;
}

function isUniqueViolation(err) {
  return !!err && (
    err.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    /UNIQUE constraint failed/i.test(err.message || '')
  );
}

/* 服务项目的对外展示形态：id + 中文名 + 演示金额。
   service 为空（第五期之前的历史预约）就返回 null，
   前端会显示「未记录项目」，订单接口也会拒绝，不会凭空算钱。 */
function serviceView(id) {
  const svc = getService(id);
  if (!svc) return null;
  return {
    id,
    label: svc.label,
    amount_cents: svc.amount_cents,
    amount_text: formatCents(svc.amount_cents)
  };
}

/* 订单摘要：只给前端判断按钮用，真正的金额以 order 接口返回为准 */
const ORDER_LABEL = { unpaid: '待支付', paid: '已支付', refunded: '已退款' };

function orderView(row) {
  if (!row.order_id) return null;
  return {
    id: row.order_id,
    status: row.order_status,
    status_label: ORDER_LABEL[row.order_status] || row.order_status,
    amount_cents: row.order_amount_cents,
    amount_text: formatCents(row.order_amount_cents)
  };
}

/* =======================================================
   0. 医生清单（公开）
   预约页要在登录前也能看到有哪些医生，所以这个接口不要求登录。
   只返回展示所需字段，不含邮箱与密码。
   ======================================================= */
router.get('/doctors', (req, res) => {
  const doctors = stmts.listDoctors.all().map((d) => ({
    id: d.id,
    name: d.name,
    dept: d.dept || null,
    /* slug 让前端把 data.js 里的展示医师（liu-ortho）映射到数据库 id */
    slug: String(d.email || '').split('@')[0]
  }));
  res.json({ doctors });
});

/* =======================================================
   1. 查可约时段（病人）
   GET /api/schedules?doctor_id=2&date=2026-11-24
   ======================================================= */
router.get('/schedules', authenticate, requireRole('patient'), (req, res) => {
  const doctorId = Number(req.query.doctor_id);
  if (!Number.isInteger(doctorId) || doctorId <= 0) {
    return fail(res, 400, 'BAD_DOCTOR_ID', 'doctor_id 不合法');
  }
  const date = parseDate(req.query.date);
  if (!date) return fail(res, 400, 'BAD_DATE', 'date 需为 YYYY-MM-DD');

  const doctor = stmts.doctorById.get(doctorId);
  if (!doctor) return fail(res, 404, 'DOCTOR_NOT_FOUND', '医生不存在或已停诊');

  const rows = stmts.slotsForDoctorDate.all(doctorId, date);

  /* appointment_id 为 null 才是可约；已占用的也返回，但标记出来，
     前端可以把「已约满」的时段灰掉，而不是让用户点进去才发现。 */
  res.json({
    doctor: { id: doctor.id, name: doctor.name, dept: doctor.dept || null },
    date,
    slots: rows.map((r) => ({
      id: r.id,
      start_time: r.start_time,
      end_time: r.end_time,
      open: r.status === 'open',
      taken: r.appointment_id !== null
    }))
  });
});

/* =======================================================
   2. 提交预约（病人）
   POST /api/appointments { schedule_id, note }
   -------------------------------------------------------
   防并发：不做「先查有没有、再插入」的两步判断（那是 TOCTOU，有竞态）。
   直接 INSERT，让数据库的部分唯一索引 decide：
     - 成功 → 201
     - 撞唯一约束 → 409 SLOT_TAKEN
   ======================================================= */
const createAppointment = db.transaction((patientId, scheduleId, service, note) => {
  const slot = stmts.scheduleById.get(scheduleId);
  if (!slot) return { status: 404, code: 'SLOT_NOT_FOUND', message: '该时段不存在' };
  if (slot.status !== 'open') {
    return { status: 409, code: 'SLOT_CLOSED', message: '该时段未开放预约' };
  }

  const startMs = slotStartMs(slot.date, slot.start_time);
  if (startMs === null || startMs <= Date.now()) {
    /* 过去时段必须挡在服务端：前端把时段列表渲染出来之后，
       用户完全可能停留到时段开始之后再点提交，或者直接改请求体里的 schedule_id。
       400 是因为这属于「请求本身不合法」，不是资源状态冲突。 */
    return { status: 400, code: 'SLOT_IN_PAST', message: '该时段已开始或已过期，请选择之后的时段' };
  }

  /* 注意：这里没有「先查是否已被占用」。查了也只是个心理安慰，
     真正的裁决在下面的 INSERT 上。 */
  const info = stmts.insertAppointment.run(patientId, slot.doctor_id, scheduleId, service, note);
  return {
    status: 201,
    id: Number(info.lastInsertRowid),
    slot
  };
});

router.post('/appointments', authenticate, requireRole('patient'), (req, res) => {
  const scheduleId = Number(req.body && req.body.schedule_id);
  if (!Number.isInteger(scheduleId) || scheduleId <= 0) {
    return fail(res, 400, 'BAD_SCHEDULE_ID', 'schedule_id 不合法');
  }

  /* 第五期：把预约项目真正落库。
     之前只是把「项目：洗牙」拼进 note —— 那是给人看的字符串，
     拿它当计费依据等于让用户自己决定价格。
     这里只接受「价格表里存在的 id」；缺省（老客户端/老脚本）允许，
     但那样的预约创建订单时会被明确拒绝（409 SERVICE_MISSING）。 */
  const rawService = req.body && typeof req.body.service === 'string' ? req.body.service.trim() : '';
  if (rawService && !getService(rawService)) {
    return fail(res, 400, 'BAD_SERVICE', '服务项目不存在，请刷新页面后重新选择');
  }
  const service = rawService || null;

  const rawNote = req.body && typeof req.body.note === 'string' ? req.body.note.trim() : '';
  if (rawNote.length > 200) {
    return fail(res, 400, 'NOTE_TOO_LONG', '备注最多 200 字');
  }
  const note = rawNote || null;

  let result;
  try {
    result = createAppointment(req.user.id, scheduleId, service, note);
  } catch (err) {
    if (isUniqueViolation(err)) {
      /* 这就是并发下输的那一方：数据库已经有一条未取消的预约占着这个 slot */
      return fail(res, 409, 'SLOT_TAKEN', '该时段刚被其他人约走，请换一个时段');
    }
    throw err;
  }

  if (result.status !== 201) {
    if (result.status === 404) return fail(res, 404, result.code, result.message);
    return fail(res, result.status, result.code, result.message);
  }

  const row = stmts.appointmentById.get(result.id);
  res.status(201).json({
    appointment: {
      id: row.id,
      status: row.status,
      note: row.note,
      date: row.date,
      start_time: row.start_time,
      end_time: row.end_time,
      doctor_id: row.doctor_id,
      service
    }
  });
});

/* =======================================================
   3. 我的预约（病人）
   GET /api/patient/appointments
   只查 patient_id = 当前登录人，没有「传别人的 id 就能看」的入口。
   ======================================================= */
router.get('/patient/appointments', authenticate, requireRole('patient'), (req, res) => {
  const rows = stmts.listByPatient.all(req.user.id);
  res.json({
    appointments: rows.map((r) => ({
      id: r.id,
      status: r.status,
      status_label: STATUS_LABEL[r.status] || r.status,
      note: r.note,
      date: r.date,
      start_time: r.start_time,
      end_time: r.end_time,
      doctor_name: r.doctor_name,
      doctor_dept: r.doctor_dept,
      service: serviceView(r.service),
      order: orderView(r),
      created_at: r.created_at,
      cancelled_at: r.cancelled_at,
      cancellable: isCancellable(r)
    }))
  });
});

function isCancellable(row) {
  if (row.status !== 'pending' && row.status !== 'confirmed') return false;
  const startMs = slotStartMs(row.date, row.start_time);
  if (startMs === null) return false;
  return startMs - Date.now() >= CANCEL_WINDOW_MS;
}

/* 取消规则的原因码：前端按 code 决定显示「可以取消」还是「请电话联系」，
   不用自己去算 24 小时，也就不会出现前后端算不一致的情况。 */
function cancelRule(row) {
  const startMs = slotStartMs(row.date, row.start_time);
  const leftMs = startMs === null ? null : startMs - Date.now();
  const hoursLeft = leftMs === null ? null : Math.max(0, Math.floor(leftMs / 3600000));

  let code = 'OK';
  if (row.status === 'cancelled') code = 'ALREADY_CANCELLED';
  else if (row.status === 'completed' || row.status === 'no_show') code = 'NOT_CANCELLABLE';
  else if (leftMs === null || leftMs < CANCEL_WINDOW_MS) code = 'TOO_LATE_TO_CANCEL';

  return {
    window_hours: CANCEL_WINDOW_MS / 3600000,
    hours_left: hoursLeft,
    cancellable: code === 'OK',
    reason: code
  };
}

/* =======================================================
   3.1 预约详情（病人，且只能看自己的）
   GET /api/patient/appointments/:id
   -------------------------------------------------------
   和列表接口的区别：列表是 WHERE patient_id = ?（根本查不到别人的），
   详情是先按 id 查、再比 patient_id。两条路径都要有，
   因为详情页只能拿到 id，没法在 SQL 里先过滤一层——
   所以这一条更依赖对象级判断，也最容易被漏。
   ======================================================= */
router.get('/patient/appointments/:id', authenticate, requireRole('patient'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return fail(res, 400, 'BAD_ID', '预约 id 不合法');
  }

  const appt = stmts.appointmentDetail.get(id);
  if (!appt) return fail(res, 404, 'NOT_FOUND', '预约不存在');

  /* ★ 对象级权限 ★ 别人的预约一律 403，不返回 404 掩盖存在性 */
  if (appt.patient_id !== req.user.id) {
    return fail(res, 403, 'NOT_OWNER', '这条预约不属于你');
  }

  res.json({
    appointment: {
      id: appt.id,
      status: appt.status,
      status_label: STATUS_LABEL[appt.status] || appt.status,
      note: appt.note,
      date: appt.date,
      start_time: appt.start_time,
      end_time: appt.end_time,
      doctor: {
        id: appt.doctor_id,
        name: appt.doctor_name,
        dept: appt.doctor_dept || null
      },
      created_at: appt.created_at,
      cancelled_at: appt.cancelled_at,
      service: serviceView(appt.service),
      order: orderView(appt),
      cancel_rule: cancelRule(appt)
    }
  });
});

/* =======================================================
   4. 取消预约（病人，且只能取消自己的）
   POST /api/appointments/:id/cancel
   -------------------------------------------------------
   顺序很重要：
     先按 id 查出来 → 不是自己的立刻 403（对象级权限）
     → 再看状态与 24 小时规则 → 最后 UPDATE 时再带一次 patient_id
   UPDATE 里重复带 patient_id 是「防御性冗余」：
   万一上面某天被改坏，SQL 这一层仍然写不动别人的行。
   ======================================================= */
router.post('/appointments/:id/cancel', authenticate, requireRole('patient'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return fail(res, 400, 'BAD_ID', '预约 id 不合法');
  }

  const appt = stmts.appointmentById.get(id);
  if (!appt) return fail(res, 404, 'NOT_FOUND', '预约不存在');

  /* ★ 对象级权限 ★ 病人 A 拿 B 的预约 id 来取消 → 403，而不是 404 或静默成功 */
  if (appt.patient_id !== req.user.id) {
    return fail(res, 403, 'NOT_OWNER', '这条预约不属于你，不能取消');
  }

  if (appt.status === 'cancelled') {
    return fail(res, 409, 'ALREADY_CANCELLED', '该预约已取消');
  }
  if (appt.status === 'completed') {
    return fail(res, 409, 'NOT_CANCELLABLE', '已完成的预约不能取消');
  }

  const startMs = slotStartMs(appt.date, appt.start_time);
  const leftMs = startMs === null ? 0 : startMs - Date.now();
  if (leftMs < CANCEL_WINDOW_MS) {
    const hours = leftMs > 0 ? Math.floor(leftMs / 3600000) : 0;
    return fail(
      res, 409, 'TOO_LATE_TO_CANCEL',
      leftMs > 0
        ? `距开始不足 24 小时（约 ${hours} 小时），不能自助取消，请电话联系门诊`
        : '该时段已开始，无法取消',
      { hours_left: hours }
    );
  }

  const info = stmts.cancelAppointment.run(id, req.user.id);
  if (info.changes === 0) {
    /* 走到这里说明状态在两步之间被改了（比如医生刚把状态改成 completed） */
    return fail(res, 409, 'STATE_CHANGED', '预约状态已变化，请刷新后再试');
  }

  res.json({ ok: true, id, status: 'cancelled' });
});

/* =======================================================
   5. 医生的患者预约（只读，只看自己的）
   GET /api/doctor/appointments
   ======================================================= */
router.get('/doctor/appointments', authenticate, requireRole('doctor'), (req, res) => {
  const rows = stmts.listByDoctor.all(req.user.id);
  res.json({
    doctor: { id: req.user.id, name: req.user.name, dept: req.user.dept || null },
    appointments: rows.map((r) => ({
      id: r.id,
      status: r.status,
      status_label: STATUS_LABEL[r.status] || r.status,
      note: r.note,
      date: r.date,
      start_time: r.start_time,
      end_time: r.end_time,
      patient_name: r.patient_name,
      patient_phone: r.patient_phone,
      /* 只读的支付状态：医生要知道这单有没有收到钱。
         这里不给任何金额计算，金额始终来自订单表（下单时由价格表写入）。 */
      order: orderView(r),
      created_at: r.created_at
    }))
  });
});

/* =======================================================
   5.1 医生端状态流转：确认 / 完成 / 未到诊 / 恢复
   -------------------------------------------------------
   状态机写成一张表，四个接口共用同一个处理器。
   每条转换声明三件事：从什么状态、到什么状态、走哪条 SQL。

   非法转换（例如 pending 直接 complete）在这里统一返回
   409 BAD_STATE，响应里带当前状态和期望状态，
   前端不用解析中文提示就能决定怎么刷新。
   ======================================================= */
const DOCTOR_TRANSITIONS = {
  confirm: {
    from: 'pending',
    to: 'confirmed',
    stmt: 'confirmAppointment',
    label: '确认',
    need: '只有「待确认」的预约可以确认'
  },
  complete: {
    from: 'confirmed',
    to: 'completed',
    stmt: 'completeAppointment',
    label: '标记完成',
    need: '只有「已确认」的预约可以标记完成'
  },
  'no-show': {
    from: 'confirmed',
    to: 'no_show',
    stmt: 'noShowAppointment',
    label: '标记未到诊',
    need: '只有「已确认」的预约可以标记未到诊'
  },
  /* 纠错入口：no_show 不是真正的终态。
     病人确实没来是常态，但医生也可能点错人/点错条，
     而且 no_show 不占号源 —— 没有回退路径就成了「时段能重约、这条却永远错着」。 */
  reopen: {
    from: 'no_show',
    to: 'confirmed',
    stmt: 'reopenAppointment',
    label: '恢复为已确认',
    need: '只有「未到诊」的预约可以恢复'
  }
};

function doctorTransition(action) {
  const cfg = DOCTOR_TRANSITIONS[action];

  return (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return fail(res, 400, 'BAD_ID', '预约 id 不合法');
    }

    const appt = stmts.appointmentDetail.get(id);
    if (!appt) return fail(res, 404, 'NOT_FOUND', '预约不存在');

    /* ★ 对象级权限 ★ 医生只能推进自己名下的预约 */
    if (appt.doctor_id !== req.user.id) {
      return fail(res, 403, 'NOT_OWNER', '这条预约不属于你，不能操作');
    }

    /* ★ 状态机 ★ 非法转换一律 409，不静默成功、不改成"最接近"的状态 */
    if (appt.status !== cfg.from) {
      return fail(
        res, 409, 'BAD_STATE',
        `当前状态是「${STATUS_LABEL[appt.status] || appt.status}」，不能${cfg.label}：${cfg.need}`,
        { status: appt.status, status_label: STATUS_LABEL[appt.status] || appt.status, expected: cfg.from }
      );
    }

    let info;
    try {
      info = stmts[cfg.stmt].run(id, req.user.id);
    } catch (err) {
      /* reopen 特有的冲突：no_show 已经把号源放出去了，
         如果这个时段已被别的病人重新约走，恢复原记录就会撞唯一索引。
         这不是「状态不对」，而是「号源已经不属于你」，给一个能区分的码。 */
      if (isUniqueViolation(err)) {
        return fail(
          res, 409, 'SLOT_REBOOKED',
          '该时段已被其他患者重新预约，无法恢复这条记录'
        );
      }
      throw err;
    }
    if (info.changes === 0) {
      /* 读到这里状态被别处改了（比如病人刚取消） */
      return fail(res, 409, 'STATE_CHANGED', '预约状态已变化，请刷新后再试');
    }

    const after = stmts.appointmentDetail.get(id);
    res.json({
      ok: true,
      appointment: {
        id: after.id,
        status: after.status,
        status_label: STATUS_LABEL[after.status] || after.status,
        date: after.date,
        start_time: after.start_time,
        end_time: after.end_time,
        patient_name: after.patient_name,
        doctor_name: after.doctor_name,
        doctor_dept: after.doctor_dept || null
      }
    });
  };
}

router.post('/doctor/appointments/:id/confirm',
  authenticate, requireRole('doctor'), doctorTransition('confirm'));
router.post('/doctor/appointments/:id/complete',
  authenticate, requireRole('doctor'), doctorTransition('complete'));
router.post('/doctor/appointments/:id/no-show',
  authenticate, requireRole('doctor'), doctorTransition('no-show'));
router.post('/doctor/appointments/:id/reopen',
  authenticate, requireRole('doctor'), doctorTransition('reopen'));

/* =======================================================
   6. 医生看自己的排班（含占用情况）
   GET /api/doctor/schedules?date=YYYY-MM-DD
   -------------------------------------------------------
   doctor_id 只从 session 取，绝不从 query 取 ——
   否则医生 A 传 doctor_id=B 就能看 B 的排班。
   ======================================================= */
router.get('/doctor/schedules', authenticate, requireRole('doctor'), (req, res) => {
  const date = parseDate(req.query.date);
  if (!date) return fail(res, 400, 'BAD_DATE', 'date 需为 YYYY-MM-DD');

  const rows = stmts.schedulesByDoctorDate.all(req.user.id, date);
  res.json({
    date,
    slots: rows.map((r) => ({
      id: r.id,
      start_time: r.start_time,
      end_time: r.end_time,
      open: r.status === 'open',
      appointment_id: r.appointment_id,
      appointment_status: r.appointment_status,
      patient_name: r.patient_name
    }))
  });
});

module.exports = router;
