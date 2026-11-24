/* =========================================================
   server/routes/orders.js — 第五期：模拟支付
   ---------------------------------------------------------
   ⚠️ 红线：这里没有任何真实支付通道。
      不接支付宝、不接微信支付、不接 Stripe，不发任何外部请求，
      不读也不存任何卡号/二维码/商户号。"支付"这个动作在代码里
      只有一条本地 SQL：把订单状态从 unpaid 改成 paid，
      再记一个 paid_at 时间戳。看见这段注释的人请不要再往里接通道。

   三条设计要点（也是这一期最容易被做错的地方）：

   1) 金额只由服务端算
      路由**完全不读** req.body.amount / amount_cents。
      价格来自 server/pricing.js 的表，按预约的 service 取。
      前端传 amount: 1 也没有用 —— 这一条有专门断言盯着。

   2) 幂等
      - 创建订单：同一预约重复 POST 不报错，返回已有那单（created=false）。
        支付页刷新、用户连点、浏览器重试都不会造出第二单；
        数据库层还有 UNIQUE(appointment_id) 兜底。
      - 支付：只有 unpaid 能付。已 paid 再付 → 409 ALREADY_PAID，
        不重复扣、不刷新 paid_at（paid_at 是"第一次付成功的时间"，
        被第二次请求改掉的话，对账就永远对不上了）。
      - 退款：只有 paid 能退。已 refunded 再退 → 409 ALREADY_REFUNDED，
        refunded_at 同理不变。

   3) 归属
      每个接口都判 order.patient_id === session 用户，
      并且 UPDATE 的 WHERE 里再带一次 patient_id。
      病人 A 拿到 B 的订单 id 只会得到 403，改不动任何一行。

   4) refunded 是终态
      三条合法转换只有 unpaid → paid → refunded，
      没有 refunded → paid 这条边。退款后订单关闭：
        - pay   → 409 ALREADY_REFUNDED
        - refund→ 409 ALREADY_REFUNDED
      同一预约也不会生成第二张订单（orders.appointment_id UNIQUE），
      所以"退款后再付一次"在这个模型里没有入口。
      要支持重新支付，必须新增状态（例如 reopened）或允许一个预约多单，
      那是产品决策 + 迁移，不是把某个 409 改掉就行。
   ========================================================= */
'use strict';

const express = require('express');
const { authenticate, requireRole } = require('../auth');
const { stmts } = require('../db');
const { getService, formatCents, listServices } = require('../pricing');

const router = express.Router();

/* 订单状态中文标签只在这里维护一份 */
const ORDER_LABEL = {
  unpaid: '待支付',
  paid: '已支付',
  refunded: '已退款'
};

/* 预约状态的中文标签（订单详情里要展示，前端不用自己映射） */
const APPT_LABEL = {
  pending: '待确认',
  confirmed: '已确认',
  cancelled: '已取消',
  completed: '已完成',
  no_show: '未到诊'
};

/* 能创建订单的预约状态：待确认 / 已确认。
   已完成、未到诊、已取消都不允许再新开订单：
   前两个的账应该在就诊流程里结，已取消的更没有收费依据。 */
const ORDERABLE_APPT = new Set(['pending', 'confirmed']);

/* 能付款的预约状态：pending / confirmed / completed。
   已完成仍然放行 —— 现实里"看完诊再结账"很常见，挡掉会让正常流程走不通。

   已取消、未到诊一律挡住（第六期修正）：
   这两种状态都表示「这次没有发生诊疗」，没有收费依据。
   尤其是 no_show：它还会释放号源，如果还能付款，
   同一个时段就可能既被下一个人约走、又给爽约的人记一笔账。
   未到诊产生的爽约费属于单独的费用规则，本期不做（README §16.2）。 */
const PAY_BLOCKED_APPT = new Set(['cancelled', 'no_show']);

function fail(res, status, code, message, extra) {
  return res.status(status).json(Object.assign({ error: message, code }, extra || {}));
}

function parseId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function isUniqueViolation(err) {
  return !!err && (
    err.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    /UNIQUE constraint failed/i.test(err.message || '')
  );
}

/* 订单的对外形态。金额同时给 cents 和展示串：
   cents 给程序用（整数、可比较），text 给人看（¥280.00）。
   前端不要拿 text 去算钱。 */
function shapeOrder(row) {
  if (!row) return null;
  const svc = getService(row.service);
  return {
    id: row.id,
    appointment_id: row.appointment_id,
    status: row.status,
    status_label: ORDER_LABEL[row.status] || row.status,
    amount_cents: row.amount_cents,
    amount_text: formatCents(row.amount_cents),
    paid_at: row.paid_at,
    refunded_at: row.refunded_at,
    created_at: row.created_at,
    service: svc
      ? { id: row.service, label: svc.label }
      : { id: row.service || null, label: null },
    appointment: {
      id: row.appointment_id,
      status: row.appointment_status,
      status_label: APPT_LABEL[row.appointment_status] || row.appointment_status,
      date: row.date,
      start_time: row.start_time,
      end_time: row.end_time,
      doctor_name: row.doctor_name,
      doctor_dept: row.doctor_dept || null
    },
    /* 明确告诉前端这是模拟的，UI 上不用自己写死文案 */
    simulated: true
  };
}

/* =======================================================
   1. 为预约创建订单（只限本人，只限 pending/confirmed）
   POST /api/patient/appointments/:id/order
   -------------------------------------------------------
   请求体一律忽略。金额只由 priceTable[appointment.service] 决定。

   幂等：已存在订单时返回 200 + created=false + 原订单，
   而不是 409 —— 「确保这单存在」比「创建一单，失败就报错」
   更适合支付页（刷新一次就 409 会让用户以为坏了）。
   ======================================================= */
router.post('/patient/appointments/:id/order', authenticate, requireRole('patient'), (req, res) => {
  const apptId = parseId(req.params.id);
  if (!apptId) return fail(res, 400, 'BAD_ID', '预约 id 不合法');

  const appt = stmts.appointmentDetail.get(apptId);
  if (!appt) return fail(res, 404, 'NOT_FOUND', '预约不存在');

  /* ★ 对象级权限 ★ 先判归属，再谈状态：
     别人的预约连"状态不对"都不该告诉你。 */
  if (appt.patient_id !== req.user.id) {
    return fail(res, 403, 'NOT_OWNER', '这条预约不属于你');
  }

  if (!ORDERABLE_APPT.has(appt.status)) {
    const label = { cancelled: '已取消', completed: '已完成', no_show: '未到诊' }[appt.status] || appt.status;
    return fail(
      res, 409, 'APPOINTMENT_NOT_PAYABLE',
      `预约当前状态是「${label}」，不能创建订单`,
      { status: appt.status }
    );
  }

  /* 已有订单 → 直接返回（幂等） */
  const existing = stmts.orderByAppointment.get(apptId);
  if (existing) {
    return res.status(200).json({ order: shapeOrder(existing), created: false });
  }

  /* 金额来源：预约上记录的服务项目 → 价格表。
     查不到就明确失败：不按科室均价猜、不按前端传的值兜底。
     "猜一个价格"在支付系统里比报错危险得多。 */
  const svc = getService(appt.service);
  if (!svc) {
    return fail(
      res, 409, 'SERVICE_MISSING',
      appt.service
        ? '这条预约记录的服务项目不在价格表中，无法计费，请联系门诊'
        : '这条预约没有记录服务项目，无法计费，请重新预约或联系门诊'
    );
  }

  let orderId;
  try {
    const info = stmts.insertOrder.run(appt.id, appt.patient_id, svc.amount_cents);
    orderId = Number(info.lastInsertRowid);
  } catch (err) {
    if (isUniqueViolation(err)) {
      /* 并发下另一个请求已经建好了 → 仍然按幂等处理 */
      const again = stmts.orderByAppointment.get(apptId);
      if (again) return res.status(200).json({ order: shapeOrder(again), created: false });
    }
    throw err;
  }

  const order = stmts.orderById.get(orderId);
  res.status(201).json({ order: shapeOrder(order), created: true });
});

/* =======================================================
   2. 模拟支付：unpaid → paid
   POST /api/patient/orders/:id/pay
   -------------------------------------------------------
   不发起任何外部请求。只改本地一行数据。
   ======================================================= */
router.post('/patient/orders/:id/pay', authenticate, requireRole('patient'), (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'BAD_ID', '订单 id 不合法');

  const order = stmts.orderById.get(id);
  if (!order) return fail(res, 404, 'NOT_FOUND', '订单不存在');

  /* ★ 对象级权限 ★ */
  if (order.patient_id !== req.user.id) {
    return fail(res, 403, 'NOT_OWNER', '这个订单不属于你');
  }

  /* 状态机（先判再改，改的时候还会再判一次） */
  if (order.status === 'paid') {
    return fail(
      res, 409, 'ALREADY_PAID',
      '该订单已支付，无需重复支付',
      { paid_at: order.paid_at, order: shapeOrder(order) }
    );
  }
  if (order.status === 'refunded') {
    return fail(
      res, 409, 'ALREADY_REFUNDED',
      '该订单已退款，不能再次支付',
      { order: shapeOrder(order) }
    );
  }
  if (PAY_BLOCKED_APPT.has(order.appointment_status)) {
    /* 已取消 / 未到诊共用同一个错误码，用 status 区分具体原因：
       前端不需要解析中文，也能知道是哪种状态挡住了支付。 */
    const label = APPT_LABEL[order.appointment_status] || order.appointment_status;
    return fail(
      res, 409, 'APPOINTMENT_NOT_PAYABLE',
      `预约当前状态是「${label}」，不能支付`,
      { status: order.appointment_status, order: shapeOrder(order) }
    );
  }

  const info = stmts.markOrderPaid.run(id, req.user.id);
  if (info.changes === 0) {
    /* 两步之间状态被改了（并发重复支付、或预约刚被取消） */
    const now = stmts.orderById.get(id);
    if (now && now.status === 'paid') {
      return fail(res, 409, 'ALREADY_PAID', '该订单已支付，无需重复支付',
        { paid_at: now.paid_at, order: shapeOrder(now) });
    }
    return fail(res, 409, 'STATE_CHANGED', '订单状态已变化，请刷新后再试');
  }

  const after = stmts.orderById.get(id);
  res.json({
    ok: true,
    simulated: true,
    note: '模拟支付完成：未发生真实扣款',
    order: shapeOrder(after)
  });
});

/* =======================================================
   3. 模拟退款：paid → refunded
   POST /api/patient/orders/:id/refund
   ======================================================= */
router.post('/patient/orders/:id/refund', authenticate, requireRole('patient'), (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return fail(res, 400, 'BAD_ID', '订单 id 不合法');

  const order = stmts.orderById.get(id);
  if (!order) return fail(res, 404, 'NOT_FOUND', '订单不存在');

  /* ★ 对象级权限 ★ */
  if (order.patient_id !== req.user.id) {
    return fail(res, 403, 'NOT_OWNER', '这个订单不属于你');
  }

  if (order.status === 'refunded') {
    return fail(
      res, 409, 'ALREADY_REFUNDED',
      '该订单已退款，无需重复操作',
      { refunded_at: order.refunded_at, order: shapeOrder(order) }
    );
  }
  if (order.status === 'unpaid') {
    return fail(res, 409, 'NOT_PAID', '订单尚未支付，没有可退的款项');
  }

  const info = stmts.markOrderRefunded.run(id, req.user.id);
  if (info.changes === 0) {
    const now = stmts.orderById.get(id);
    if (now && now.status === 'refunded') {
      return fail(res, 409, 'ALREADY_REFUNDED', '该订单已退款，无需重复操作',
        { refunded_at: now.refunded_at, order: shapeOrder(now) });
    }
    return fail(res, 409, 'STATE_CHANGED', '订单状态已变化，请刷新后再试');
  }

  const after = stmts.orderById.get(id);
  res.json({
    ok: true,
    simulated: true,
    note: '模拟退款完成：未发生真实资金往来',
    order: shapeOrder(after)
  });
});

/* =======================================================
   4. 我的订单（病人）
   GET /api/patient/orders
   -------------------------------------------------------
   只查 patient_id = 当前登录人，没有「传 id 看别人订单」的入口。
   ======================================================= */
router.get('/patient/orders', authenticate, requireRole('patient'), (req, res) => {
  const rows = stmts.listOrdersByPatient.all(req.user.id);
  res.json({ orders: rows.map(shapeOrder) });
});

/* =======================================================
   5. 公开价格表（只读，供页面展示"参考价"用）
   GET /api/services
   -------------------------------------------------------
   只是把服务端价格表原样吐出来，避免前端 data.js 里的
   展示文案和计费表各写一份、越走越远。
   金额仍是演示数据，不构成报价。
   ======================================================= */
router.get('/services', (req, res) => {
  res.json({ services: listServices(), simulated: true });
});

module.exports = router;
