/* =========================================================
   server/app.js — Express 装配
   ---------------------------------------------------------
   静态站（五个展示页 + 三个账户页）由本进程一起托管，
   所以启动后访问 http://localhost:3000/ 就是原来的站点，
   /api/* 才是后端接口。
   ========================================================= */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');

const { db, DB_FILE, seededNow, seededSchedules } = require('./db');
const { initJwt, TTL_SECONDS } = require('./jwt');
const authRoutes = require('./routes/auth');
const protectedRoutes = require('./routes/protected');
const appointmentRoutes = require('./routes/appointments');
const orderRoutes = require('./routes/orders');
const publicRoutes = require('./routes/public');
const { readProxyTarget, createProxy } = require('./api-proxy');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
/* ★ 监听地址必须是 0.0.0.0（所有网卡），不能是 127.0.0.1 ★
   127.0.0.1 只接受「本机自己」的连接，手机 / 同事电脑 / 局域网里的任何设备
   都会连不上 —— 小程序真机调试时请求超时，十有八九是这里写死了回环地址。
   容器（Koyeb / Docker）同理：绑回环地址时平台的健康检查也探不到。
   需要只给本机用时，用 HOST=127.0.0.1 npm start 显式收窄。 */
const HOST = process.env.HOST || '0.0.0.0';
const isProd = process.env.NODE_ENV === 'production';

/* 会话密钥文件放在数据库同目录（默认 data/）：
   换 DB_PATH 时密钥跟着走，不会出现「库在挂载盘、密钥在容器里」这种半持久状态。 */
const SECRET_FILE = path.join(path.dirname(DB_FILE), '.session-secret');

const app = express();
app.disable('x-powered-by');

/* Render 在应用前面挂一层反向代理，req.ip 默认会变成代理地址。
   不 trust proxy 的后果：① 按 IP 的限流把所有访客算成同一个人（60 次/分钟全站共享）；
   ② secure cookie 的协议判断失真。只信任一跳（Render 自己的代理），
   不写 true —— 那样客户端可以自带 X-Forwarded-For 伪造来源 IP。 */
if (isProd) app.set('trust proxy', 1);

/* ---------- 1. 基础安全响应头 ---------- */
/* 说明：静态页里有内联 style 和 SVG，暂不启用严格 CSP；
   生产环境应改为 nonce / hash 方案后再上 CSP。 */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

app.use(express.json({ limit: '16kb' }));

/* ---------- 2. 会话 ---------- */
/* secret 持久化到 data/.session-secret：重启后已登录用户不掉线。
   生产环境可改用环境变量 SESSION_SECRET，且必须配 HTTPS + secure cookie。

   没有「默认字符串」兜底：密钥缺失或过短一律拒绝启动。
   理由：写死的默认密钥等于把签名算法公开——任何人都能伪造会话。
   宁可起不来，也不要带着弱密钥对外服务。 */
const MIN_SECRET_LEN = 32;   // 32 字符 ≈ 256 位熵（hex 编码时正好 64 位）

function loadSecret() {
  /* ① 环境变量优先 */
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv !== undefined) {
    if (fromEnv.trim().length < MIN_SECRET_LEN) {
      throw new Error(
        `SESSION_SECRET 太短（当前 ${fromEnv.trim().length} 字符，至少 ${MIN_SECRET_LEN}）。` +
        '生成方式：node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
      );
    }
    return { secret: fromEnv.trim(), source: '环境变量 SESSION_SECRET' };
  }

  /* ② 落盘文件（首次生成、之后复用）。
     云端（Render 免费层）每次冷启动容器是干净的：文件读不到 → 走第 ③ 步
     当场生成一份新的。后果是重启后所有 cookie 与 token 都失效、需要重新登录。
     这是预期行为，不是故障（见 DEPLOY.md「注意事项」）。 */
  const file = SECRET_FILE;
  const shown = path.relative(ROOT, file) || file;
  let secret = '';
  try {
    secret = fs.readFileSync(file, 'utf8').trim();
  } catch { /* 首次运行，文件还不存在 */ }

  if (secret) {
    if (secret.length < MIN_SECRET_LEN) {
      throw new Error(
        `${shown} 内容异常（长度 ${secret.length} < ${MIN_SECRET_LEN}），可能被截断或手工改过。` +
        '请删除该文件后重启，系统会重新生成（已登录用户需要重新登录）。'
      );
    }
    /* 非 Windows 平台补一次权限收紧，防止文件被同机其他用户读取 */
    if (process.platform !== 'win32') {
      try {
        if (fs.statSync(file).mode & 0o077) fs.chmodSync(file, 0o600);
      } catch { /* 权限调整失败不影响启动 */ }
    }
    return { secret, source: `${shown}（复用已有）` };
  }

  /* ③ 首次生成：crypto.randomBytes(32) → 256 位熵 */
  const generated = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, generated, { mode: 0o600 });   // 仅属主可读写
  return { secret: generated, source: `${shown}（本次新生成）` };
}

let secretInfo;
try {
  secretInfo = loadSecret();
} catch (err) {
  console.error('[启动失败] ' + err.message);
  process.exit(1);
}

/* ---------- 2.1 小程序通道的 JWT 密钥 ----------
   规则（server/jwt.js）：
     ① 配了 JWT_SECRET → 用它（少于 32 字符直接拒绝启动，不自动降级）
     ② JWT_REQUIRE_ENV=1 且没配 → 拒绝启动
     ③ 都没配 → 从会话密钥派生（HMAC-SHA256 + 固定标签，重启后不变）

   ★ 没有默认字符串兜底 ★
   写死的默认密钥等于公开签名算法：谁都能签一个 role=admin 的 token。
   这里宁可起不来，也不带着可预测的密钥对外服务。 */
let jwtInfo;
try {
  jwtInfo = initJwt(secretInfo.secret);
} catch (err) {
  console.error('[启动失败] ' + err.message);
  process.exit(1);
}

app.use(session({
  name: 'lsd.sid',
  secret: secretInfo.secret,
  resave: false,
  saveUninitialized: false,   // 未登录不写 cookie，减少无意义会话
  rolling: true,              // 有操作就续期
  cookie: {
    httpOnly: true,           // JS 读不到 document.cookie
    sameSite: 'lax',          // 跨站 POST 不携带，挡掉大部分 CSRF
    secure: isProd,           // 生产（HTTPS）必须 true
    maxAge: 2 * 60 * 60 * 1000,
    path: '/'
  }
}));

/* ---------- 3. 不对外暴露的路径（第二道闸） ---------- */
/* 第一道闸是下面第 5 节的静态白名单；这里是按路径模式提前拦掉，
   让「明显在探敏感文件」的请求连 express.static 都不进。 */
const BLOCKED = [
  /^\/(server|data|node_modules|scripts|tests|\.workbuddy|\.git)(\/|$)/i,
  /^\/(package(-lock)?\.json|README\.md|DEPLOY\.md|render\.ya?ml|\.gitignore|\.env)/i,
  /\.(db|db-wal|db-shm|sqlite|env|log|md|secret|pem|key|crt|ya?ml)$/i,
  /^\/\./                                   // 任何以点开头的路径段（.git、.env、.session-secret…）
];

app.use((req, res, next) => {
  if (BLOCKED.some((re) => re.test(req.path))) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
});

/* ---------- 4. 接口 ---------- */

/* 合库开关（默认关闭）：服务端目录里存在 api-proxy.json 时，
   所有 /api 请求转给权威后端，本机这份 SQLite 不参与业务。
   这样「前台域名」可以和「数据所在域名」分开，避免同一套系统
   出现两份互不相干的账号与预约。详见 server/api-proxy.js。 */
const API_PROXY = readProxyTarget();
if (API_PROXY) {
  app.use('/api', createProxy(API_PROXY.target));
  console.log('[api-proxy] 已启用：/api → ' + API_PROXY.target + (API_PROXY.note ? '（' + API_PROXY.note + '）' : ''));
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, db: path.basename(DB_FILE), users: countUsers() });
});

function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

app.use('/api', authRoutes);
app.use('/api', protectedRoutes);
app.use('/api', appointmentRoutes);
app.use('/api', orderRoutes);

/* 小程序端：/api/public/* 三个公开只读接口（免登录 + 60 次/分钟限流）。
   单独挂在 /api/public 前缀下，和需要登录的业务接口在路径上就分得开，
   以后要加白名单 / 单独限流 / 单独缓存，都不用改业务路由。 */
app.use('/api/public', publicRoutes);

/* 未命中的 /api 统一返回 JSON，别吐 HTML */
app.use('/api', (req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

/* ---------- 5. 静态站（白名单，不是黑名单） ---------- */
/* 之前用 express.static(ROOT) 托管整个项目根目录，靠 BLOCKED 黑名单挡敏感文件。
   问题是黑名单只能挡「想到的」：README.md 就是这么漏出去的（里面写着演示账号密码）。
   改成白名单后，磁盘上多出任何文件都不会自动变成可访问 URL。 */
const PAGES = new Set([
  'index.html',
  'services.html',
  'doctors.html',
  'appointment.html',
  'contact.html',
  'login.html',
  'register.html',
  'dashboard.html',
  'payment.html'
]);

/* 5.1 只有 /assets 下的 css、js、图片、字体可读 */
app.use('/assets', express.static(path.join(ROOT, 'assets'), {
  index: false,          // 不列目录
  dotfiles: 'deny',      // /assets/.something 一律拒绝
  setHeaders(res, filePath) {
    if (/\.(css|js)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  }
}));

/* 5.2 只有白名单里的 9 个页面可读；其余路径不落到任何静态处理器 */
app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'), { headers: { 'Cache-Control': 'no-cache' } });
});

app.get('/:page', (req, res, next) => {
  const page = req.params.page;
  if (!PAGES.has(page)) return next();          // 交给 404，不猜、不回退
  res.sendFile(path.join(ROOT, page), { headers: { 'Cache-Control': 'no-cache' } });
});

app.use((req, res) => {
  res.status(404).type('text/plain; charset=utf-8').send('404 · 页面不存在');
});

/* ---------- 6. 错误处理 ---------- */
/* 只记方法 + 路径 + 错误信息，绝不打印请求体（里面可能有密码） */
app.use((err, req, res, next) => {  // eslint-disable-line no-unused-vars
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求体不是合法 JSON' });
  }
  console.error(`[error] ${req.method} ${req.path} :: ${err && err.message}`);
  res.status(500).json({ error: '服务器内部错误' });
});

/* ---------- 7. 启动 ---------- */
/* 启动时把「本机能用的网址」打出来。
   局域网 IP 是手写 miniprogram/config.js 时最需要的信息；
   让人自己去 ipconfig 里翻，很容易抄到虚拟网卡（VMware / WSL / VPN / 蓝牙）的地址上。
   取 family=IPv4 且非 internal 的地址；取不到就什么都不打，绝不影响启动。 */
function lanAddresses() {
  const out = [];
  try {
    const nets = os.networkInterfaces();
    Object.keys(nets).forEach((name) => {
      (nets[name] || []).forEach((n) => {
        const family = typeof n.family === 'string' ? n.family : (n.family === 4 ? 'IPv4' : '');
        if (family === 'IPv4' && !n.internal) out.push({ name, address: n.address });
      });
    });
  } catch { /* 拿不到网卡信息不影响启动 */ }

  /* 虚拟网卡（VPN / VMware / WSL / 蓝牙…）也会报一个 IPv4，
     抄错了在手机上就是连不上。把真实网卡排前面，虚拟的标注出来。 */
  const VIRTUAL = /vpn|virtual|vmware|vbox|hyper-v|vethernet|wsl|docker|tap|tun|zerotier|radmin|tailscale|bluetooth|loopback|npcap/i;
  return out
    .map((n) => ({ name: n.name, address: n.address, virtual: VIRTUAL.test(n.name) }))
    .sort((a, b) => Number(a.virtual) - Number(b.virtual));
}

const server = app.listen(PORT, HOST, () => {
  console.log(`齿记工具助手演示站已启动  监听 ${HOST}:${PORT}`);
  /* localhost 在某些 Windows 环境会先解析成 ::1，而这里绑的是 IPv4 全网卡，
     所以本机调试统一推荐 127.0.0.1，少一类「明明启动了却打不开」的困惑。 */
  console.log(`本机访问：http://127.0.0.1:${PORT}`);
  const lan = lanAddresses();
  if (lan.length) {
    console.log('同一局域网 / 手机真机访问（填进 miniprogram/config.js 的 BASE_URL）：');
    lan.forEach((n) => console.log(
      `  http://${n.address}:${PORT}   [${n.name}]${n.virtual ? '  ← 虚拟网卡，手机通常连不到这个' : ''}`
    ));
  }
  console.log(`数据库：${DB_FILE}`);
  /* 只打印来源，绝不打印密钥本身 */
  console.log(`会话密钥：${secretInfo.source}`);
  console.log(`令牌密钥：${jwtInfo.source}（Bearer token 有效期 ${TTL_SECONDS / 3600} 小时）`);
  if (seededNow.length) console.log(`已创建种子账号：${seededNow.join(', ')}`);
  if (seededSchedules) console.log(`已生成种子排班：${seededSchedules} 个时段（4 位医生 × 未来 14 天）`);
  /* 初始密码不写日志：日志可能被收集、转发，密码一律只出现在 README 的演示说明里 */
  console.log('种子账号的初始密码见 README「第二阶段 · 种子账号」');
});

function shutdown() {
  server.close(() => {
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  });
}

['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, shutdown));

module.exports = app;
