/* =========================================================
   server/routes/auth.js — 注册 / 医生申请 / 登录 / 登出 / 当前身份
   ---------------------------------------------------------
   POST /api/register       公开注册，只能注册病人
   POST /api/doctor/apply   医生入驻申请，落库即 pending
   POST /api/login          手机号或邮箱 + 密码
   POST /api/logout         销毁会话
   GET  /api/me             当前登录身份（未登录返回 200 + null）
   ========================================================= */
'use strict';

const express = require('express');
const { hashPasswordSync } = require('../password');
const {
  hashPassword,
  verifyPassword,
  toPublicUser,
  isPhone,
  isEmail,
  isPassword,
  isName,
  str,
  resolveIdentity,
  createRateLimiter
} = require('../auth');
const { signToken, TTL_SECONDS } = require('../jwt');
const { findUserByAccount, findUserById, stmts } = require('../db');

const router = express.Router();

/* 登录、注册都限流：同一 IP + 同一账号 15 分钟内最多 10 次 */
const authLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });

/* 用真实哈希做一次假比对，避免「账号不存在」比「密码错误」返回更快 */
const DUMMY_HASH = hashPasswordSync('timing-attack-placeholder');

function isUniqueError(err) {
  return err && typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT');
}

/* ---------- 注册（只允许病人） ---------- */
router.post('/register', authLimiter, async (req, res, next) => {
  try {
    const body = req.body || {};
    /* 注意：完全忽略 body.role / body.status —— 角色由服务端写死 */
    const name = str(body.name);
    const phone = str(body.phone);
    const password = typeof body.password === 'string' ? body.password : '';

    if (!isName(name)) return res.status(400).json({ error: '请填写 2–20 个字的姓名' });
    if (!isPhone(phone)) return res.status(400).json({ error: '请输入 11 位有效的手机号' });
    if (!isPassword(password)) return res.status(400).json({ error: '密码至少 8 位' });

    if (stmts.byPhone.get(phone)) {
      return res.status(409).json({ error: '该手机号已注册，请直接登录' });
    }

    const hash = await hashPassword(password);
    const info = stmts.insertPatient.run(phone, hash, name);

    res.status(201).json({
      user: { id: info.lastInsertRowid, role: 'patient', name, status: 'active' },
      message: '注册成功，请登录'
    });
  } catch (err) {
    if (isUniqueError(err)) return res.status(409).json({ error: '该手机号已注册' });
    next(err);
  }
});

/* ---------- 医生入驻申请（不直接可用） ---------- */
router.post('/doctor/apply', authLimiter, async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = str(body.name);
    const email = str(body.email).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';

    if (!isName(name)) return res.status(400).json({ error: '请填写 2–20 个字的姓名' });
    if (!isEmail(email)) return res.status(400).json({ error: '请输入有效邮箱' });
    if (!isPassword(password)) return res.status(400).json({ error: '密码至少 8 位' });

    if (stmts.byEmail.get(email)) {
      return res.status(409).json({ error: '该邮箱已提交过申请' });
    }

    const hash = await hashPassword(password);
    const info = stmts.insertDoctorPending.run(email, hash, name);

    res.status(201).json({
      user: { id: info.lastInsertRowid, role: 'doctor', name, status: 'pending' },
      message: '申请已提交，待管理员审核激活后方可登录'
    });
  } catch (err) {
    if (isUniqueError(err)) return res.status(409).json({ error: '该邮箱已提交过申请' });
    next(err);
  }
});

/* ---------- 登录 ---------- */
router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const body = req.body || {};
    const account = str(body.account || body.phone || body.email);
    const password = typeof body.password === 'string' ? body.password : '';

    if (!account || !password) {
      return res.status(400).json({ error: '请填写账号与密码' });
    }

    const row = findUserByAccount(account);

    /* 账号不存在也跑一次 bcrypt，响应时间不暴露账号是否存在 */
    let ok = false;
    if (row) {
      ok = await verifyPassword(password, row.password_hash);
    } else {
      await verifyPassword(password, DUMMY_HASH);
    }

    if (!row || !ok) {
      return res.status(401).json({ error: '账号或密码不正确' });
    }

    /* 密码正确之后才谈状态，避免「密码错也能探测账号状态」 */
    if (row.status === 'pending') {
      return res.status(403).json({ error: '账号待审核，请联系门诊管理员', status: 'pending' });
    }
    if (row.status === 'disabled') {
      return res.status(403).json({ error: '账号已停用，请联系门诊管理员', status: 'disabled' });
    }

    /* 会话固定攻击防护：登录成功换一个新 session id */
    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => (err ? reject(err) : resolve()));
    });
    req.session.uid = row.id;
    req.session.role = row.role;     // 仅用于前端渲染提示，鉴权以数据库为准
    await new Promise((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });

    const token = signToken(row);

    res.json({
      user: { id: row.id, role: row.role, name: row.name, status: row.status },
      /* 第八期：同一次登录同时下发两种凭证
           cookie（上面 regenerate 的那个）→ Web 继续用，行为零变化
           token（下面这串 JWT）        → 小程序存进 storage，放进 Bearer 头
         两者互不依赖：Web 完全不读 token，小程序完全不用 cookie。 */
      token,
      token_type: 'Bearer',
      expires_in: TTL_SECONDS,
      message: '登录成功'
    });
  } catch (err) {
    next(err);
  }
});

/* ---------- 登出 ---------- */
/* cookie 通道：销毁服务端会话 + 清 cookie。
   Bearer 通道：JWT 是无状态的，服务端没有「这条 token 的会话」可销毁，
   所以这里只能告诉客户端「把本地那份删掉」。
   真正的兜底是 authenticate 每次回库查 status —— 账号一停用，
   手里还攥着有效 token 也进不来。 */
router.post('/logout', (req, res, next) => {
  const hasBearer = !!req.headers.authorization;
  if (!req.session) return res.json({ ok: true });

  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('lsd.sid');
    res.json(hasBearer
      ? { ok: true, hint: '客户端请删除本地保存的 token' }
      : { ok: true });
  });
});

/* ---------- 当前身份 ---------- */
/* 同时认 Bearer 与 cookie：小程序启动时用它判断「本地 token 还有效吗」。
   注意 401 只发生在「带了凭证但凭证不对」的情况下；
   什么都没带仍然是 200 + user:null（Web 首屏就靠这个分支）。 */
router.get('/me', (req, res) => {
  const id = resolveIdentity(req);
  if (id.error) {
    return res.status(401).json({ user: null, code: id.error.code, error: id.error.message });
  }
  if (!id.uid) return res.json({ user: null });

  const row = findUserById(id.uid);
  if (!row) return res.json({ user: null });

  /* 状态变了就别再当成已登录 */
  if (row.status !== 'active') {
    return res.json({ user: null, status: row.status });
  }
  res.json({ user: toPublicUser(row), auth: id.source });
});

module.exports = router;
