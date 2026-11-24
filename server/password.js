/* =========================================================
   server/password.js — bcrypt 适配层
   ---------------------------------------------------------
   算法就是 bcrypt（$2b$、60 字符、自带 salt），只是实现可换：

   1. 优先用 `bcrypt`（node-bcrypt，C++ 原生）——多数机器装得上
   2. 装不上时退到 `@node-rs/bcrypt`（Rust 实现，带 Windows 预编译）
   3. 两者产出的哈希格式完全一致，可互相校验，所以换实现不用迁移数据

   本机（无 MSVC 编译链）走的是第 2 条：bcrypt 需要 node-gyp 现场编译，
   装不上；@node-rs/bcrypt 直接下载预编译二进制，装得上。
   ========================================================= */
'use strict';

function tryRequire(name) {
  try { return require(name); } catch { return null; }
}

const nativeBcrypt = tryRequire('bcrypt');
const rsBcrypt = tryRequire('@node-rs/bcrypt');

const impl = nativeBcrypt ? 'bcrypt' : (rsBcrypt ? '@node-rs/bcrypt' : null);
if (!impl) {
  throw new Error('缺少 bcrypt 实现：请安装 bcrypt 或 @node-rs/bcrypt');
}

const DEFAULT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 10);

async function hashPassword(plain, rounds = DEFAULT_ROUNDS) {
  if (nativeBcrypt) return nativeBcrypt.hash(plain, rounds);
  return rsBcrypt.hash(plain, { cost: rounds });
}

function hashPasswordSync(plain, rounds = DEFAULT_ROUNDS) {
  if (nativeBcrypt) return nativeBcrypt.hashSync(plain, rounds);
  return rsBcrypt.hashSync(plain, { cost: rounds });
}

async function verifyPassword(plain, hash) {
  if (nativeBcrypt) return nativeBcrypt.compare(plain, hash);
  return rsBcrypt.compare(plain, hash);
}

function verifyPasswordSync(plain, hash) {
  if (nativeBcrypt) return nativeBcrypt.compareSync(plain, hash);
  return rsBcrypt.compareSync(plain, hash);
}

module.exports = {
  impl,
  DEFAULT_ROUNDS,
  hashPassword,
  hashPasswordSync,
  verifyPassword,
  verifyPasswordSync
};
