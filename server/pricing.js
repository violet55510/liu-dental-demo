/* =========================================================
   server/pricing.js — 服务项目计费表（订单金额的唯一来源）
   ---------------------------------------------------------
   四条硬规则，改动前先读：

   1) 金额一律用「分」存整数。
      ¥280.00 → 28000。不用浮点，避免 0.1 + 0.2 那类误差在钱上出现。

   2) 前端传来的任何金额字段都不参与计算。
      路由层连 req.body.amount 都不读。价格只在下面的表里查。
      这是整个支付模块的命门：金额一旦能被请求体影响，
      「改个 1 分钱」就是一行 fetch 的事。

   3) 查不到服务项目 → 报错，不猜、不兜底。
      没有 service 的历史预约、或 service 不在表里，
      宁可返回 409 SERVICE_MISSING，也不要"按科室均价"编一个金额出来。

   4) 价格数据只有一份，在 assets/js/data.js 的 services[]。
      本文件不另存一份数字，而是在启动时「读 + 校验」：
        - id / label / amount_cents 必须齐；
        - amount_cents 必须是正整数（单位：分）；
        - 若条目带 price_range，则 min ≤ amount_cents ≤ max。
      校验失败直接抛错、拒绝启动 —— 与其带着错价跑起来，
      不如在第一次启动时就红给你看。
      服务页（services.html）的区间也由同一个文件渲染，
      所以不存在「页面写一个价、订单收另一个价」的双源问题。

   ⚠️ 本表的金额是**演示数据**，不对应任何真实门诊报价。
      真实系统里这块数据应来自物价/HIS，且需要审批与留痕。

   改动价格后需要重启服务（本文件在启动时加载一次）。
   ========================================================= */
'use strict';

/* data.js 的加载逻辑在 site-data.js（vm 跑一遍、JSON 往返）。
   第七期起小程序接口也用同一份，所以不再在本文件里重复实现。 */
const { siteData, DATA_FILE } = require('./site-data');

function loadSiteData() {
  const services = siteData.services;
  if (!Array.isArray(services) || !services.length) {
    throw new Error('[pricing] assets/js/data.js 里没有可用的 services[]');
  }
  return services;
}

function buildTable() {
  const table = Object.create(null);

  for (const svc of loadSiteData()) {
    if (!svc || typeof svc.id !== 'string' || !svc.id) {
      throw new Error('[pricing] services[] 里有一条缺少 id');
    }
    if (typeof svc.label !== 'string' || !svc.label) {
      throw new Error(`[pricing] 服务项目 ${svc.id} 缺少 label`);
    }
    if (!Number.isInteger(svc.amount_cents) || svc.amount_cents <= 0) {
      throw new Error(`[pricing] 服务项目 ${svc.id} 的 amount_cents 必须是正整数（单位：分）`);
    }
    if (table[svc.id]) {
      throw new Error(`[pricing] 服务项目 id 重复：${svc.id}`);
    }

    const range = svc.price_range || null;
    if (range) {
      const ok = Number.isInteger(range.min_cents) && Number.isInteger(range.max_cents) &&
        range.min_cents > 0 && range.min_cents <= range.max_cents;
      if (!ok) {
        throw new Error(`[pricing] 服务项目 ${svc.id} 的 price_range 不合法`);
      }
      /* 页面展示的区间必须能把实际计费金额框进去，否则用户看到
         「¥6,000–15,000」却被收 ¥20,000 —— 这种不一致必须在启动时拦住。 */
      if (svc.amount_cents < range.min_cents || svc.amount_cents > range.max_cents) {
        throw new Error(
          `[pricing] 服务项目 ${svc.id} 自相矛盾：amount_cents=${svc.amount_cents} 不在展示区间 ` +
          `${range.min_cents}–${range.max_cents} 内`
        );
      }
    }

    table[svc.id] = {
      label: svc.label,
      amount_cents: svc.amount_cents,
      price_range: range
    };
  }

  return table;
}

const SERVICES = buildTable();

function getService(id) {
  if (typeof id !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(SERVICES, id) ? SERVICES[id] : null;
}

function isServiceId(id) {
  return !!getService(id);
}

/* 只用于展示：分 → 「¥6,800.00」。真正参与计算的一直是整数分。 */
function formatCents(cents) {
  if (!Number.isInteger(cents)) return '—';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fen = String(abs % 100).padStart(2, '0');
  return sign + '¥' + yuan + '.' + fen;
}

/* 服务项目清单（对外接口用，不含任何内部字段） */
function listServices() {
  return Object.keys(SERVICES).map((id) => ({
    id,
    label: SERVICES[id].label,
    amount_cents: SERVICES[id].amount_cents,
    amount_text: formatCents(SERVICES[id].amount_cents)
  }));
}

module.exports = {
  SERVICES,
  DATA_FILE,
  getService,
  isServiceId,
  formatCents,
  listServices
};
