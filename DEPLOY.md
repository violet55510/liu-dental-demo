# DEPLOY.md — 把「刘氏口腔演示站」部署到云端

> **主方案：Koyeb 免费实例（Docker 构建，不绑卡）。**
> **备选：Render（原方案，步骤完整保留在[附录 R](#附录-r备选路线-render原方案)）**——放弃的原因是 Render 免费层要绑信用卡验证，国内卡不被接受。
>
> 给**第一次部署的人**看：每一步都写清「点哪里、填什么、看到什么算成功」。
> 本文只讲**部署**。项目本身是什么、功能边界在哪，见 `README.md`。
> 这是一套**学习演示系统**，不含真实医疗机构、不处理真实患者信息、不接真实支付。

---

## 目录

- [0. 两条路线怎么选](#0-两条路线怎么选)
- [1. 前置条件（都免费）](#1-前置条件都免费)
- [2. 本地先自检（3 分钟，别把问题带到云端）](#2-本地先自检3-分钟别把问题带到云端)
- [3. 推到 GitHub（含具体命令）](#3-推到-github含具体命令)
- [4. 部署到 Koyeb（主方案）](#4-部署到-koyeb主方案)
- [5. 构建日志怎么读](#5-构建日志怎么读)
- [6. 验收：先看 /api/health，再看首页](#6-验收先看-apihealth再看首页)
- [7. 种子账号（老师登录用这个）](#7-种子账号老师登录用这个)
- [8. 免费实例的脾气（六件事）](#8-免费实例的脾气六件事)
- [9. 可选：固定密钥，让登录态不被重启清掉](#9-可选固定密钥让登录态不被重启清掉)
- [10. 小程序端怎么指向云端](#10-小程序端怎么指向云端)
- [11. 改完代码怎么重新部署 / 怎么回滚](#11-改完代码怎么重新部署--怎么回滚)
- [12. 常见问题（对着报错查）](#12-常见问题对着报错查)
- [附录 A：项目用到的环境变量](#附录-a项目用到的环境变量)
- [附录 B：部署相关文件清单](#附录-b部署相关文件清单)
- [附录 R：备选路线 Render（原方案）](#附录-r备选路线-render原方案)

---

## 0. 两条路线怎么选

| | **Koyeb（主方案，本文第 4 节）** | Render（备选，附录 R） |
| --- | --- | --- |
| 构建方式 | **Docker**（用仓库里的 `Dockerfile`） | 原生 Node 环境（用 `render.yaml`） |
| 免费实例要不要绑卡 | 不需要 | **需要验证信用卡**（国内卡常被拒 → 本次放弃的原因） |
| 免费实例 | 1 个 Web Service，空闲缩容到 0 | 1 个，空闲 15 分钟休眠 |
| 数据持久化 | 无（重启重建） | 无（重启重建） |
| 网址 | `https://<服务名>-<组织>.koyeb.app` | `https://<服务名>.onrender.com` |

两条路线的**代码是同一份**，只有「平台怎么把应用跑起来」不同：

```
GitHub 仓库（代码 + Dockerfile）
   │  push 到 main → Koyeb 自动构建镜像
   ▼
Docker 镜像（node:22-slim + node_modules + 源码 + 9 个静态页 + assets）
   │  容器启动：node server/app.js  监听 8000
   ▼
https://<服务名>-<组织>.koyeb.app
   ├── /                → 官网首页（5 个展示页 + 4 个账户页）
   ├── /api/*           → Express 接口（认证 / 预约 / 订单 / 公开接口）
   └── /api/health      → 健康检查 → {"ok":true,"db":"app.db","users":5}
```

关键事实：**SQLite 文件在容器里，不在镜像里。** 镜像不含 `data/`（`.dockerignore` 排除），
容器第一次启动时 `server/db.js` 自己建表、写 5 个种子账号、生成 196 个排班时段。
所以仓库里没有数据库，也不会把本机的演示数据（和 `.session-secret`）传到云端。

> **Docker 只用于云端构建，本地开发不需要它。** 你照旧 `npm install && npm start`；
> 只有想在本机验证镜像时才需要装 Docker（见第 2 节的「可选」）。

---

## 1. 前置条件（都免费）

| 需要 | 怎么准备 | 检查方式 |
| --- | --- | --- |
| GitHub 账号 | https://github.com/signup 注册 | 能登录、能看到自己的仓库列表 |
| Koyeb 账号 | https://app.koyeb.com/ → **Sign up** → 选 **GitHub** 登录。**免费实例不需要绑卡** | 能进控制台，能看到 **Create Service** 按钮 |
| 本机 git | 命令行执行 `git --version` | 有输出即可（Windows 装 Git for Windows 自带） |

> Koyeb 用 GitHub 登录后，第一次创建服务会要求**安装 Koyeb GitHub App 并授权仓库**。
> 选 **Only select repositories** 只勾这一个仓库更稳妥（后面可随时改）。

（备选路线 Render 的账号：https://dashboard.render.com/ → **Get Started** → GitHub 登录，
**会要求验证信用卡**。）

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

### 2.1 可选：在本机先验一次镜像（装了 Docker 才做）

没装 Docker 就跳过这一步，不影响部署（Koyeb 会在云端构建，见第 5 节的日志判读）。

```bash
docker build -t liu-dental-demo .
docker run --rm -p 8000:8000 \
  -e NODE_ENV=production -e DB_PATH=data/app.db -e PORT=8000 \
  liu-dental-demo
# 另开终端：curl http://localhost:8000/api/health
```

> 说明：本项目开发机上**没有装 Docker**，所以上面两条命令没在本机跑过；
> 「镜像内容是否正确」是用等价方式验的：按 `.dockerignore` 的排除规则把文件挑出来放进一个干净目录、
> 用 `npm ci --omit=dev` 装一份干净依赖，再以 `PORT=8000 DB_PATH=data/app.db NODE_ENV=production` 启动
> （结果见第 5 节末尾的实测）。真正的镜像构建由 Koyeb 执行。

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
git commit -m "chore: 首次提交，准备部署到 Koyeb"
git remote add origin https://github.com/<你的用户名>/liu-dental-demo.git
git push -u origin main
```

`git status` 那一步请真的看一眼，**必须看不到**这三类：

- `node_modules/`（依赖，镜像里会自己装）
- `data/`（本地数据库 + `.session-secret`，推上去等于公开会话密钥）
- `.workbuddy/`（本地日志与截图）

如果看到了，说明 `.gitignore` 没生效，先 `git rm -r --cached data` 再提交。

**必须能看到** `Dockerfile` 和 `.dockerignore`（Koyeb 靠前者构建；后者决定镜像里放什么）。
如果 `git status` 里没有它们，说明被 `.gitignore` 误伤了，检查一下。

> 推送时如果要求身份验证：GitHub 现在不接受账号密码，需用 **Personal Access Token**
> 当密码（Settings → Developer settings → Personal access tokens → Fine-grained tokens，
> 勾选该仓库的 Contents: Read and write），或者装 GitHub Desktop 登录一次。

推送成功后刷新仓库页面，应能看到 `Dockerfile`、`.dockerignore`、`server/`、`assets/`、`*.html`、`package.json`。

---

## 4. 部署到 Koyeb（主方案）

### 4.1 创建服务

1. 打开 https://app.koyeb.com/ ，用 **GitHub** 登录
2. 首次使用会要求授权仓库：**Install** → 选 **Only select repositories** → 勾 `liu-dental-demo` → **Install & Authorize**
3. 回到控制台，点 **Create Service**（有的界面写 **Create Web Service**，是同一个入口）
4. **Deployment method** 选 **GitHub** → 在仓库列表里选 `liu-dental-demo`
5. **Branch** 选 `main`

### 4.2 关键配置：Builder 必须选 Dockerfile

| 配置项 | 填什么 | 为什么 |
| --- | --- | --- |
| **Builder** | **Dockerfile**（不要选 Buildpack） | 仓库里有 `Dockerfile`，里面装了 `python3 make g++` 编译 `better-sqlite3`；选 Buildpack 走的是平台自动探测，控制不了这一步 |
| **Dockerfile location** | `Dockerfile`（仓库根目录，默认值） | 文件确实在根目录 |
| **Port** | `8000` | 与 `Dockerfile` 的 `EXPOSE 8000` / `ENV PORT=8000` 一致；Koyeb 会把 `PORT` 注入容器 |
| **Protocol** | `HTTP` | 这是网站 |
| **Path** | `/` | 默认值 |
| **Instance type** | **Free** | 免费实例，不绑卡 |
| **Region** | 只有带 Free 标记的区域可选（常见 Washington, D.C. / Frankfurt） | 免费档不是所有区域都提供；控制台里没有 Free 标记的区域要付费 |
| **Service name** | `liu-dental-demo` | 决定网址：`https://liu-dental-demo-<组织>.koyeb.app` |

### 4.3 环境变量（三个，逐个加）

在 **Environment variables**（有的界面叫 **Environment**）里点 **Add variable**：

| Key | Value | 作用 |
| --- | --- | --- |
| `NODE_ENV` | `production` | 打开 `secure` cookie 与 `trust proxy`（反向代理下限流才按真实 IP 计） |
| `DB_PATH` | `data/app.db` | SQLite 路径，相对镜像内的 `/app`；容器可写 |
| `PORT` | `8000` | 与应用监听端口一致（镜像里已有默认值，显式写一份更清楚） |

> 不用配 `SESSION_SECRET` / `JWT_SECRET`：首次启动会自动生成一把随机密钥。
> 代价是**每次重启都会换新密钥 → 已登录用户掉线**（属预期，见第 8 节）。
> 想让登录态跨重启保持，见[第 9 节](#9-可选固定密钥让登录态不被重启清掉)。

### 4.4 健康检查（建议加，30 秒的事）

同一页面的 **Health checks** / **Advanced** 里：

- Type：**HTTP**
- Port：`8000`
- Path：`/api/health`
- Grace period：默认即可（首次构建完启动要几秒）

不配也能用（默认是 TCP 端口探测），配了能更早发现「进程起来了但接口挂了」。

### 4.5 点 Deploy

点页面底部 **Deploy** / **Create Service**。之后自动开始构建，跳到 **Build logs**。
构建 + 启动一般 **3–6 分钟**（比 Render 的原生 Node 慢一点，因为要装编译工具链、打镜像）。

---

## 5. 构建日志怎么读

日志是按 `Dockerfile` 的步骤走的，认这几段就行：

```
Step 1/… : FROM node:22-slim AS builder
Step …   : RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++
            → Setting up python3 … make … g++ …            ← 编译工具链装好了
Step …   : RUN npm ci --omit=dev
            → added 123 packages in 25s                    ← 依赖装好（本机实测耗时，云端 30–90 秒）
Step …   : FROM node:22-slim AS runtime
Step …   : RUN mkdir -p /app/data && chown node:node /app/data
Step …   : exporting to image / pushing image               ← 镜像构建完成
```

镜像构建成功后，Koyeb 启动容器，应用自己的日志（这是**最该看的一段**）：

```
刘氏口腔演示站已启动  http://localhost:8000
数据库：/app/data/app.db
会话密钥：data/.session-secret（本次新生成）
令牌密钥：由会话密钥派生（HMAC-SHA256 / lsd/jwt/v1）（Bearer token 有效期 2 小时）
已创建种子账号：admin@demo.local, liu-implant@demo.local, liu-ortho@demo.local, liu-general@demo.local, liu-kid@demo.local
已生成种子排班：196 个时段（4 位医生 × 未来 14 天）
```

> 出现 `connect.session() MemoryStore is not designed for a production environment` 是**警告不是错误**：
> `express-session` 默认的内存存储不适合多实例，本项目是单实例演示，可以忽略（第 8 节第 4 条）。

看到服务状态变成 **Healthy**（或 **Running**）就是好了。日志里出现下列情况要停下来看
[第 12 节](#12-常见问题对着报错查)：

- `gyp ERR! find Python` / `gyp ERR! stack Error: not found: make`
- `invalid ELF header`
- `EACCES: permission denied, mkdir '/app/data'`
- `Exited with code 1` / 反复重启 / 健康检查失败

**等价环境实测（本机，`PORT=8000 DB_PATH=data/app.db NODE_ENV=production TZ=Asia/Shanghai`）：**

```
刘氏口腔演示站已启动  http://localhost:8000
数据库：…\app\data\app.db          ← data/ 不存在也能自建（db.js 里 mkdirSync recursive）
已创建种子账号：5 个                ← admin + 4 位医生
已生成种子排班：196 个时段

GET  /api/health        → 200 {"ok":true,"db":"app.db","users":5}
GET  /                  → 200        GET /services.html → 200
GET  /login.html        → 200        GET /payment.html  → 200
GET  /README.md         → 404        GET /Dockerfile    → 404
GET  /server/app.js     → 404        GET /data/app.db   → 404
GET  /api/public/doctors→ 200（4 位）
POST /api/login（模拟 HTTPS 代理头）→ 200 + token + Set-Cookie: Secure
```

---

## 6. 验收：先看 /api/health，再看首页

按顺序验四样，**顺序别换**（health 最快能告诉你「服务活没活」）。

**① 健康检查**

浏览器打开 `https://<你的网址>/api/health`，期望：

```json
{"ok":true,"db":"app.db","users":5}
```

- `ok: true` → 进程活着
- `users: 5` → 种子账号已经写进去了（1 管理员 + 4 医生）
- 打不开 / 502 → 见[第 12 节](#12-常见问题对着报错查)

**② 首页**

打开 `https://<你的网址>/`，应看到「刘氏口腔」首页，电话、地址、今日门诊、8 项服务、4 位医师都在。
如果首页白屏但 health 正常，按 `F12` 看 Console 的报错（多半是浏览器缓存，`Ctrl + F5` 强刷）。

**③ 登录一次**

打开 `https://<你的网址>/login.html`，用 `admin@demo.local` / `Demo@1234` 登录，
应进入 `dashboard.html` 并看到「待审核」列表。这一步同时验证了 cookie 会话在 HTTPS 下能正常工作。

**④ 点几个页面确认没有 404**

`/services.html`、`/doctors.html`、`/appointment.html`、`/contact.html` 都应正常。
顺手确认 `https://<你的网址>/README.md` 是 **404**（说明静态白名单没失守）。

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

## 8. 免费实例的脾气（六件事）

1. **空闲会缩容到 0，下次访问要冷启动。** 免费实例在空闲一段时间后自动停掉（具体空闲时长以控制台
   Free 计划说明为准），下一次访问要等**十几秒到一分钟**（页面转圈或 502 几秒）。
   这是正常行为，不是部署失败。**给老师发网址时请附一句「首次打开可能要等半分钟，刷新一下就好」。**
2. **没有持久磁盘，重启数据就没了。** 重新部署、实例重启、缩容后唤醒，容器都是全新的：
   `data/app.db` 消失 → 下次启动自动重新建表、重写种子。老师看到的是**干净的演示数据**。
   老师自己注册的账号、提交的预约，在下次重启后会消失——这是可接受的取舍，不是 bug。
3. **重启后所有人都要重新登录。** 会话密钥 `data/.session-secret` 也在容器里，重启后重新生成，
   旧 cookie 与旧 token 全部失效。**这是预期行为。** 想让登录态跨重启保持，见[第 9 节](#9-可选固定密钥让登录态不被重启清掉)。
4. **会话存在进程内存里。** 用的是 `express-session` 的 MemoryStore，免费层只有 1 个实例，
   所以能正常工作；但它**不适合多实例**，也不适合长期运行（会缓慢泄漏内存）。
   扩大规模要换 Redis 之类的共享存储——本项目不做。
5. **镜像里没有 `data/`、`node_modules/`（本机的）、`.workbuddy/`、`miniprogram/`、`scripts/`、文档。**
   前两类由 `.dockerignore` 排除：`node_modules` 必须在 linux 里重装（Windows 装的原生模块进容器会报
   `invalid ELF header`），`data/` 里有本机演示库和 `.session-secret`，绝不能进镜像。
   顺带的结果：容器里 `npm run test:*` 不可用（测试要本机浏览器），`/miniprogram/...` 也是 404。
6. **免费额度有限。** 免费档只有 1 个 Web Service，内存约 512 MB、共享 CPU（以控制台显示为准），
   构建也要排队。演示作业够用；连续频繁推代码会明显变慢。`bcrypt` 用 10 轮哈希是刻意选的低成本参数。

---

## 9. 可选：固定密钥，让登录态不被重启清掉

不配也能跑（每次重启换一把新钥匙）。若希望**重启后不用重新登录**，在 Koyeb 控制台加两个环境变量：

1. 本地各生成一把密钥（跑两次）：

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. Koyeb → 你的 Service → **Settings** → **Environment variables**（或 **Environment**）→ **Add variable**：
   - Key `SESSION_SECRET`，Value 第一把（64 位 hex）
   - Key `JWT_SECRET`，Value 第二把（64 位 hex）
3. 保存后服务会**自动重新部署**（Redeploy）。

规则（写死在代码里，配错会**直接拒绝启动**，不会静默降级）：

- 两把都必须 **≥ 32 字符**（建议就用 64 位 hex）；
- 只配 `SESSION_SECRET` 不配 `JWT_SECRET` 也能跑（token 密钥从会话密钥派生）；
- 想强制要求独立 `JWT_SECRET`，再加一个 `JWT_REQUIRE_ENV=1`。

> 为什么默认不配：这是演示站，密钥泄露风险由「每次重启都换新的」抵消；
> 而固定密钥一旦随文档流出，等于所有人都能伪造管理员会话。

**注意：固定密钥只保住「登录态」，保不住「数据库」。** 免费实例没有持久盘，
账号与预约仍会在重启后消失（第 8 节第 2 条）。要数据也留住，只能换付费实例 + 持久卷，
本项目不做（Render 那边的对应做法见附录 R 的「持久盘」一节）。

---

## 10. 小程序端怎么指向云端

小程序的后端地址只有一处：`miniprogram/config.js`

```js
module.exports = {
  BASE_URL: 'https://liu-dental-demo-<组织>.koyeb.app'
};
```

改完重新编译小程序即可。两点限制：

- **必须是 HTTPS**（Koyeb 的 `koyeb.app` 域名自带证书），写成 `http://` 会被小程序拦掉；
- **真机预览**要求该域名在小程序后台配置为「request 合法域名」，而本项目不发布
  （个人主体不受理医疗类目），所以云端地址只在**开发者工具**里勾了「不校验合法域名」时能用。

老师只看网站的话，这一步可以跳过——小程序是额外的客户端，不影响网页访问。

---

## 11. 改完代码怎么重新部署 / 怎么回滚

**自动部署**：Koyeb 连接 GitHub 后默认「push 即部署」。

```bash
git add .
git commit -m "fix: 改了什么"
git push
```

推送后到服务页的 **Deployments**（或 **Overview**）能看到一次新的构建自动开始。
（如果不想自动部署，可在 Service → Settings 里关掉 auto-deploy，之后用下面的手动方式。）

**手动触发**：服务页右上角 **Redeploy** → 选 **Use latest commit** → 确认。
**只想重启不改代码**：同一个按钮里选 **Restart**（不重新构建）。

**回滚**：**Deployments** 列表 → 找到上一个成功的部署 → 右侧 **⋯** →
**Redeploy**（或 **Rollback**）。回滚只换代码/镜像，数据库仍是当前的（免费层每次重启本来就会重建）。

> 改了 `Dockerfile` 或 `package.json` 的依赖，必须**重新构建**（Redeploy），只 Restart 不会生效。

---

## 12. 常见问题（对着报错查）

| 现象 | 原因 | 怎么修 |
| --- | --- | --- |
| 打开网址转圈十几秒到一分钟才出页面 | 免费实例缩容到 0 后被唤醒 | 正常。再刷一次就快；给老师的说明里写清这一点 |
| 502 / "no healthy instances" | 实例还在冷启动，或已崩溃 | 等 60 秒再刷；仍不行看 **Logs**，找 `Exited with code 1` |
| 构建失败：`gyp ERR! find Python` | builder 阶段没装 python3 | `Dockerfile` 里那行 `apt-get install -y python3 make g++` 被删了或写错，恢复它 |
| 构建失败：`gyp ERR! stack Error: not found: make` | 同上，缺 make/g++ | 同上 |
| 运行时报 `invalid ELF header` / `is not a valid Win32 application` | 把 Windows 的 `node_modules` 打进了镜像 | 确认 `.dockerignore` 第一行 `node_modules` 还在；本地别 `git add -f node_modules` |
| 启动报 `EACCES: permission denied, mkdir '/app/data'` | 改成 `USER node` 但没建目录 / 没给属主 | `Dockerfile` 里的 `mkdir -p /app/data && chown node:node /app/data` 不能删 |
| 构建成功但健康检查一直失败 | 端口不是 8000，或没监听 0.0.0.0 | 服务里 **Port** 填 8000；`PORT` 环境变量也设 8000；代码是 `app.listen(process.env.PORT)`，别写死 |
| 首页 404、health 正常 | 访问了错误路径 | 首页是 `/`，账户页是 `/login.html` 这种带 `.html` 的形式 |
| `/README.md`、`/Dockerfile` 能打开 | 静态白名单失效 | 严重问题：确认 `server/app.js` 的白名单 + `BLOCKED` 两道闸没被改回 `express.static(ROOT)` |
| 登录后一刷新就掉登录 | cookie 没写进去（`secure` 在 HTTP 下不生效） | 确认访问的是 `https://`，且 `NODE_ENV=production` 已配 |
| 登录报 429 | 登录接口有按 IP 限流 | 等一会儿再试；别在循环里试密码 |
| 数据"自己变回去了" | 实例重启，SQLite 是临时的 | 预期行为，见[第 8 节](#8-免费实例的脾气六件事) |
| `connect.session() MemoryStore is not designed for production` | express-session 的告警 | 单实例演示可忽略；多实例必须换共享存储 |
| 控制台里没有 **Free** 实例类型 | 账号已有 1 个免费服务，或所选区域不提供免费档 | 删掉/暂停旧服务，或换到带 Free 标记的区域 |
| 构建特别慢（5 分钟以上） | 免费档构建排队 + 装编译工具链 + 打镜像 | 正常；终端里等，别反复点 Redeploy（会重复排队） |
| 想省构建时间 | `Dockerfile` 先 `COPY package*.json` 再 `npm ci`，源码改动不会让依赖层失效 | 已按这个顺序写好了，别把两步合并 |

---

## 附录 A：项目用到的环境变量

| 变量 | 默认 | 作用 | 部署时必须配吗 |
| --- | --- | --- | --- |
| `PORT` | `3000`（镜像里 `ENV PORT=8000`） | 监听端口 | 要：Koyeb 服务里 Port 与 `PORT` 都设 8000 |
| `DB_PATH` | `data/app.db` | SQLite 文件路径，相对应用根（镜像内 `/app`） | 要：`data/app.db` |
| `DB_FILE` | — | 回归脚本用的库路径（优先级低于 `DB_PATH`） | 不用（镜像里没有 `scripts/`） |
| `NODE_ENV` | — | `production` 时启用 `secure` cookie 与 `trust proxy` | 要：`production` |
| `TZ` | 镜像里设为 `Asia/Shanghai` | 「今日门诊」「时段是否已过」按这个时区算 | 不用改 |
| `SESSION_SECRET` | 自动生成 | 会话签名密钥（≥ 32 字符） | 不用；想固定登录态才配 |
| `JWT_SECRET` | 由会话密钥派生 | Bearer token 密钥（≥ 32 字符） | 同上 |
| `JWT_REQUIRE_ENV` | — | `1` 时强制要求显式 `JWT_SECRET` | 不用 |
| `BCRYPT_ROUNDS` | `10` | 密码哈希轮数（回归脚本会调低到 4 提速） | 不用 |

## 附录 B：部署相关文件清单

| 文件 | 作用 | 能不能删 |
| --- | --- | --- |
| `Dockerfile` | Koyeb 的镜像定义：Node 22 slim + python3/make/g++ + `npm ci --omit=dev` + 非 root 运行 + 8000 端口 | **不能删**（Koyeb 选 Dockerfile 构建就靠它） |
| `.dockerignore` | 决定哪些文件不进镜像：`node_modules`、`data`、`.git`、`.workbuddy`、`miniprogram`、`scripts`、文档 | **不能删**（删了会把本机 `node_modules` 和演示库打进镜像） |
| `render.yaml` | Render 蓝图（备选路线用）：服务类型 / 构建 / 启动 / 健康检查 / 环境变量 | 用 Koyeb 时没作用，但留着不碍事 |
| `package.json` 的 `engines.node` | 固定 Node 22.x（`better-sqlite3` 的原生模块要匹配 ABI） | 不要删 |
| `package.json` 的 `scripts.start` | `node server/app.js`，容器的启动命令（`CMD` 也是它） | 不要删 |
| `package-lock.json` | `npm ci` 依赖它做版本可复现安装 | **不能删**（删了 `npm ci` 直接失败） |
| `.gitignore` | 排除 `data/`（库与密钥）、`node_modules/`、`.workbuddy/` | 不要删 |
| `server/db.js` | 空库自举：建表 + 种子账号 + 排班（云端每次重启都靠它） | 不要删 |
| `miniprogram/config.js` | 小程序端后端地址（唯一一处） | 网页部署用不到，小程序要用 |

---

## 附录 R：备选路线 Render（原方案）

> **为什么是「备选」**：Render 免费层创建服务时要求验证信用卡，国内卡不被接受，所以主方案换到了 Koyeb。
> 这一段原样保留，便于以后有可用卡、或改用 Render 付费层时直接照做。**仓库里的 `render.yaml` 也一直在。**

### R.1 在 Render 上创建服务（Blueprint）

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
> Render 走原生 Node 环境，**不使用** `Dockerfile`。

### R.2 等构建完成

免费层一般 **2–5 分钟**，看到这两行就是好了：

```
==> Running 'npm start'
刘氏口腔演示站已启动  http://localhost:10000
```

> 端口由 Render 通过 `PORT` 环境变量注入（实例内部是 10000），
> 服务端代码是 `Number(process.env.PORT || 3000)`，所以你不用改任何东西。

状态变 **Live** 后，页面顶部就是网址：`https://liu-dental-demo.onrender.com`
（服务名可能带随机后缀，以页面显示为准）。

### R.3 Render 免费层的脾气

- **15 分钟没人访问会休眠**，下次访问要等 30–60 秒冷启动；
- 其余与 Koyeb 相同：无持久盘、重启重建数据库、重启掉登录、单实例 MemoryStore；
- 环境变量在 **Environment** 标签页配；
- 重新部署：push 到 `main` 自动部署，或 **Manual Deploy** → **Deploy latest commit**；
- 回滚：**Events** / **Deploys** → 上一个成功的部署 → **⋯** → **Rollback to this deploy**。

### R.4 可选：加持久盘（要付费）

要让数据真正留存，必须挂持久盘，免费层没有。

1. 把服务 Plan 从 Free 改成 **Starter**（付费）；
2. 在服务页 **Disks** → **Add Disk**：Name `data`，Mount Path `/var/data`，Size 1 GB；
3. 到 **Environment** 把 `DB_PATH` 改成 `/var/data/app.db`；
4. 保存后重新部署。之后库与 `.session-secret` 都落在盘上（密钥文件跟库同目录）。

> Koyeb 的持久卷同样是付费能力，配置方式见 Koyeb 控制台 **Volumes**；
> 挂载后把 `DB_PATH` 指到挂载点下的文件即可，逻辑与这里一致。

---

**部署完把网址发出去之前，自己先按[第 6 节](#6-验收先看-apihealth再看首页)走一遍。**
健康检查 200、首页正常、管理员能登录，这三条过了就算部署成功。
