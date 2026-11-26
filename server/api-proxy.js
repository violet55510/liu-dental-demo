/* =========================================================
   server/api-proxy.js — 把 /api 转发到另一台后端的「合库开关」
   ---------------------------------------------------------
   为什么需要它
   ------------
   同一套代码可以被部署到多台机器上，每台都自带一份 SQLite。
   于是「Web 端」和「小程序端」如果指向了两个不同域名，它们看到的
   是两份互不相干的数据库：这边注册的病人，那边查不到；这边的预约，
   那边是空的。这不是接口 bug，是「一库变两库」的结构问题。

   正确的做法只有一个：**所有客户端连同一台后端**。
   这个模块让「前台入口域名」和「数据所在域名」解耦：
     · 浏览器仍然打开好记的托管域名（页面、静态资源、cookie 都在那里）；
     · 所有 /api 请求由这台服务器转给真正的权威后端。

   默认关闭
   --------
   只有在**服务端目录下存在 `api-proxy.json`** 时才启用：
       { "target": "https://xxx.example.com", "note": "写给自己看的备注" }
   仓库里不放这个文件，所以 `npm start`、六套回归、本机临时库
   的行为一点不变；它只出现在发布产物里（见 DEPLOY.md §13）。

   转发时的几条规矩
   ----------------
   1. **不转发 Authorization**。托管平台的网关会往每个请求里塞它自己的
      Authorization（iss=cloudstudio.net），转发过去既没意义又会让上游
      误判。Web 端本来就用 cookie 会话，不需要这个头。
   2. **转发 Cookie**。会话 cookie 由上游签发、浏览器按「当前访问的域名」
      保存，所以只要这台机器原样透传，登录态在浏览器侧就是连续的。
   3. **请求体重新序列化**。express.json() 已经把 body 解成对象，直接
      把原始流再转发一次会读到空流。
   4. **失败要说人话**。上游超时/连不上时返回 502 + 机器码
      `UPSTREAM_ERROR`，而不是让浏览器拿到一个 HTML 错误页。
   ========================================================= */
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'api-proxy.json');
const TIMEOUT_MS = 15000;

/* 读取开关。任何异常都按「不启用」处理并打日志——
   宁可退回本机库，也不要带着一个半配置的状态对外服务。 */
function readProxyTarget() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch {
    return null;   // 文件不存在 = 正常情况（本地开发 / 回归）
  }

  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    console.warn('[api-proxy] api-proxy.json 不是合法 JSON，已忽略');
    return null;
  }

  const target = cfg && typeof cfg.target === 'string' ? cfg.target.trim() : '';
  if (!/^https?:\/\/[^/\s]+/i.test(target)) {
    console.warn('[api-proxy] target 必须是 http(s):// 开头的地址，已忽略');
    return null;
  }
  return { target: target.replace(/\/+$/, ''), note: cfg.note || '' };
}

/* 拼上游地址：保留路径与查询串，去掉本平台的 sharecode（上游不认识） */
function buildUpstreamUrl(base, originalUrl) {
  const [rawPath, rawQuery] = String(originalUrl).split('?');
  const search = new URLSearchParams(rawQuery || '');
  search.delete('sharecode');
  const qs = search.toString();
  const prefix = base.pathname === '/' ? '' : base.pathname.replace(/\/+$/, '');
  return base.origin + prefix + rawPath + (qs ? '?' + qs : '');
}

function createProxy(target) {
  const base = new URL(target);
  const agent = base.protocol === 'https:' ? https : http;

  return function apiProxy(req, res) {
    /* --- 1. 只转发业务需要的头 --- */
    const headers = { accept: 'application/json' };
    if (req.headers.cookie) headers.cookie = req.headers.cookie;
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
    if (req.headers['user-agent']) headers['user-agent'] = req.headers['user-agent'];
    const ip = req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress);
    if (ip) headers['x-forwarded-for'] = ip;

    /* --- 2. 请求体：已解析的对象要重新序列化成字节 --- */
    let body = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const parsed = req.body;
      if (Buffer.isBuffer(parsed) && parsed.length) {
        body = parsed;
        headers['content-length'] = String(body.length);
      } else if (parsed && typeof parsed === 'object' && Object.keys(parsed).length) {
        body = Buffer.from(JSON.stringify(parsed), 'utf8');
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(body.length);
      } else {
        // 无参数的动作接口（如 confirm / no-show）
        body = Buffer.from('{}', 'utf8');
        headers['content-type'] = 'application/json';
        headers['content-length'] = '2';
      }
    }

    const url = buildUpstreamUrl(base, req.originalUrl);
    let finished = false;

    function bail(code, message) {
      if (finished || res.headersSent) return;
      finished = true;
      res.status(code).json({ error: message, code: 'UPSTREAM_ERROR' });
    }

    const up = agent.request(url, { method: req.method, headers, timeout: TIMEOUT_MS }, (upRes) => {
      if (finished) { upRes.resume(); return; }
      finished = true;

      const out = { 'content-type': upRes.headers['content-type'] || 'application/json' };
      /* 多个 Set-Cookie 必须逐个下发，合并成一行会把其中一个吃掉 */
      if (upRes.headers['set-cookie']) out['set-cookie'] = upRes.headers['set-cookie'];
      if (upRes.headers['cache-control']) out['cache-control'] = upRes.headers['cache-control'];

      res.writeHead(upRes.statusCode || 502, out);
      upRes.pipe(res);
    });

    up.on('timeout', () => up.destroy(new Error('upstream timeout')));
    up.on('error', (err) => {
      console.warn('[api-proxy] ' + url + ' → ' + err.message);
      bail(502, '数据服务暂时连不上，请稍后再试');
    });

    if (body) up.write(body);
    up.end();
  };
}

module.exports = { readProxyTarget, createProxy, CONFIG_FILE };
