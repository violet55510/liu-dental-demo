/* =========================================================
   server/rate-limit.js — 通用内存限流器（固定窗口）
   ---------------------------------------------------------
   和 auth.js 里那个登录限流器不是一回事，所以单独放一个文件：

     | 维度 | auth.js 的登录限流 | 本文件 |
     | --- | --- | --- |
     | 计数键 | IP + 账号（body 里的 account/phone/email） | 只按 IP |
     | 目的 | 防撞库：同一账号试 10 次就锁 | 防刷量：同一来源每分钟有配额 |
     | 超额响应 | 纯 error 文案 | 带 code + Retry-After + X-RateLimit-* |

   为什么按 IP 而不是按接口：小程序的「首页」一次就要打 3 个公开接口，
   如果每个接口各给 60 次，实际放行量就变成 180 次/分钟/来源，
   配额就失去意义了。三个接口共享一个桶，口径才说得清。

   局限（演示够用，生产不够）：
   - 计数在进程内存里：多实例部署时各算各的，重启即清零；
   - 固定窗口不是滑动窗口，跨窗口边界可能瞬间放过 2 倍；
   - 只按 IP，NAT 后的多个用户会共享配额。
   真实网关层应换成 Redis / 云 WAF 的滑动窗口计数。
   ========================================================= */
'use strict';

function createRateLimiter({
  windowMs = 60 * 1000,
  max = 60,
  message = '请求过于频繁，请稍后再试',
  code = 'RATE_LIMITED'
} = {}) {
  const hits = new Map();

  /* 定期清掉已过窗的记录，避免长期运行后 Map 只增不减。
     unref() 让这个定时器不阻止进程退出（否则测试脚本会挂住）。 */
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, rec] of hits) {
      if (rec.resetAt <= now) hits.delete(key);
    }
  }, windowMs);
  if (typeof sweeper.unref === 'function') sweeper.unref();

  return function rateLimit(req, res, next) {
    const key = req.ip || req.socket && req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const rec = hits.get(key) || { count: 0, resetAt: now + windowMs };

    if (now >= rec.resetAt) {
      rec.count = 0;
      rec.resetAt = now + windowMs;
    }
    rec.count += 1;
    hits.set(key, rec);

    const remaining = Math.max(0, max - rec.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(rec.resetAt / 1000)));

    if (rec.count > max) {
      const retry = Math.max(1, Math.ceil((rec.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retry));
      return res.status(429).json({
        error: message,
        code,
        retry_after: retry
      });
    }
    next();
  };
}

module.exports = { createRateLimiter };
