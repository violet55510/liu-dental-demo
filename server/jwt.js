/* =========================================================
   server/jwt.js — Bearer token（小程序通道）
   ---------------------------------------------------------
   为什么要两套凭证而不是一套：
     Web 已经有 cookie session（httpOnly + SameSite，浏览器自动携带），
     小程序没有 cookie 容器，wx.request 也不保证带上会话 ——
     它需要的是一个能显式放进请求头的字符串。所以：
       cookie  → 给 Web（继续用，行为零变化）
       Bearer  → 给小程序（JWT，客户端自己保存与携带）

   token 的三条硬约束：
     1. payload 只放 { id, role }（iat / exp / iss 是 JWT 标准声明，由库写入；
        iss 用来区分「本服务签发」与「托管平台网关塞进来的第三方 token」），
        不放姓名 / 手机号 —— token 会落在客户端的 storage 里，能少放就少放。
     2. role 只是「客户端拿来做提示」的线索，鉴权一律回库查（auth.js）。
        所以就算有人把 payload 里的 role 改成 doctor，也提不了权；
        何况改 payload 会破坏签名，连验签都过不去。
     3. 密钥不许有默认值：
        没配 JWT_SECRET 就从会话密钥派生（HMAC-SHA256，带固定标签），
        两者都拿不到 → 直接拒绝启动（见 app.js 的启动失败分支）。
   ========================================================= */
'use strict';

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const ALGORITHM = 'HS256';
const TTL_SECONDS = 2 * 60 * 60;        // 2 小时，和 Web 会话 maxAge 保持一致
const MIN_SECRET_LEN = 32;              // 32 字符 ≈ 256 位熵（hex 编码时 64 位）
const DERIVE_LABEL = 'lsd/jwt/v1';      // 派生标签：换标签等于换一把新钥匙
const OWNER = 'liu-dental-demo';        // 本服务签发 token 的 iss，用来区分「谁的凭证」

/* ---------- 1. 密钥解析 ----------
   优先级：
     ① 环境变量 JWT_SECRET（显式配置，推荐生产）
     ② JWT_REQUIRE_ENV=1 时：没有 ① 就拒绝启动（严格模式）
     ③ 从会话密钥派生（同一份 data/.session-secret，重启后不变）

   为什么不给「默认字符串」兜底：写死的默认密钥等于把签名算法公开，
   任何人都能自己签一个 token 进来。宁可起不来。 */
function resolveSecret(sessionSecret) {
  const fromEnv = process.env.JWT_SECRET;

  if (fromEnv !== undefined) {
    const trimmed = fromEnv.trim();
    if (trimmed.length < MIN_SECRET_LEN) {
      throw new Error(
        `JWT_SECRET 太短（当前 ${trimmed.length} 字符，至少 ${MIN_SECRET_LEN}）。` +
        '生成方式：node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
      );
    }
    return { secret: trimmed, source: '环境变量 JWT_SECRET' };
  }

  if (process.env.JWT_REQUIRE_ENV === '1') {
    throw new Error(
      'JWT_REQUIRE_ENV=1 但没有配置 JWT_SECRET。' +
      '严格模式下不接受从会话密钥派生，必须显式提供独立密钥。'
    );
  }

  if (typeof sessionSecret !== 'string' || sessionSecret.length < MIN_SECRET_LEN) {
    throw new Error(
      '没有可用的 JWT 密钥材料：JWT_SECRET 未配置，会话密钥也不可用。' +
      '请配置至少 32 字符的 JWT_SECRET 后重启。'
    );
  }

  /* 派生而不是复用：同一个密钥同时签 cookie 和 token，
     一旦其中一条通道的密钥泄露，另一条也跟着失守。
     HMAC 派生出的 64 位 hex 与原始会话密钥在计算上互不可推。 */
  const derived = crypto.createHmac('sha256', sessionSecret).update(DERIVE_LABEL).digest('hex');
  return { secret: derived, source: '由会话密钥派生（HMAC-SHA256 / ' + DERIVE_LABEL + '）' };
}

/* 启动时算一次，后续签发/校验都用这一份 —— 避免每个请求重算派生值 */
const secretInfo = { secret: null, source: '（未初始化）' };

function initJwt(sessionSecret) {
  const info = resolveSecret(sessionSecret);
  secretInfo.secret = info.secret;
  secretInfo.source = info.source;
  return info;
}

function getSecret() {
  if (!secretInfo.secret) throw new Error('JWT 密钥尚未初始化（initJwt 未调用）');
  return secretInfo.secret;
}

/* ---------- 2. 签发 ---------- */
/* row 可以是数据库整行，这里只挑 id 与 role 两个字段进 payload。 */
function signToken(row) {
  if (!row || !Number.isInteger(row.id) || !row.role) {
    throw new Error('签发票据需要合法的用户行（id 为整数、role 非空）');
  }
  return jwt.sign(
    { id: row.id, role: row.role },
    getSecret(),
    { algorithm: ALGORITHM, expiresIn: TTL_SECONDS, issuer: OWNER }
  );
}

/* ---------- 2.5 这是谁的凭证 ----------
   托管平台（WorkBuddy 应用托管 / 云 IDE 反代）会在网关层给**每个**请求
   塞一条自己的 `Authorization: Bearer <平台 JWT>`（iss=cloudstudio.net），
   并且会覆盖客户端自己带的那一条。

   我们的「出现 Authorization 就只认 Bearer、验签失败即 401」是为了防止
   「过期 token + 有效 cookie」静默通过 —— 不是为了让别人的网关 token
   把我们自己的 Web 会话打死。所以先认签发方：

     · iss 明确是别人（且不是我们） → 平台注入，忽略，交还给 cookie 通道
     · 没有 iss / 结构不是 JWT / iss 就是我们 → 一律当自己的凭证
       （验签失败照样 401，绝不静默放行）

   注意：忽略外来 token 不会放宽任何校验 —— 外来 token 本来就签不出我们的
   密钥，就算被当成自己的也只会 401。这里只是别让它误伤 cookie。 */
function isForeignToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return false;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return false;
  }

  const iss = payload && payload.iss;
  return typeof iss === 'string' && iss.length > 0 && iss !== OWNER;
}

/* ---------- 3. 校验 ----------
   返回统一结构，不抛异常：
     { ok: true,  payload }
     { ok: false, code, message }
   code 用来区分「过期」与「伪造」——前端文案不同，排查方向也不同。 */
function verifyToken(token) {
  if (typeof token !== 'string' || !token) {
    return { ok: false, code: 'TOKEN_MISSING', message: '没有提供登录凭证' };
  }

  let payload;
  try {
    /* algorithms 必须显式指定：不写的话库会按 header 里的 alg 选算法，
       历史上出现过「alg=none」和 HS/RS 混用导致的提权漏洞。 */
    payload = jwt.verify(token, getSecret(), { algorithms: [ALGORITHM] });
  } catch (err) {
    if (err && err.name === 'TokenExpiredError') {
      return { ok: false, code: 'TOKEN_EXPIRED', message: '登录状态已过期，请重新登录' };
    }
    /* 签名不对 / 结构不对 / 被改过 payload —— 对外统一一句话，
       不告诉攻击者具体错在哪一位。 */
    return { ok: false, code: 'TOKEN_INVALID', message: '登录凭证无效，请重新登录' };
  }

  if (!payload || !Number.isInteger(payload.id) || payload.id <= 0) {
    return { ok: false, code: 'TOKEN_INVALID', message: '登录凭证无效，请重新登录' };
  }

  return { ok: true, payload };
}

module.exports = {
  ALGORITHM,
  TTL_SECONDS,
  MIN_SECRET_LEN,
  OWNER,
  initJwt,
  signToken,
  verifyToken,
  isForeignToken,
  getSecretInfo: () => ({ source: secretInfo.source })
};
