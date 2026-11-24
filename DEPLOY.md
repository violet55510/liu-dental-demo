# DEPLOY.md — 把「刘氏口腔演示站」部署到 Render

> 给**第一次部署的人**看：每一步都写清「点哪里、填什么、看到什么算成功」。
> 全程免费，不需要信用卡（Render 免费层注册即可用），不需要 Docker。
>
> 本文只讲**部署**。项目本身是什么、功能边界在哪，见 `README.md`。
> 这是一套**学习演示系统**，不含真实医疗机构、不处理真实患者信息、不接真实支付。

---

## 目录

- [0. 这套部署是什么样子的](#0-这套部署是什么样子的)
- [1. 前置条件（三样东西，都免费）](#1-前置条件三样东西都免费)
- [2. 本地先自检（3 分钟，别把问题带到云端）](#2-本地先自检3-分钟别把问题带到云端)
- [3. 推到 GitHub（含具体命令）](#3-推到-github含具体命令)
- [4. 在 Render 上创建服务（Blueprint）](#4-在-render-上创建服务blueprint)
- [5. 等构建完成，拿到网址](#5-等构建完成拿到网址)
- [6. 验收：先看 /api/health，再看首页](#6-验收先看-apihealth再看首页)
- [7. 种子账号（老师登录用这个）](#7-种子账号老师登录用这个)
- [8. 必须知道的六件事（免费层的脾气）](#8-必须知道的六件事免费层的脾气)
- [9. 可选：固定密钥，让登录态不被重启清掉](#9-可选固定密钥让登录态不被重启清掉)
- [10. 可选：加持久盘（要付费）](#10-可选加持久盘要付费)
- [11. 小程序端怎么指向云端](#11-小程序端怎么指向云端)
- [12. 改完代码怎么重新部署 / 怎么回滚](#12-改完代码怎么重新部署--怎么回滚)
- [13. 常见问题（对着报错查）](#13-常见问题对着报错查)
- [附录 A：项目用到的环境变量](#附录-a项目用到的环境变量)
- [附录 B：部署相关文件清单](#附录-b部署相关文件清单)

---

## 0. 这套部署是什么样子的

```
GitHub 仓库（代码）
   │  push 到 main → Render 自动构建
   ▼
Render Web Service（Node 原生环境，免费层）
   │  npm install → npm start → node server/app.js
   ▼
https://<服务名>.onrender.com
   ├── /                → 官网首页（静态 5 页 + 4 个账户页）
   ├── /api/*           → Express 接口（认证 / 预约 / 订单 / 公开接口）
   └── /api/health      → 健康检查（Render 用它判断服务是否活着）
```

关键事实：**SQLite 文件在容器里，不在仓库里。** `data/` 被 `.gitignore` 排除，
云端第一次启动时 `server/db.js` 会自己建表、写 5 个种子账号、生成 196 个排班时段。
所以仓库里没有数据库，也不会把本地的演示数据（和你本机的 `.session-secret`）传上去。

---

## 1. 前置条件（三样东西，都免费）

| 需要 | 怎么准备 | 检查方式 |
| --- | --- | --- |
| GitHub 账号 | https://github.com/signup 注册 | 能登录、能看到自己的仓库列表 |
| Render 账号 | https://dashboard.render.com/ → **Get Started** → 选 **GitHub** 登录（不填信用卡） | 能进 Dashboard，左侧有 **Blueprints** |
| 本机 git | 命令行执行 `git --version` | 有输出即可（Windows 装 Git for Windows 自带） |

> Render 用 GitHub 登录后，第一次创建服务会要求**授权访问仓库**。
> 选 **Only select repositories** 只勾这一个仓库更稳妥（后面可随时改）。

---

## 2. 本地先自检（3 分钟，别把问题带到云端）

在仓库根目录（就是有 `package.json` 的那层）执行：

```bash
npm install
npm start
```

控制台应出现类似这几行（**看到 `已启动` 就对了**）：

```
刘氏口腔演示站已启动  http://localhost:3000
数据库：…\data\app.db
会话密钥：data/.session-secret（本次新生成）
令牌密钥：由会话密钥派生（HMAC-SHA256 / lsd/jwt/v1）（Bearer token 有效期 2 小时）
已创建种子账号：admin@demo.local, liu-implant@demo.local, …
```

另开一个终端验证两个地址：

```bash
# 期望：{"ok":true,"db":"app.db","users":5}
curl http://localhost:3000/api/health

# 期望：返回首页 HTML（不是 404）
curl -I http://localhost:3000/
```

浏览器打开 http://localhost:3000/ 看一眼首页正常，再 `Ctrl + C` 停掉服务。
**本地跑不起来就别往下走**——云端报错比本地难看得多。

---

## 3. 推到 GitHub（含具体命令）

### 3.1 在 GitHub 建一个空仓库

1. 右上角 **＋** → **New repository**
2. **Repository name** 填 `liu-dental-demo`（随便起，后面命令要对应）
3. 选 **Private**（推荐；课堂作业不必公开）或 Public 都行
4. **不要**勾 "Add a README file"、不要加 .gitignore、不要选 license（避免和本地文件打架）
5. 点 **Create repository**，页面会给你一个仓库地址，形如
   `https://github.com/<你的用户名>/liu-dental-demo.git`

### 3.2 在本地初始化并推送

在仓库根目录执行（把 `<你的用户名>` 换成你的 GitHub 用户名）：

```bash
git init -b main
git add .
git status          # 检查一遍：不该出现 data/、node_modules/、.workbuddy/
git commit -m "chore: 首次提交，准备部署到 Render"
git remote add origin https://github.com/<你的用户名>/liu-dental-demo.git
git push -u origin main
```

`git status` 那一步请真的看一眼，**必须看不到**这三类：

- `node_modules/`（依赖，云端会自己装）
- `data/`（本地数据库 + `.session-secret`，推上去等于公开会话密钥）
- `.workbuddy/`（本地日志与截图）

如果看到了，说明 `.gitignore` 没生效，先 `git rm -r --cached data` 再提交。

> 推送时如果要求身份验证：GitHub 现在不接受账号密码，需用 **Personal Access Token**
> 当密码（Settings → Developer settings → Personal access tokens → Fine-grained tokens，
> 勾选该仓库的 Contents: Read and write），或者装 GitHub Desktop 登录一次。

推送成功后刷新仓库页面，应能看到 `server/`、`assets/`、`*.html`、`render.yaml`、`package.json`。

---

## 4. 在 Render 上创建服务（Blueprint）

`render.yaml` 已经写好了服务类型、构建命令、启动命令和健康检查路径，所以在 Render 上**只需要指一下仓库**，不用手填。

1. 打开 https://dashboard.render.com/ ，右上角 **New +** → **Blueprint**
2. 第一次用会要求连接 GitHub：点 **Connect GitHub** → 授权（选 Only select repositories → 勾 `liu-dental-demo`）
3. 在仓库列表里找到并选中 `liu-dental-demo` → 点 **Connect**
4. 下一屏 Render 已经解析出 `render.yaml`，显示一个服务：

   | 字段 | 应显示 |
   | --- | --- |
   | Name | `liu-dental-demo` |
   | Runtime | Node |
   | Plan | Free |
   | Region | Singapore |
   | Build Command | `npm install` |
   | Start Command | `npm start` |
   | Health Check Path | `/api/health` |

5. **Blueprint Name** 随便填（如 `liu-dental`）→ 点 **Apply** / **Create Resources**

> 找不到 Blueprint 入口时的手动备选：**New +** → **Web Service** → 选仓库 →
> Runtime 选 **Node** → Build `npm install` → Start `npm start` → Plan **Free** →
> 在 **Environment** 里加 `NODE_ENV=production`、`DB_PATH=data/app.db` →
> Health Check Path 填 `/api/health` → **Create Web Service**。效果和蓝图一样，只是手填。

---

## 5. 等构建完成，拿到网址

创建后会自动开始构建，页面下方是实时日志。免费层一般 **2–5 分钟**，看到这两行就是好了：

```
==> Running 'npm start'
刘氏口腔演示站已启动  http://localhost:10000
```

> 端口由 Render 通过 `PORT` 环境变量注入（实例内部是 10000），
> 服务端代码是 `Number(process.env.PORT || 3000)`，所以你不用改任何东西。

日志里出现下列任一情况要停下来看 [第 13 节](#13-常见问题对着报错查)：

- `[启动失败] …`（密钥相关，通常不会在免费层出现）
- `Exited with status 1`
- 反复重启 / 健康检查失败

服务状态变成 **Live** 后，页面顶部就是你的网址：

```
https://liu-dental-demo.onrender.com      ← 你的服务名可能带随机后缀，以页面显示为准
```

把它复制下来，后面验收和发给老师都用这个。

---

## 6. 验收：先看 /api/health，再看首页

按顺序验三样，**顺序别换**（health 最快能告诉你「服务活没活」）：

**① 健康检查**

浏览器打开 `https://<你的网址>/api/health`，期望：

```json
{"ok":true,"db":"app.db","users":5}
```

- `ok: true` → 进程活着
- `users: 5` → 种子账号已经写进去了（1 管理员 + 4 医生）
- 打不开 / 502 → 见 [第 13 节](#13-常见问题对着报错查)

**② 首页**

打开 `https://<你的网址>/`，应看到「刘氏口腔」首页，电话、地址、今日门诊、8 项服务、4 位医师都在。
如果首页白屏但 health 正常，按 `F12` 看 Console 的报错（多半是被浏览器缓存了旧页面，`Ctrl + F5` 强刷）。

**③ 登录一次**

打开 `https://<你的网址>/login.html`，用 `admin@demo.local` / `Demo@1234` 登录，
应进入 `dashboard.html` 并看到「待审核」列表。这一步同时验证了 cookie 会话在 HTTPS 下能正常工作。

**④ 点几个页面确认没有 404**

`/services.html`、`/doctors.html`、`/appointment.html`、`/contact.html` 都应正常。
顺手确认一下 `https://<你的网址>/README.md` 是 **404**（说明静态白名单没失守）。

---

## 7. 种子账号（老师登录用这个）

**统一初始密码：`Demo@1234`**

| 角色 | 登录账号 | 说明 |
| --- | --- | --- |
| 管理员 | `admin@demo.local` | 审核医生申请、查看病人列表 |
| 医生 · 种植科 | `liu-implant@demo.local` | 刘主任 |
| 医生 · 正畸科 | `liu-ortho@demo.local` | 刘医生 |
| 医生 · 综合与牙周 | `liu-general@demo.local` | 刘医生 |
| 医生 · 儿童齿科 | `liu-kid@demo.local` | 刘医生 |

- 病人账号**没有种子**，请自行注册：`register.html` → 选「我是患者」→ 手机号 + 密码（8 位以上）。
- 医生账号登录后进入 `dashboard.html`，可对预约做确认 / 完成 / 未到诊 / 恢复。
- 医生**不能**自行注册，只能提交申请、由管理员审核（演示用，避免随便提权）。
- 这些账号是**演示数据**，密码写在文档里，真实项目绝不可这样。

---

## 8. 必须知道的六件事（免费层的脾气）

1. **15 分钟没人访问会休眠。** 免费实例空闲 15 分钟后自动挂起，**下一次访问要等 30–60 秒**冷启动
   （页面会转圈或直接 502 几秒）。这是免费层的正常行为，不是部署失败。
   **给老师发网址时请附一句「首次打开可能要等半分钟，刷新一下就好」。**
   想让它一直醒着需要付费实例，或者用外部定时任务每隔 10 分钟打一次 `/api/health`（不建议滥用）。
2. **没有持久磁盘，重启数据就没了。** 重新部署、实例重启、休眠后唤醒，容器都是全新的：
   `data/app.db` 消失 → 下次启动自动重新建表、重写种子。所以老师看到的是**干净的演示数据**。
   老师自己注册的账号、提交的预约，在下一次重启后会消失——这是可接受的取舍，不是 bug。
3. **重启后所有人都要重新登录。** 会话密钥 `data/.session-secret` 也在容器里，重启后重新生成，
   旧 cookie 与旧 token 全部失效。**这是预期行为。** 想让登录态跨重启保持，见 [第 9 节](#9-可选固定密钥让登录态不被重启清掉)。
4. **会话存在进程内存里。** 用的是 `express-session` 的 MemoryStore，免费层只有 1 个实例，
   所以能正常工作；但它**不适合多实例**，也不适合长期运行（会缓慢泄漏内存）。
   扩大规模要换 Redis 之类的共享存储——本项目不做。
5. **构建产物不含 `data/`、`node_modules/`、`.workbuddy/`。** 前者由 `.gitignore` 排除、
   后两者本地才有。`miniprogram/` 会跟着仓库上传，但**不会被网站托管**
   （服务端静态白名单只放行 9 个页面 + `/assets`），访问 `/miniprogram/...` 是 404。
6. **免费层有流量与构建时长限制。** 演示作业够用；连续频繁推代码可能排队。
   另外免费实例 CPU 很弱，`bcrypt` 用 10 轮哈希是刻意选的低成本参数（`BCRYPT_ROUNDS`）。

---

## 9. 可选：固定密钥，让登录态不被重启清掉

不配也能跑（每次重启换一把新钥匙）。若希望**重启后不用重新登录**，在 Render 控制台手动加两个环境变量：

1. 本地各生成一把密钥（跑两次）：

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. Render Dashboard → 点你的服务 → 左侧 **Environment** → **Add Environment Variable**：
   - Key `SESSION_SECRET`，Value 第一把（64 位 hex）
   - Key `JWT_SECRET`，Value 第二把（64 位 hex）
3. 点 **Save Changes**，服务会自动重新部署。

规则（写死在代码里，配错会**直接拒绝启动**，不会静默降级）：

- 两把都必须 **≥ 32 字符**（建议就用 64 位 hex）；
- 只配 `SESSION_SECRET` 不配 `JWT_SECRET` 也能跑（token 密钥从会话密钥派生）；
- 想强制要求独立 `JWT_SECRET`，再加一个 `JWT_REQUIRE_ENV=1`。

> 为什么默认不配：这是演示站，密钥泄露风险由「每次重启都换新的」抵消；
> 而固定密钥一旦随文档流出，等于所有人都能伪造管理员会话。

---

## 10. 可选：加持久盘（要付费）

要让数据真正留存（老师的注册与预约跨重启还在），必须挂持久盘，免费层没有。

1. 把服务 Plan 从 Free 改成 **Starter**（付费）；
2. 在服务页 **Disks** → **Add Disk**：Name `data`，Mount Path `/var/data`，Size 1 GB；
3. 到 **Environment** 把 `DB_PATH` 改成 `/var/data/app.db`；
4. 保存后重新部署。之后库与 `.session-secret` 都落在盘上（密钥文件跟库同目录）。

---

## 11. 小程序端怎么指向云端

小程序的后端地址只有一处：`miniprogram/config.js`

```js
module.exports = {
  BASE_URL: 'https://liu-dental-demo.onrender.com'
};
```

改完重新编译小程序即可。两点限制：

- **必须是 HTTPS**（Render 的域名自带证书），写成 `http://` 会被小程序拦掉；
- **真机预览**要求该域名在小程序后台配置为「request 合法域名」，而本项目不发布
  （个人主体不受理医疗类目），所以云端地址只在**开发者工具**里勾了「不校验合法域名」时能用。

老师只看网站的话，这一步可以跳过——小程序是额外的客户端，不影响网页访问。

---

## 12. 改完代码怎么重新部署 / 怎么回滚

**自动部署**：`render.yaml` 里 `autoDeploy: true`，push 到 `main` 就会自动构建部署。

```bash
git add .
git commit -m "fix: 改了什么"
git push
```

**手动触发**：Dashboard → 你的服务 → 右上角 **Manual Deploy** → **Deploy latest commit**。

**回滚**：Dashboard → **Events**（或 **Deploys**）→ 找到上一个成功的部署 →
右侧 **⋯** → **Rollback to this deploy**。回滚只换代码，数据库仍是当前的（免费层每次重启本来就会重建）。

---

## 13. 常见问题（对着报错查）

| 现象 | 原因 | 怎么修 |
| --- | --- | --- |
| 打开网址转圈 30–60 秒才出页面 | 免费实例休眠后被唤醒 | 正常。再刷一次就快；给老师的说明里写清这一点 |
| 502 / "Application failed to respond" | 实例还在冷启动，或已崩溃 | 等 60 秒再刷；仍不行看 **Logs** 里的 `Exited with status 1` |
| 构建失败：`npm ERR! ... better-sqlite3` | Node 版本不在预编译范围内 | 确认 `package.json` 的 `engines.node` 仍是 `22.x`；删掉 Render 上手动设的 `NODE_VERSION` 覆盖 |
| 构建成功但健康检查失败 | `/api/health` 不通（进程没起来） | 看 Logs：`[启动失败] …` 是密钥问题；`EADDRINUSE` 是端口写死（本项目用 `process.env.PORT`） |
| 首页 404、health 正常 | 访问了错误路径 | 首页是 `/`，账户页是 `/login.html` 这种带 `.html` 的形式 |
| `/README.md` 能打开 | 静态白名单失效 | 严重问题：确认 `server/app.js` 的白名单 + `BLOCKED` 两道闸没被改回 `express.static(ROOT)` |
| 登录后一刷新就掉登录 | cookie 没写进去（`secure` 在 HTTP 下不生效） | 确认访问的是 `https://`；本项目在 `NODE_ENV=production` 下要求 HTTPS |
| 登录报 429 | 登录接口有按 IP 限流 | 等一会儿再试；别在循环里试密码 |
| 数据"自己变回去了" | 实例重启，SQLite 是临时的 | 预期行为，见 [第 8 节](#8-必须知道的六件事免费层的脾气) |
| `connect.session() MemoryStore is not designed for production` | express-session 的告警 | 单实例演示可忽略；多实例必须换共享存储 |

---

## 附录 A：项目用到的环境变量

| 变量 | 默认 | 作用 | 部署时必须配吗 |
| --- | --- | --- | --- |
| `PORT` | `3000` | 监听端口，Render 会注入 | 不用（平台注入） |
| `DB_PATH` | `data/app.db` | SQLite 文件路径，相对仓库根 | 已在 `render.yaml` 里显式配 |
| `DB_FILE` | — | 回归脚本用的库路径（优先级低于 `DB_PATH`） | 不用 |
| `NODE_ENV` | — | `production` 时启用 `secure` cookie 与 trust proxy | 已在 `render.yaml` 里配 |
| `SESSION_SECRET` | 自动生成 | 会话签名密钥（≥ 32 字符） | 不用；想固定登录态才配 |
| `JWT_SECRET` | 由会话密钥派生 | Bearer token 密钥（≥ 32 字符） | 同上 |
| `JWT_REQUIRE_ENV` | — | `1` 时强制要求显式 `JWT_SECRET` | 不用 |
| `BCRYPT_ROUNDS` | `10` | 密码哈希轮数（回归脚本会调低到 4 提速） | 不用 |

## 附录 B：部署相关文件清单

| 文件 | 作用 | 能不能删 |
| --- | --- | --- |
| `render.yaml` | Render 蓝图：服务类型 / 构建 / 启动 / 健康检查 / 环境变量 | 删了就得在控制台手填 |
| `package.json` 的 `engines.node` | 固定 Node 22.x（`better-sqlite3` 的原生模块要匹配 ABI） | 不要删 |
| `package.json` 的 `scripts.start` | `node server/app.js`，Render 的启动命令 | 不要删 |
| `.gitignore` | 排除 `data/`（库与密钥）、`node_modules/`、`.workbuddy/` | 不要删 |
| `server/db.js` | 空库自举：建表 + 种子账号 + 排班（云端每次重启都靠它） | 不要删 |
| `miniprogram/config.js` | 小程序端后端地址（唯一一处） | 网页部署用不到，小程序要用 |

---

**部署完把网址发出去之前，自己先按 [第 6 节](#6-验收先看-apihealth再看首页) 走一遍。**
健康检查 200、首页正常、管理员能登录，这三条过了就算部署成功。
