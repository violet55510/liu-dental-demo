/* =========================================================
   server/routes/protected.js — 需要登录 / 需要角色的业务路由
   ---------------------------------------------------------
   本期只做最小可用的占位数据，重点是「权限在服务端」这件事本身：
   - /api/patient/*  仅病人
   - /api/doctor/*   仅医生
   - /api/admin/*    仅管理员
   ========================================================= */
'use strict';

const express = require('express');
const { authenticate, requireRole } = require('../auth');
const { stmts, findUserById } = require('../db');

const router = express.Router();

/* ---------- 病人 / 医生 ---------- */
/* 第二期起，病人的「我的预约」与医生的「我的患者预约」都在
   routes/appointments.js 里，带对象级权限。这里只留管理员接口。 */

const VALID_STATUS = new Set(['pending', 'active', 'disabled']);

/* ---------- 管理员：账号审核 ---------- */
router.get('/admin/users', authenticate, requireRole('admin'), (req, res) => {
  const status = String(req.query.status || 'pending');
  if (!VALID_STATUS.has(status)) {
    return res.status(400).json({ error: 'status 只能是 pending / active / disabled' });
  }
  res.json({ status, users: stmts.listByStatus.all(status) });
});

router.post('/admin/users/:id/activate', authenticate, requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id 不合法' });

  const target = findUserById(id);
  if (!target) return res.status(404).json({ error: '账号不存在' });
  if (target.role === 'admin') return res.status(400).json({ error: '管理员账号不在此处审核' });

  stmts.setStatus.run('active', id);
  res.json({ ok: true, user: { id, status: 'active' } });
});

router.post('/admin/users/:id/disable', authenticate, requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id 不合法' });

  const target = findUserById(id);
  if (!target) return res.status(404).json({ error: '账号不存在' });
  if (target.role === 'admin') return res.status(400).json({ error: '不能停用管理员账号' });

  stmts.setStatus.run('disabled', id);
  res.json({ ok: true, user: { id, status: 'disabled' } });
});

module.exports = router;
