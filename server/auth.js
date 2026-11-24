/* =========================================================
   server/auth.js — 密码、校验、权限中间件
   ---------------------------------------------------------
   三条铁律：
   1. 密码只以 bcrypt 哈希落库，任何响应里都不出现哈希
   2. 权限以「数据库里的 role + status」为准，不信 session / token 里缓存的值
   3. 客户端提交的任何 role 字段一律丢弃

   第八期起这里是**双通道**入口：
     Web  → cookie session（保持不变）
     小程序 → Authorization: Bearer <JWT>
   两条通道解析出同一个 req.user，后面的 requireRole 与业务代码一行不用改。
   ========================================================= */
'use strict';

const {
  hashPassword,
  verifyPassword
} = require('./password');
const { findUserById } = require('./db');
const { verifyToken, isForeignToken } = require('./jwt');

/* ---------- 1. 密码 ---------- */
/* 具体实现（bcrypt / @node-rs/bcrypt）在 password.js 里选，调用方不关心。 */

/* ---------- 2. 出口白名单 ---------- */
/* 只挑字段，不做 delete 操作——避免以后加字段时忘了删而泄露。 */
function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    role: row.role,
    name: row.name,
    status: row.status,
    phone: row.phone || null,
    email: row.email || null,
    dept: row.dept || null
  };
}

/* ---------- 3. 输入校验 ---------- */
const PHONE_RE = /^1[3-9]\d{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isPhone(v) {
  return typeof v === 'string' && PHONE_RE.test(v);
}

function isEmail(v) {
  return typeof v === 'string' && v.length <= 120 && EMAIL_RE.test(v);
}

function isPassword(v) {
  return typeof v === 'string' && v.length >= 8 && v.length <= 72;
}

function isName(v) {
  return typeof v === 'string' && v.trim().length >= 2 && v.trim().length <= 20;
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/* ---------- 4. 双通道身份解析 ----------
   一套逻辑认两种凭证，产出同一个 uid：

     Authorization: Bearer <jwt>   小程序 / 任何非浏览器客户端
     Cookie: lsd.sid=...           Web（httpOnly 会话，行为与改造前完全一致）

   ★ 顺序与「不回落」★
   只要请求里出现了 Authorization 头，就只认 Bearer：
   验签失败 → 401，绝不偷偷退回 cookie。
   否则会出现最危险的一种「通过」：token 已经过期/被改，但浏览器里
   恰好还有一条有效会话，接口照样 200 —— 前端以为 token 还活着，
   测试也测不出 token 通道坏了。宁可明确失败。

   ★ 头格式不对也算失败 ★
   "Authorization: abc"（缺 Bearer 前缀）不当作「没带凭证」，
   因为那说明客户端代码写错了，静默忽略只会让 bug 藏得更深。

   ★ 唯一的例外：签发方明确是别人的 token ★
   反向代理层可能自己塞一条 Bearer（WorkBuddy 应用托管就是这样，iss=cloudstudio.net），
   而且会覆盖客户端带的那条。那条 token 不是我们的凭证，验签必然失败，
   留着它只会把 Web 的 cookie 会话一起打死。所以 iss 明确是别人的 → 忽略这一条，
   继续看 cookie。判断逻辑在 jwt.js 的 isForeignToken()，
   结构不合法 / 没有 iss 的 token 仍然按「自己的」处理（失败即 401，不放宽）。 */
function readBearer(req) {
  const raw = req.headers && req.headers.authorization;
  if (typeof raw !== 'string' || raw.trim() === '') return null;

  const m = /^Bearer[ ]+(\S+)$/i.exec(raw.trim());
  if (!m) {
    return { error: { code: 'BAD_AUTH_HEADER', message: 'Authorization 头格式应为：Bearer <token>' } };
  }
  if (isForeignToken(m[1])) return null;
  return { token: m[1] };
}

/* 只解析、不响应 —— /api/me 需要「没凭证就返回 200 + null」，
   不能复用会直接 401 的中间件。 */
function resolveIdentity(req) {
  const bearer = readBearer(req);

  if (bearer) {
    if (bearer.error) return { uid: null, source: 'bearer', error: bearer.error };

    const v = verifyToken(bearer.token);
    if (!v.ok) {
      return { uid: null, source: 'bearer', error: { code: v.code, message: v.message } };
    }
    return { uid: v.payload.id, source: 'bearer', payload: v.payload };
  }

  const uid = req.session && req.session.uid;
  if (!uid) return { uid: null, source: 'anonymous' };
  return { uid, source: 'cookie' };
}

/* ---------- 5. 权限中间件 ---------- */
/* authenticate：先解析凭证，再回库取最新状态。
   - 账号不存在 / 已删除 → 401
   - 状态 pending / disabled → 403，并销毁会话（token 由客户端自行丢弃）
   这样「管理员改了状态」能立刻生效，不用等 token 过期 ——
   这一条正是「JWT 无状态、无法服务端吊销」的补偿：
   我们不信 token 里的 role，只信数据库里的 role。 */
function authenticate(req, res, next) {
  const id = resolveIdentity(req);

  if (id.error) {
    return res.status(401).json({ error: id.error.message, code: id.error.code });
  }
  if (!id.uid) {
    return res.status(401).json({ error: '请先登录', code: 'NO_CREDENTIALS' });
  }

  const row = findUserById(id.uid);
  if (!row) {
    if (req.session) req.session.destroy(() => {});
    return res.status(401).json({ error: '登录状态已失效，请重新登录', code: 'USER_GONE' });
  }

  if (row.status !== 'active') {
    const msg = row.status === 'pending' ? '账号待审核，暂不可用' : '账号已停用';
    if (req.session) req.session.destroy(() => {});
    return res.status(403).json({ error: msg, status: row.status, code: 'ACCOUNT_' + row.status.toUpperCase() });
  }

  req.user = row;               // 完整行，仅服务端使用
  req.publicUser = toPublicUser(row);
  req.authSource = id.source;   // 'cookie' | 'bearer'，便于日志与断言
  if (id.payload) req.tokenPayload = id.payload;
  next();
}

/* 老名字保留成同一个函数：路由里写 requireAuth 还是 authenticate
   都是同一个实现，不存在「两套鉴权逻辑」的隐患。 */
const requireAuth = authenticate;

/* requireRole('doctor') / requireRole('patient') / requireRole('admin') */
function requireRole(...roles) {
  return function (req, res, next) {
    if (!req.user) return res.status(401).json({ error: '请先登录' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: '没有权限访问该资源' });
    }
    next();
  };
}

/* ---------- 5. 简易限流（内存版，够演示用） ---------- */
/* 生产环境应换成 Redis 计数或网关级限流。 */
function createRateLimiter({ windowMs = 15 * 60 * 1000, max = 10 } = {}) {
  const hits = new Map();

  return function (req, res, next) {
    const key = req.ip + '|' + (req.body && (req.body.account || req.body.phone || req.body.email) || '');
    const now = Date.now();
    const rec = hits.get(key) || { count: 0, resetAt: now + windowMs };

    if (now > rec.resetAt) {
      rec.count = 0;
      rec.resetAt = now + windowMs;
    }
    rec.count += 1;
    hits.set(key, rec);

    if (rec.count > max) {
      const retry = Math.ceil((rec.resetAt - now) / 1000);
      res.set('Retry-After', String(retry));
      return res.status(429).json({ error: '尝试次数过多，请稍后再试' });
    }
    next();
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  toPublicUser,
  isPhone,
  isEmail,
  isPassword,
  isName,
  str,
  readBearer,
  resolveIdentity,
  authenticate,
  requireAuth,
  requireRole,
  createRateLimiter
};
