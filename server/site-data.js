/* =========================================================
   server/site-data.js — 站点数据（assets/js/data.js）的唯一读取入口
   ---------------------------------------------------------
   为什么需要这个文件：
     data.js 是给浏览器用的（`window.SITE_DATA = {...}`，没有 module.exports）。
     第六期 pricing.js 已经用 vm 跑过一遍；第七期小程序接口又要用同一份数据。
     如果每个模块各写一次 vm 加载，就会出现「同一份文件被三种方式解析」，
     改一次 data.js 要验证三处 —— 这不是数据单一来源，只是文件单一。

   所以：加载逻辑收在这里，pricing.js 与 routes/public.js 都从这里取。

   两个实现细节：
     1) vm.runInNewContext 给一个只有 `window` 的空上下文，
        跑完直接读 window.SITE_DATA —— 不需要给 data.js 加 module.exports，
        也不需要构建步骤，file:// 打开仍然可用。
     2) 取到之后做一次 JSON 往返。vm 里创建的对象属于另一个 realm，
        Array.isArray 能过，但 instanceof Array / Object 会失败，
        跨模块传递时容易埋雷。往返一次就回到主 realm，代价是这点数据量可以忽略。
   ========================================================= */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'assets', 'js', 'data.js');

function load() {
  const src = fs.readFileSync(DATA_FILE, 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox, { filename: 'assets/js/data.js', timeout: 2000 });

  const raw = sandbox.window.SITE_DATA;
  if (!raw || typeof raw !== 'object') {
    throw new Error('[site-data] assets/js/data.js 没有挂载 window.SITE_DATA');
  }
  return JSON.parse(JSON.stringify(raw));
}

const DATA = load();

/* 启动即校验结构：与其上线后接口返回 undefined，不如第一次启动就红。
   这里只校验「有没有」，具体字段的合法性由使用方（pricing / public 路由）负责。 */
if (!DATA.clinic || typeof DATA.clinic !== 'object') {
  throw new Error('[site-data] SITE_DATA.clinic 缺失');
}
if (!Array.isArray(DATA.doctors) || !DATA.doctors.length) {
  throw new Error('[site-data] SITE_DATA.doctors 必须是非空数组');
}
if (!Array.isArray(DATA.services) || !DATA.services.length) {
  throw new Error('[site-data] SITE_DATA.services 必须是非空数组');
}

module.exports = {
  siteData: DATA,
  DATA_FILE
};
