/* =========================================================
   server/routes/public.js — 小程序端的公开只读接口
   ---------------------------------------------------------
   三个接口，全部：
     - 免登录（不 requireAuth）：这是给未登录的小程序展示页用的；
       需要身份的接口（查时段 / 预约 / 我的预约）走 /api/* 的 Bearer 通道，
       不在这里开第二套；
     - 只读：只有 GET，没有写操作，也没有任何用户数据；
     - 限流：60 次/分钟/来源（可用环境变量覆盖，见下）；
     - 数据源：assets/js/data.js（经 site-data.js 读取），
       **服务端不另维护一份诊所信息**——官网改了，小程序下次请求就跟着变。

   三个接口都刻意「收窄字段」：
     医师不返回 license（执业证书编号）、不返回 email、不返回 photo 空路径；
     项目不返回 amount_cents（分），只给展示用的 price_text。
   收窄不是洁癖：小程序包一旦发出，别人可以在开发者工具里读全部代码和请求，
   下发的字段就等于公开的字段。能不发的就不发。

   限流的配额是「三个接口共享 60 次/分钟」，原因见 rate-limit.js 顶部注释。
   环境变量 PUBLIC_RATE_MAX / PUBLIC_RATE_WINDOW_MS 只给自动化测试用
   （测试要能在 6 次请求内验证 429，不能真发 61 次把后面用例的配额吃光）。
   ========================================================= */
'use strict';

const express = require('express');
const { siteData } = require('../site-data');
const { formatCents, getService } = require('../pricing');
const { createRateLimiter } = require('../rate-limit');
const { db } = require('../db');

const router = express.Router();

const RATE_MAX = Number(process.env.PUBLIC_RATE_MAX || 60);
const RATE_WINDOW_MS = Number(process.env.PUBLIC_RATE_WINDOW_MS || 60 * 1000);

router.use(createRateLimiter({
  windowMs: Number.isFinite(RATE_WINDOW_MS) && RATE_WINDOW_MS > 0 ? RATE_WINDOW_MS : 60 * 1000,
  max: Number.isFinite(RATE_MAX) && RATE_MAX > 0 ? RATE_MAX : 60
}));

/* ---------- 1. 诊所信息 ---------- */
function todayHours(days) {
  /* weekday 0 = 周日，和 data.js 的约定一致。
     注意：这里用的是**服务器本地时区**的星期几，和排班接口同一口径
     （README §7 已记录该取舍）。多时区部署时应改为按诊所所在时区换算。 */
  const weekday = new Date().getDay();
  const hit = days.find((d) => Number(d.weekday) === weekday);
  if (!hit) return null;
  return {
    weekday: Number(hit.weekday),
    label: hit.label,
    open: hit.open,
    close: hit.close,
    note: hit.note || ''
  };
}

function clinicView() {
  const c = siteData.clinic;
  const days = Array.isArray(c.hours && c.hours.days) ? c.hours.days : [];
  const city = (c.address && c.address.city) || '';
  const detail = (c.address && c.address.line1) || '';

  return {
    name: c.name,
    name_en: c.nameEn || '',
    /* 没有 logo 素材，前端用首字做标记；在这里算好，WXML 里不用求值 */
    initial: String(c.name || '').slice(0, 1),
    phone: {
      /* display 给人看（带空格分组），tel 给 wx.makePhoneCall 用（纯数字） */
      display: (c.phone && c.phone.display) || '',
      tel: (c.phone && c.phone.tel) || ''
    },
    address: {
      city,
      detail,
      full: [city, detail].filter(Boolean).join(' '),
      note: (c.address && c.address.note) || ''
    },
    hours: {
      caption: (c.hours && c.hours.caption) || '',
      holiday_note: (c.hours && c.hours.holidayNote) || '',
      today: todayHours(days),
      days: days.map((d) => ({
        weekday: Number(d.weekday),
        label: d.label,
        open: d.open,
        close: d.close,
        note: d.note || ''
      }))
    },
    demo_notice: c.demoNotice || ''
  };
}

/* ---------- 2. 医师公开信息 ---------- */
/* 预约要的是 users.id，而 data.js 里的医师用 slug（liu-ortho）标识。
   两者的桥是「医生账号邮箱的前缀 = slug」（官网 /api/doctors 也是这么映射的）。
   这里在服务端查一次给出 booking_id，小程序就不用自己拼映射，
   也不会出现「前端把 slug 当数字 id 传过去 → 400」这种错。
   没有对应账号（例如官网列了但还没建账号）→ booking_id: null，
   小程序据此把「在线预约」置灰，而不是让用户点了才失败。 */
function bookingIds() {
  const rows = db.prepare(
    "SELECT id, email FROM users WHERE role = 'doctor' AND status = 'active'"
  ).all();
  const map = new Map();
  for (const r of rows) map.set(String(r.email || '').split('@')[0], r.id);
  return map;
}

function doctorView(d, ids) {
  return {
    id: d.id,
    booking_id: ids.has(d.id) ? ids.get(d.id) : null,
    name: d.name,
    /* 头像位没有真实照片，前端用姓氏首字做占位；这里先算好，
       免得 WXML 里写 {{item.name[0]}} 这种依赖模板求值的写法 */
    initial: String(d.name || '').slice(0, 1),
    dept: d.dept || '',
    title: d.title || '',
    years: d.years || '',
    /* data.js 里 yearsPending 为 true 表示「年限待核对」。
       原样下发，让前端自己决定要不要加「待核对」标记 —— 不替用户猜。 */
    years_pending: !!d.yearsPending,
    schedule: d.schedule || '',
    schedule_pending: !!d.schedulePending,
    intro: d.intro || '',
    short_intro: d.shortIntro || '',
    tags: Array.isArray(d.tags) ? d.tags.slice(0, 4) : [],
    services: Array.isArray(d.services) ? d.services.slice() : []
    /* 刻意不返回：license（执业证书编号）、photo（空路径）、email */
  };
}

/* ---------- 3. 诊疗项目 ---------- */
function priceView(svc) {
  const range = svc.price_range;
  if (range) {
    const unit = range.unit ? ' / ' + range.unit : '';
    return {
      price_text: formatCents(range.min_cents) + ' – ' + formatCents(range.max_cents) + unit,
      price_note: range.note || '参考区间，非最终报价'
    };
  }
  return {
    price_text: formatCents(svc.amount_cents) + ' 起',
    price_note: '演示参考价，非最终报价'
  };
}

function serviceView(svc) {
  const price = priceView(svc);
  return {
    id: svc.id,
    label: svc.label,
    desc: svc.desc || '',
    price_text: price.price_text,
    price_note: price.price_note
    /* 刻意不返回 amount_cents：小程序只负责展示，
       一旦下发「分」，前端就会有人拿它做加减，金额口径又多一处。 */
  };
}

/* ---------- 路由 ---------- */
router.get('/clinic', (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ clinic: clinicView() });
});

router.get('/doctors', (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  const ids = bookingIds();
  res.json({
    doctors: siteData.doctors.map((d) => doctorView(d, ids)),
    total: siteData.doctors.length
  });
});

router.get('/services', (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  const services = siteData.services.map(serviceView);
  /* 自检：每个项目的 id 必须能在计价表里查到。
     查不到说明 data.js 与 pricing.js 的校验被绕过了（例如有人手工改了表），
     这时宁可 500 也不要给小程序一个「点进去没有价格」的列表。 */
  const broken = services.filter((s) => !getService(s.id));
  if (broken.length) {
    return res.status(500).json({
      error: '服务项目与计价表不一致',
      code: 'PRICING_MISMATCH',
      ids: broken.map((s) => s.id)
    });
  }
  res.json({ services, total: services.length });
});

module.exports = router;
