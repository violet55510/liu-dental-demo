# 齿记工具助手 · 演示站点

> **本节为期末作业的交付说明**，与仓库根目录的 [作业交付说明.md](./作业交付说明.md) 内容一致（若两者有出入，以该文件为准）。
> 老师检查时建议先读这一节；实现细节、设计取舍与每期的验证记录在后面各章。

## 期末作业交付说明

> 课程：系统分析与设计　|　姓名：刘洋　|　学号：1602240110　|　班级：信管2401　|　提交日期：2026-11-24

### 一、项目简介

本项目是一个面向口腔诊所的业务演示系统。后端使用 **Node.js + Express**，数据存储使用 **SQLite**（`better-sqlite3`），前端为原生 HTML / CSS / JavaScript（不使用前端框架），另有一套微信小程序客户端。系统按使用对象分为两端：

| 端 | 使用者 | 主要功能 |
| --- | --- | --- |
| **Web 端** | 医生、管理员、病人 | 诊所展示页（首页 / 医师团队 / 诊疗项目 / 联系我们）、注册与登录、在线预约、我的预约与取消、医生工作台（确认 / 完成 / 标记未到诊 / 恢复）、管理员审核医生入驻、模拟支付与退款 |
| **小程序端** | 病人 | 诊所信息、医师团队、诊疗项目、注册登录、预约挂号、取消预约、我的预约、模拟支付与退款（不接微信支付） |

技术上重点做了以下几件事（也是本项目的考察点）：

1. **权限以数据库为准**：每次请求都回库查 `role` 与 `status`，不信任前端传值，也不信任 session / token 里缓存的角色；管理员停用账号后立即生效。
2. **预约状态机**：`pending → confirmed → completed / no_show / cancelled` 共 8 条合法转换（含 `no_show → confirmed` 与 `completed → confirmed` 两条纠错边），非法转换统一返回 `409`，并把「当前状态 + 期望状态」一并告诉前端。
3. **防重复预约交给数据库**：同一时段用部分唯一索引 `ux_appt_active_slot` 保证只能有一条有效预约，不在应用层写「先查有没有、再插入」。
4. **价格只有一个来源**：金额维护在 `assets/js/data.js` 的 `services[]`（整数分），服务端启动时读取并校验；下单金额完全由服务端计算，不接收前端传来的金额。
5. **双凭证认证**：Web 用 cookie 会话，小程序用 JWT Bearer，两条通道解析出同一个身份，业务代码不需要分叉。
6. **支付为模拟支付**：只有「下单 / 支付 / 退款」的状态流转与幂等、越权校验，**不接入任何真实支付通道**。

主要依赖：Node.js 22.x、Express 4、`better-sqlite3`、`express-session`、`jsonwebtoken`、`bcrypt`（`@node-rs/bcrypt`）。

---

### 二、Web 端使用指南

#### 2.1 访问地址

系统已部署到云端，**无需在本地安装任何环境**即可直接检查：

**https://liu-dental.app.workbuddy.host/?sharecode=VN5PSCMXE4**

> 请把整条链接一起打开（末尾的 `?sharecode=...` 是访问凭证），缺少参数会提示「链接不完整」。

**Web 端与小程序端共用同一份数据库。** 这个网址只是「门」：页面与静态资源由这里提供，所有 `/api` 请求由服务端转发到同一台权威后端（腾讯云托管），因此——在 Web 端注册的病人，用同一个手机号在小程序里登录看到的是同一个账号；在 Web 端约的号，小程序「我的预约」里也在，反过来也一样。同一个手机号不需要在两个端各注册一次。

> 判断依据：两个入口的 `/api/health` 返回的 `users` 数字必须相同。数字不同就说明它们连的是两个库（本项目早期踩过这个坑，排查与修复见 `DEPLOY.md` §12.10）。

#### 2.2 演示账号

密码统一为 **`Demo@1234`**，账号如下：

| 角色 | 账号 | 可以做什么 |
| --- | --- | --- |
| 管理员 | `admin@demo.local` | 查看全部用户、审核医生入驻申请、调整账号状态 |
| 医生（种植科） | `liu-implant@demo.local` | 在自己的工作台里确认 / 完成 / 标记未到诊 / 恢复预约 |
| 医生（正畸科） | `liu-ortho@demo.local` | 同上 |
| 医生（综合与牙周） | `liu-general@demo.local` | 同上 |
| 医生（儿童口腔） | `liu-kid@demo.local` | 同上 |

#### 2.3 登录与注册

- **登录**：打开首页右上角「登录」，或在地址栏直接访问 `/login.html`，输入上表的账号与密码。
- **注册（病人）**：在 `/register.html` 用手机号自助注册，注册成功后再登录即可预约。注册接口**不接受前端指定角色**，一律落库为病人（`patient`）。
- **医生账号不能自助注册**：医生需在「医生入驻申请」提交资料，落库为待审核（`pending`），由管理员在控制台审核通过后才可登录。这样设计是为了避免「自己注册一个医生账号就能看别人预约」。

#### 2.4 建议的验收路径（约 5 分钟）

1. 用**病人**身份注册并登录 → 「预约挂号」选择医师、日期、时段与项目 → 提交，状态为「待确认」。
2. 换用该医师的账号登录 → 控制台工作台出现这条预约 → 点「确认」。**「标记完成」要等预约时段开始之后**（提前点会被拒绝，提示 `TOO_EARLY`）——这是防止「把明天的预约今天标成已完成」的闸门。
3. 换回病人账号 → 「我的预约」查看详情；对另一条预约点「取消」。**时段开始前都可以自助取消**，已支付的会在同一笔操作里一并退款；时段已开始则需电话联系门诊（规则由服务端计算，前端不自己判断）。
4. 病人 → 我的预约 → 打开未支付的订单 → 进入支付页完成「支付」或「退款」。**这是模拟支付，不会产生任何真实扣款。**
5. 管理员登录 → 控制台查看待审核的医生申请并通过一条，再用该医生账号登录验证权限已生效。

---

### 三、小程序端使用指南（请重点查看）

#### 3.1 代码位置

小程序代码在仓库根目录的 **`miniprogram/`** 文件夹内，是一个独立工程（`project.config.json` 就在该目录中，`miniprogramRoot` 为 `./`），共 9 个页面、5 个底部 tab，只实现**病人端**；医生端与管理端保留在 Web 端。

小程序病人端也能完成**模拟支付与退款**：我的预约 → 某条预约 → 「去支付」→ 弹窗显示服务端算出的金额 → 确认后订单变「已支付」；已支付的可以「申请退款」。金额不由前端传，接口只接受预约记录里的服务项目；这是**模拟**流程，不调用微信支付、不产生任何真实扣款。

#### 3.2 上线进展：体验版已开通，正式版审核整改中

小程序已上传**体验版**，并且**已把老师的微信号加入本小程序的「体验成员」**（体验版与开发版都可打开查看）。后端已部署到云端（腾讯云托管，公网 HTTPS 地址 `https://springboot-vaij-353722-13-1540473897.sh.run.tcloudbase.com`），所以**不再要求手机与作者电脑连同一个网络，也不需要电脑一直开机**：4G、家里 Wi-Fi、校园网都能用。

**正式版已进入审核流程**。2026-11-26 收到整改意见：名称「刘氏牙齿」容易被判定为**医疗机构 / 企业名称**，而个人主体不能以机构名义运营，审核员建议改为「××助手」形式。处理方式：

- 小程序名称改为 **齿记工具助手**，定位从「一家诊所」调整为「口腔护理预约与记录工具」；
- 同步替换 Web 端 9 个页面、小程序页面标题、页脚版权、`data.js`、服务端启动日志与文档中的旧品牌名，共 37 个文件、163 处；
- 首页标题与首屏标语里的「专科 / 门诊」改为「预约服务」，联系我们页不再提示「导航搜索门诊名称」，避免继续出现机构经营信息。

> 改名只影响展示，不影响功能与数据：账号、预约、订单仍在同一份云端库里，访问链接、AppID、后端地址全部不变。

> **品牌名有两个来源，别只改仓库。** Web 页面是本地 HTML（改文件即可）；小程序首页的诊所卡片读的是云端 `/api/public/clinic`，而它由**云端容器里那份** `assets/js/data.js` 决定。只改仓库、不重新部署后端，小程序首页仍会显示旧名——必须按 `DEPLOY.md` §12.4 重新部署一次云托管。

小程序访问云端的通道不变：**微信云托管通道**（`wx.cloud.callContainer`），请求由微信内部网关直达容器，**不受「request 合法域名」限制**——不用买域名、不用配置域名白名单，也**不需要打开「开发调试」**。

> ⚠️ 云端后端是**唯一的数据所在**（Web 端与小程序都连它），但容器文件系统不是持久卷：**重新部署或实例重建会回到初始演示数据**（5 个账号 + 196 个排班时段）。检查期间请不要重新部署；需要长期保存数据，应给容器挂载云文件存储（见 `DEPLOY.md` §12.9）。

#### 3.2.1 开发版 / 体验版 / 正式版 的差别

| 版本 | 谁能打开 | 域名校验 | 本项目状态 |
| --- | --- | --- | --- |
| 开发版 | 开发者工具、开发者本人 | 可关闭（「详情 → 本地设置」） | ✅ 可运行 |
| 体验版 | 体验成员（老师微信号已加入） | **不校验**（走云托管通道，请求不经域名白名单） | ✅ 已上传 |
| 正式版 | 任何人扫码 / 搜索 | 同样不校验域名，但须先完成**小程序备案**并通过审核 | ⏳ 审核整改中（名称已改，重新提审） |

**「服务器域名」这一关本项目已经绕开了**：走云托管通道的请求不受域名白名单约束，所以既不用买域名，也不用配置 request 合法域名——这就是「用云开发 / 云托管无需配置服务器域名」的实际含义。

正式版剩下的是账号层面两件事：**小程序备案**（2023 年 9 月起，上架前的必备手续）与**服务类目审核**（本项目的名称与内容不能读起来像医疗机构经营信息，本次整改即属此类）。两项都在开发者后台完成，不涉及代码改动。

#### 3.3 本地运行步骤

1. **安装微信开发者工具**（稳定版），用微信扫码登录。
2. **导入项目**：选择「导入项目」，目录**选到 `miniprogram` 文件夹本身**（不要选仓库根目录）。
3. **AppID**：可填自己的小程序 AppID 或使用「测试号」；仓库里保留的是开发时使用的 AppID，导入时改成自己的即可。
4. **启动后端**：在仓库根目录执行
   ```bash
   npm install
   npm start
   ```
   **Node.js 版本须为 22.x.x**（`better-sqlite3` 是原生模块，Node 大版本不一致可能装不到对应的预编译包）。默认监听 3000 端口，控制台会打印本机地址、局域网地址（含网卡名）与数据库路径。
5. **改后端地址**：打开 `miniprogram/config.js`，把 `BASE_URL` 改成**你自己电脑的局域网 IPv4 地址**，例如：
   ```js
   module.exports = { BASE_URL: 'http://192.168.1.5:3000' };
   ```
   （Windows 在命令行执行 `ipconfig`，取「无线局域网适配器 WLAN」下的 **IPv4 地址**；macOS 在「系统设置 → 网络」中查看。）
   > 仓库里当前填的是**云端后端地址** `https://springboot-vaij-353722-13-1540473897.sh.run.tcloudbase.com`（作者部署的演示后端，克隆下来直接就能用，不依赖任何本机服务）。要连**自己本机**的后端，把这一行改成 `http://localhost:3000`（只在电脑模拟器里看），或本机的局域网 IPv4（手机真机调试，Windows 用 `ipconfig` 查「无线局域网适配器 WLAN」下的地址）；改完在开发者工具点一次「编译」。
   > 用局域网 IP 时，校园网/公司网络常开**终端隔离**，同一 Wi-Fi 下的手机未必能访问到电脑；连不通时优先用模拟器，或看 `DEPLOY.md` 第 11 节的内网穿透。
> 另外：`config.js` 里的 `CLOUD.enabled` 默认是 `true`（走云托管），**本机开发请改成 `false`**，否则每个请求都会先试一次云通道再回退，白等一轮。
6. **手机与电脑连接同一个 Wi-Fi**（同一局域网），在开发者工具点「预览」，用手机扫码打开；只在电脑模拟器里调试则可保留 `localhost`。
7. **关闭域名校验**：开发者工具右上角「详情 → 本地设置」勾选「**不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书**」——因为本地是 `http` + IP 直连，没有配置 HTTPS 域名。

#### 3.4 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 页面提示网络错误 / 请求超时 | 用手机浏览器打开 `https://springboot-vaij-353722-13-1540473897.sh.run.tcloudbase.com/api/health`，应返回 `{"ok":true,"db":"app.db","users":N}`（N 是当前账号数，会随注册增长）（最小实例为 0 时首次要等 10–30 秒冷启动）。云端正常还报错，就是域名白名单问题，见下一条 |
| 提示 `url not in domain list` | 说明请求退回了「公网域名」通道（云通道没用上），而该默认域名不许配进白名单。先按 `DEPLOY.md` §12.8 核对 `CLOUD.service` 等服务名；临时可开「开发调试」放行，但正常状态下不该出现这条 |
| 连自己本机后端时连不上 | 确认第 4、5、6 步都做了，并用手机浏览器打开 `http://<你的IP>:3000/api/health` 验证 |
| 开发者工具里白屏 / 只显示「加载失败」 | 看红字定位：若含 `url not in domain list`，按第 7 步勾「不校验合法域名」再「清缓存 → 全部清除」重新编译；若提示连不上后端，用浏览器打开 `https://…/api/health` 验证云端是否在跑。另外导入目录必须是 `miniprogram` 本身，选成仓库根目录会直接报找不到 `app.json` |
| 手机能打开网页、小程序却连不上 | Windows 防火墙拦了 Node，放行「专用网络」即可 |
| 登录成功但后续请求 401 | 检查 `config.js` 是否已从 `localhost` 改成局域网 IP，改完需重新编译（工具里点「编译」） |
| 后端端口不是 3000 | 若用 `PORT=8000 npm start` 启动，`BASE_URL` 里也要写 `8000`，两处必须一致 |
| 首次打开列表为空 | 后端首次启动会自动建表并写入演示数据（5 个账号 + 196 个排班时段），稍等几秒刷新 |
| 老师手机上打开体验版提示网络错误 | 先用手机浏览器打开云端 `/api/health`，确认后端在跑（最小实例为 0 时冷启动 10–30 秒）；能打开说明是通道问题，见上一条 |

> **「同一网络 + 改 IP」这两步已经不需要了。** 后端在云端，小程序通过微信云托管通道访问它；
> 手机用流量就能用，电脑可以关机。
>
> 云端有两种接法，本项目**用的是第一种**：
>
> - **`wx.cloud.callContainer`**（当前采用）：免域名、免备案、免「开发调试」。前提是 `CLOUD.service` 填**服务名**
>   （`springboot-vaij`，不带 `-001`），且云托管环境属于本小程序；
> - **公网域名**（仅作自动降级）：本质就是换一个 HTTPS 地址，通不通用浏览器打开 `/api/health` 就能确认；
>   但云托管的**默认域名不许配进 request 合法域名**（官方限制），只能靠「开发调试」放行。
>
> 完整步骤见 [`DEPLOY.md` 第 12 节](DEPLOY.md#12-微信云托管让小程序摆脱同网络--改-ip)，云托管通道在 §12.8。

---

### 四、数据与占位说明

- 门牌地址、医师真实姓名与职称、执业证号、照片等展示信息**留白或使用 ×× / 「待填充」占位**，属于演示模板，不代表真实机构，检查时可忽略。
- 诊疗价格只给区间示意，页面已注明「以现场结算与当地医保政策为准」；文案避免绝对化疗效表述，符合医疗类内容的常规要求。
- 云端演示环境的数据库为容器内文件，**每次重新部署会回到初始演示数据**，属正常现象；本地执行 `npm run reset-db` 也可重置。

---

### 五、声明

本项目为本人课程学习与期末作业用途，**未用于任何商业用途**，不对外提供真实医疗服务，也不收集、不存储真实患者信息。

系统内的支付流程为**模拟支付**，不接入支付宝、微信支付或任何第三方支付通道，不采集银行卡号、二维码或商户信息，**不会产生真实扣款**。

页面中出现的机构名称、地址、电话、医师姓名、执业证号、照片等均为示例或占位内容，与任何真实机构、真实人员无关，敬请谅解并忽略。

---

### 六、附：本地运行与自测

```bash
npm install          # 安装依赖（需 Node.js 22.x）
npm start            # 启动服务，默认 http://localhost:3000
npm run reset-db     # 重置演示数据（需先停止服务）

# 自动化回归（需本机已安装 Edge 浏览器，脚本会自行起临时库与临时端口）
npm run test:api     # 接口回归：22 组 / 266 条断言
npm run test:race    # 并发防重：2 组 / 7 条
npm run test:ui      # 展示页交互：7 组 / 31 条
npm run test:e2e     # 端到端流程：9 组 / 45 条
npm run test:mp      # 小程序工程静态检查：6 组 / 51 条
npm run mock:mp      # 小程序逻辑模拟：9 组 / 58 条
```

以上六套合计 **458 条断言**，当前全部通过。完整的实现细节、设计取舍与每一期的验证记录见 `README.md` 正文各章。

---


> **本站是系统设计与学习用的演示站点，不是真实医疗机构。**
> 页面上的诊所名称、医师姓名、证号、地址、电话、二维码均为占位示例，不构成任何真实的诊疗、报价或预约承诺。
> 第二阶段的账号与角色系统同样为教学演示，**不处理任何真实患者信息**。

项目分五个阶段：**第一阶段**是移动端优先的五页静态官网（HTML + CSS + 原生 JS，无构建）；**第二阶段**加上账号体系（Node + Express + SQLite），做认证、角色与权限；**第三阶段**把预约业务闭环做通——病人提交 / 取消 / 看详情，医生确认 / 完成 / 标记未到诊；**第四阶段**修掉 `no_show` 造成的号源死锁（释放号源 + 纠错接口），并把端到端脚本归档进仓库；**第五阶段**加订单与**模拟支付**（下单、支付、退款、幂等与越权），**不接入任何真实支付通道**。展示页本身没有改动，只是多了「登录 / 注册 / 控制台 / 支付」四个账户页和顶栏的登录状态。

**第七期**另起一个客户端：`miniprogram/` 下的微信小程序**阶段一**，把五个展示页迁移过去，并给后端加三个公开只读接口（诊所 / 医师 / 项目）。**第八期**接着做小程序**阶段二**：后端加一条 Bearer token 通道（cookie 留给 Web，网站行为零变化），小程序端补上登录 / 注册 / 在线预约 / 我的预约；**模拟支付与退款**在后续补齐（仍不接微信支付）。小程序**不做医生端**，仅本机学习演示，不发布（§18）。

| 阶段 | 内容 | 对应章节 |
| --- | --- | --- |
| 一 | 五页静态展示站、数据驱动渲染、无障碍与合规口径 | §2–§8 |
| 二 | 注册 / 登录 / 角色 / 管理员审核、静态资源白名单、会话密钥、XSS | §10、§11 |
| 三 | 预约状态机闭环、医生端操作、病人预约详情、`no_show` 迁移 | §12–§14 |
| 四 | `no_show` 释放号源 + `reopen` 纠错、索引迁移修复、E2E 归档、时区口径 | §15 |
| 五 | 订单表、服务端计价、模拟支付 / 退款、幂等与越权（不接真实通道） | §16 |
| 六（另一客户端） | 微信小程序阶段一：五页迁移、3 个公开只读接口、60 次/分钟限流（不登录 / 不预约 / 不支付） | §18 |
| 七（另一客户端） | 微信小程序阶段二：JWT Bearer 通道、登录 / 注册、在线预约、我的预约与取消（只做病人端） | §18 |

---

## 1. 项目定位

| 项 | 说明 |
| --- | --- |
| 用途 | 系统设计作业 / 前端练习 / 交互演示 / 后端权限练习 |
| 真实性 | 演示站点，非真实医疗机构，不承接真实预约，不存真实患者信息 |
| 技术栈（一阶段） | HTML + CSS + 原生 JavaScript，无框架、无构建 |
| 技术栈（二阶段） | Node ≥ 22 + Express 4 + better-sqlite3 + bcrypt + express-session |
| 启动方式 | `npm install && npm start`，访问 `http://localhost:3000` |
| 纯静态预览 | 五个展示页仍可双击直接打开（`file://`），但登录、注册、控制台必须走服务端 |
| 云端部署 | Koyeb 免费实例（Docker 构建、不绑卡，GitHub 推送自动部署），镜像定义见 `Dockerfile`；Render 作为备选（`render.yaml`）。步骤见 `DEPLOY.md`，取舍见 §20 |
| 适配 | 移动端优先，断点 640 / 960 / 1200，960 以下为汉堡导航 |
| 视觉 | 蓝白为主色、浅绿为点缀，圆角卡片 + 轻阴影 |

---

## 2. 页面结构

### 2.1 五个展示页（第一阶段，未改动）

| 页面 | 文件 | 主要内容 |
| --- | --- | --- |
| 首页 | `index.html` | Hero、信任条、三项优势（数字化检查 / 专科医师团队 / 透明收费与随访）、主打项目（种植/矫正）、医师预览（3 位）、就诊流程 4 步、转化 CTA |
| 服务项目 | `services.html` | 项目速览 3 卡、种植牙（`#implant`）、牙齿矫正（`#ortho`）、综合诊疗 6 项（`#general`）、矫正方式对比表、收费与术后随访 |
| 医生团队 | `doctors.html` | 三条团队理念、4 位主诊医师卡（含「预约该医师」）、资质展示与证照扫描件位、CTA 转化区 |
| 预约 | `appointment.html` | 7 字段表单（姓名/手机/项目/医师/日期/时段/备注）+ 隐私勾选、医师与项目联动、首次就诊须知、急诊边界提示、提交后四步 |
| 联系我们 | `contact.html` | 4 张联系信息卡、地图占位、地铁/公交/自驾指引、7 天营业时间表（今天高亮）、FAQ 手风琴 |

导航在五页中保持一致：首页 → 服务项目 → 医生团队 → 预约 → 联系我们；页脚另有诊疗项目锚点链接与联系方式。

### 2.2 四个账户页（第二 / 五阶段新增）

| 页面 | 文件 | 主要内容 |
| --- | --- | --- |
| 登录 | `login.html` | 手机号或邮箱 + 密码，错误统一样式，成功跳 `dashboard.html`（支持 `?next=` 白名单跳转） |
| 注册 | `register.html` | 上半屏病人自助注册（姓名 / 手机号 / 密码，**没有角色选项**），下半屏 `#doctor` 医生入驻申请（姓名 / 邮箱 / 密码） |
| 控制台 | `dashboard.html` | 按角色渲染：病人看「我的预约」+ 详情 / 去支付 / 取消，医生看「我的患者预约」并确认 / 完成 / 未到诊 / 恢复，管理员看「待审核医生申请」 |
| 模拟支付 | `payment.html` | `?appointment=<id>`；页首写明「模拟支付，不产生真实扣款」；金额、状态全部来自服务端；支付 / 退款按钮只改本地订单状态（第五期） |

顶栏的登录状态由 `assets/js/session.js` 统一渲染：未登录显示「登录 / 注册」，已登录显示「姓名 · 角色 → 控制台」+「退出」。桌面端用 `header-actions` 里的槽位，移动端用汉堡菜单里的槽位，两者互斥显示。

---

## 3. 文件结构

### 3.1 目录树

```
Dental Clinic/
├── index.html              # 首页
├── services.html           # 服务项目（含 #implant / #ortho / #general 锚点）
├── doctors.html            # 医生团队（含资质与证照区）
├── appointment.html        # 预约（表单 id=appointment-form；登录后走真实预约）
├── contact.html            # 联系我们（营业时间表 + FAQ）
├── login.html              # 登录（第二阶段）
├── register.html           # 注册病人 / 医生入驻申请（第二阶段）
├── dashboard.html          # 控制台：按角色渲染（第二阶段）
├── payment.html            # 模拟支付：?appointment=<id>（第五阶段）
├── package.json            # 依赖与脚本（npm start / test:api / test:race / test:ui / test:e2e / test:mp / mock:mp / test:all / reset-db）
├── README.md               # 本文件
├── DEPLOY.md               # 部署手册：Koyeb 主方案（Docker）+ Render 备选（第十/十一期）
├── Dockerfile              # 容器镜像：node:22-slim 两段构建，Koyeb 用它构建
├── .dockerignore           # 不进镜像的东西：node_modules / data / .git / .workbuddy / miniprogram / scripts
├── render.yaml             # Render 蓝图（备选路线）：服务类型 / 构建 / 启动 / 健康检查 / 环境变量
├── server/                 # 后端（第二阶段）
│   ├── app.js              # Express 装配：会话、静态托管、路由、错误处理
│   ├── db.js               # SQLite 连接、建表、迁移、种子数据、参数化查询封装
│   ├── site-data.js        # 读取 assets/js/data.js 的唯一入口（vm + JSON 往返，第六/七期共用）
│   ├── pricing.js          # 计费表：从 site-data 取数并校验（整数分）
│   ├── rate-limit.js       # 通用内存限流器（公开接口用；与登录限流分开）
│   ├── password.js         # bcrypt 适配层（bcrypt / @node-rs/bcrypt）
│   ├── jwt.js              # Bearer token：密钥解析 / 签发 / 校验（第八期）
│   ├── auth.js             # 校验函数、authenticate（cookie + Bearer）、requireRole、登录限流
│   ├── api-proxy.js        # 可选：把 /api 转发到权威后端（多入口共用一个库，见 DEPLOY §12.10）
│   ├── reset-db.js         # 重置演示库：DROP TABLE 后重建（不删文件，见 §14）
│   └── routes/
│       ├── auth.js         # 注册 / 医生申请 / 登录（下发 cookie + token）/ 登出 / me
│       ├── appointments.js # 排班、提交/取消预约、我的预约、医生患者预约（第二期）
│       ├── orders.js       # 订单、模拟支付、模拟退款、我的订单（第五期）
│       ├── public.js       # 小程序公开只读接口：clinic / doctors / services（第七期）
│       └── protected.js    # 管理员接口（病人 / 医生的业务接口已迁到 appointments.js）
├── miniprogram/            # 微信小程序端（第七期展示 + 第八期登录/预约，不发布）
│   ├── app.js / app.json / app.wxss
│   ├── config.js           # 后端地址（唯一一处环境配置，request.js 从这里读）
│   ├── project.config.json # appid=wx89cb…15cf（不上传不发布），urlCheck=false；导入这个目录即可
│   ├── sitemap.json        # 全站 disallow（不参与微信搜索）
│   ├── utils/
│   │   ├── request.js      # 从 config.js 取地址 / token 存取 / Bearer 头 / 401 统一跳登录
│   │   └── api.js          # 公开接口 + 认证 + 预约的语义封装
│   └── pages/
│       ├── index/          # 首页：诊所卡 + 服务入口 + 医师预览 + 预约 CTA
│       ├── services/       # 服务列表（8 项）
│       ├── service-detail/ # 项目详情（?id=cleaning）
│       ├── doctors/        # 医师团队（4 位）
│       ├── appointment/    # 预约：医师 → 日期 → 时段 → 项目 → 提交
│       ├── my-appointments/ # 我的预约：列表 + 二次确认取消
│       ├── login/          # 登录（手机号 + 密码，与 Web 同一接口）
│       ├── register/       # 注册（只能注册病人）
│       └── mine/           # 登录态 / 我的预约入口 / 退出登录
├── data/                   # 运行时生成，不入库（云端每次重启重建，见 DEPLOY.md）
│   ├── app.db              # SQLite 数据库（含 WAL 文件）
│   └── .session-secret     # 会话签名密钥（首次启动自动生成，≥32 字符否则拒绝启动）
├── scripts/
│   ├── regression.mjs      # 展示页回归：file:// + 真浏览器，7 组 / 31 条断言
│   ├── api-test.mjs        # 接口回归：真实 HTTP，22 组 / 266 条断言（19 组支付、20 组价格、21 组公开接口、22 组 Bearer）
│   ├── concurrency-test.mjs  # 并发抢位：单进程 8 并发 + 双进程 TOCTOU，2 组 / 7 条
│   ├── race-worker.cjs       # 上面的双进程子进程（故意写「读→延迟→写」的竞态）
│   ├── e2e.mjs               # 端到端：真服务 + 真浏览器点按钮，9 组 / 45 条（含 Network 自检）
│   ├── miniprogram-check.mjs # 小程序静态体检：结构 / 无 DOM / token 通道，6 组 / 51 条
│   ├── miniprogram-mock.mjs  # 小程序页面模拟：wx 垫片 + 真后端跑页面，9 组 / 58 条
│   └── capture-payment.mjs   # 支付页截图 + Network 请求清单（审查用，输出到 .workbuddy/shots）
├── assets/
│   ├── css/
│   │   └── style.css       # 全站唯一样式表（变量 → 组件 → 响应式 → 账户/控制台/预约列表/支付）
│   └── js/
│       ├── data.js         # 数据源：诊所信息、证照、医师、诊疗项目与**价格（唯一来源）**
│       ├── render.js       # 渲染层：把数据写进 data-* 挂载点（含服务页价格区间）
│       ├── main.js         # 交互层：导航、动画、预约表单校验与联动
│       ├── session.js      # 顶栏登录状态（全站共用）
│       ├── auth-pages.js   # 登录 / 注册 / 医生申请三个表单
│       ├── booking.js      # 预约页在线模式：拉排班、提交预约（含服务项目，第五期起落库）
│       ├── dashboard.js    # 控制台：按角色取数并渲染（纯 DOM，无 innerHTML）
│       └── payment.js      # 支付页：取订单、模拟支付 / 退款（第五期）
└── .workbuddy/             # 编辑器工作目录，与站点无关，可忽略
```

### 3.2 前端三个脚本各自做什么

（后端 `server/` 下各文件的职责见 §10.2。）

**`assets/js/data.js` — 唯一数据源**

以 `window.SITE_DATA` 挂载，不依赖模块系统，`file://` 下也能跑。

```
SITE_DATA
├── clinic
│   ├── name / nameEn
│   ├── phone { display, tel }        # 页面显示号码 / tel: 链接纯数字
│   ├── email { address, note }
│   ├── address { city, line1, note }
│   ├── wechat { label, qr, note }    # qr 为空则渲染二维码占位块
│   ├── licenses[]                    # 资质证照：label/title/summary/no/image/icon
│   ├── hours { holidayNote, caption, days[] }
│   └── demoNotice
├── doctors[]                         # id/name/dept/title/years/license/schedule/photo/intro/tags/services
└── services[]                        # id/label/doctors[]（用于预约页「医师擅长」联动）
```

**`assets/js/render.js` — 渲染层（只读数据，不绑定交互）**

按挂载点属性把数据写进 DOM，共 8 个渲染函数、8 类挂载点：

| 挂载点 | 渲染内容 |
| --- | --- |
| `[data-site="phone-text"]`、`a[href^="tel:"]` | 电话号码与 `tel:` 链接 |
| `[data-site="address-line\|address-plain\|address-city\|address-detail\|address-map"]` | 地址的几种写法 |
| `[data-site="hours-line\|hours-plain\|hours-note\|hours-caption"]`、`[data-hours-body]` | 营业时间摘要 + 7 天营业时间表（当天加 `is-today`） |
| `[data-site="footer-contact\|footer-demo"]` | 页脚联系方式与演示声明 |
| `[data-contact-cards]` | 联系页 4 张信息卡（含二维码占位） |
| `[data-doctor-list]`、`[data-doctor-preview]` | 医师完整卡 / 首页预览卡 |
| `[data-license-item]`、`[data-license-slot]` | 资质说明行与证照扫描件位 |
| `[data-doctor-select]`、`[data-service-select]` | 预约页两个下拉的选项 |

空字符串或 `null` 一律渲染成「待填充」标记（`.is-todo`），不会显示空白，也不会伪造数据。

**`assets/js/main.js` — 交互层**

1. 移动端导航开合（含 Esc 关闭、点击导航项关闭、视口变宽复位）
2. 页脚年份
3. `.reveal` 滚动入场（`IntersectionObserver`，带降级）
4. 预约表单：必填/手机号/日期范围校验、`?doctor=` 预选、医师↔项目联动、今日提示、演示提交

### 3.3 为什么加载顺序不能换

三个基础脚本必须严格按 **data → render → main** 排列，账户相关脚本接在后面：

```html
<!-- 五个展示页 -->
<script src="assets/js/data.js"></script>
<script src="assets/js/render.js"></script>
<script src="assets/js/main.js"></script>
<script src="assets/js/session.js"></script>

<!-- 登录 / 注册页：在 main.js 之后多加载一个 auth-pages.js -->
<script src="assets/js/auth-pages.js"></script>

<!-- 控制台：在 main.js 之后多加载一个 dashboard.js -->
<script src="assets/js/dashboard.js"></script>

<!-- 预约页：在 main.js 之后多加载一个 booking.js（在线模式接管提交） -->
<script src="assets/js/booking.js"></script>
```

- `render.js` 第一行就读 `window.SITE_DATA`，读不到会直接 `return`。若放在 `data.js` 之前，整页的医师、下拉、营业时间、资质区全空。
- `main.js` 依赖**渲染后**的 DOM。`?doctor=liu-ortho` 预选要遍历 `#f-doctor` 的 `options`；星标联动要读每个 `option` 上的 `data-doctors`。渲染未完成时，下拉里只有空壳，预选静默失败，联动的 `data-*` 属性也读不到。
- `session.js` 只改顶栏槽位、`auth-pages.js` / `dashboard.js` / `booking.js` 只绑自己的表单和面板，彼此不依赖顺序；但都要在 `main.js` 之后，避免和导航开合、年份这些基础交互抢同一个 DOM。
- `booking.js` 必须在 `main.js` 之后：它给 `window.LSD_BOOKING.active` 置位，`main.js` 的 submit 处理器在开头读这个标志位决定是否 `return`。顺序反了，两个 submit 处理器都会跑，一次提交会变成「先演示提示、再真实下单」。
- 所以顺序错一位，页面不报错但功能失效——这是本方案最容易被踩的坑。

### 3.4 无脚本时的行为

`<noscript>` 提供三处兜底：`.reveal` 强制可见、页脚提示「信息由脚本渲染」、医生页资质区提示「启用 JavaScript 后显示」。JS 被禁用时，静态正文（服务项目、FAQ、就诊须知）仍可阅读，但医师卡、下拉、营业时间表、证号与**服务页价格区间**为空（价格第六期起改由 `data.js` 渲染，不再写死在 HTML 里）。

---

## 4. 怎么替换占位内容

占位内容分两类，**先判断它属于哪一类，再动手**。

### 4.1 第一类：改 `data.js`（会被渲染覆盖，不要改 HTML）

| 要改什么 | 改哪里 |
| --- | --- |
| 电话（显示号码 + `tel:` 号码） | `clinic.phone.display` / `clinic.phone.tel` |
| 邮箱 | `clinic.email.address` / `clinic.email.note` |
| 地址 | `clinic.address.city` / `line1` / `note` |
| 公众号二维码 | `clinic.wechat.qr`（图片路径，留空显示占位块） |
| 营业时间（7 天逐日） | `clinic.hours.days[]`，`weekday` 0 = 周日 |
| 节假日口径 | `clinic.hours.holidayNote` |
| 资质证号与扫描件 | `clinic.licenses[]` 的 `no` / `image` |
| 医师姓名、科室、职称、年限、证号、出诊时间、照片、擅长、标签 | `doctors[]` 对应字段 |
| 预约项目清单、医师擅长映射 | `services[]` 的 `label` / `doctors` |

改完刷新即可，五页同时生效。几个约定：

- `photo` 留空 → 渲染「姓氏首字 + 照片待填充」；填路径 → 渲染 `<img>`，`alt` 自动拼成「姓名 + 科室职称 + 门诊出诊医师照片」。
- `years` / `schedule` 旁有 `yearsPending` / `schedulePending` 布尔标记，为 `true` 时末尾追加「（待填充）」；填真实数据后记得把标记改成 `false`。
- `licenses[].no` 留空 → 「证号待填充」；`image` 留空 → 虚线扫描件占位，填了自动切换为图片态（去掉虚线框、图片铺满）。
- 医师 `id` 同时是预约页 `?doctor=` 的参数值，改名会断开医生页「预约该医师」的跳转。

### 4.2 第二类：逐条搜 HTML 注释（`<!-- 待填充 ... -->`）

这类内容没有数据源，属于各页独有文案，直接搜注释定位：

```bash
grep -rn "待填充" *.html
```

典型需要手改的：服务项目正文与价格区间、矫正方式对比表、FAQ 答案、到院交通线路、门诊外观图片位、页面 `<title>` 与 `<meta name="description">`、预约时段选项、资质区上方「资质证书待补充真实文件」的说明。

改文案时同步守住第 8 节的合规口径。

---

## 5. 当前剩余占位清单

### 5.1 HTML 注释：共 19 条

| 文件 | 条数 | 主要位置 |
| --- | --- | --- |
| `index.html` | 3 | 首页项目卡文案、医师预览说明、图片位 |
| `services.html` | 7 | 种植/矫正正文、对比表、综合诊疗说明（价格区间已改为从 `data.js` 渲染，不再算占位） |
| `doctors.html` | 2 | 医师字段（指向 `data.js`）、证照原件扫描件 |
| `appointment.html` | 2 | 项目下拉（指向 `data.js`）、医师下拉（指向 `data.js`） |
| `contact.html` | 5 | 地址电话邮箱卡、地铁路线、公交站名、停车场、门头实拍图 |

统计口径：`<!-- ... 待填充 ... -->` 形式的 HTML 注释条数，不含 JS 里渲染出的「待填充」文本，也不含 `data.js` 里的空值。第六期把服务页的价格占位改成「数据源渲染」注释后，本条从 20 降为 19。

### 5.2 `data.js` 空值字段：13 个

统计口径：递归遍历 `SITE_DATA`，值**恰好是空字符串**（或 `null`）的字段个数。这 13 个是「缺内容」的字段。

| 字段 | 数量 | 含义 |
| --- | --- | --- |
| `clinic.wechat.qr` | 1 | 公众号二维码图片 |
| `clinic.licenses[*].no` | 2 | 机构执业许可证证号、医师执业证书编号 |
| `clinic.licenses[*].image` | 2 | 两份证照扫描件 |
| `doctors[*].license` | 4 | 四位医师的执业证书编号 |
| `doctors[*].photo` | 4 | 四位医师的出诊照片 |
| **合计** | **13** | 1 + 2 + 2 + 4 + 4 |

另有一批**非空但仍是占位**的字段，容易被误认为已填好：

| 字段 | 当前值 | 说明 |
| --- | --- | --- |
| `clinic.address.line1` | `×× 路 ×× 号 ×× 栋 2 层` | 有内容，但是占位字符 |
| `clinic.email.address` | `info@example.com` | 示例域名，不是真实邮箱 |
| `doctors[*].years`、`doctors[*].schedule` | `19 年`、`周一、周三、周五全天` 等 | 8 个字段的值都在，但真实性未核；靠 `yearsPending` / `schedulePending` 这 **8 个布尔标记**在页面上追加「（待填充）」 |

**两处数字不重叠**：`13` 数的是「值为空」的**内容字段**；`8` 数的是「值有内容但待核」的字段所对应的**布尔标记**。13 个空值里没有一个 `*Pending`，8 个 `*Pending` 也不在任何空值里——它们是两个不同集合，加不到一起。

---

## 6. 回归验证（第一阶段：展示页交互）

用 Edge 无头浏览器 + DevTools 协议在真实浏览器里跑断言：**7 个检查组、31 条断言，全部通过**。接口回归（22 组 / 266 条）在 §10.7，两套脚本互不替代：这一套验前端交互，那一套验服务端权限。

“组”和“条”是两个口径：**一条断言 = 一个 `check()`**，一组 = 一类交互场景，一组里通常有 3–6 条断言。下面的表按**组**列（7 行），组内断言数见最后一列，7 组相加 = 31。

| # | 检查组 | 覆盖内容 | 断言数 | 结果 |
| --- | --- | --- | --- | --- |
| 1 | 医生页「预约该医师」→ `?doctor=` 预选 | 链接参数正确、下拉选中「刘医生（正畸科）」、预选提示条可见 | 3 | ✅ 3/3 |
| 2 | 期望日期「今天」琥珀提示 | 选今天出现、改其他日期收起、清空收起 | 3 | ✅ 3/3 |
| 3 | 医师↔项目联动 | 选医师出 ★、说明行列出擅长项、反复切换不叠加 ★、只选项目出医师建议 | 4 | ✅ 4/4 |
| 4 | 表单校验与 aria-live 播报 | 4 条错误、均带 `aria-live`、`MutationObserver` 记录到 DOM 真更新、`aria-describedby` 关联、`aria-invalid`、焦点落到首个错误字段 | 6 | ✅ 6/6 |
| 5 | 联系页「今天」营业时间高亮 | 7 行、`is-today` 唯一且与系统星期一致、背景/文字色有区分、「今天」角标 | 4 | ✅ 4/4 |
| 6 | 数据驱动渲染（首页 / 预约页 / 服务页） | 医师预览 3 卡、电话地址营业时间填充、项目下拉 9 项、医师下拉「姓名（科室）」、服务页区间渲染、区间与计费金额自洽 | 6 | ✅ 6/6 |
| 7 | 资质区数据化渲染 | 2 条说明非空、空证号显示待填充、2 个扫描件位占位、区块仍 4 个图片位、`licenses` 2 条 | 5 | ✅ 5/5 |
|  | **合计** |  | **31** | **✅ 31/31** |

本轮修复 1 处：营业时间「今天」行的背景色原来是 `--blue-50`，与表头默认底色相同，首列看不出高亮；改为 `--blue-100` 后整行区分明显。

### 6.1 如何复跑

脚本在 `scripts/regression.mjs`，是项目内资产，不依赖 `node_modules`。

**依赖**

- Node ≥ 22（用到内置 `WebSocket`，无需 `ws` 包）
- 本机安装 Edge 或 Chrome（脚本会自动在常见路径里找；也可用 `EDGE_PATH` 指定）
- 无需启动本地服务器：脚本用 `file://` 打开项目根目录

**运行**（在项目根目录）

```bash
node scripts/regression.mjs          # 只打印明细与按组汇总
node scripts/regression.mjs --json   # 另外写 scripts/regression-result.json
```

退出码：`0` 全部通过、`2` 有失败项、`1` 浏览器没起来。

**会发生什么**

1. 以 `--headless=new --remote-debugging-port=9333` 启动浏览器，用户数据目录建在系统临时目录；
2. 轮询 `/json/version` 拿到调试地址，连上 DevTools 协议；
3. 依次打开 `doctors → appointment(?doctor=...) → contact → index → appointment`，用 `Runtime.evaluate` 跑断言；
4. 打印 `✅/❌` 明细 + 每组 `通过/总数` + `合计 31/31 条断言通过，共 7 组`，然后关闭浏览器。

**端口冲突**：`CDP_PORT=9444 node scripts/regression.mjs`。

**已知限制**：截图/交互断言依赖真实字体排版，`is-today` 相关断言会跟随运行当天的星期变化——这是预期行为，不是随机失败。

### 6.2 README 数字自洽性核对

**28 项核对：25 项原本一致，3 项发现不一致并已修正，修正后 28/28 全一致。**

「28/28 全一致」说的是**修正之后**的状态，不是「原本 28 项都对」。表体每行 = 一个核对点，共 28 行；「结果」列只有 `✅ 原本一致` 与 `❌ 已改` 两种取值。

> 本表是**第一阶段快照**，保留当时的核对结果。第六期把 `services.html` 的价格占位块改成「由 `data.js` 渲染」，那条注释不再含「待填充」二字，因此当前实际值是：`services.html` 7 条、合计 **19** 条。当前口径以 §9 为准。

| # | 核对点 | README 原值 | 实际值 | 结果 |
| --- | --- | --- | --- | --- |
| 1 | 页面数 | 5 | 5 | ✅ 原本一致 |
| 2 | HTML 待填充注释合计 | 20 | 20 | ✅ 原本一致 |
| 3 | `index.html` 注释 | 3 | 3 | ✅ 原本一致 |
| 4 | `services.html` 注释 | 8 | 8 | ✅ 原本一致 |
| 5 | `doctors.html` 注释 | 2 | 2 | ✅ 原本一致 |
| 6 | `appointment.html` 注释 | 2 | 2 | ✅ 原本一致 |
| 7 | `contact.html` 注释 | 5 | 5 | ✅ 原本一致 |
| 8 | `data.js` 空值字段 | 13 | 13 | ✅ 原本一致 |
| 9 | `*Pending` 布尔标记 | 8 | 8 | ✅ 原本一致 |
| 10 | 医师数 | 4 | 4 | ✅ 原本一致 |
| 11 | 预约项目 | 8 | 8 | ✅ 原本一致 |
| 12 | 预约页下拉项（含「请选择」） | 9 | 9 | ✅ 原本一致 |
| 13 | 资质证照 `clinic.licenses[]` | 2 | 2 | ✅ 原本一致 |
| 14 | 资质区图片位 | 4 | 4 | ✅ 原本一致 |
| 15 | 资质说明行 | 2 | 2 | ✅ 原本一致 |
| 16 | CSS 断点 | 3 个（640 / 960 / 1200） | 3 个 | ✅ 原本一致 |
| 17 | 首页医师预览 | 3 | 3 | ✅ 原本一致 |
| 18 | 首页就诊流程 | 4 步 | 4 步 | ✅ 原本一致 |
| 19 | 医生页医师卡 | 4 | 4 | ✅ 原本一致 |
| 20 | 医生页团队理念卡 | 3 | 3 | ✅ 原本一致 |
| 21 | 服务页项目速览卡 | 3 | 3 | ✅ 原本一致 |
| 22 | 服务页综合诊疗 | 6 项 | 6 项 | ✅ 原本一致 |
| 23 | 预约表单 | 7 字段 + 1 勾选 | 7 + 1 | ✅ 原本一致 |
| 24 | 联系页信息卡 | 4 | 4 | ✅ 原本一致 |
| 25 | 营业时间表行数 | 7 | 7 | ✅ 原本一致 |
| 26 | 首页优势卡 | 四项优势 | 3 项 | ❌ 已改 |
| 27 | `render.js` 挂载点组数 | 8 组 / 表却 9 行 | 8 组 / 8 行 | ❌ 已改 |
| 28 | 回归核对 | 29 项 / 表 10 行 | 7 组 / 29 条 | ❌ 已改 |

三处修正的具体内容（「项」列指上表的核对点编号，不是本表行号）：

| 项 | 原文 | 改为 | 原因 |
| --- | --- | --- | --- |
| 第 26 项 | 「四项优势」 | 「三项优势（数字化检查 / 专科医师团队 / 透明收费与随访）」 | 首页实际 3 张 `article.card` |
| 第 27 项 | 「共 8 组」但表列 9 行 | 把「营业时间摘要」与「7 天营业时间表」并入同一行，恢复 8 行 | 渲染函数实际 8 个，一个函数对应一类挂载点 |
| 第 28 项 | 「29 项」配 10 行表 | §6 改为 7 行组表 + 断言数列，7 组相加 = 29 | 29 是 `check()` 条数，不是表格行数 |

核对方式：静态数字直接读文件（注释、`data.js` 字段、数组长度、CSS 媒体查询），DOM 数字用同一套 Edge + CDP 驱动取渲染后的真实值。口令见 §9。

> **本表是第一阶段收尾时的快照**，行数固定为 28。第二阶段新增 `login.html` / `register.html` / `dashboard.html` 后，`ls *.html` 从 5 变 8——这个变化不改写历史核对，只更新 §9 的口径表（拆成「展示页 5 / HTML 总数 8」两行）。

---

## 7. 已知取舍

| 取舍 | 具体影响 | 代价 / 后续方案 |
| --- | --- | --- |
| 数据由 JS 渲染 | `doctors.html` 的医师卡、`contact.html` 的信息卡与营业时间表、`appointment.html` 的下拉选项，在 HTML 源码里都是空容器 | 不执行 JS 的爬虫拿不到这部分内容。缓解：服务正文、价格区间、FAQ、机构介绍仍是静态 HTML，`<title>`/`description` 手写并含本地词。要彻底解决需改为构建期静态化或服务端渲染 |
| 预约表单有两条路径 | 未登录时仍是纯前端演示（不发送、不落库）；登录后的病人走真实接口，写本地 SQLite | 同一页面两套行为，靠 `window.LSD_BOOKING.active` 区分。改动时要同时跑展示页回归（31 条）与接口/端到端回归，否则容易只顾一头 |
| 号源粒度是「一个时段一个人」 | 没有容量概念（同一时段不能放 3 个号），也不能改期，只能取消后重约 | 要支持需给 `schedules` 加 `capacity`、给 `appointments` 加序号，防双订索引也要跟着改 |
| 时间按服务器本地时区计算 | `slotStartMs()` 用 `new Date('YYYY-MM-DDTHH:MM:00')` 拼时间，**不带时区后缀**，因此按运行机器的本地时区解析。取消规则（时段是否已开始）、`SLOT_IN_PAST` 判定、`date` 比较全部基于这个基准 | 单机房演示没问题。**多时区部署必须改造**：库里存 UTC 时间戳（或带 offset 的 ISO 串），服务端比较一律用 UTC，展示层再按用户时区格式化；否则「病人在 UTC+8 看到 09:00，服务器按 UTC 判断成 17:00」 |
| 无真实地图 | 联系页地图位是虚线占位块 | 接入地图需用具备测绘资质、带审图号的服务，且坐标与门牌要真实，否则不如不放 |
| 演示性文案 | 「勾选即同意」「30 分钟内回电」等是流程示意 | 不能当作真实服务承诺阅读 |
| 支付是**模拟**的 | 没有真实资金流、没有对账文件、没有退款审批、没有票据；「支付」只是本地一条 `UPDATE` | 这是刻意的：接真实通道需要商户资质、密钥托管、回调验签、退款风控与 PCI 合规，本作业不碰。真要接，必须由持牌收单机构提供 SDK 与服务端回调，且金额仍由服务端算 |
| 订单金额是演示定价 | 价格只在 `assets/js/data.js` 的 `services[]` 里维护一份；`server/pricing.js` 启动时读取并校验，服务页区间也由同一文件渲染 | 改价后**需要重启服务**（启动时加载一次）；`data.js` 必须保持纯数据，加副作用会在启动时报错。真实系统里价格来自物价 / HIS，有生效日期与审批留痕；展示区间与结算金额也常常不是一回事 |
| 订单与预约是两个生命周期 | 取消预约或标记未到诊后，订单不能再支付（409 `APPOINTMENT_NOT_PAYABLE`），但订单本身不会被自动关单或自动退款 | 真实系统需要「取消 → 触发退款 / 关单」的联动与补偿任务（对账、重试、幂等键）。本期只做单点行为，不做联动 |
| `refunded` 是终态 | 退款后订单关闭，同一预约不再支持重新支付；`UNIQUE(appointment_id)` 也保证不会生成第二单 | 想再付只能重新预约（新 `appointment` → 新订单）。若产品要求"同一预约重新支付"，需要新增状态（如 `reopened`）或放开"一预约多单"，属于迁移级改动 |
| `no_show` 不收爽约费 | 未到诊的预约既不能下单也不能支付；没有"违约金"类型的单据 | 爽约费需要独立费用类型、减免审批与告知流程，本期明确不做（§16.2、§16.8） |
| token 有效期 2 小时，**无 refresh token** | 小程序与 Web 共用同一个 TTL（`expires_in: 7200`）。过期后接口一律 401，小程序清 token 并 `reLaunch` 回登录页，用户必须**重新输入手机号 + 密码**。没有任何「静默续期」通道 | 演示够用：TTL 短于一次门诊时长，且每次请求都回库查 `status`，停用能立刻生效。**生产系统应加 refresh 机制**——短期 access token（5–15 分钟）+ 长期 refresh token（可吊销、按设备记录、轮换使用），否则「每 2 小时踢一次」在真实产品里是致命的体验问题。加 refresh 会同时引入吊销表、并发刷新与重放防护，属于迁移级改动，本期不做（§18.10 已记） |

---

## 8. 合规注意事项

### 8.1 禁用词清单（全站已清零，新增文案请继续避开）

| 类别 | 禁用写法 | 现状替代 |
| --- | --- | --- |
| 保证性承诺 | 质保、保修、保证治愈、包治、永久、终身 | 「术后随访与维护」「复查频次写进方案」 |
| 绝对化用语 | 最好、最佳、第一、领先、唯一、顶级 | 「没有放之四海皆准的方案」「按检查结果定方案」 |
| 疗效断言 | 根治、无痛、100% 成功、彻底解决、立刻见效 | 「多数情况下」「因人而异」「以检查结果为准」 |
| 虚假预约状态 | 预约成功、实时可约、号源已锁定、已为你保留 | 「演示提交完成：信息未发送，也未生成预约记录」 |
| 权威背书 | 专家推荐、协会认证、临床验证有效 | 只写可核验的执业信息，并提示「可现场查验」 |

### 8.2 医疗广告不能做的表述

- 不得对疗效、安全性作断言或保证，不得说明治愈率、有效率。
- 不得利用患者、卫生技术人员、医学教育科研机构及人员、行业协会的名义或形象作证明（所以站内没有「患者见证」「感谢信」板块）。
- 不得出现「免费治疗」「保证治愈」「无效退款」这类诱导性表述。
- 价格只能给区间并注明「非最终报价」，不能以低价引流再加项；费用与医保一律写「以现场结算与当地医保政策为准」。
- 机构与医师资质必须真实、可核验；证号与扫描件未落实前，页面明确标注「待填充」，不虚构编号。
- 节假日接诊一律写「以门诊公告为准」，不用「全年无休」「节假日正常接诊」这类容易被理解为承诺的说法。

### 8.3 隐私勾选的作用

预约表单的勾选框（`#f-consent`，`required`）承担三件事：

1. **告知**：说明信息用途仅限「本次预约联系」，不对外提供。
2. **取得同意**：未勾选时提交被拦下，错误提示「请先阅读并同意隐私说明」，并通过 `aria-live` 播报。
3. **留痕口径**：真实上线时应能证明「用户主动同意」，因此勾选必须是**未预勾选**状态，不能默认选中。

本站的勾选**只是交互演示**：不发送、不存储、不产生任何同意记录。真实部署需按《个人信息保护法》落实单独同意、最小必要收集、留存期限与撤回渠道，并在表单旁提供隐私政策全文入口。

页脚固定保留一行声明：**「本站为系统设计与学习用演示站点，非真实医疗机构」**，任何页面改版都不要删。

---

## 9. 数字口径（避免「26 处 vs 5 条」式混淆）

同一件事常有几种数法。本文件出现的数字，一律按此表定义；改动后请同步更新，并注明口径。

| 指标 | 当前值 | 口径定义 | 复算方式 |
| --- | --- | --- | --- |
| 页面数（展示页） | 5 | 第一阶段那五个展示页，不含账户页 | `ls index.html services.html doctors.html appointment.html contact.html \| wc -l` |
| 页面数（HTML 总数） | 9 | 5 个展示页 + 4 个账户页（login / register / dashboard / payment） | `ls *.html \| wc -l` |
| HTML 待填充注释 | 19 | `<!-- ... 待填充 ... -->` 形式的注释条数。**不**含 JS 渲染出的「待填充」文字，**不**含 `data.js` 空值。第六期把 `services.html` 的价格块改为数据源渲染，合计 20 → 19 | `grep -c "<!--.*待填充" *.html` 逐页相加（账户页为 0） |
| `data.js` 空值字段 | 13 | 递归遍历 `SITE_DATA`，值恰为 `''` 或 `null` 的**字段**个数 | 见下方脚本 |
| `*Pending` 布尔标记 | 8 | 4 位医师 ×（`yearsPending` + `schedulePending`），标记「值有内容但待核」，**与 13 个空值无重叠** | `grep -c "Pending: true" assets/js/data.js` |
| 展示页回归组 / 断言 | 7 / 31 | `scripts/regression.mjs`：一个 `GROUP` 段落 = 1 组，一次 `check()` = 1 条。第六期第 6 组 +2 条（服务页价格渲染） | 脚本末尾「按组汇总」 |
| 接口回归组 / 断言 | 22 / 266 | `scripts/api-test.mjs`；第 7–11 组第二期、12–16 组第三期、17 组第四期（no_show 释放 + reopen）、18 组日志、**19 组第五期模拟支付 + 第九期取消退款联动（54 条）**、**20 组第六期价格单一来源（5 条）**、**21 组第七期小程序公开接口（15 条）**、**22 组第八期 Bearer 通道（32 条）** | `npm run test:api` 末尾汇总 |
| 并发回归组 / 断言 | 2 / 7 | `scripts/concurrency-test.mjs`；A 组单进程 8 并发、B 组双进程 TOCTOU | `npm run test:race` 末尾汇总 |
| 端到端回归组 / 断言 | 9 / 45 | `scripts/e2e.mjs`：真服务 + 真浏览器，一个 `group()` = 1 组，一次 `check()` = 1 条；第 7 组含 Network 自检，第 8 组验医生端支付状态 | `npm run test:e2e` 末尾汇总 |
| 小程序静态体检组 / 断言 | 6 / 46 | `scripts/miniprogram-check.mjs`：结构 9 + 无 DOM 6 + 数据来源 3 + 网络层与 token 10 + 认证与预约页 16 + WXSS 2 | `npm run test:mp` 末尾汇总 |
| 小程序页面模拟组 / 断言 | 9 / 58 | `scripts/miniprogram-mock.mjs`：wx 垫片跑真实 `onLoad` / 点击处理，覆盖「未登录 → 注册 → 登录 → 预约 → 模拟支付 → 退款 → 取消 → token 过期」 | `npm run mock:mp` 末尾汇总 |
| 小程序页面数 | 9 | 5 个 tab + 服务详情 + 我的预约 + 登录 + 注册（后 4 个都是 `navigateTo` / `reLaunch`，不在 tabBar） | `miniprogram/app.json` 的 `pages` 长度 |
| 小程序文件数 | 44 | 根级 6（`app.js`/`app.json`/`app.wxss`/`config.js`/`project.config.json`/`sitemap.json`）+ `utils` 2 + 9 页 × 四件套 36。**不含**开发者工具首次导入后自动生成的 `project.private.config.json`（本地配置，已在 `.gitignore` 排除） | `find miniprogram -type f ! -name project.private.config.json \| wc -l` |
| 六套断言合计 | 458 | 266 + 7 + 31 + 45 + 51 + 58；**这是「断言条数」不是「测试用例数」**，一次 `check()` 记 1 条，一个 `group()` 记 1 组（合计 55 组） | `npm run test:all` 六段「按组汇总」相加 |
| token 有效期 | 2 小时 | `server/jwt.js` 的 `TTL_SECONDS = 7200`，与 Web 会话 `maxAge` 同值；断言 `exp - iat === 7200` | `npm run test:api` 第 22 组 |
| 小程序本地存储 | 1 个键 | 只有 `token`（`wx.setStorageSync('token')`）；**不存密码**、不存用户资料 | `grep -n "StorageSync" miniprogram/utils/request.js` |
| 小程序公开接口 | 3 | `/api/public/clinic`、`/doctors`、`/services`；免登录、只读、60 次/分钟/来源 | `server/routes/public.js` |
| 公开接口限流 | 60 / 分钟 | 按 IP 计，三个接口**共享**一个桶（不是每个接口 60）；超出返回 429 + `Retry-After` | `X-RateLimit-Limit` 响应头 |
| 种子账号 | 5 | `SEED_USERS` 长度：管理员 1 + 医生 4 | `SELECT COUNT(*) FROM users` 或 `/api/health` 的 `users` |
| API 端点 | 29 | 只数 `/api/*`（含 `/api/health`）。**不含** `/` 与 `/:page` 两个静态页处理器；第五期新增 5 个（下单 / 支付 / 退款 / 我的订单 / 价格表），第七期新增 3 个（小程序公开接口） | 见下方命令 |
| 排班时段 | 196 | 4 位医生 × 14 天 ×（3 或 4）= 49 × 4 | `SELECT COUNT(*) FROM schedules` |
| 预约状态 | 5 | pending / confirmed / cancelled / completed / no_show，由 `CHECK` 约束 | 见 `server/db.js` 的 `appointments` 建表语句 |
| 订单状态 | 3 | unpaid / paid / refunded，由 `CHECK` 约束；`paid_at` / `refunded_at` 与状态强一致（另有两条 `CHECK`） | 见 `server/db.js` 的 `orders` 建表语句 |
| 订单金额口径 | 整数分 | 库里存 `amount_cents`（如 `28000`），**不是元、不是浮点**；展示串 `¥280.00` 只用于显示 | `SELECT amount_cents FROM orders` |
| 合法状态转换 | 8 | 见 §11.2 的表：#1–#8 八条（含第四期 `no_show → confirmed`、第九期 `completed → confirmed` 撤销完成）。`#9`「任何 → pending」不存在，只是列出来说明「没有回退入口」 | §11.2 转换表 |
| 非法状态转换断言 | 8 | 每种「源状态 × 目标动作」组合一条，全部断言 409 `BAD_STATE`。另有 4 条 reopen 的边界断言（非本人 403 / 病人 403 / 不存在 404 / 非 no_show 409）在第 17 组 | `npm run test:api` 第 13 组 |
| 医师数 | 4 | `data.js` 的 `doctors[]` 长度（展示层） | `SITE_DATA.doctors.length` |
| 预约项目 | 8 | `services[]` 长度；下拉显示 9 项 = 8 项 + 「请选择」占位 | `SITE_DATA.services.length` |
| 资质证照 | 2 | `clinic.licenses[]` 长度（机构 1 + 医师 1） | `SITE_DATA.clinic.licenses.length` |
| 核对项合计 | 28 | §6.2 对照表**表体一行 = 一个核对点**，共 28 行（第一阶段快照） | 下方命令，第 1 条 |
| 核对项通过率 | 25 原本一致 + 3 已改 | **两个口径不能混**：「原值一致」= 25 项；「发现不一致」= 3 项；`25 + 3 = 28`。「修正后 28/28 全一致」说的是改完全对，**不等于**原本 28 项全对 | 下方命令，第 2、3 条 |

复算核对项通过率（原值一致 vs 修正后一致）。三条命令都用 `^\| [0-9]+` 锚定数据行，避免把正文里的「原本一致」算进去：

```bash
# 1) 表体行数应为 28
awk '/^### 6.2/,/^## 7\./' README.md | grep -cE '^\| [0-9]+.*(✅ 原本一致|❌ 已改)'
# 2) 原值就一致：25
awk '/^### 6.2/,/^## 7\./' README.md | grep -cE '^\| [0-9]+.*✅ 原本一致'
# 3) 发现不一致、已修正：3
awk '/^### 6.2/,/^## 7\./' README.md | grep -cE '^\| [0-9]+.*❌ 已改'
```

三条命令相加必须自洽：`28（行数）= 25 + 3`。若只报「28/28 全一致」而不写「25 + 3」，就会被读成「原本全对」——这正是本条口径要防的歧义。

复算空值字段：

```bash
node -e "global.window={};require('./assets/js/data.js');
const D=window.SITE_DATA;let n=0;const hits=[];
(function w(o,p){if(o===null){n++;hits.push(p);return}
if(typeof o==='string'){if(!o.trim()){n++;hits.push(p)}return}
if(Array.isArray(o))return o.forEach((v,i)=>w(v,p+'['+i+']'));
if(typeof o==='object')for(const k in o)w(o[k],p?p+'.'+k:k)})(D,'SITE_DATA');
console.log(n,hits)"
```

复算 API 端点（只数 `/api/*`，不含静态页处理器 `/` 与 `/:page`）：

```bash
# 期望 26
{ grep -hoE "^router\.(get|post)\('[^']+'" server/routes/*.js
  grep -hoE "^app\.(get|post)\('/api[^']*'" server/app.js
} | wc -l
```

复算数据库行数（需先 `npm start` 生成过种子）：

```bash
node -e "const D=require('better-sqlite3');const d=new D('data/app.db',{readonly:true});
console.log('users', d.prepare('SELECT COUNT(*) n FROM users').get().n);
console.log('schedules', d.prepare('SELECT COUNT(*) n FROM schedules').get().n);
console.log('appointments', d.prepare('SELECT COUNT(*) n FROM appointments').get().n);
console.log('orders', d.prepare('SELECT COUNT(*) n FROM orders').get().n)"
```

---

## 10. 第二阶段：认证与角色

**本系统仅供学习与演示，不处理任何真实患者信息。** 所有账号、姓名、邮箱都是假数据。

### 10.1 技术栈与启动

| 项 | 说明 |
| --- | --- |
| 运行时 | Node ≥ 22（用到内置 `fetch` / `WebSocket`，脚本无第三方测试框架） |
| Web 框架 | Express 4 |
| 数据库 | SQLite（better-sqlite3，同步 API + 预编译语句） |
| 密码 | bcrypt（`$2b$`，cost 10）。实现可换：优先 `bcrypt`，装不上退 `@node-rs/bcrypt`，见 `server/password.js` |
| 会话 | express-session + httpOnly cookie（`lsd.sid`），签名密钥落 `data/.session-secret` |

```bash
npm install        # 装依赖
npm start          # 起服务，默认 http://localhost:3000
npm run reset-db   # 清空并重建数据库（回到 5 个种子账号）
npm run test:api    # 接口回归：22 组 / 266 条（19 组支付、20 组价格、21 组公开接口、22 组 Bearer）
npm run test:race   # 并发抢位：2 组 / 7 条（多进程）
npm run test:ui     # 展示页回归：7 组 / 31 条（需要浏览器）
npm run test:e2e    # 端到端：真服务 + 真浏览器，9 组 / 45 条（需要浏览器，含 Network 自检）
npm run test:mp     # 小程序静态体检：6 组 / 51 条（不需要开发者工具）
npm run mock:mp     # 小程序页面模拟：9 组 / 58 条（wx 垫片 + 临时服务）
npm run test:all    # 依次跑上面六套（不含截图脚本）
```

首次 `npm start` 会自动建表并写入种子账号；重复启动不会重复插入（按邮箱判重）。

启动日志会打印两类地址，手机调试时直接用下面这一类：

```
齿记工具助手演示站已启动  监听 0.0.0.0:3000
本机访问：http://127.0.0.1:3000
同一局域网 / 手机真机访问（填进 miniprogram/config.js 的 BASE_URL）：
  http://192.168.1.23:3000   [WLAN]
  http://26.3.211.185:3000   [Radmin VPN]  ← 虚拟网卡，手机通常连不到这个
```

两条与「手机连不上」直接相关的约定：

- **监听地址显式绑 `0.0.0.0`**：`app.listen(PORT, HOST, …)`，`HOST` 默认 `0.0.0.0`，可用同名环境变量收窄。绑成 `127.0.0.1`（回环）时只有本机能连，手机、别的电脑、容器的健康检查全都探不到。
- **Windows 防火墙需放行 3000**：管理员执行 `netsh advfirewall firewall add rule name="LSD-3000" dir=in action=allow protocol=TCP localport=3000`，或在 Defender 弹窗里选「允许」（勾专用网络）。详细排查与「体验版」的三层域名限制见 `DEPLOY.md` §11。

另有一个**只用于出证据**的脚本（不进 `test:all`，因为它会截图、会写文件）：

```bash
node scripts/capture-payment.mjs   # 支付页截图 + Network 请求清单 → .workbuddy/shots/
```

可选环境变量：`PORT`（默认 3000）、`DB_FILE`（默认 `data/app.db`）、`SESSION_SECRET`、`BCRYPT_ROUNDS`。

### 10.2 `server/` 各文件职责

| 文件 | 职责 | 关键点 |
| --- | --- | --- |
| `app.js` | Express 装配：安全响应头、JSON 解析、会话、路由挂载、静态托管、错误处理 | 静态目录的 `BLOCKED` 名单挡住 `/server` `/data` `/node_modules` `*.db` |
| `db.js` | 连接 SQLite、建表、种子数据、把常用查询预编译成 `stmts` | 全部 `prepare()` + 参数绑定；`seed()` 用事务 |
| `password.js` | bcrypt 适配层 | 两种实现产出格式一致，换实现不用迁移数据 |
| `auth.js` | 校验函数（手机号/邮箱/密码/姓名）、`authenticate`（cookie + Bearer 双通道，`requireAuth` 是它的别名）、`requireRole`、内存限流 | 权限以**数据库里的 role + status** 为准 |
| `routes/auth.js` | 注册、医生申请、登录、登出、`/me` | 注册接口**不读** `role` 字段 |
| `routes/protected.js` | 病人 / 医生 / 管理员三组业务接口 | 每个路由都挂 `authenticate` + `requireRole` |
| `reset-db.js` | 删库重建 | 演示前想回到干净状态时用 |

### 10.3 数据库设计

只有一张表 `users`：

```sql
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  role          TEXT NOT NULL CHECK (role IN ('patient','doctor','admin')),
  phone         TEXT UNIQUE,          -- 病人用
  email         TEXT UNIQUE,          -- 医生 / 管理员用
  password_hash TEXT NOT NULL,        -- bcrypt，$2b$10$ 开头，60 字符
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','active','disabled')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (role = 'patient'            AND phone IS NOT NULL AND email IS NULL)
    OR
    (role IN ('doctor','admin')  AND email IS NOT NULL AND phone IS NULL)
  )
);
```

三点设计说明：

1. **登录标识随角色分流**：病人用手机号，医生与管理员用邮箱。表级 `CHECK` 把这条规则焊死在数据库层——代码写错也插不进「有邮箱的病人」。
2. **`status` 三态**：`pending` 待审核 / `active` 正常 / `disabled` 停用。默认 `pending` 是「安全的那一侧」：忘了显式激活，账号就不会生效。
3. **`role` 的 `CHECK`** 只允许三个值，防止拼写错误造出第四种角色。

### 10.4 种子账号

`npm start` 首次运行自动创建，初始密码统一为 **`Demo@1234`**（仅演示用，真实项目绝不能预置固定密码）。

| 角色 | 账号 | 密码 | 状态 |
| --- | --- | --- | --- |
| 管理员 | `admin@demo.local` | `Demo@1234` | active |
| 医生（种植科） | `liu-implant@demo.local` | `Demo@1234` | active |
| 医生（正畸科） | `liu-ortho@demo.local` | `Demo@1234` | active |
| 医生（综合与牙周） | `liu-general@demo.local` | `Demo@1234` | active |
| 医生（儿童齿科） | `liu-kid@demo.local` | `Demo@1234` | active |

四位医生与 `data.js` 里的展示医师一一对应（`liu-implant` / `liu-ortho` / `liu-general` / `liu-kid`）。病人账号需要自己注册，没有预置。

### 10.5 API 列表

| 方法 | 路径 | 权限 | 说明 | 主要失败码 |
| --- | --- | --- | --- | --- |
| GET | `/api/health` | 公开 | 健康检查，返回用户总数 | — |
| POST | `/api/register` | 公开 | 病人注册（姓名 + 手机号 + 密码） | 400 校验失败 / 409 手机号已存在 |
| POST | `/api/doctor/apply` | 公开 | 医生入驻申请，落库即 `pending` | 400 / 409 邮箱已申请 |
| POST | `/api/login` | 公开（限流） | 手机号或邮箱 + 密码 | 400 / 401 账号或密码错 / 403 待审核或停用 / 429 太频繁 |
| POST | `/api/logout` | 公开 | 销毁会话并清 cookie | — |
| GET | `/api/me` | 公开 | 当前身份；未登录返回 `{ user: null }` | — |
| GET | `/api/patient/summary` | 病人 | 我的预约（占位，`state: "todo"`） | 401 未登录 / 403 角色不符 |
| GET | `/api/doctor/patients` | 医生 | 我的患者（占位） | 401 / 403 |
| GET | `/api/admin/users?status=` | 管理员 | 按状态列账号，`status` ∈ pending/active/disabled | 400 / 401 / 403 |
| POST | `/api/admin/users/:id/activate` | 管理员 | 激活账号（审核通过 / 恢复停用） | 400 / 404 |
| POST | `/api/admin/users/:id/disable` | 管理员 | 停用账号（不能停用管理员） | 400 / 404 |

统一约定：成功返回 `{ user }` 或 `{ users }`，失败返回 `{ error: "中文提示" }`；**任何响应都不含 `password_hash`**。

> 第二期起的预约接口见 §11.8，第三期医生端状态流转见 §12.2，第五期订单与模拟支付接口见 §16.4。

### 10.6 安全设计

| 面 | 做法 | 为什么这样做 |
| --- | --- | --- |
| 密码存储 | bcrypt（cost 10，自带随机 salt），库里只有 `$2b$10$...` | 拖库也拿不到明文；同密码不同人哈希不同 |
| 密码外泄面 | 出口用**字段白名单**（`toPublicUser` 只挑 id/role/name/status/phone/email） | 以后加字段也不会因为「忘了删」而泄露 |
| 日志 | 只记 `method + path + error.message`，请求体永不落日志 | 登录请求体里就是明文密码 |
| 角色（注册） | 服务端硬编码 `role='patient'`，**完全不读** `body.role`；数据库 `CHECK` 再兜一层 | 客户端传什么角色都无效，改 DOM 也没用 |
| 角色（医生） | 只能走 `/api/doctor/apply`，固定 `role='doctor'` + `status='pending'` | 医生不能自助激活，必须管理员审核 |
| 权限判断 | `authenticate` 每次请求**回库查** `role` 与 `status`（cookie 与 Bearer 都一样）；`requireRole(...)` 再卡角色 | 停用立刻生效，不信 session / token 里缓存的值 |
| 会话 | `httpOnly: true`、`sameSite: 'lax'`、`saveUninitialized: false`、登录成功后 `session.regenerate()` | JS 读不到 cookie；跨站 POST 不带 cookie；防会话固定攻击 |
| SQL 注入 | 全部 `db.prepare(...).run/get/all(参数)`，无字符串拼接 | 参数是值不是 SQL 片段 |
| 输入校验 | 服务端二次校验手机号正则、密码 ≥ 8、姓名 2–20、邮箱格式 | 前端校验只为少一次往返，不是安全边界 |
| 登录爆破 | 同一 IP + 账号 15 分钟 10 次，超限 429 + `Retry-After` | 内存版，够演示；生产换 Redis |
| 账号探测 | 账号不存在与密码错误返回同一句「账号或密码不正确」，且都跑一次 bcrypt | 响应文案与时序都不泄露账号是否存在 |
| 源码/数据边界 | `/server`、`/data`、`/node_modules`、`*.db`、`package.json` 一律 404 | 静态托管根目录是整个项目，必须显式挡 |

**本期没做的**（写在这里，避免误以为有）：CSRF token（只靠 `sameSite=lax`）、HTTPS（本地 http）、会话持久化（`MemoryStore`，重启掉线）、登录审计表、验证码、密码找回、医生材料上传与人工核验。

### 10.7 接口回归：22 组 / 266 条（第 7–11 组第二期、12–17 组第三/四期、18–20 组第五/六期、21 组第七期、22 组第八期）

`scripts/api-test.mjs` 会另起一个服务进程（端口 3101）+ 临时库（`.workbuddy/test.db`），用真实 HTTP 请求跑断言，**关键的「角色」断言还会直接查库核对 `role` 列**。跑完自动删库，不污染 `data/app.db`。

| # | 检查组 | 断言数 | 结果 |
| --- | --- | --- | --- |
| 1 | 注册：角色不可由客户端指定 | 8 | ✅ 8/8 |
| 2 | 注册字段校验（手机号 / 密码 / 姓名 / 重复） | 4 | ✅ 4/4 |
| 3 | 登录与会话 cookie（HttpOnly / SameSite / 统一错误文案 / 注入串） | 8 | ✅ 8/8 |
| 4 | 权限拦截（未登录 401、角色不符 403、正向也验） | 7 | ✅ 7/7 |
| 5 | 医生申请 → 待审核 → 管理员激活 → 可登录 | 9 | ✅ 9/9 |
| 6 | 停用即时生效 + 登出 | 6 | ✅ 6/6 |
| 7 | 静态资源不可访问（源码 / 数据库 / README / .git…） | 15 | ✅ 15/15 |
| 8 | 预约：可约时段与提交（含 409 / 404 / 400 分支） | 11 | ✅ 11/11 |
| 9 | 并发防重：同一时段只成功一个 | 5 | ✅ 5/5 |
| 10 | 对象级越权（病人 A vs 病人 B / 医生 A vs 医生 B） | 7 | ✅ 7/7 |
| 11 | 取消规则：时段开始前可取消 | 8 | ✅ 8/8 |
| 12 | 医生状态流转：确认 → 完成 / 未到诊（第三期） | 8 | ✅ 8/8 |
| 13 | 非法状态转换：全部拒绝（第三期） | 14 | ✅ 14/14 |
| 14 | 病人预约详情（第三期） | 9 | ✅ 9/9 |
| 15 | 补漏复核：过去时段 / 取消幂等 / 医生审核（第三期） | 12 | ✅ 12/12 |
| 16 | 老库迁移 no_show：不丢数据、索引还在且条件已更新；索引**整个缺失**也会自动补建（第三/四期，第六期加强） | 8 | ✅ 8/8 |
| 17 | no_show 释放号源 + reopen 纠错（第四期） | 17 | ✅ 17/17 |
| 18 | 日志与密码（日志里无明文、无哈希、无密钥） | 3 | ✅ 3/3 |
| 19 | 模拟支付：金额、幂等、归属；no_show 拦截；医生端支付状态（第五/六期） | 45 | ✅ 45/45 |
| 20 | 价格单一来源：`/api/services` = `pricing.js`；HTML 无硬编码金额（第六期） | 5 | ✅ 5/5 |
| 21 | 小程序公开接口：免登录 / 字段收窄（无证号、无邮箱、无金额分）/ 与 data.js 同源 / 限流 429（第七期） | 15 | ✅ 15/15 |
| | **合计** | **222** | **✅ 222/222** |

#### 「病人不能把自己注册成医生」怎么验的

分四层，缺一层都不算验到：

1. **客户端伪造参数**：`POST /api/register` 时在 body 里塞 `role: "admin"`、`role: "doctor"`、`status: "active"`、`isAdmin: true` → 接口仍返回 `201`，但响应里的 `role` 是 `patient`。
2. **看响应不算数**：再直接打开 SQLite 查一行 `SELECT role, status, password_hash FROM users WHERE phone = ?`，确认 `role = patient`、`status = active`，且 `password_hash` 是 `$2b$` 开头的哈希而不是明文。
3. **看能力不算数，要看拦截**：用这个病人会话去调 `GET /api/doctor/appointments` 和 `GET /api/admin/users`，必须双双 `403`；调 `GET /api/patient/appointments` 才是 `200`。
4. **数据库兜底**：`users` 表有 `CHECK (role IN ('patient','doctor','admin'))` 与「病人必须有 phone、不能有 email」的约束；就算代码被改坏，也插不进一个「有邮箱、role=doctor」的病人行。

以上四步都在 `npm run test:api` 的**第 1 组（8 条）**与**第 4 组（7 条）**里，每次跑都会重新证明一遍。第三组还额外验了「登录账号传 `' OR '1'='1` 只会得到 401，不会 500」——说明查询是参数化的，不是拼字符串。

### 10.8 本期未做

- 预约业务：`appointments` 表、号源、医生排班、患者与医生的关联视图（控制台里两处标了「待开发」）。
- 管理员对病历、处方、收费的增删改查。
- 医生申请的材料上传与人工核验流程。
- 移动端登录态的进一步打磨（目前是汉堡菜单里的文本链接）。

---

## 11. 第二期：在线预约

> **范围**：病人预约、取消、查看自己的预约；医生只读查看自己的患者预约。
> **不做**：支付、病历、处方、医生确认/完成操作、候补、短信通知。
> 所有数据仍是演示假数据，保存在本地 SQLite。

### 11.1 数据设计

两张新表 + 一条**部分唯一索引**。没有把时段信息塞进 `appointments`，因为「可约时段」和「谁约了」是两件事：

- `schedules` 是**供给**：哪个医生、哪天、几点到几点、是否开放。改排班不影响已有预约。
- `appointments` 是**占用**：谁占了哪个 `schedule_id`。取消只改这一行，不删排班。

```sql
CREATE TABLE schedules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id   INTEGER NOT NULL REFERENCES users(id),
  date        TEXT    NOT NULL,        -- YYYY-MM-DD
  start_time  TEXT    NOT NULL,        -- HH:MM
  end_time    TEXT    NOT NULL,        -- HH:MM
  status      TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (start_time < end_time),
  UNIQUE (doctor_id, date, start_time)   -- 同医生同一天同一开始时间只能有一个时段
);

CREATE TABLE appointments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id   INTEGER NOT NULL REFERENCES users(id),
  doctor_id    INTEGER NOT NULL REFERENCES users(id),
  schedule_id  INTEGER NOT NULL REFERENCES schedules(id),
  status       TEXT    NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','confirmed','cancelled','completed','no_show')),
  note         TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  cancelled_at TEXT,
  -- 取消必须有时间戳；没取消就不许有。否则取消规则与统计都会被脏数据带偏
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);

-- ★ 防双重预订的唯一防线 ★
-- 只有「占着号源」的状态才进索引：cancelled 与 no_show 都不占号，必须排除
CREATE UNIQUE INDEX ux_appt_active_slot
  ON appointments (schedule_id) WHERE status NOT IN ('cancelled', 'no_show');
```

**部分索引的语义**：只对「占着号源」的行建唯一约束。于是

- 一个时段最多只能有 1 条 `pending / confirmed / completed` 的预约 → 抢不到第二个；
- 取消或标记未到诊后，该行退出索引 → 时段自动重新可约，不需要写「删预约」或「置空」的补偿逻辑；
- `completed` 仍然占着时段（这个时间确实被用掉了），语义正确。

> **第四期修正**：第二期的条件是 `WHERE status <> 'cancelled'`，把 `no_show` 也算成占用。结果是被标「未到诊」的时段永久锁死——病人约不了、医生也改不回来。`no_show` 的真实语义是「这个人这次没来」，不是「这个时段被消耗了」，所以它必须释放号源。改索引之外还得同时改两处查询的 `LEFT JOIN` 条件，否则会出现「数据库允许插入、列表却仍显示已占用」的矛盾。

种子排班：4 位医生 × 未来 14 天 × 每天 3–4 个时段 = **196** 条。只在「该医生一条排班都没有」时生成，重复启动不会翻倍。

### 11.2 预约状态机

五个状态、**八条**合法转换。第三期把 `confirmed / completed / no_show` 从虚线改成了实线，第四期给 `no_show` 补了 `reopen`，第九期又给 `completed` 补了 `revert`（撤销完成），并给「完成」加了时间闸门。

```
pending ──confirm──▶ confirmed ──complete──▶ completed
   │                    │   ▲                    │
   │ cancel（未开始）     │   └─────revert────────┘   （仅时段未开始）
   │                    ├──no-show──▶ no_show ──reopen──▶ confirmed
   ▼                    │
cancelled（终态）◀───────┘  cancel（未开始）
```

**谁能触发哪个转换**（这张表就是服务端的判断依据，不是文档装饰）：

| # | 转换 | 触发者 | 接口 | 附加条件 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | （无）→ `pending` | 病人本人 | `POST /api/appointments` | 时段存在、`open`、未开始、未被占 | ✅ |
| 2 | `pending` → `confirmed` | 该预约的医生 | `POST /api/doctor/appointments/:id/confirm` | 只能是 `pending` | ✅ |
| 3 | `confirmed` → `completed` | 该预约的医生 | `POST /api/doctor/appointments/:id/complete` | 只能是 `confirmed`；**时段已开始**（否则 `409 TOO_EARLY`） | ✅ 第九期加时间闸门 |
| 4 | `confirmed` → `no_show` | 该预约的医生 | `POST /api/doctor/appointments/:id/no-show` | 只能是 `confirmed` | ✅ |
| 5 | `no_show` → `confirmed` | 该预约的医生 | `POST /api/doctor/appointments/:id/reopen` | 只能是 `no_show`；时段未被别人重约 | ✅ 第四期新增 |
| 6 | `pending` → `cancelled` | 病人本人 | `POST /api/appointments/:id/cancel` | **时段还没开始** | ✅ |
| 7 | `confirmed` → `cancelled` | 病人本人 | 同上 | **时段还没开始** | ✅ |
| 8 | `completed` → `confirmed` | 该预约的医生 | `POST /api/doctor/appointments/:id/revert` | 只能是 `completed`；**时段还没开始**（已开始的拒绝） | ✅ 第九期新增 |
| 9 | 任何 → `pending` | — | — | 没有「回到待确认」的入口 | ❌ 不存在 |
| — | `cancelled` → 任何 | — | — | `cancelled` 是真正的终态 | ❌ 拒绝 |

`no_show` **不是终态**：它是医生对「这次没来」的标记，可能标错，所以留了 `reopen` 一条纠错边。它也不是「可取消」的状态——病人不能取消一条已经判定为未到诊的记录，要改只能由医生操作。

`completed` 也不再是绝对终态，但只对「时段还没开始」开放 `revert`：那是明显的误操作（诊疗一天都还没发生）。已经开始的诊疗记录不许改回去。

**非法转换一律 409 `BAD_STATE`**，响应带 `{ status, status_label, expected }`，前端不用解析中文文案。当前 8 种组合都有断言（见 §12.5）：

| 非法转换 | 为什么非法 |
| --- | --- |
| `pending` → `complete` | 没确认就完成，跳过了医生确认这一步 |
| `pending` → `no-show` | 没确认就不存在「患者没来」 |
| `cancelled` → `confirm` / `complete` | 已取消的时段已被别人订走，复活会造成双订 |
| `completed` → `confirm` / `complete` | 已完成不能再确认或再完成一次；要纠正只能走 `revert`（且时段必须还没开始） |
| `no_show` → `confirm` / `complete` | `no_show` 的唯一合法出边是 `reopen`；要回到可推进状态必须先 reopen |

三层保证：**路由判状态**（409 BAD_STATE）→ **SQL 的 WHERE 带原状态**（`AND status = 'pending'`，并发下 changes=0）→ **数据库 CHECK**（只允许五个合法值）。少任何一层都能被绕过。

`reopen` 还多一种冲突：`no_show` 已经把号源放出去了，如果这个时段**已经被别人重新约走**，把原记录改回 `confirmed` 就会撞 `ux_appt_active_slot`。这一条不能报 `BAD_STATE`（状态是对的，是号源没了），单独返回 **409 `SLOT_REBOOKED`**。


### 11.3 取消规则：时段开始前可取消（第九期修订）

- 判定基准是**时段开始时刻**（`date + start_time` 按本地时间拼），不是预约创建时刻。
- **只要时段还没开始**就允许自助取消；已经开始的一律 `409 ALREADY_STARTED`。
- `cancel_rule` 里给 `minutes_left` / `hours_left` / `cancellable` / `reason`，前端只做翻译，不自己算时间。
- **取消已支付的预约时，订单在同一个事务里变成 `refunded`**（见 §11.4），响应带 `refund` 字段。

**为什么把「开始前 24 小时内不可取消」这条规则删掉了**：它假设用户提前几天预约，但演示里几乎所有人都是「今天约明天」。一条 11-25 11:24 提交、11-26 09:00 开始的预约，提交时距开始只有 21 小时 36 分——**从预约成功的那一秒起就取消不了**，规则比它想防的问题更伤人。现在临期爽约交给门诊侧用电话改期处理，不再用它卡住所有预约。

### 11.4 取消与退款联动（第九期新增）

只把预约改成 `cancelled`、订单留在 `paid`，会留下「人不来了、钱还挂着」的半截状态，病人还得自己再找退款按钮——而那个入口此前恰好是断的。

现在两条 UPDATE 在**同一个事务**里（`cancelWithRefund`）：

| 订单状态 | 取消后的行为 |
|---|---|
| 没有订单 | 只取消 |
| `unpaid` | 只取消（没付过钱，没有可退的） |
| `paid` | 取消 + 退款（`refunded_at` 落时间戳） |
| `refunded` | 只取消（不重复退） |

响应：`{ ok:true, id, status:'cancelled', refund: { order_id, amount_cents, amount_text, status:'refunded', simulated:true } | null }`。前端据此提示「已取消，¥280.00 已退回（模拟）」。

另有两条配套改动：
- `POST /api/patient/appointments/:id/order` 把「已有订单就直接返回」提到状态检查**之前**。否则 `completed` / `cancelled` 的预约进支付页会直接 409，拿不到订单，退款按钮根本不渲染——功能存在但永远点不到。
- Web 端「我的预约」里，已支付的预约不再只显示一行文字，而是给出「查看 / 退款」入口进 `payment.html`。

### 11.5 医生端时间闸门与「撤销完成」（第九期新增）

状态机只回答「这条记录现在是什么状态」，回答不了「现在该不该做这个动作」。原来医生可以在任何时刻把一条**明天上午**的预约标成 `completed`，病人因此不能取消、也退不了款。

现在加了两道时间闸门：

| 动作 | 闸门 | 错误码 |
|---|---|---|
| `completed` ← `confirmed` | 时段必须**已经开始** | `409 TOO_EARLY` |
| `confirmed` ← `completed`（撤销完成） | 时段必须**还没开始** | `409 ALREADY_STARTED` |

`revert` 是新增的第 8 条合法边，只给「时段还没开始却被标完成」的误操作兜底：没有它，一条误标的记录同时锁死三件事（不能取消、不能退款、单子结不掉）。已经开始的诊疗记录不许改回去。

前端在 `completed` 且时段未开始时显示「撤销完成」按钮；服务端仍会独立校验，不依赖前端。

### 11.6 并发防重：为什么不在应用层写 if

**错误做法（有竞态）**：

```js
// 千万不要这样
const taken = db.prepare('SELECT 1 FROM appointments WHERE schedule_id = ? AND status != ?').get(sid, 'cancelled');
if (taken) return res.status(409).json({ error: '已约满' });   // ← 两个请求可能同时走到这里
db.prepare('INSERT ...').run(...);                              // ← 两条 INSERT 都执行
```

「查」和「写」之间有一条时间缝，两个病人同时进来就会都查到「空」、都插入成功。**加事务也救不了**：如果两个事务都是「先读后写」，读阶段都不加写锁，照样双插。

**实际做法**：不查，直接插，让数据库裁决。

```js
// server/routes/appointments.js
const info = stmts.insertAppointment.run(patientId, slot.doctor_id, scheduleId, note);
// 撞唯一约束 → SQLITE_CONSTRAINT_UNIQUE → 翻译成 409 SLOT_TAKEN
```

`isUniqueViolation(err)` 把 `SQLITE_CONSTRAINT_UNIQUE` / `UNIQUE constraint failed` 统一识别，返回 `409 SLOT_TAKEN`。其余异常继续抛给全局错误处理，不会把真实错误吞成 409。

**三层验证**（`npm run test:race`，2 组 / 7 条）：

| 层 | 做法 | 结果 |
| --- | --- | --- |
| A. 单进程 8 并发 | 8 个 `Promise` 同时 POST 同一 `schedule_id` | 1 个 `201`、7 个 `409`；库里该时段 1 条未取消记录 |
| B. 双进程 TOCTOU | 两个**独立操作系统进程**各自持连接：读「有没有被占」→ 故意等 400ms → INSERT | 两个进程都读到「空闲」（竞态窗口真实存在），只有 1 个 INSERT 成功，另 1 个是 `SQLITE_CONSTRAINT_UNIQUE` |
| C. 绕过接口 | 用独立连接直接 `INSERT` 同一 slot（不经过任何路由代码） | 被唯一索引拒绝 |

B 和 C 是关键：它们证明「即使应用层判断被删掉、或者换成多进程/多实例部署，也不会双订」。A 单独看其实说服力有限——Node 单线程 + better-sqlite3 同步驱动会把两个 HTTP 请求排队，所以 A 只能证明「行为正确」，B/C 才证明「机制正确」。

`scripts/race-worker.cjs` 就是 B 里的那个子进程，故意写成「读 → 睡 → 写」的经典 TOCTOU 形态。

### 11.7 对象级权限（比 requireRole 更细的一层）

`requireRole('patient')` 只回答「你是不是病人」。它回答不了「这条预约是不是你的」——病人 A 和病人 B 都是 `patient`，角色校验对两人都放行。所以每个涉及具体资源的接口都要再比一次 id：

| 接口 | 归属条件 | 写在哪 |
| --- | --- | --- |
| `GET /api/patient/appointments` | `WHERE patient_id = req.user.id` | SQL 的 WHERE |
| `POST /api/appointments/:id/cancel` | 先查出来比 `patient_id`，不是自己 → `403 NOT_OWNER`；`UPDATE` 里再带一次 `patient_id` | 代码 + SQL 双保险 |
| `GET /api/doctor/appointments` | `WHERE doctor_id = req.user.id` | SQL 的 WHERE |
| `GET /api/doctor/schedules` | `WHERE doctor_id = req.user.id`；**doctor_id 不从 query 取** | 只认 session |

`UPDATE` 里重复带 `patient_id` 是刻意的冗余：万一上面某天被改坏，SQL 这一层仍然写不动别人的行。查到 `changes === 0` 时返回 `409 STATE_CHANGED`，而不是假装成功。

**实测**（`npm run test:api` 第 10 组，7 条，全通过）：

1. 病人 B 拿 A 的预约 id 去取消 → `403 NOT_OWNER`（不是 404、也不是静默成功）。
2. 越权尝试后回库核对：A 那条预约状态仍是 `pending`，没被改。
3. B 的「我的预约」列表里看不到 A 的预约。
4. 医生 A 查排班时传 `?doctor_id=<医生B>` → 结果与不传完全相同（参数被忽略）。
5. 正畸医生看不到种植科医生的那条预约；种植科医生能看到属于自己的那条（正向也验，避免「全都拦」被误判成通过）。

### 11.8 新增 API

| 方法 | 路径 | 权限 | 说明 | 主要错误码 |
| --- | --- | --- | --- | --- |
| GET | `/api/doctors` | 公开 | 医生清单（id / name / dept / slug），供预约页把 `data.js` 的 `liu-ortho` 映射到数据库 id | — |
| GET | `/api/schedules?doctor_id=&date=` | 病人 | 某医生某天的时段，含 `open` 与 `taken` | 400 `BAD_DOCTOR_ID` / `BAD_DATE`；404 `DOCTOR_NOT_FOUND` |
| POST | `/api/appointments` | 病人 | 提交预约，body `{ schedule_id, note }` | 400 `BAD_SCHEDULE_ID` / `NOTE_TOO_LONG` / **`SLOT_IN_PAST`**；404 `SLOT_NOT_FOUND`；409 `SLOT_TAKEN` / `SLOT_CLOSED` |
| GET | `/api/patient/appointments` | 病人 | 我的预约（仅自己） | 401 / 403 |
| GET | `/api/patient/appointments/:id` | 病人 | **第三期新增**。预约详情：医生姓名 / 科室 / 时段 / 状态 / 剩余小时数 / 取消规则 | 400 `BAD_ID`；403 `NOT_OWNER`；404 `NOT_FOUND` |
| POST | `/api/appointments/:id/cancel` | 病人 | 取消自己的预约 | 403 `NOT_OWNER`；404 `NOT_FOUND`；409 `ALREADY_CANCELLED` / `NOT_CANCELLABLE` / `ALREADY_STARTED` / `STATE_CHANGED`；成功时响应带 `refund` |
| GET | `/api/doctor/appointments` | 医生 | 我的患者预约（仅自己） | 401 / 403 |
| POST | `/api/doctor/appointments/:id/confirm` | 医生 | **第三期新增**。`pending` → `confirmed` | 400 `BAD_ID`；403 `NOT_OWNER`；404 `NOT_FOUND`；409 `BAD_STATE` / `STATE_CHANGED` |
| POST | `/api/doctor/appointments/:id/complete` | 医生 | **第三期新增**。`confirmed` → `completed`；**第九期起要求时段已开始** | 400 `BAD_ID`；403 `NOT_OWNER`；404 `NOT_FOUND`；409 `BAD_STATE` / **`TOO_EARLY`** / `STATE_CHANGED` |
| POST | `/api/doctor/appointments/:id/no-show` | 医生 | **第三期新增**。`confirmed` → `no_show`（同时释放号源） | 同上 |
| POST | `/api/doctor/appointments/:id/reopen` | 医生 | **第四期新增**。`no_show` → `confirmed`，纠错用 | 400 `BAD_ID`；403 `NOT_OWNER`；404 `NOT_FOUND`；409 `BAD_STATE` / **`SLOT_REBOOKED`** |
| POST | `/api/doctor/appointments/:id/revert` | 医生 | **第九期新增**。`completed` → `confirmed`（撤销完成），仅限时段还没开始 | 400 `BAD_ID`；403 `NOT_OWNER`；404 `NOT_FOUND`；409 `BAD_STATE` / **`ALREADY_STARTED`** |
| GET | `/api/doctor/schedules?date=` | 医生 | 自己的排班与占用情况（doctor_id 取 session） | 400 `BAD_DATE` |

错误响应统一为 `{ error: "中文提示", code: "MACHINE_CODE" }`，前端按 `code` 分支，不靠匹配中文文案。上表合计 13 条，与 §9 的 **22** 个 `/api/*` 端点一致（另 9 条是第一期的认证与管理接口）。

### 11.9 前端改造

| 文件 | 改动 |
| --- | --- |
| `appointment.html` | 表单卡片顶部加 `#booking-bar`（登录态提示）、时段下拉补 `#err-time`、把「演示不会发出请求」的文案改成「未登录不发请求 / 登录后写入本地库」 |
| `assets/js/booking.js` | **新增**。已登录病人进入在线模式：预填姓名手机号并设为只读、拉 `/api/doctors` 建 slug→id 映射、医师或日期变化时拉 `/api/schedules` 填充时段、提交走 `POST /api/appointments` |
| `assets/js/main.js` | submit 处理器开头加一行：`if (window.LSD_BOOKING && window.LSD_BOOKING.active) return;` —— 在线模式交给 booking.js，未登录时行为与第一期完全一致（29 条展示页回归仍全绿） |
| `dashboard.html` | 病人面板改为「我的预约」列表 + 新建按钮；医生面板改为「我的患者预约」（只读）+ 科室字段 |
| `assets/js/dashboard.js` | 重写为 **纯 DOM + textContent** 渲染；病人侧支持行内二次确认取消；医生侧只读 |
| `assets/css/style.css` | 追加 §18：`.booking-bar`、`.appt-*`、`.btn--danger`、只读输入框样式 |

取消的二次确认是**行内两步**，不是 `window.confirm`：第一次点「取消预约」→ 变成「确认取消这次预约？[确认取消] [再想想]」→ 第二次点才发请求。这样既能被自动化测试断言，也不依赖浏览器弹窗行为。

一个取舍：`appointments` 表没有 `service` 列，但预约页的项目是必填项。做法是把项目名拼进 `note`（`项目：牙齿矫正｜<用户备注>`，截断 200 字），避免「选了却不落库」。代价是结构化查询项目需要解析备注——本期不做统计，可以接受；要正经做得加 `service_id` 列。

### 11.10 本轮安全加固（三个击穿点实测 + 修复）

#### 11.8.1 静态文件泄露

改造前用 `express.static(ROOT)` 托管整个项目根目录，靠 `BLOCKED` 黑名单挡敏感文件。实测结果：

| 路径 | 状态码 | 说明 |
| --- | --- | --- |
| `/data/app.db` | 404 | 黑名单命中 |
| `/data/.session-secret` | 404 | 黑名单命中 |
| `/.session-secret` | 404 | 文件不在根目录 |
| `/server/app.js` | 404 | 黑名单命中 |
| `/package.json` | 404 | 黑名单命中 |
| `/.git/config` | 404 | 黑名单命中 |
| **`/README.md`** | **200** | ❌ **40KB 全文可读，其中 §10.4 写着种子账号密码** |

黑名单只挡「想到的」。`README.md` 不在名单里，于是整个项目的部署说明、账号密码、安全设计全成了公开页面。

**修复**：改成白名单，只放行白名单页面与 `/assets`（当时 8 个页面，第五期加 `payment.html` 后为 9 个）：

```js
const PAGES = new Set(['index.html','services.html','doctors.html','appointment.html',
  'contact.html','login.html','register.html','dashboard.html']);

app.use('/assets', express.static(path.join(ROOT, 'assets'), { index: false, dotfiles: 'deny' }));
app.get('/', ...);                                  // 只发 index.html
app.get('/:page', (req,res,next) => {
  if (!PAGES.has(req.params.page)) return next();   // 不在白名单就 404，不猜、不回退
  res.sendFile(...);
});
```

`BLOCKED` 保留为第二道闸，并补上 `/README.md`、`*.md`、`*.secret`、`^\/\.`（任何点开头的路径）。

**固化**：`api-test.mjs` 第 7 组「静态资源不可访问」共 **15 条**——13 条逐个路径断言 404 且响应体不含 `password_hash` / `$2b$` / `Demo@1234`，1 条断言白名单没误伤（8 页 + assets 全 200），1 条断言未知接口仍返回 JSON 404。

#### 11.8.2 session secret

生成逻辑在 `server/app.js` 的 `loadSecret()`，三级：

1. 有 `SESSION_SECRET` 环境变量 → 用它。**长度 < 32 直接抛错退出**（原来测试脚本用的 16 字符密钥现在会被拦）。
2. 有 `data/.session-secret` → 读它。内容 < 32 字符视为被截断/手改，抛错而不是凑合用；非 Windows 平台顺手 `chmod 0600`。
3. 都没有 → `crypto.randomBytes(32).toString('hex')`（256 位熵、64 字符 hex），写盘时 `mode: 0o600`。

**没有「环境变量没设就用默认字符串」的兜底**。写死的默认密钥等于把签名算法公开，任何人拿着源码就能伪造任意账号的会话——宁可起不来。

实测：

| 场景 | 结果 |
| --- | --- |
| 删掉密钥文件后启动 | 日志「会话密钥：data/.session-secret（本次新生成）」，文件 64 字符，sha256 = `4cc1c838…` |
| 紧接着再启动一次 | 日志「（复用已有）」，sha256 仍是 `4cc1c838…` → 确认复用而非重新生成 |
| `SESSION_SECRET=tooshort` 启动 | `[启动失败] SESSION_SECRET 太短（当前 8 字符，至少 32）`，退出码 **1** |
| 日志是否打印密钥 | 只打印**来源**，不打印值；第 12 组有专门断言 |

`data/` 已在 `.gitignore` 里，所以 `.session-secret` 不会进仓库。注意 Windows 上 `mode: 0o600` 不生效（POSIX 权限位在 NTFS 上无意义），代码里对非 Windows 平台补了 `chmod`。

#### 11.8.3 XSS

审计 `dashboard.js` 的渲染点，发现两类：

- 标题、姓名、手机号、邮箱 → 本来就是 `textContent`，安全；
- 管理员表格与「已停用账号」列表 → 用 `esc()` 转义后拼 `innerHTML`。转义本身是对的，但依赖「每次拼接都记得调用 `esc()`」，属于容易在某次改动中漏掉的写法。

**做法**：把这两处也改成 `createElement` + `textContent`，整个文件不再出现 `innerHTML`。多写几行，换来「不可能忘」。

实测用 `<img src=x onerror=alert(1)>` 注册：

| 尝试 | 结果 |
| --- | --- |
| 姓名直接提交 `<img src=x onerror=alert(1)>`（28 字） | `400 请填写 2–20 个字的姓名` —— 长度校验先拦住了 |
| 换成能过校验的短载荷 `<b>X</b>`（8 字） | `201` 创建成功，库里原样存 `<b>X</b>` |
| 登录后打开控制台，检查 `#dash-title` | `textContent` = `<b>X</b>，你好`；`innerHTML` = `&lt;b&gt;X&lt;/b&gt;，你好`；子元素数 **0** |
| 管理员表格里显示 `<b>D</b>` 的待审核医生 | 单元格 `textContent` = `<b>D</b>`，子元素数 **0**，表内 `b/img/script/svg` 数量 **0** |
| `window.__alerts`（拦截 alert / confirm / prompt 及 error 事件） | 两个视图都是空数组，没有弹窗 |

结论：**服务端不转义、只做长度校验；渲染层一律 `textContent`**。这条分工要写进约定——如果哪天有人为了「显示备注里的换行」改成 `innerHTML`，XSS 就会回来。

### 11.11 回归（第二期快照；最新数字见 §16.7）

> 下表是第二期收尾时的值。之后每期都往上加了断言：第四期 17 组、第五期 19 组 / 194 条、第六期 20 组 / 207 条、第七期 21 组 / 222 条、第八期 22 组 / 254 条、第九期 22 组 / 266 条。**要看当前值请直接看 §9 的口径表。**

| 脚本 | 内容 | 结果 |
| --- | --- | --- |
| `npm run test:api` | 18 组 / 155 条（静态资源 15、预约 11、并发 5、越权 7、24 小时 6、状态流转 8、非法转换 14、详情 9、补漏 12、迁移 6、no_show/reopen 17、日志 3） | ✅ 155/155 |
| `npm run test:race` | 2 组 / 7 条（单进程 8 并发 + 双进程 TOCTOU） | ✅ 7/7 |
| `npm run test:ui` | 7 组 / 29 条（第一期展示页交互，无退化） | ✅ 29/29 |
| `npm run test:all` | 依次跑接口 / 并发 / 展示页 / 端到端 / 小程序静态 / 小程序模拟六套 | — |

端到端脚本现已归档为 `scripts/e2e.mjs`（`npm run test:e2e`），第四期补了「未到诊 → 恢复」一组，共 7 组 / 24 条。它跑的流程是：注册 → 登录 → 预约页出现绿色登录条、姓名手机号只读 → 选医师与日期后拉到 4 个可约时段 → 提交得到「已提交：2026-11-30 09:00–10:00，状态「待确认」」→ 控制台出现 1 条「待确认」→ 点取消出现行内二次确认、状态不变 → 点「再想想」确认区消失 → 再点取消并确认，状态变「已取消」、提示「该时段已重新放出」。

### 11.12 本期未做（第二期结束时）

> 前两条已在第三期完成，见 §12；其余仍未做。

- 医生端的确认 / 完成操作（状态机里 `confirmed`、`completed` 两个状态目前无法产生）。
- 号源容量（一个时段固定只服务 1 人，没有「同一时段可放 3 个号」的概念）。
- 改期（只能取消后重约）、爽约记录、候补队列。
- 支付、病历、处方、检查报告。
- 短信 / 邮件通知（提交后没有任何自动化触达）。
- 排班管理界面（排班目前只有种子数据，改排班要直接改库或加脚本）。

---

## 12. 第三期：医生端闭环 + 病人预约详情

第二期结束时，状态机里 `confirmed`、`completed` 两个状态是画在纸上但走不到的。第三期把虚线接上：医生能确认、能完成、能标记未到诊，病人能看预约详情。**本期仍不做支付、不做病历。**

### 12.1 数据库：新增 `no_show`

五个状态由 `CHECK` 约束：

```sql
status TEXT NOT NULL DEFAULT 'pending'
       CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed', 'no_show'))
```

**迁移是个坑**：SQLite 不支持 `ALTER TABLE ... 改 CHECK`，只能重建表。老库里已经有真实预约，重建时漏一步就丢数据。做法：

```sql
ALTER TABLE appointments RENAME TO appointments_legacy;
CREATE TABLE appointments (...新的 CHECK...);
INSERT INTO appointments (id, patient_id, doctor_id, schedule_id, status, note, created_at, cancelled_at)
  SELECT id, patient_id, doctor_id, schedule_id, status, note, created_at, cancelled_at
  FROM appointments_legacy;
DROP TABLE appointments_legacy;
-- 再重建三个索引
```

三个细节：

1. **判定要不要迁移**：读 `sqlite_master` 里的建表语句，`/no_show/` 命中就 `return`。可以重复执行，启动一百次也只迁一次。
2. **索引必须重建，而且必须先删再建**：`ALTER TABLE ... RENAME` 不会改名索引，旧索引会跟着旧表走。此时新表上的 `CREATE UNIQUE INDEX IF NOT EXISTS` 会因为「同名索引已存在」被跳过，随后 `DROP TABLE appointments_legacy` 把索引一起带走——**新表上一条唯一索引都没有，双订静默复活**。第三期就踩了这个坑（当时的回归夹具只造了表、没造索引，所以没测出来），第四期已补：迁移前显式 `DROP INDEX`，夹具也把旧索引一起造出来。
3. **`foreign_keys` 要临时关掉**：改名 + 建表 + 拷数据期间，外键约束会让 `DROP` 失败。`db.pragma('foreign_keys = OFF')` 必须在事务外面执行。

迁移有专门的回归夹具：测试启动前手工造一张「第三期之前」的表并塞一条记录，服务启动时触发迁移，然后断言「记录还在」「`no_show` 已生效」「唯一索引还在」「非法状态值仍然插不进去」。

### 12.2 医生端接口：一张转换表 + 一个处理器

四个接口（confirm / complete / no-show / reopen）除了「从什么状态到什么状态」之外完全一样，所以写成数据 + 工厂函数：

```js
const DOCTOR_TRANSITIONS = {
  confirm:   { from: 'pending',   to: 'confirmed', stmt: 'confirmAppointment' },
  complete:  { from: 'confirmed', to: 'completed', stmt: 'completeAppointment' },
  'no-show': { from: 'confirmed', to: 'no_show',   stmt: 'noShowAppointment' },
  reopen:    { from: 'no_show',   to: 'confirmed', stmt: 'reopenAppointment' }  // 第四期
};
```

处理器按顺序判四件事，**顺序不能换**：

| 顺序 | 判断 | 不通过时 | 为什么必须在这个位置 |
| --- | --- | --- | --- |
| 1 | id 合法 | `400 BAD_ID` | 先挡脏输入，后面查库才有意义 |
| 2 | 预约存在 | `404 NOT_FOUND` | 不存在的资源谈不上归属 |
| 3 | `appt.doctor_id === req.user.id` | `403 NOT_OWNER` | **对象级权限**。角色是 doctor ≠ 这条预约是你的 |
| 4 | `appt.status === cfg.from` | `409 BAD_STATE` | **状态机**。带 `{ status, status_label, expected }` |

最后 `UPDATE` 的 `WHERE` 里再带一次 `doctor_id` 和原状态：

```sql
UPDATE appointments SET status = 'confirmed'
WHERE id = ? AND doctor_id = ? AND status = 'pending'
```

`changes === 0` 说明读完之后状态被别处改了（比如病人恰好取消），返回 `409 STATE_CHANGED` 而不是硬写。**注意没有返回值就直接成功的写法**——那等于把并发问题藏起来。

`reopen` 多一层：`no_show` 已经释放了号源，如果时段被别人重约，把原记录改回 `confirmed` 会撞唯一索引。此时状态是对的、冲突在号源，所以不能报 `BAD_STATE`，要在执行 `UPDATE` 时捕获唯一约束错误并翻译成 `409 SLOT_REBOOKED`。

### 12.3 病人预约详情

`GET /api/patient/appointments/:id`。和列表接口的区别值得说清：

- 列表是 `WHERE patient_id = ?`，别人的预约根本查不到，天然安全；
- 详情只能按 id 查，**没法在 SQL 里先过滤一层**，所以完全依赖对象级判断：`appt.patient_id !== req.user.id` → `403 NOT_OWNER`。

响应里带 `cancel_rule`，把「能不能取消」算在服务端：

```json
{
  "appointment": {
    "id": 12, "status": "pending", "status_label": "待确认",
    "date": "2026-12-05", "start_time": "09:00", "end_time": "10:00",
    "doctor": { "id": 2, "name": "刘主任", "dept": "种植科" },
    "cancel_rule": { "minutes_left": 16380, "hours_left": 273, "cancellable": true, "reason": "OK" }
  }
}
```

`reason` 四选一：`OK` / `ALREADY_STARTED` / `NOT_CANCELLABLE` / `ALREADY_CANCELLED`。前端只负责翻译成中文，**不自己算时间**——两边各算一遍迟早会算出不同结果。

### 12.4 前端

| 位置 | 改动 |
| --- | --- |
| 医生卡片 | 按状态给按钮：`pending` → 确认；`confirmed` → 标记完成 / 患者未到；`no_show` → 恢复为已确认；`completed` / `cancelled` 不给按钮 |
| 医生卡片顶部 | `#d-summary` 显示「待确认 N · 已确认 M」，操作后跟着变 |
| 操作后刷新 | 只重拉 `/api/doctor/appointments` 重渲染列表，**不整页刷新**（会丢滚动位置和提示） |
| 病人卡片 | 新增「预约详情」，就地展开，`aria-expanded` 同步；再点收起 |
| 卡片标识 | `.appt-item` 上加 `data-appt-id`，既是排查线索也是自动化测试的稳定锚点 |
| 交互防护 | 点操作按钮时先禁用列表里所有按钮，避免连点发两次请求（服务端仍会兜住） |

详情是**就地展开**而不是弹窗、也不是跳新页面：一是不打断阅读上下文，二是用 `aria-expanded` 能被读屏播报，三是自动化测试能直接断言 DOM。

一个测试驱动的细节：最初我用「卡片里的按钮」定位预约卡片，结果预约完成、按钮消失后定位就失效了。给卡片加 `data-appt-id` 之后定位与状态无关——这既修了测试，也是 DOM 该有的可读性。

### 12.5 第三期回归

| 脚本 | 内容 | 结果 |
| --- | --- | --- |
| `npm run test:api` | 17 组 / 137 条 | ✅ 137/137 |
| `npm run test:race` | 2 组 / 7 条 | ✅ 7/7 |
| `npm run test:ui` | 7 组 / 29 条 | ✅ 29/29 |
| 浏览器端到端 | 3 组 / 23 条（当时是一次性脚本） | ✅ 23/23 |

> 这张表是第三期结束时的快照。第四期把端到端脚本正式归档为 `scripts/e2e.mjs`（补了 no_show → reopen 一组，现为 **7 组 / 24 条**），接口回归也扩到 **18 组 / 155 条**；当前数字见 §15.4。

端到端用真实 Edge（CDP）跑：医生登录 → 卡片只有「确认预约」→ 点击 → 状态变已确认、按钮换成两个、小结从 2/0 变 1/1 → 点「标记完成」→ 变已完成、按钮全消失 → 查库确认 `status=completed`；切换病人登录 → 点「预约详情」→ 就地展开出 6 个字段（医师/时段/状态/取消规则/提交时间/备注）、`aria-expanded=true` → 再点收起。全程控制台无异常。

### 12.6 第三期未做

- 医生端不能取消预约（只有病人能取消）。真实门诊里医生需要「停诊并通知已约病人」，这牵涉通知，本期没做。
- 没有记录「谁在什么时候确认的」——`appointments` 只有 `created_at` 与 `cancelled_at`，`confirmed_at / completed_at / no_show_at` 都没加。要追溯操作历史得单独一张 `appointment_events` 表，比加三个字段更合适。
- 病人侧没有「改期」，只能取消后重约。
- 没有分页：医生的号一多，列表会很长。
- 医生端没有按日期 / 状态筛选。

---

## 13. 补漏三项（第三期开工前实测）

上一轮验收提了三处可能的漏洞。结论：**一处是命名不一致（已按新口径改），两处原本就是对的（补了断言固化）。**

### 13.1 过去时段：原本已经挡住，但状态码不对

实测三个过去时段（昨天 / 前天 / 今天已过去的 22:00）：

| 场景 | 改造前 | 改造后 |
| --- | --- | --- |
| 昨天 09:00 | `409 {"code":"SLOT_PAST"}` | `400 {"code":"SLOT_IN_PAST"}` |
| 前天 09:00 | `409 {"code":"SLOT_PAST"}` | `400 {"code":"SLOT_IN_PAST"}` |
| 今天 22:00（已开始） | `409 {"code":"SLOT_PAST"}` | `400 {"code":"SLOT_IN_PAST"}` |

拦截逻辑本来就在（`slotStartMs(slot.date, slot.start_time) <= Date.now()`），缺的只是口径：按验收要求统一成 `400 SLOT_IN_PAST`。为什么是 400 而不是 409：这属于「请求本身不合法」（要订一个已经过去的时间），不是「资源状态冲突」。

断言落在第 15 组：昨天时段 400、今天已开始时刻 400、以及**过去时段没有生成任何预约记录**（光看状态码不够，得确认库里没留下脏数据）。

### 13.2 取消幂等：原本就是 409，补了第二次/第三次

| 次数 | 状态码 | 响应体 |
| --- | --- | --- |
| 第 1 次 | `200` | `{"ok":true,"id":1,"status":"cancelled"}` |
| 第 2 次 | `409` | `{"error":"该预约已取消","code":"ALREADY_CANCELLED"}` |
| 第 3 次 | `409` | `{"error":"该预约已取消","code":"ALREADY_CANCELLED"}` |

关键是第 2、3 次不只返回码对，**库里的 `status` 与 `cancelled_at` 都没变**——断言直接比对两次操作前后的行，确认没有「重复取消刷新时间戳」这种隐性副作用。

### 13.3 医生申请链路：审核 UI 是「第二阶段第一期」做的，不是第三期补的

先更正上一轮的表述。上一轮写的「UI 其实一直有」容易被读成「第一阶段就有」——**这是错的**，需要把时间线说准：

| 阶段 | 有没有管理员审核页 | 说明 |
| --- | --- | --- |
| 第一阶段（纯静态站） | ❌ 没有 | 五个展示页 + 前端表单，**没有后端、也没有 `dashboard.html`**，不存在「后台页面」这种东西 |
| 第二阶段第一期（认证与角色） | ✅ 有 | 随 `dashboard.html` 与 `/api/admin/users*` 一起实现：待审表格 `#admin-tbody` + 刷新 `#admin-refresh` + 停用列表。当时验收里说的「做一个最简单的后台页」，落地的就是这个 |
| 第三期 | 只补断言 | 页面与接口都已在位，第三期加的是一条检查 `#admin-tbody` / `#admin-refresh` 是否还存在的断言，防止改版删掉入口而测试仍绿 |

所以准确说法是：**审核 UI 在第二阶段第一期实现，第三期只补了回归断言，第四期只把这段来历写清楚。** 第一阶段没有它，第三期也没有新做它。

完整链路实测：

| 步骤 | 结果 |
| --- | --- |
| 医生提交 `POST /api/doctor/apply` | `201`，`status=pending` |
| 未审核就登录 | `403 账号待审核，请联系门诊管理员` |
| 管理员 `GET /api/admin/users?status=pending` | `200`，能看到这条申请 |
| 管理员点「通过」→ `POST /api/admin/users/:id/activate` | `200`，`status=active` |
| 激活后登录 | `200`，`role=doctor` |

入口写明白：**用管理员账号（`admin@demo.local`）登录 → 控制台 → 「待审核的医生申请」表格 → 点「激活」。**

---

## 14. `reset-db` 重写：不再删文件

第二期收尾时发现 `npm run reset-db` 经常报 `EBUSY`：

```
Error: EBUSY: resource busy or locked, unlink 'D:\Dental Clinic\data\app.db'
```

原因是脚本先 `fs.unlinkSync(app.db)` 再重建。Windows 上只要还有任何进程持有句柄（编辑器索引、杀软扫描、上次没退干净的进程），删文件就会失败——而删文件失败跟「重置逻辑」其实没关系。

改成**用 SQL 清空**：

```js
// 1. 独立连接，按外键依赖倒序 DROP
DROP TABLE IF EXISTS appointments;
DROP TABLE IF EXISTS schedules;
DROP TABLE IF EXISTS users;
// 2. 关闭连接后 require('./db')，让建表与种子逻辑只保留一份
```

好处：

- 不需要删文件，绕开句柄问题；
- 建表语句与种子数据仍然只在 `db.js` 里维护，不在两个文件里各写一份；
- 可以连续跑多次，结果一致。

实测连续跑三次，每次输出一致：

```
已重置 app.db
  种子账号 5 个（新增 admin@demo.local, liu-implant@..., liu-ortho@..., liu-general@..., liu-kid@...）
  在职医生 4 位
  排班时段 196 条（本次新增 196）
  预约记录 0 条
```

注意仍然**需要先停掉服务**：服务进程持有 WAL 写锁时，`DROP TABLE` 会等到 `busy_timeout` 超时后失败。这是 SQLite 的机制，不是脚本的问题。

---

## 15. 第四期：no_show 死胡同修复 + E2E 归档

### 15.1 问题：`no_show` 是个死胡同

第三期把 `no_show` 当成「终态」，但它同时踩了两个坑，叠加起来就是**号源被永久锁死**：

| 缺陷 | 具体表现 |
| --- | --- |
| 索引把 `no_show` 算成占用 | `ux_appt_active_slot` 的条件是 `status <> 'cancelled'`，`no_show` 仍在索引里 → 同一时段插不进第二条预约 → 病人约不了 |
| 状态机没有出边 | `no_show` 只能被 `confirm` / `complete` 拒绝，没有任何接口能把它改回可用状态 → 医生也无法纠错 |

结果是一个自相矛盾的组合：**时段明明没用上，却谁都动不了。**

### 15.2 修复：索引放行 + `reopen` 出边

**① 索引条件**改成「只有真正占号的状态才进索引」：

```sql
CREATE UNIQUE INDEX ux_appt_active_slot
  ON appointments (schedule_id) WHERE status NOT IN ('cancelled', 'no_show');
```

**② 查询条件必须同步改**。`slotsForDoctorDate` 与 `schedulesByDoctorDate` 的 `LEFT JOIN` 原来也是 `a.status <> 'cancelled'`。若只改索引不改这里，会出现「数据库允许插入、可约列表却仍显示已占用」的矛盾——这是这类部分索引最容易漏的配套改动。

**③ 新增 `POST /api/doctor/appointments/:id/reopen`**：`no_show → confirmed`，只限该预约的医生本人，非 `no_show` 返回 `409 BAD_STATE`。

**④ `reopen` 的额外冲突**：`no_show` 已经把号源放出去了，如果这个时段**已经被别人重新约走**，把原记录改回 `confirmed` 会撞唯一索引。此时状态是对的、冲突在号源，所以单独返回 **`409 SLOT_REBOOKED`**，不复用 `BAD_STATE`。

### 15.3 实测结果

A/B 复现（不碰生产库，内存库各建一种索引条件，同槽先放 `no_show` 再插 `pending`）：

| 索引条件 | 插入第二条 | 结论 |
| --- | --- | --- |
| `WHERE status <> 'cancelled'`（旧） | `UNIQUE constraint failed` | 死胡同的根因确认 |
| `WHERE status NOT IN ('cancelled','no_show')`（新） | 成功 | 号源确实释放 |

接口层实测（`npm run test:api` 第 17 组，17 条全通过）：

| 场景 | 结果 |
| --- | --- |
| `no_show` 后该时段在 `/api/schedules` 里的状态 | `open: true, taken: false` |
| 另一个病人预约这个时段 | `201`，`status=pending` |
| 时段被重约后，原医生 `reopen` 那条 `no_show` | `409 SLOT_REBOOKED`，原记录仍是 `no_show` |
| 正常纠错：`no_show → reopen` | `200`，`status=confirmed` |
| `reopen` 后该时段的可约状态 | `taken: true`（号源被收回） |
| 已 `confirmed` 的再 `reopen` | `409 BAD_STATE` |
| 别的医生 `reopen` 我的 `no_show` | `403 NOT_OWNER`，原记录未被改 |
| 病人调 `reopen` | `403`（角色层先拦） |
| `reopen` 不存在的预约 | `404 NOT_FOUND` |
| `reopen` 一条 `pending` | `409 BAD_STATE` |

浏览器层实测（`npm run test:e2e` 第 4 组）：医生卡片点「患者未到」→ 徽标变「未到诊」→ 同一张卡片出现「恢复为已确认」→ 点击 → 徽标回到「已确认」、按钮回到「标记完成 / 患者未到」，全程无整页刷新。

### 15.4 连带发现：迁移会让唯一索引消失

给索引换条件时复查了第三期的迁移代码，发现一个更危险的问题：

```
ALTER TABLE appointments RENAME TO appointments_legacy;   -- 索引跟着旧表走，名字不变
CREATE TABLE appointments (...);
CREATE UNIQUE INDEX IF NOT EXISTS ux_appt_active_slot ... -- 同名索引「已存在」→ 被跳过
DROP TABLE appointments_legacy;                           -- 索引随旧表一起被删
-- 结果：新表上一条唯一索引都没有
```

也就是说，**从老库升级上来的实例，防双订会静默失效**。第三期的迁移夹具只造了表、没造索引，所以断言「索引还在」是在一个空起点上通过的，没测出来。

修复与加固：

- 迁移事务开头显式 `DROP INDEX IF EXISTS` 三个索引，再改名建表；
- 新增独立的索引迁移 `migrateSlotIndex()`：读 `sqlite_master.sql`，条件不含 `no_show` 就 `DROP + CREATE`；索引干脆不存在时也补建；
- 回归夹具改成「旧表 + 旧索引 + 一条旧记录」，并新增断言「迁移后的索引条件已含 `no_show`」。

**`migrateSlotIndex()` 到底什么时候修（第六期确认）：**

它在 `server/db.js` 被 `require` 时执行，**每次启动服务都会跑一遍**，不依赖 `migrateNoShow()` 是否触发。判定只有两种：

| 启动时读到的状态 | 动作 |
| --- | --- |
| 索引存在，且 `sqlite_master.sql` 里已含 `no_show` | 什么都不做（可重复执行） |
| 索引存在，但条件还是旧的（`status <> 'cancelled'`） | `DROP INDEX` → 按新条件 `CREATE` |
| **索引完全不存在**（例如上一轮迁移把它带走了） | `DROP INDEX IF EXISTS`（空操作）→ 按新条件 `CREATE` |

所以「已经升级过、表结构已含 `no_show`、但索引丢了的库」也会被自动补建——这是上轮 latent bug 的兜底。第六期专门加了两条断言（api 第 16 组）：造一个「有表、有 `no_show`、没有索引」的库，起一次服务进程，验证索引被创建且条件正确。

### 15.5 E2E 脚本归档

第三期那次端到端验证是一次性脚本，跑完就删了——这是资产，不该丢。现已归档为 **`scripts/e2e.mjs`**：

```bash
npm run test:e2e          # 或 node scripts/e2e.mjs
```

它自己起服务（默认端口 3102、临时库 `.workbuddy/e2e.db`）并拉起 Edge headless，跑完清理。可选环境变量：`E2E_PORT`、`E2E_CDP_PORT`（默认 9444）、`EDGE_PATH`。

**为什么不并进 `regression.mjs`**：那一套用 `file://` 打开静态页，不需要服务、不需要数据库、不涉及登录态；这一套必须有服务、有会话 cookie、有真实数据流转。合并会让「展示页回归」也被迫依赖后端，失去它「纯前端可跑」的价值。

七组断言覆盖：医生登录与面板 → 待确认→确认（状态/按钮/小结/无整页刷新）→ 完成 → 未到诊→恢复 → 落库核对 → 病人详情展开收起 → 控制台无报错。脚本不再保存截图：README 与脚本本身才是可复跑的资产，截图只是一次性证据，需要看效果直接跑脚本。

### 15.6 本轮回归（第四期快照）

| 脚本 | 内容 | 结果 |
| --- | --- | --- |
| `npm run test:api` | 18 组 / 155 条 | ✅ 155/155 |
| `npm run test:race` | 2 组 / 7 条 | ✅ 7/7 |
| `npm run test:ui` | 7 组 / 29 条 | ✅ 29/29 |
| `npm run test:e2e` | 7 组 / 24 条 | ✅ 24/24 |

> 第五期加了支付相关的断言、第六期又补了 `no_show` 与价格来源，四套脚本的数字都变了。**最新值见 §9 与 §18.8**，本表保留第四期收尾时的快照，便于对照「哪些是后来新增的」。

### 15.7 时区口径

`slotStartMs()` 的写法是：

```js
function slotStartMs(date, startTime) {
  const t = new Date(date + 'T' + startTime + ':00').getTime();  // 不带 Z / offset
  return isNaN(t) ? null : t;
}
```

- **不带时区后缀的 ISO 串，JavaScript 按「运行环境的本地时区」解析**，不是 UTC。所以判定基准是「**服务器所在机器的本地时区**」。
- 取消规则（时段是否已开始）、`SLOT_IN_PAST`、`date` 的字符串比较全部基于这个基准；页面展示的日期时间也是同一套本地时间，所以单机演示不会出现前后不一致。
- 代价与改造方向写在 §7「已知取舍」里：**演示站按服务器本地时区计算，多时区部署需改造**（库里存 UTC，比较用 UTC，展示层再按用户时区格式化）。中国全境单一时区，本地演示不受影响。

---

## 16. 第五期：模拟支付（订单 / 支付 / 退款）

> **红线：本系统只做模拟支付。**
> 不接入支付宝、微信支付、银联、Stripe 等任何真实支付通道（真实模式与沙箱模式都不碰）；
> **不发起任何外部请求**，不采集、不存储任何支付信息（没有卡号、没有二维码、没有商户号、没有签名密钥）。
> 页面上的「支付」按钮，在代码里只是一条本地 SQL：`UPDATE orders SET status='paid'`。
> 页面与 README 都写明了这件事，不靠"看起来很像真的"来制造错觉。
>
> 章节编号说明：你要求的「README §12 支付章节」在本文档里已不可用——§12 是第三期（医生端闭环）。
> 本文档按时间顺序编号，支付落在 **§16**；§12 末尾与 §10.5 末尾都留了指向这里的索引。

### 16.1 数据设计

**（1）`appointments` 新增 `service` 列**

第二 / 三期把「项目」拼进 `note`（`项目：洗牙｜…`）。那是给人看的自由文本——**拿它当计费依据，等于让用户用备注决定价格**。所以第五期单独加了 `service TEXT`（存 `implant` / `cleaning` 这样的 id），并在建预约时校验它必须存在于价格表中：

- 老库通过 `migrateService()` 补列（先查 `PRAGMA table_info`，可重复执行）；
- 第五期之前的历史预约 `service IS NULL` —— 它们的订单会被明确拒绝（`409 SERVICE_MISSING`），**不会按科室均价猜一个金额**。

**（2）`orders` 表**

```sql
CREATE TABLE orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL UNIQUE REFERENCES appointments(id),  -- 一个预约一单
  patient_id     INTEGER NOT NULL REFERENCES users(id),
  amount_cents   INTEGER NOT NULL CHECK (amount_cents > 0),            -- 整数分
  status         TEXT    NOT NULL DEFAULT 'unpaid'
                         CHECK (status IN ('unpaid', 'paid', 'refunded')),
  paid_at        TEXT,
  refunded_at    TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  -- 付过才有支付时间；没付就不许有
  CHECK ((status <> 'unpaid') = (paid_at IS NOT NULL)),
  -- 退回才有退款时间；没退就不许有
  CHECK ((status = 'refunded') = (refunded_at IS NOT NULL))
);
CREATE INDEX idx_orders_patient ON orders (patient_id, status);
```

三个决定值得单说：

| 决定 | 为什么 |
| --- | --- |
| `amount_cents` 用整数分 | 钱不能用浮点。`0.1 + 0.2 !== 0.3` 这种误差在金额上就是对不上账。库里只有分，`¥280.00` 是展示层格式化的结果 |
| `UNIQUE(appointment_id)` 放在数据库 | 应用层的「先查有没有再插」有竞态。唯一约束是最后一道防线：就算接口被改坏，也插不进第二单。回归里有「绕过接口直接 INSERT」的断言 |
| 两条时间戳 `CHECK` | 防止出现「status=paid 但 paid_at 为空」这种对账永远对不上的脏数据。断言里也真的去试了「只改 status 不写 paid_at」→ 被 CHECK 拒绝 |

**（3）建表顺序的坑（本期踩到了）**

`orders` 必须在 `migrateNoShow()` **之后**创建。原因：那段迁移会 `ALTER TABLE appointments RENAME TO appointments_legacy`，而 SQLite 3.25+ 会顺手把**其它表**里指向 `appointments` 的外键改写成指向 `appointments_legacy`；随后旧表被 `DROP`，`orders` 的外键就指向了一张不存在的表，插订单时报 `no such table: main.appointments_legacy`。现在 `db.js` 里的顺序是「先迁移 appointments，再建引用它的表」，注释也写在那里。

### 16.2 订单状态机

三个状态、三条合法转换（`unpaid → paid → refunded`）。**`refunded` 是终态**，没有出边：

```
        POST /patient/appointments/:id/order
              （预约须 pending / confirmed）
                    │
                    ▼
              ┌──────────┐   pay    ┌────────┐   refund   ┌───────────┐
   （无订单）──▶│  unpaid  │─────────▶│  paid  │───────────▶│ refunded  │
              │  待支付  │          │ 已支付 │            │  已退款   │ ← 终态
              └──────────┘          └────────┘            └───────────┘
```

**完整出边表（每个状态能往哪走、哪些尝试会被拒）：**

| 当前状态 | 出边 | 接口 | 被拒绝的尝试 → 拒绝码 |
| --- | --- | --- | --- |
| 无订单 | → `unpaid` | `POST /api/patient/appointments/:id/order` | 非本人 → 403 `NOT_OWNER`；预约 `cancelled` / `no_show` / `completed` → 409 `APPOINTMENT_NOT_PAYABLE`；缺 `service` → 409 `SERVICE_MISSING` |
| `unpaid` | → `paid` | `POST /api/patient/orders/:id/pay` | 重复支付 → 409 `ALREADY_PAID`；已退款 → 409 `ALREADY_REFUNDED`；预约 `cancelled` / `no_show` → 409 `APPOINTMENT_NOT_PAYABLE` |
| `paid` | → `refunded` | `POST /api/patient/orders/:id/refund` | 未支付 → 409 `NOT_PAID`；重复退款 → 409 `ALREADY_REFUNDED` |
| `refunded` | **无（终态）** | — | `pay` / `refund` → 409 `ALREADY_REFUNDED`；再下单 → `200 + created:false` 返回原订单（不会新建） |

**为什么 `refunded` 定为终态。** 一张订单退完，这笔交易就结束了。让它能再变回 `paid`，等于允许"同一笔钱退两次、收两次"，而 `paid_at` / `refunded_at` 也会失去唯一的时间含义。当前模型里也没有第二个入口：`orders.appointment_id` 是 `UNIQUE`，同一预约最多一单，这张单关着就永远是关着的。

**退款后想再付怎么办？** 只能重新预约（新的 `appointment`），从而生成一张新订单——这符合"退款 = 取消这次交易"的语义，也不需要改 `UNIQUE`。真想支持"同一预约重新支付"，就必须引入新状态（例如 `reopened`）或放开"一个预约多单"，那是产品决策 + 数据迁移，不是把某个 409 改掉就行。

**哪些预约状态能付：**

| 预约状态 | 能否创建订单 | 能否支付 | 理由 |
| --- | --- | --- | --- |
| `pending` / `confirmed` | ✅ | ✅ | 正常路径 |
| `completed` | ❌ | ✅ | 看完诊再结账是常态；但已完成的单不该再新开 |
| `cancelled` | ❌ | ❌ | 没有服务发生，没有收费依据 |
| `no_show` | ❌ | ❌ | 同上；而且 `no_show` 会释放号源，能付款就会出现"同一时段既被别人约走、又给爽约的人记账" |

`cancelled` 与 `no_show` 统一返回 `409 APPOINTMENT_NOT_PAYABLE`，响应里的 `status` 字段区分具体原因。

> **未到诊的爽约费：本期不做。** 爽约费需要单独的计费规则、减免审批和告知流程，不能借用"诊疗订单"来收。想演示这个场景，应该新开一张"违约金"类型的单据，而不是把 `no_show` 的预约订单放行。

### 16.3 金额从哪来（这一期真正的命门）

**四条规则，缺一条就等于没有支付系统：**

1. **只由服务端算。** 路由函数里**完全不读** `req.body.amount` / `amount_cents` / `price` / `total` —— 不是"读了但忽略"，是连读都不读。
2. **只有一份价格数据。** `assets/js/data.js` 的 `services[]` 是唯一来源，每条带 `amount_cents`（整数分）：

   | 项目 id | 名称 | 金额（分） | 展示 |
   | --- | --- | --- | --- |
   | `implant` | 种植牙 | 680000 | ¥6,800.00 |
   | `ortho` | 牙齿矫正 | 1280000 | ¥12,800.00 |
   | `cleaning` | 洗牙 | 28000 | ¥280.00 |
   | `filling` | 补牙 | 38000 | ¥380.00 |
   | `extraction` | 拔牙 | 45000 | ¥450.00 |
   | `rct` | 根管治疗 | 98000 | ¥980.00 |
   | `perio` | 牙周治疗 | 68000 | ¥680.00 |
   | `kids` | 儿童齿科 | 26000 | ¥260.00 |

   `server/pricing.js` **不再自己抄一份数字**，而是在启动时读取 `data.js` 并校验：

   - 每条必须有 `id` / `label` / 正整数 `amount_cents`，id 不能重复；
   - 带 `price_range` 的项目必须满足 `min_cents ≤ amount_cents ≤ max_cents`（展示区间要把实收金额框住）；
   - 任何一条不满足 → 抛错、拒绝启动。

3. **页面展示读同一份。** `services.html` 里已经没有金额，`[data-price-box]` 的三个字段由 `render.js` 按 `price_range` 渲染（`¥6,000 – 15,000`、`/ 颗 · 参考区间，非最终报价`）。所以**不存在"两处价格表需要人工同步"**：改价只改 `data.js` 一处，重启服务后订单计价与服务页展示同时生效。回归里有两组断言盯着这件事——
   - `test:ui`：服务页渲染出的区间必须等于 `data.js` 里的 `price_range`；
   - `test:api`：`/api/services` 必须与 `pricing.js` 完全一致，且 `services.html` 里不含硬编码金额。
4. **算不出来就报错。** 预约没记录项目、或项目不在表里 → `409 SERVICE_MISSING`。**不兜底、不取均价、不用前端传的值**。在钱这件事上，"猜一个"比"报错"危险得多。

**为什么让 Node 去读一个浏览器文件？** 因为这个项目没有构建步骤。`data.js` 是纯数据（只做 `window.SITE_DATA = {...}`），`pricing.js` 用 `vm` 在只有 `window` 的空上下文里跑一遍就能拿到对象，服务端与浏览器因此天然同源。代价是两条，都写进了 §7：

- 改完价格要**重启服务**（`pricing.js` 在启动时加载一次）；
- `data.js` 必须保持"纯数据"，加任何副作用都会在启动时暴露——这其实是好事，比悄悄算出错价强。

**实测（第 19 组，`npm run test:api`）：**

```
POST /api/patient/appointments/12/order
{ "amount": 1, "amount_cents": 1, "price": 1, "total": 0.01 }

→ 201 { order: { amount_cents: 680000, amount_text: "¥6,800.00" } }   # 种植牙演示金额
→ SELECT amount_cents FROM orders WHERE id = 13  →  680000
```

前端改不动，库里也不是 1 分。这两条是**同一次请求的两个视角**：一个证明接口没采信，一个证明落库没被改。

### 16.4 API

| 方法 | 路径 | 权限 | 说明 | 主要失败码 |
| --- | --- | --- | --- | --- |
| POST | `/api/patient/appointments/:id/order` | 病人本人 | 创建订单（幂等：已存在则返回原单，`created:false`） | 400 `BAD_ID` / 401 / 403 `NOT_OWNER` / 404 / 409 `APPOINTMENT_NOT_PAYABLE` / 409 `SERVICE_MISSING` |
| POST | `/api/patient/orders/:id/pay` | 订单本人 | **模拟**支付：`unpaid → paid`，写 `paid_at` | 401 / 403 `NOT_OWNER` / 404 / 409 `ALREADY_PAID` / 409 `ALREADY_REFUNDED` / 409 `APPOINTMENT_NOT_PAYABLE`（预约已取消或未到诊） |
| POST | `/api/patient/orders/:id/refund` | 订单本人 | **模拟**退款：`paid → refunded`，写 `refunded_at` | 401 / 403 `NOT_OWNER` / 404 / 409 `NOT_PAID` / 409 `ALREADY_REFUNDED` |
| GET | `/api/patient/orders` | 病人 | 我的订单（只查 `patient_id = 本人`） | 401 / 403 |
| GET | `/api/services` | 公开 | 价格表（演示数据，只读） | — |

响应示例（支付成功）：

```json
{
  "ok": true,
  "simulated": true,
  "note": "模拟支付完成：未发生真实扣款",
  "order": {
    "id": 1, "appointment_id": 1, "status": "paid", "status_label": "已支付",
    "amount_cents": 28000, "amount_text": "¥280.00",
    "paid_at": "2026-11-23 15:48:39", "refunded_at": null,
    "service": { "id": "cleaning", "label": "洗牙" },
    "appointment": { "id": 1, "status": "confirmed", "date": "2026-11-28", "start_time": "09:00", "end_time": "10:00", "doctor_name": "刘主任", "doctor_dept": "种植科" },
    "simulated": true
  }
}
```

`simulated: true` 出现在响应里，是为了让前端**不用自己写死"模拟"文案**——它是数据的一部分，不是文案的一部分。

### 16.5 幂等与并发

**为什么重复下单返回 200 而不是 409。** 支付页一进来就会 `POST .../order`（刷新、后退、浏览器重试都会再来一次）。如果第二次返回 409，用户看到的是"坏了"，而实际状态完全正常。所以「确保这单存在」比「创建一单，失败就报错」更贴合这个场景：已有订单 → `200 + created:false + 原订单`。数据库层的 `UNIQUE(appointment_id)` 兜住并发版本——撞约束后**再查一次并返回原单**，不是把约束错误抛给用户。

**为什么重复支付是 409 而不是 200。** 反过来：`pay` 是一个"动作"，不是"确保状态"。第二次点支付时，如果回 200，前端会以为又扣了一次；回 409 `ALREADY_PAID` 才能明确告诉它「这次什么也没发生」。同时 `paid_at` 必须**保持第一次的值**——它是"付成功的时间"，被第二次请求改写的话，对账永远对不上。

**并发下的写法**（不是"先查再改"）：

```sql
UPDATE orders SET status = 'paid', paid_at = datetime('now')
WHERE id = ? AND patient_id = ? AND status = 'unpaid';
```

`changes === 0` 说明三件事里有一件不成立（不存在 / 不是本人 / 状态已变）。路由已经分别判过 404 / 403 / 409，走到这里只可能是并发：再读一次，若已是 `paid` 就回 `ALREADY_PAID`。与 §11.6 的抢号是同一个思路——**让数据库裁决，不让 if 裁决**。

**实测：** 连续支付两次，中间隔 1.1 秒（`datetime('now')` 只到秒，不等的话"没被改"可能只是同一秒）：

```
第 1 次 → 200 paid  paid_at = 2026-11-23 15:48:39
第 2 次 → 409 ALREADY_PAID
paid_at 仍是 2026-11-23 15:48:39          ← 断言比对的是字符串相等
```

### 16.6 前端

**控制台的「去支付」按钮**（`dashboard.js` → `buildPayAction`）：

| 预约状态 | 订单状态 | 显示 |
| --- | --- | --- |
| `pending` / `confirmed` | 无订单 或 `unpaid` | `去支付` / `继续支付` 按钮 → `payment.html?appointment=<id>` |
| `pending` / `confirmed` | `paid` / `refunded` | 「已支付 ¥280.00」/「已退款 ¥280.00」标签，**没有按钮** |
| `cancelled` / `no_show` | 任意 | 只显示详情；即使有未支付订单，也不给支付入口 |
| `completed` | 任意 | 只显示详情（结账仍可在已完成前完成；新订单不再创建） |

按钮条件与服务端规则**是同一套语义**，但前端这层只是体验：手工敲 `payment.html?appointment=别人的id` 只会拿到 403；手工给 `no_show` 的预约打开支付页，支付按钮不会出现，服务端也会 `409 APPOINTMENT_NOT_PAYABLE`。

**医生端的「支付状态」（第六期新增，只读）**

医生需要知道这单收没收到钱，所以在预约卡片上多一行：

| 服务端返回的 `order` | 卡片显示 |
| --- | --- |
| `null` | 支付：**未下单**（灰） |
| `status=unpaid` | 支付：**未支付**（琥珀） |
| `status=paid` | 支付：**已支付 ¥280.00**（绿） |
| `status=refunded` | 支付：**已退款 ¥280.00**（灰） |

**纯展示，没有任何操作按钮**：医生端没有支付 / 退款入口，`,doctor/appointments` 只多返回一个 `order` 摘要，收款接口仍然只对 `patient` 会话开放。E2E 第 8 组专门断言"卡片有支付标签、但没有支付入口"。

支付页对 `no_show` 与 `cancelled` 相同的处理：隐藏支付按钮，并在状态区说明原因（"未到诊"或"已取消"），不让用户点了才收到 409。

**支付页**（`payment.html` + `payment.js`）三件事：

1. 页首一块琥珀色提示，第一句就是「**模拟支付，不产生真实扣款**」，后面点名不接入的通道；
2. 金额、状态、项目、医师、时间全部来自接口，前端只做格式化；
3. 只有两个动作——`支付`（`unpaid` 时可见）与`退款`（`paid` 时可见），失败时把服务端的 `order` 一并渲染出来，用户看到的永远是真实状态。

**全程无外部请求**：所有 `fetch` 都是相对路径（`/api/...`），页面里的 `src`/`href` 全是本地文件，没有任何 CDN、字体、统计脚本。这一点有机器证据，见下节。

### 16.7 回归与证据

**四套脚本（第六期收尾时的快照；第七期新增小程序两套、第八期新增 Bearer 组后，接口总数为 22 组 / 266 条，见 §18.8）**

| 脚本 | 内容 | 结果 |
| --- | --- | --- |
| `npm run test:api` | 20 组 / 207 条（第 19 组 45 条、第 20 组 5 条、第 16 组 +2 条） | ✅ 207/207 |
| `npm run test:race` | 2 组 / 7 条（未受影响） | ✅ 7/7 |
| `npm run test:ui` | 7 组 / 31 条（第 6 组 +2 条：服务页价格由 data.js 渲染） | ✅ 31/31 |
| `npm run test:e2e` | 9 组 / 45 条（第 7 组 19 条支付链路，第 8 组 2 条医生端支付状态） | ✅ 45/45 |

**第五期点名的六条 + 第六期补的两条，逐条对应：**

| 要求 | 断言（`npm run test:api` 第 19 组） | 实际结果 |
| --- | --- | --- |
| 前端篡改金额无效 | `POST .../order` 带 `{amount:1, amount_cents:1, price:1, total:0.01}`，服务端仍按 680000 分下单 + 库里也是 680000 | ✅ 2 条 |
| 重复支付 | 连续两次 `pay`，第二次 `409 ALREADY_PAID`；`paid_at` 前后字符串相等 | ✅ 2 条 |
| 越权支付 | 病人 B 用自己 session 付 A 的订单 → `403 NOT_OWNER`，且订单仍是 `unpaid` | ✅ 2 条 |
| 未登录支付 | 无 cookie 调 `pay` → `401`；无 cookie 调下单 → `401` | ✅ 2 条 |
| 退款幂等 | 连续两次 `refund`，第二次 `409 ALREADY_REFUNDED`；`refunded_at` 不变；已退款再 `pay` → 409 | ✅ 3 条 |
| 已取消预约不能下单 | 对 `cancelled` 的预约下单 → `409 APPOINTMENT_NOT_PAYABLE` | ✅ 1 条 |
| **no_show 不能下单** | 预约标 `no_show` 后下单 → `409 APPOINTMENT_NOT_PAYABLE`，且库里没有生成订单 | ✅ 2 条 |
| **no_show 不能支付** | 先下单再标 `no_show`，`pay` → `409 APPOINTMENT_NOT_PAYABLE`，订单仍是 `unpaid` | ✅ 2 条 |

**45 条的完整分组（上表那些都在里面）：**

| 分组 | 条数 | 覆盖 |
| --- | --- | --- |
| 预约与项目校验 | 4 | 预约带 `service` 落库、响应回显、非法 service → 400 `BAD_SERVICE`、被拒时不留下预约记录 |
| 下单、金额与篡改 | 8 | 201 / `created:true` / 28000 分 / `¥280.00` / `simulated:true` / 重复下单幂等 200 / 库里只有 1 单 / `amount:1` 仍是 680000（接口 + 落库各一条） |
| 归属与登录 | 5 | 未登录下单 401、越权下单 403、未登录支付 401、越权支付 403、越权后状态未变 |
| 支付 | 4 | 200 且 `paid_at` 有值、`simulated + note`、重复支付 409、`paid_at` 不变 |
| 退款 | 5 | 200 且 `refunded_at` 有值、重复退款 409、`refunded_at` 不变、已退款再支付 409、未支付退款 409 `NOT_PAID` |
| 预约状态联动 | 4 | 已取消不能下单、缺项目 `SERVICE_MISSING`、先下单后取消仍能取消、取消后支付被拒 |
| no_show 拦截（第六期） | 4 | 未到诊不能下单（且没生成订单）、已下单后标未到诊不能支付、被拒后状态不变 |
| 订单列表隔离 | 2 | 本人能看到、B 看不到 A 的 |
| 医生端支付状态（第六期） | 2 | 医生列表带 `order`（已支付 + 金额）、未下单时为 `null` |
| 数据库兜底 | 3 | 绕过接口插第二单被 `UNIQUE` 拒、`paid` 无 `paid_at` 被 `CHECK` 拒、非法状态值被 `CHECK` 拒 |
| 前端自检 | 4 | `payment.html` / `payment.js` 无外链、页面写明"不产生真实扣款"、列表带 `order` 字段 |
| **合计** | **45** | |

**第六期（收尾轮）新增断言一览：**

| 位置 | 内容 | 条数 |
| --- | --- | --- |
| api 第 19 组 | `no_show` 不能下单 / 不能支付 / 被拒后不生成订单 / 状态不变 | 4 |
| api 第 19 组 | 医生端 `order`：已支付 ¥380.00、未下单为 `null` | 2 |
| api 第 16 组 | 索引**整个缺失**时启动自动补建；补出来的条件含 `no_show` | 2 |
| api 第 20 组 | `/api/services` 与 `pricing.js` 一致、8 项正整数、区间自洽、HTML 无硬编码金额、data.js 是唯一来源 | 5 |
| ui 第 6 组 | 服务页渲染出 `¥6,000 – 15,000`；区间与 680000 分同源自洽 | 2 |
| e2e 第 8 组 | 医生端卡片有支付标签（已退款 ¥280.00）；没有任何支付/退款入口 | 2 |

**Network 证据（怎么确认"没有外部请求"）**

headless 浏览器截不到 DevTools 面板的 UI，所以拆成两半做，比一张模糊截图更可核对：

```bash
node scripts/capture-payment.mjs
```

它用 CDP 的 `Network.requestWillBeSent` 记录浏览器**实际发出**的每一条请求，输出三份东西到 `.workbuddy/shots/`：

| 产物 | 内容 |
| --- | --- |
| `payment-unpaid.png` | 支付页初始态：琥珀色「模拟支付，不产生真实扣款」提示、`¥280.00`、「待支付（模拟）」、只有「支付」按钮 |
| `payment-paid.png` | 支付后：「已支付」徽标、支付时间已回填、按钮换成「退款（模拟）」、绿色反馈「未发生真实扣款」 |
| `network-log.md` | 逐条请求清单 + 结论 |

本次实测输出：

```
http 请求 31 条，外部 0 条
支付页期间 12 条：
  GET  /payment.html?appointment=1
  GET  /assets/css/style.css
  GET  /assets/js/data.js
  GET  /assets/js/render.js
  GET  /assets/js/main.js
  GET  /assets/js/payment.js
  GET  /assets/js/session.js
  GET  /api/me
  GET  /api/me
  GET  /api/patient/appointments/1
  POST /api/patient/appointments/1/order
  POST /api/patient/orders/1/pay
```

**31 条 http 请求里，指向本站以外的 0 条；打开支付页到支付完成共 12 条，全部在 `http://127.0.0.1:3103` 下。** 点「支付」只产生 1 个 `POST /api/patient/orders/1/pay`，没有 XHR 到任何第三方、没有埋点、没有支付 SDK。

同一条结论在 `npm run test:e2e` 里是**自动断言**，不依赖人去看：

- 「整场会话没有一条外部网络请求（Network 里只有本站）」
- 「支付页期间的请求全部是本站地址（页面 / 静态资源 / 接口）」
- 「点『支付』只发出 1 个本站 `POST /api/patient/orders/:id/pay`」
- 「支付页从打开到退款，没有任何外部请求」

**落库核对**（截图那次运行的订单行）：

```json
{"id":1,"appointment_id":1,"amount_cents":28000,"status":"paid",
 "paid_at":"2026-11-23 15:48:39","refunded_at":null}
```

时间戳由 SQLite `datetime('now')` 生成，是 **UTC**（截图时本地 23:48、库里 15:48）。这与其它页面的 `created_at` 口径一致，支付页底部也写明了这一点。要改成"展示本地时间"需要统一处理所有 `created_at`，不在本期范围内。

### 16.8 本期未做（也是"模拟"的边界）

- 真实收单：商户资质、密钥托管、服务端回调验签、异步通知重试、防重放；
- 对账、结算、发票、部分退款、退款审批流、订单超时自动关闭；
- 优惠券 / 折扣 / 多币种 / 分账；
- **未到诊（`no_show`）的爽约费 / 违约金单据：本期不做。** 现在 `no_show` 与 `cancelled` 一样禁止下单与支付；真要收爽约费，需要独立的费用类型、减免审批与告知流程；
- 支付风控（设备指纹、频次限制——目前只有登录限流）；
- `orders` 与预约取消的联动（取消预约不会自动关单或退款，见 §7）。

这些不是"忘了做"，而是**接真实通道之前必须先有的东西**；在没有商户资质与合规评审的前提下，做一半比不做更危险。

### 16.9 一句话总结

这一期真正做的不是"支付页面"，而是四件在真实系统里最容易做错、也最贵的事：

1. **金额只能由服务端算**（前端传 1 分也没用，库里就是 680000 分）；
2. **重复操作必须幂等**（不重复扣、不改时间戳、刷新不多单）；
3. **每个资源都要判归属**（拿别人的订单号只会得到 403）；
4. **状态边界要一次划清**（`cancelled` / `no_show` 都不能收钱，`refunded` 是终态，不留"也许还能付"的灰区）。

支付通道本身被刻意留空——**这才是"模拟支付"该有的样子：把边界写在代码和文档里，而不是靠 UI 长得像。**

---

## 17. 项目总览（收尾）

### 17.1 一句话定位

**齿记工具助手是一个本地运行、可完整走通「浏览 → 注册登录 → 预约 → 医生处理 → 模拟结账」的口腔门诊演示系统。** 它不是真实医疗机构，不处理真实患者信息，也不接入任何真实支付通道；所有姓名、医师、排班、价格与订单都是演示数据。

### 17.2 技术栈

| 层 | 选型 | 备注 |
| --- | --- | --- |
| 前端 | 原生 HTML + CSS + ES5 风格 JS | 无框架、无构建、无 CDN；`data.js → render.js → main.js` 顺序固定 |
| 后端 | Node ≥ 22 + Express 4 | 单进程；路由分 `auth / protected / appointments / orders` |
| 数据库 | SQLite（`better-sqlite3`，WAL） | 文件在 `data/app.db`；不提交仓库；`npm run reset-db` 可重置 |
| 会话 | `express-session` + httpOnly Cookie（SameSite=lax） | 密钥来自 env 或 `data/.session-secret`，**少于 32 字符拒绝启动** |
| 密码 | `server/password.js` 适配层 | 优先 `bcrypt`，装不上退 `@node-rs/bcrypt`；库里只存哈希 |
| 测试 | Node 脚本 + Edge/Chrome DevTools 协议 | 不用 Jest/Playwright；六套脚本见 §17.4 |
| 支付 | **无** | 只有本地 SQL 状态变更，没有 SDK、没有外部请求 |

### 17.3 五阶段演进

| 阶段 | 做了什么 | 关键产物 | 章节 |
| --- | --- | --- | --- |
| 一 · 展示站 | 五页静态站、蓝白+浅绿视觉、移动优先；数据化、无障碍、合规口径 | `*.html`、`style.css`、`data.js` / `render.js` / `main.js` | §2–§8 |
| 二 · 认证与角色 | 注册 / 登录 / 医生申请 / 管理员审核；静态白名单、会话密钥、防 XSS | `server/app.js`、`server/auth.js`、`login/register/dashboard.html` | §10 |
| 三 · 在线预约 | 排班与预约、并发防重（部分唯一索引）、时段开始前可取消、对象级权限 | `schedules` / `appointments`、`booking.js` | §11 |
| 四 · 医生闭环 | 五状态状态机、`no_show` 释放号源 + `reopen`、迁移索引修复、E2E 归档 | `doctor/appointments/:id/*`、`scripts/e2e.mjs` | §12–§15 |
| 五 · 模拟支付 | 订单表、金额只由服务端算、幂等、退款、医生端支付状态、价格单一来源 | `orders`、`pricing.js`、`payment.html/js` | §16 |
| 六 · 小程序端（阶段一） | 5 页展示迁移 + 服务详情、三个公开只读接口、限流、统一网络层 | `miniprogram/`、`server/routes/public.js`、`rate-limit.js` | §18 |
| 七 · 小程序端（阶段二） | JWT Bearer 通道、登录 / 注册、在线预约、我的预约与取消 | `server/jwt.js`、`server/auth.js`、`miniprogram/pages/{login,register,my-appointments}` | §18.9–§18.11 |

> README 按实现轮次编号（§12 是「第三期：医生端闭环」），上表按业务演进把「预约」与「医生闭环」拆成两段；两种说法指的是同一批代码。

### 17.4 六套测试怎么跑（四套网站 + 两套小程序）

```bash
npm run test:api    # 22 组 / 266 条：真实 HTTP + 临时库（端口 3101），含 32 条 Bearer 断言
npm run test:race   #  2 组 /   7 条：单进程 8 并发 + 双进程 TOCTOU
npm run test:ui     #  7 组 /  31 条：file:// + 真浏览器（导航 / 表单 / 联动 / 价格渲染）
npm run test:e2e    #  9 组 /  45 条：真服务 + 真浏览器点完整流程（端口 3102 / CDP 9444）
npm run test:mp     #  6 组 /  51 条：小程序静态体检（结构 / 无 DOM / token 通道 / 页面结构）
npm run mock:mp     #  8 组 /  51 条：wx 垫片跑真实页面（登录 → 预约 → 支付 → 退款 → 取消 → 401）
npm run test:all    # 依次跑上面六套
```

| 问题 | 说明 |
| --- | --- |
| 需要装浏览器吗 | `test:ui` 与 `test:e2e` 需要本机 Edge 或 Chrome；`test:api` / `test:race` / `test:mp` / `mock:mp` 不需要 |
| 需要装微信开发者工具吗 | **不需要**（命令行起不来它）。`test:mp` 查文件约束，`mock:mp` 用垫片跑页面逻辑；**排版效果仍要在开发者工具里看**（§18.2） |
| 会不会污染演示库 | 不会。六套脚本都用 `.workbuddy/` 下的临时库，跑完自动删；`test:api` 还会先造一个「第三期之前」的老库夹具来验迁移 |
| 端口冲突 | `test:api` / `test:e2e` / `mock:mp` 支持环境变量改端口：`TEST_PORT=…`、`CDP_PORT=…`、`MP_PORT=…` |
| 断言失败看哪里 | 每套脚本都会打印逐条明细与按组汇总，失败项后面跟 `→ 实际值` |

### 17.5 种子账号

演示库首次启动会写入 5 个账号，**统一密码 `Demo@1234`**（仅演示，真实项目绝不可这样预置）：

| 角色 | 账号 | 能做什么 |
| --- | --- | --- |
| 管理员 | `admin@demo.local` | 审核医生入驻、停用 / 恢复账号 |
| 医生（种植科） | `liu-implant@demo.local` | 确认 / 完成 / 未到诊 / 恢复；看患者预约与支付状态 |
| 医生（正畸科） | `liu-ortho@demo.local` | 同上 |
| 医生（综合与牙周） | `liu-general@demo.local` | 同上 |
| 医生（儿童齿科） | `liu-kid@demo.local` | 同上 |

病人账号没有种子，需在 `register.html` 自助注册（注册接口强制 `role=patient`，传什么都不改）。

### 17.6 占位与已知取舍索引

| 想查什么 | 去哪里 |
| --- | --- |
| HTML 里的「待填充」注释（当前 19 处） | §4.2；口径见 §9 |
| `data.js` 空值字段（13 个）与待核布尔标记（8 个） | §5.2、§4.2 |
| 数字口径（每个数字怎么数出来的） | §9 |
| 已知取舍（时区、号源粒度、无地图、演示文案、模拟支付…） | §7 |
| 各阶段明确没做的 | §10.8、§11.12、§12.6、§16.8 |
| `no_show` 爽约费 | §16.2 与 §16.8：**本期不做** |
| `refunded` 是否终态 | §16.2：是终态，完整出边表在那里 |
| 价格改哪里 / 为什么只有一份 | §16.3：只改 `assets/js/data.js`，改完重启 |
| 索引迁移与自愈 | §15.4、§16.7（第 16 组断言） |
| 时区基准 | §7、§15.7 |
| 小程序端怎么导入、baseURL 怎么改 | §18.2、§18.4 |
| 小程序本期做了什么 / 没做什么 | §18.7 |
| 小程序为什么不发布 | §18.1（个人主体不发布医疗类目） |
| 两套凭证怎么分工（cookie / Bearer） | §18.9 |
| token 过期、被篡改、账号被停用会怎样 | §18.10 |
| `JWT_SECRET` 怎么配、缺失会怎样 | §18.11 |

### 17.7 启动

```bash
npm install
npm start                 # 默认 http://localhost:3000
npm run reset-db          # 回到 5 个种子账号（先停服务，WAL 会占写锁）
```

`data/` 是运行时目录：数据库、会话密钥、日志都不入库。`.workbuddy/` 是编辑器/测试工作目录，可忽略。

### 17.8 八条红线（后续改动不要越）

1. **不接真实支付**：没有支付宝 / 微信支付 / 银联 / Stripe，不发起外部请求，不采集支付信息。
2. **不放真实患者数据**：这是演示作业，姓名、电话、证照编号都用占位。
3. **静态托管保持白名单**：不要改回 `express.static(ROOT)` + 黑名单——`README.md` 就是这么漏出去的。
4. **会话密钥不设默认值**：少于 32 字符就拒绝启动，别为了"跑起来方便"加回弱密钥。
5. **渲染用户数据只用 `textContent` / DOM 节点**：`dashboard.js` 至今没有 `innerHTML`，保持住。
6. **改价格只改 `data.js`**；改 `appointments` 的 CHECK 必须重建表**并重建 `ux_appt_active_slot`**（§15.4）。
7. **小程序端不发布、不加真实支付、不采集个人信息**：`appid` 虽是真实 `wx89cb…15cf`，但**不上传代码、不提审**；`AppSecret` 不进任何前端文件；`sitemap.json` 保持 disallow；公开接口只加只读字段，不加写接口、不下发用户数据。
8. **鉴权只有一套判断逻辑**：`authenticate` 同时认 cookie 与 Bearer，角色一律回库查（不信 token 里的 `role`）；出现 `Authorization` 头就只认 Bearer，**不许回落到 cookie**（§18.9）。

---

**项目到此暂时收尾。** 六套回归全绿（266 / 7 / 31 / 45 / 46 / 44），所有未完成项都写明了位置与原因，没有「以后再说」的悬空结论。

---

## 18. 小程序端（第七期 · 阶段一 + 第八期 · 阶段二）

### 18.1 定位与三条边界

> **口径更新（2026-11-26）**：小程序已进入正式版审核整改，名称由「刘氏牙齿」改为「齿记工具助手」。本章与 §19 中「不发布 / 不提审」的表述属早期阶段记录，当前状态以 §3.2 为准。

**这是官网的另一个客户端，不是第二个项目。** 小程序读的是同一份 `assets/js/data.js`、同一个后端、同一套接口与演示数据；区别只是渲染方式：没有 DOM，改用 `Page({data, onLoad}) + setData`。

第八期加了登录与预约，所以边界要重写（阶段一那版写的是「不碰账号、不碰预约」，现在不成立了）：

| 边界 | 具体做法 | 为什么 |
| --- | --- | --- |
| **不发布** | `appid` 已填项目所有者自己的 AppID（`wx89cb…15cf`，见 `project.config.json`），但**不上传、不发布**；`sitemap.json` 全站 `disallow`，README 与页面都写明学习演示 | **个人主体不发布医疗类目**；本项目也不是真实医疗机构，没有资质公示、没有真实医师、没有诊疗行为。填真实 AppID 只是为了「开发者工具能正常导入、真机预览可用」，不等于具备上线条件 |
| **只做病人端** | 预约 / 取消 / 我的预约 / 模拟支付与退款都在小程序；**医生端（确认 / 完成 / 未到诊 / 恢复）留在官网** | 医生端一个误触就是改别人的排班；支付只做模拟，不接微信支付（红线 §17.8 第 1 条） |
| **不接微信身份** | 不用 `wx.login`、不取 `openid`、不申请手机号授权；账号是「手机号 + 密码」，和 Web 走同一个 `/api/register`、`/api/login` | 拿 `openid` 就要写隐私协议、说明留存期限与最小必要。现在这套只是「换个客户端登录」，**不新增任何个人信息来源**，也不需要在微信侧做任何配置 |

三条边界之外还有一条工程约束：小程序端**不新增后端接口**。登录、注册、查时段、提交预约、取消预约、我的预约，全部复用官网已有的 `/api/*`——接口一分叉，权限逻辑就会分叉（§18.9）。

### 18.2 怎么导入开发者工具

1. 先启动后端：在仓库根目录 `npm start`（默认 3000，控制台会打印 `http://localhost:3000`）。
2. 打开微信开发者工具 → **导入项目** → 目录选 **`D:\Dental Clinic\miniprogram`**（注意不是仓库根目录；`project.config.json` 在小程序目录里，`miniprogramRoot` 为 `./`）。
3. AppID 已写死在 `miniprogram/project.config.json`（`"appid": "wx89cbf3e1c05215cf"`），导入时无需再选。若换成你自己的 AppID，**只改这一处**，并确认开发者工具登录的是该 AppID 所属的微信账号；否则会报「项目 AppID 与当前账号不匹配」。
4. 右上角 **详情 → 本地设置**，勾选：
   - ☑ **不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书**
   - ☑ 将 JS 编译成 ES5（可选，兼容低版本基础库）
5. 点 **编译**。Console 里应出现：

   ```
   [首页] 诊所=齿记工具助手，电话=0731-8888 0000，今日=09:00–20:00，服务=8 项，医师=4 位
   ```

6. 底部五个 tab 逐个点一遍；在「服务」里点任一项，应进入详情页并显示价格区间与擅长医师。
7. 切到「**预约**」tab：未登录时应出现「登录后才能预约」的引导卡（不是空白页）。点「去登录 / 注册」→ 注册一个病人账号（姓名 + 手机号 + 密码，8 位以上）→ 回登录页 → 登录 → 回到预约页，选医师 / 日期 / 时段 / 项目后提交。提交成功的文案是「**已提交 · 待门诊确认**」，不是「预约成功」。
8. 「我的」→「我的预约」能看到刚提交的那条，点「取消预约」会先弹确认框。之后可在官网 `dashboard.html` 用同一个患者账号看到这条记录（同库同账号）。

> 如果 Console 报 `连接不上后端（http://…:3000）`：括号里就是 `utils/request.js` 当前配的 `BASE_URL`。按三处查——① 后端是否在跑（`npm start`）；② 这个地址从当前设备能不能通（浏览器直接打开 `http://<该地址>:3000/api/health`）；③ 第 4 步的「不校验合法域名」是否勾上。真机还要多查一项：手机与电脑是否在同一网络、防火墙是否放行 3000。

### 18.3 目录结构

```
miniprogram/
├── app.js                  # 全局入口：clinic 缓存（5 分钟）+ 登录用户缓存（不含 token）
├── app.json                # 9 个页面 + tabBar（5 项）+ 导航栏配色
├── app.wxss                # 全局样式：卡片 / 按钮 / 标签 / 表单 / 登录引导（rpx）
├── project.config.json     # urlCheck=false、appid=wx89cbf3e1c05215cf、miniprogramRoot=./
├── sitemap.json            # 全站 disallow（不参与微信搜索）
├── config.js               # 后端地址（唯一一处环境配置；换环境只改这里，见 §18.4）
├── utils/
│   ├── request.js          # 从 config.js 取地址 / token 存取 / Bearer 头 / 401 统一跳登录
│   └── api.js              # 公开接口 + 认证 + 预约（每个调用显式标 withAuth）
└── pages/
    ├── index/               # 首页：诊所卡 + 6 项服务 + 3 位医师 + CTA
    ├── services/            # 服务列表：8 项
    ├── service-detail/      # 项目详情：?id=cleaning
    ├── doctors/             # 医师团队：4 位
    ├── appointment/         # 选医师 → 日期 → 时段 → 项目 → 提交（需登录）
    ├── my-appointments/     # 我的预约：列表 + 两次确认后取消
    ├── login/               # 手机号 + 密码（与 Web 同一接口）
    ├── register/            # 只注册病人（没有角色选择）
    └── mine/                # 登录态 / 我的预约入口 / 退出登录
```

每个页面都是四件套（`.js` / `.json` / `.wxml` / `.wxss`），`npm run test:mp` 会检查有没有漏。

### 18.4 后端地址怎么改（`miniprogram/config.js`，唯一一处）

地址从第九期起从 `utils/request.js` 挪到了**独立配置文件** `miniprogram/config.js`：
网络层只管「怎么发请求」，环境只管「发给谁」。只改这一行：

```js
// miniprogram/config.js
module.exports = {
  BASE_URL: 'http://localhost:3000'
};
```

| 场景 | 填什么 | 注意 |
| --- | --- | --- |
| 开发者工具模拟器 | `http://localhost:3000` | 模拟器里的 `localhost` 就是你的电脑。**只在模拟器里调试就把值改回这个** |
| 手机真机调试 / 预览（同一局域网） | 电脑 WLAN 网卡的 IPv4，如 `http://192.168.1.23:3000`（仓库默认值已改成云端 HTTPS 域名，连本机时按这个格式改） | 手机与电脑同一 Wi-Fi；**Windows 防火墙必须放行 3000**；仍需勾「不校验合法域名」。换网络后 IP 会变，以启动日志 `[WLAN]` 那行为准；校园网可能开终端隔离，同网也未必可达 |
| **体验版**（上传后在手机微信里打开） | 只能 HTTPS（cpolar / ngrok 穿透地址） | 体验版**不读**开发者工具里的「不校验合法域名」：要么在手机上打开「开发调试」临时豁免，要么配合法域名（IP + 3000 端口永远配不进去）。步骤见 `DEPLOY.md` §11 |
| 部署到云端（Koyeb）后 | `https://<服务名>-<组织>.koyeb.app` | **必须 HTTPS**；且真机预览要求该域名已配成「request 合法域名」——本项目不发布，所以云端地址只能在开发者工具里用（见 `DEPLOY.md` §10） |

> **监听地址**：`server/app.js` 现在**显式**绑 `0.0.0.0`（`app.listen(PORT, HOST, …)`，`HOST` 可由同名环境变量覆盖，默认 `0.0.0.0`）。绑 `127.0.0.1` 时只有本机能连，手机 / 别的电脑 / 容器健康检查全部探不到——这是「真机连不上」最常见的隐形原因。确实只想给本机用时：`HOST=127.0.0.1 npm start`。
>
> 启动日志会直接打印可用地址与网卡名（`[WLAN]` 那种就是该抄的，标了「虚拟网卡」的 VPN / VMware / WSL 地址不要用），不用自己去 `ipconfig` 里翻。
>
> **Windows 防火墙需放行 3000**（真机、局域网访问的前提）。管理员 CMD / PowerShell 执行一次即可：
>
> ```
> netsh advfirewall firewall add rule name="LSD-3000" dir=in action=allow protocol=TCP localport=3000
> ```
>
> 也可以在首次运行 Node 弹出的 Defender 提示里选「允许」，并勾上「专用网络」；当时点了取消的话，就到「控制面板 → Windows Defender 防火墙 → 允许应用通过防火墙」里补一条 Node.js。
>
> 真机连不上时按「地址 → 网络 → 防火墙」三步查：`ipconfig` 看 WLAN 的 IPv4 是否还是配置里那个（DHCP 会变）、手机与电脑是否同一网段（路由器「AP 隔离」也会挡）、3000 是否有 `LISTENING`。改地址**不需要重启后端**，小程序端重新编译一次即可。

页面代码里**不允许出现完整域名**：`request.js` 的 `assertLocalPath()` 只接受 `/` 开头的路径，写全地址会直接抛 `BAD_URL`；同时 `request.js` 通过 `require('../config')` 取地址，自己不再声明常量（`test:mp` 第 4 组会断言「config.js 里只有一处、request.js 里没有硬编码」）。这样换环境只需要改一个地方，也不会出现「某个页面偷偷连了别的域名」。

### 18.5 后端：三个公开只读接口

| 方法 | 路径 | 返回 | 明确**不**返回 |
| --- | --- | --- | --- |
| GET | `/api/public/clinic` | 名称、英文名、`phone.display/tel`、`address.city/detail/full`、`hours.caption/holiday_note/today/days[7]`、`demo_notice` | 邮箱、微信公众号二维码、证照编号 |
| GET | `/api/public/doctors` | 4 位医师：`id/booking_id/name/initial/dept/title/years/schedule/intro/short_intro/tags[]/services[]` | **执业证号 `license`**、邮箱、照片路径 |
| GET | `/api/public/services` | 8 个项目：`id/label/desc/price_text/price_note` | **`amount_cents`（分）** |

三个决定值得单说：

1. **数据不另存一份。** 路由通过 `server/site-data.js` 读 `assets/js/data.js`（第六期抽出来的入口，`pricing.js` 也用同一个）。官网改了电话或医师，服务重启后小程序下次请求就是新值。回归第 21 组会逐字比对接口与 `data.js`，不一致直接红。
2. **字段只减不加。** 小程序包发出去之后，代码和请求都能被翻出来看，**下发的字段等于公开的字段**。所以证号、邮箱不发；金额连「分」都不发，只发格式化好的 `price_text` —— 前端拿不到数字，就不会有人在小程序里做金额加减。
3. **限流按 IP，三个接口共享 60 次/分钟。** 首页一次要打 3 个接口，如果每个接口各给 60 次，实际放行量就是 180 次/分钟，配额失去意义。超额返回：

   ```json
   { "error": "请求过于频繁，请稍后再试", "code": "RATE_LIMITED", "retry_after": 42 }
   ```

   响应头带 `X-RateLimit-Limit` / `Remaining` / `Reset`，429 时另带 `Retry-After`。实现是进程内固定窗口（`server/rate-limit.js`），**不是**生产级：多实例各算各的、重启清零、NAT 后多人共享配额。真上线要换 Redis 或网关限流，并按 `openid` 计量。

**`booking_id` 是第八期加的，也是唯一新增的字段。** 小程序展示用的是 `data.js` 里的 slug（`liu-ortho`），但 `/api/schedules?doctor_id=` 要的是 `users.id` 整数。这个映射（医生账号邮箱前缀 = slug）原本只在官网前端 `booking.js` 里做；小程序如果自己再拼一遍，就会有两处映射、两份「谁是谁」。所以由服务端查一次 `users` 表给出 `booking_id`，没建账号的医师给 `null`，小程序据此把在线预约置灰。

**实测（`node scripts/api-test.mjs` 第 21 组，15 条 + 第 22 组里的 1 条 booking_id 断言）：**

```
GET /api/public/clinic   → 200，7 天营业时间，today = 周二 09:00–20:00
GET /api/public/doctors  → 200，4 位，无 license / email 字段；booking_id = 2/3/4/5
GET /api/public/services → 200，8 项，洗牙 price_text="¥280.00 起"，无 amount_cents
GET /api/public/nothing  → 404 JSON（公开接口就 3 个）
第 6 次请求（配额 5 的测试进程）→ 429 + Retry-After
```

### 18.6 页面与数据来源

| tab | 页面 | 数据来源 | 交互 |
| --- | --- | --- | --- |
| 首页 | `pages/index` | clinic + services（前 6）+ doctors（前 3） | 拨打电话、预约到店、点项目进详情、下拉刷新 |
| 服务 | `pages/services` | services（8 项） | 点任意一项 → 详情 |
| 医生 | `pages/doctors` | doctors（4 位） | 查看简介 / 标签 / 出诊时间（带「待核对」标记） |
| 预约 | `pages/appointment` | doctors（`booking_id`）+ services + `/api/schedules` | **未登录**只显示登录引导；登录后选医师 → 选日期（`picker mode="date"`）→ 选时段 → 选项目 → 提交 |
| 我的 | `pages/mine` | `/api/me`（有 token 时） | 查看身份、进「我的预约」、退出登录 |
| （详情） | `pages/service-detail` | services + doctors（按 `services[]` 过滤擅长医师） | 电话咨询、回列表 |
| （二级） | `pages/my-appointments` | `/api/patient/appointments` | 列表 + 取消（`wx.showModal` 二次确认） |
| （二级） | `pages/login` | `POST /api/login` | 手机号 + 密码；失败留在本页显示原因 |
| （二级） | `pages/register` | `POST /api/register` | 姓名 + 手机号 + 密码；成功后回登录页并回填手机号 |

每个页面都有三态：加载中 / 错误（带「重新加载」按钮）/ 正常。错误态不是白屏——这是小程序比网页更容易被忽略的地方。

预约页还有两个容易做错、这里刻意做对的细节：

| 细节 | 做法 | 不这么做会怎样 |
| --- | --- | --- |
| 已过时间的时段 | 服务端只标「有没有被占」，不标「是不是已过」；页面按本地时间把 `start_time <= now` 的时段标成「已过时间」并置灰 | 下午打开预约页，还能点今天 09:00，点完提交才 400 `SLOT_IN_PAST` |
| 连续改医师 / 日期 | `loadSlots()` 自增一个序号，回来时序号对不上就丢弃 | 先点医师 A 再点 B，A 的响应晚到，把 B 的时段覆盖掉 |

### 18.7 两个阶段各做了什么、没做什么

**阶段一（第七期）**

- 5 个 tab + 1 个详情页，WXML/WXSS 重写，**没有复用** `render.js` / `main.js`（那两个依赖 DOM）；
- `utils/request.js`：统一 baseURL、超时、错误归一化（`NETWORK` / `HTTP_4xx` / `RATE_LIMITED`）；
- `app.js` 的 clinic 缓存（5 分钟），避免「首页 → 预约页」重复请求打满配额；
- 三个公开接口 + 限流 + 字段收窄。

**阶段二（第八期）**

- 后端加 Bearer 通道：`server/jwt.js`（签发 / 校验 / 密钥解析）、`authenticate`（cookie + Bearer 双认）、`/api/login` 同时下发 token（§18.9）；
- 小程序：登录、注册、预约（医师 → 日期 → 时段 → 项目 → 提交）、我的预约（列表 + 取消）；
- 网络层：`token` 存 storage、`withAuth` 自动加 `Authorization`、401 统一清 token 跳登录（§18.10）；
- 公开医师接口补 `booking_id`（唯一新增字段，见 §18.5）；
- 自动化：`test:api` 第 22 组 32 条、`test:mp` 46 条、`mock:mp` 44 条，覆盖「过期 / 篡改 / 换密钥」三种失败。

**没做（每个都有原因，不是遗漏）**

| 没做 | 原因 | 属于 |
| --- | --- | --- |
| 医生端（确认 / 完成 / 未到诊 / 恢复） | 医生账号是邮箱 + 审核制，小程序端没有审核流；误触就是改别人的排班 | 不做（官网已完整，分层理由见 §19.2） |
| 支付 / 订单 | 两端调同一个 `/api/patient/orders/*`，都是**模拟**支付（不接微信支付、不产生真实资金） | 小程序已支持（我的预约页内联），见 §19.2 |
| `openid` 登录、手机号一键授权、订阅消息 | 都要真实 `appid`、类目审核与隐私协议；本项目不发布 | 不做 |
| 图片（医师照片 / 门头 / 配图） | 没有可用素材；医疗场景的图片还涉及肖像授权 | 不做（用首字 / 色块代替） |
| 分享、客服、地图导航 | 发布才有意义；地图另需测绘资质与审图号（官网同样只用占位） | 不做 |
| 改期（而不是取消后重约） | 改期要「先占新号再释放旧号」的事务语义，接口与状态机都要动 | 未做（现在只能取消后重约） |
| token 主动吊销 | JWT 无状态，服务端没有「吊销表」；当前靠 2 小时过期 + 每次都回库查 `status` 兜底 | 已知取舍（§18.10 有说明） |

### 18.8 验证：没有开发者工具也能证明「数据通了」

微信开发者工具没有命令行模式，所以拆成三层：

| 脚本 | 做什么 | 结果 |
| --- | --- | --- |
| `npm run test:api` | 第 22 组专测 Bearer 通道：token 能进、角色越界 403、过期 401、改 payload 401、换密钥 401、坏头不回落 cookie、停用即失效、密钥缺失 / 过短拒绝启动 | **第 22 组 32 条 ✅**（全量 22 组 / 266 条） |
| `npm run test:mp` | 文件级体检：9 页四件套、tabBar 顺序、无 DOM API、无 `<img>`、无外部域名、页面不硬编码电话 / 地址 / 医师名 / 手机号、无第三方 UI 库、token 只在网络层存取、云通道的开关与门控（`env` + `service` 齐备才生效，配错不弄挂本地开发）、加载失败提示由 `backendHint()` 统一生成（页面不写死后端命令）、登录 / 预约 / 取消页的结构约束、WXSS 无 `:focus-visible` 与裸 `px` | **6 组 / 51 条 ✅** |
| `npm run mock:mp` | 最小 `wx` / `Page` / `App` 垫片（含 storage / showModal / reLaunch），require **真实的页面文件**，跑「未登录 → 注册 → 登录 → 预约 → 模拟支付 → 退款 → 取消」，再签一个**已过期**的 token 验 401 跳登录；最后单独验云托管通道（服务名不符自动换名重试、成功后记住、全不通降级公网域名） | **9 组 / 58 条 ✅** |

`mock:mp` 的页面 console（这就是「登录 → 预约 → 取消」的证据，比截图更可核对）：

```
[预约] 未登录：显示登录引导，不发任何需要身份的请求
[我的预约] 未登录：显示登录引导
[注册] 成功：patient / 13800001234
[登录] 成功，身份=小程序病人，已保存 token
[预约] 医师 4 位、项目 8 个
[预约] 2026-11-24：3 个时段，可约 0 个        ← 今天的时段都已过开始时间
[预约] 2026-11-27：4 个时段，可约 4 个
[预约] 已提交 #1（2026-11-27 09:00，待门诊确认）
[我的预约] 1 条：#1待确认
[我的预约] 用户放弃取消 #1
[我的预约] 已取消 #1 → cancelled
[我的预约] 1 条：#1已取消
[我的] 已登录：小程序病人（patient）
[我的] 已退出登录，本地 token 已清除
```

请求流水（主机被改写到临时端口 3107，路径与查询串与真机一致）：

```
[api]      POST /api/register                      auth=-        ← 注册时不带凭证
[api]      POST /api/login                         auth=-        ← 登录前没有 token
[api]      GET  /api/public/doctors                auth=-
[api]      GET  /api/public/services               auth=-
[api]      GET  /api/schedules?doctor_id=2&...     auth=Bearer   ← 之后的请求全带 token
[api]      POST /api/appointments                  auth=Bearer
[api]      GET  /api/patient/appointments          auth=Bearer
[modal]    取消预约 → cancel                                     ← 点「再想想」，没有发请求
[modal]    取消预约 → confirm
[api]      POST /api/appointments/1/cancel         auth=Bearer
[api]      GET  /api/patient/appointments          auth=Bearer
[reLaunch] /pages/login/login                                    ← 过期 token 触发的跳转
```

关键数据快照（`setData` 之后的真实取值）：

```json
{
  "token_in_storage_after_login": "eyJhbGciOiJIUzI1Ni…（3 段）",
  "patient_id": 6,
  "booked": { "id": 1, "date": "2026-11-27", "time": "09:00–10:00",
              "doctor": "刘主任", "service": "洗牙", "status": "待确认" },
  "after_cancel": { "id": 1, "status": "cancelled", "canCancel": false },
  "expired_token_error": { "code": "TOKEN_EXPIRED", "status": 401, "needLogin": true }
}
```

> 说明：`mock:mp` 会把请求的**主机部分**改写到临时端口 3107（不和你正在跑的 3000 抢），路径与查询串原样保留；它验证的是「页面真实发出的那条请求」，不是另写一套假数据。**渲染效果（字号、间距、安全区）必须在开发者工具里看**，脚本不替代人眼。

### 18.9 认证双通道：cookie 给 Web，Bearer 给小程序

设计目标只有一句：**加一条通道，不改 Web 的任何一个行为。**

| | Web（官网） | 小程序 |
| --- | --- | --- |
| 凭证 | `lsd.sid` cookie（`httpOnly` / `SameSite=Lax` / 2 小时） | `Authorization: Bearer <JWT>` |
| 谁保存 | 浏览器，JS 读不到 | `wx.setStorageSync('token')` |
| 从哪来 | `POST /api/login` 的 `Set-Cookie` | **同一个** `POST /api/login` 的 `token` 字段 |
| 谁校验 | `authenticate()`（`server/auth.js`） | `authenticate()` —— 同一个函数 |
| 身份来源 | 回库查 `users` 的 `role` + `status` | 同上 |

`POST /api/login` 现在一次给两样：

```json
{
  "user": { "id": 6, "role": "patient", "name": "小程序病人", "status": "active" },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.…",
  "token_type": "Bearer",
  "expires_in": 7200,
  "message": "登录成功"
}
```

Web 端**根本不读 `token`**（`assets/js/auth-pages.js` 只看 `message` 与状态码，然后跳控制台），所以这次改造对网站是纯增量：

```
第 1–21 组（222 条，绝大多数以 cookie 会话为前提）  一条断言都没改 → 全绿
第 22 组（32 条，Bearer 通道）                    本期新增
test:ui  7 组 / 31 条                            全绿
test:e2e 9 组 / 45 条                            全绿
```

> 口径说明：第 1–21 组里第 7 组（静态资源）与第 21 组（公开接口）本来就不需要登录，其余各组都以 cookie 会话为前提。这里不写「47 条 cookie 断言」这种具体数：脚本里没有人给断言按「是否依赖 cookie」打标签，硬报一个数反而是编的。可信的口径是「第 1–21 组一条没改、222 条全过；加上新增的第 22 组，合计 266 条」。

**中间件的判断顺序**（`server/auth.js` 的 `authenticate`）：

1. 请求里**有** `Authorization` 头 → 只认 Bearer：
   - 格式不是 `Bearer <token>` → 401 `BAD_AUTH_HEADER`
   - 验签失败 → 401 `TOKEN_INVALID`；过期 → 401 `TOKEN_EXPIRED`
2. 请求里**没有** `Authorization` → 走老路径 `req.session.uid`
3. 拿到 `uid` 之后**一律回库查** `role` + `status`——token 里的 `role` 只用于客户端提示

**最容易写错的一处：坏了也不许回落 cookie。** 如果「Bearer 验签失败 → 悄悄用 cookie 兜底」，会出现最危险的一种通过：token 已经过期或被改，但浏览器里恰好还有有效会话，接口照样 200。前端以为 token 还活着，测试也测不出 token 通道坏了。所以只要出现 `Authorization` 头就只认它，失败就明确 401。断言：

```
好 cookie + 坏 Bearer → 401 TOKEN_INVALID
只带 cookie          → 200（对照组，证明 cookie 没被改坏）
```

**payload 只放 `{ id, role }`**（`iat` / `exp` 是 JWT 标准声明，由库写入）。不放姓名、手机号、邮箱：token 落在客户端 storage 里，能少放就少放；资料一律以 `/api/me` 的返回为准。签名算法固定 `HS256`，校验时显式传 `algorithms: ['HS256']`——不写的话库会按 header 里的 `alg` 选算法，历史上 `alg=none` 与 HS/RS 混用都出过提权漏洞。

**两条通道互不干扰**：Web 登出只销毁会话，不会让手里的小程序 token 失效；小程序清本地 token，也不影响浏览器里的登录态。代价是「同一账号两处登录」会有两个独立凭证——演示场景可以接受，真实产品通常还要一张「登录设备表」。

**token 不区分端。** 服务端只验签名与载荷，**不问这张 token 是从浏览器还是从小程序发出来的**：Web 端（`fetch` 里、或 `curl` / Postman）带上 `Authorization: Bearer <token>` 一样能调通；把小程序拿到的 token 塞进浏览器请求头，也是同一个身份、同样的权限。**这是设计选择，不是漏洞。**

理由三条：

1. **凭证代表「这个人」，不代表「这个客户端」。** 权限依据始终是回库查到的 `role` + `status`，与凭证形态无关。若按客户端分权，等于把授权建在一个可伪造的请求头上（`User-Agent` 能改，token 里也没有端标识）。
2. **分开反而制造漏洞。** 「小程序 token 只能调小程序接口」需要服务端额外维护 `token → 端` 的映射，等于把无状态 JWT 变回有状态会话；任何一处漏判就是越权。两端共用同一套 `/api/*` 与同一个 `authenticate`，判断只有一份，不会分叉（§18.12「接口」一行）。
3. **跨端可互换带来的是运维便利。** 排查线上问题时，拿用户小程序里的 token 做一次 `curl` 复现，走的就是同一条代码路径，不需要另开「小程序专用入口」。

真要区分端的场景（比如「小程序不能退款」）不该靠 token 来源判断，而应写成**角色 / 资源级**规则：退款接口本来就只有「订单属于本人」才能调，Web 与小程序一视同仁地受限。这与「token 可互换」并不冲突。

### 18.10 token 生命周期与 401 处理策略

**生命周期**：登录成功签发 → 2 小时后过期 → 重新登录。没有 refresh token：演示站没有「静默续期」的必要，多一个刷新接口就多一处必须做对的权限判断。

```
POST /api/login  ──►  token（exp = iat + 7200）
                        │
        ┌───────────────┴───────────────┐
        │ 有效                           │ 过期 / 被改 / 换密钥
        ▼                                ▼
   200（req.user 来自数据库）        401 + code
```

401 的四种 `code`，前端按 code 决定文案，不去匹配中文：

| code | 触发条件 | 小程序的处理 |
| --- | --- | --- |
| `TOKEN_EXPIRED` | 签名对、`exp` 已过 | 清 token → `reLaunch` 登录页 |
| `TOKEN_INVALID` | 签名不对 / payload 被改 / 换密钥 | 同上 |
| `BAD_AUTH_HEADER` | 有 `Authorization` 但不是 `Bearer x` | 同上（客户端代码写错了，不该静默） |
| `NO_CREDENTIALS` | 什么都没带 | 同上 |

**统一出口在 `utils/request.js` 的 `handleUnauthorized()`**，页面一行判断都不用写：

```js
function handleUnauthorized() {
  clearToken();                                    // 废票立刻丢掉
  if (currentRoute() === LOGIN_PAGE) return false; // 已经在登录页，别自己跳自己
  if (redirectingToLogin) return true;             // 连发 3 个请求同时 401，只跳一次
  redirectingToLogin = true;
  wx.reLaunch({ url: LOGIN_PAGE, complete: () => { redirectingToLogin = false; } });
  return true;
}
```

三个刻意的例外：

| 情况 | 为什么不能跳 |
| --- | --- |
| `POST /api/login` 返回 401（密码错） | 跳走就等于「一输错密码页面就刷新」，密码框还会被清空。所以 `api.login()` 传 `skipAuthRedirect: true`，错误留在页面上 |
| 公开接口（`/api/public/*`） | 它们不会 401；跳转条件写成 `withAuth && 401`，公开请求不参与 |
| 已经在登录页 | 否则登录页自己触发 401 会无限 `reLaunch` |

**「JWT 无状态、无法吊销」怎么补**：`authenticate` 每次都回库查 `status`，所以管理员一停用账号，手里那张还有 1 小时有效期的 token 立刻 403（断言：`账号被停用后，未过期的 token 立刻 403`）。这不是真正的吊销（改密码不会让旧 token 失效），但覆盖了「停用 / 删除」这两种真正需要立刻生效的场景；要更强的语义就得引入 token 版本号或黑名单表，那是另一个设计题。

**篡改实测**（`npm run test:api` 第 22 组，全部真实 HTTP）：

```
① 把 payload 里的 role 改成 doctor，保留原签名
   → 401 {"error":"登录凭证无效，请重新登录","code":"TOKEN_INVALID"}
   （改 payload 必然改签名输入；何况角色本来就回库查，改成了 doctor 也进不了医生接口）
② 用别的密钥签一个合法结构的 token
   → 401 TOKEN_INVALID
③ 直接用会话密钥签（而不是派生密钥）
   → 401（证明服务端真的用的派生密钥，没有把会话密钥复用成 JWT 密钥）
④ 用派生密钥签一个 exp 已过的 token
   → 401 {"code":"TOKEN_EXPIRED"}
⑤ Authorization 头缺 Bearer 前缀
   → 401 {"code":"BAD_AUTH_HEADER"}
⑥ 好 cookie + 坏 Bearer
   → 401 TOKEN_INVALID（不回落）
```

小程序侧也用**真的过期 token** 走了一遍（`mock:mp` 第 5 组）：把 `exp` 设在 60 秒前、签名正确，页面请求 → 401 → token 从 storage 清空 → `reLaunch('/pages/login/login')`，全部由拦截器完成，页面代码没有一处 `if (status === 401)`。

### 18.11 `JWT_SECRET` 怎么配（以及缺失时会发生什么）

`server/jwt.js` 的密钥解析按优先级：

| 顺序 | 条件 | 结果 |
| --- | --- | --- |
| ① | 配了 `JWT_SECRET` 且 ≥ 32 字符 | 用它。来源记为「环境变量 JWT_SECRET」 |
| ② | 配了但 < 32 字符 | **拒绝启动**（退出码 1），不会「太短就自动降级去派生」——手滑配错却悄悄换钥匙，比起不来更难查 |
| ③ | `JWT_REQUIRE_ENV=1` 且没配 | **拒绝启动**（严格模式，生产建议开） |
| ④ | 都没配，但有会话密钥（`SESSION_SECRET` 或 `data/.session-secret`） | 派生：`HMAC-SHA256(sessionSecret, 'lsd/jwt/v1')` → 64 位 hex |
| ⑤ | 连会话密钥都没有（或不足 32 字符） | **拒绝启动** |

**没有默认字符串兜底。** 写死的默认密钥等于把签名算法公开：谁都能自己签一个 `role=admin` 的 token 进来。宁可起不来，也不带着可预测的密钥对外服务。

派生而不是直接复用会话密钥，是因为一个密钥同时签 cookie 和 token 时，任一条通道泄露都会让另一条跟着失守。

实测的启动失败（`npm run test:api` 第 22 组会把这两种都跑一遍并断言退出码）：

```bash
$ JWT_SECRET=too-short SESSION_SECRET=… node server/app.js
[启动失败] JWT_SECRET 太短（当前 9 字符，至少 32）。生成方式：node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# 退出码 1

$ JWT_REQUIRE_ENV=1 SESSION_SECRET=… node server/app.js
[启动失败] JWT_REQUIRE_ENV=1 但没有配置 JWT_SECRET。严格模式下不接受从会话密钥派生，必须显式提供独立密钥。
# 退出码 1
```

正常启动时控制台会打印密钥来源（**只打印来源，不打印密钥本身**）：

```
会话密钥：环境变量 SESSION_SECRET
令牌密钥：由会话密钥派生（HMAC-SHA256 / lsd/jwt/v1）（Bearer token 有效期 2 小时）
```

生产环境怎么配：

```bash
# 生成一把独立密钥（32 字节 → 64 位 hex）
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 写进环境变量后启动；多实例部署必须用同一把，否则 A 实例签的 token 到 B 实例就 401
JWT_SECRET=<64 位 hex> JWT_REQUIRE_ENV=1 SESSION_SECRET=<另一把 64 位 hex> npm start
```

> 本地演示**不配也能跑**（走 ④ 派生），因为 `data/.session-secret` 首次启动会自己生成。这条派生的密钥随文件走：删掉 `.session-secret` 会同时让所有 cookie 会话和所有 token 失效，已登录用户需要重新登录——这和 Web 那边换会话密钥的行为一致。

**一句必须说清的边界：** 删除 `data/.session-secret` 会让 **Web cookie 会话和小程序 token 同时失效**（token 密钥是从它派生的），下次启动会**重新生成一份新的**随机密钥文件。也就是说：

- 这不是「只影响小程序」的操作——删了就两边一起掉线；
- 反过来也一样：换了 `JWT_SECRET` 只影响 token，不影响 cookie（两条通道的密钥材料是分开的，见上表 ①）；
- 密钥文件属于**运行时状态**，不进版本库（`.gitignore` 已排除 `data/`）；换机器部署要么带文件，要么显式配 `JWT_SECRET` + `SESSION_SECRET`，否则所有旧凭证一并作废。这是预期行为，不是故障。

**云端（Koyeb / Render 免费实例）同理，而且更频繁：** 免费层没有持久磁盘，`data/` 整个目录都在容器里，**重启 / 重新部署 / 休眠唤醒后一律消失**。于是每次冷启动都会重新生成一把新的 `.session-secret`：

- **已登录用户会掉线，需要重新登录——这是预期行为，不是故障。** 会话 cookie 的签名密钥变了，旧 cookie 一律验不过；
- 同一个原因，**SQLite 数据库也会被重建**（`server/db.js` 的空库自举：建表 + 5 个种子账号 + 196 个排班时段），老师每次看到的都是干净的演示数据；
- 想让登录态跨重启保持，就在平台控制台配 `SESSION_SECRET` / `JWT_SECRET` 两个环境变量（各 64 位 hex），见 `DEPLOY.md` §9。

细节与取舍见 `DEPLOY.md` §8，本文不重复。

### 18.12 与官网的关系（改哪里、别改哪里）

| 事项 | 结论 |
| --- | --- |
| 诊所信息 / 医师 / 项目 | 只改 `assets/js/data.js`。官网经 `render.js` 渲染，小程序经 `/api/public/*` 读取，**同一份数据** |
| 价格 | 只在 `data.js` 的 `services[]`（`amount_cents` + `price_range`）。官网服务页区间、`/api/services`、小程序 `price_text` 都从它派生；改完**重启服务** |
| 项目简介 | `services[].desc` 是小程序用的 1–2 句摘要；`services.html` 里的长文案是给人读的段落。两者措辞不同、事实一致，**价格不在这两者里** |
| 接口 | 小程序**不新开** `/api/mp/*`。要加能力就给已有 `/api/*` 加字段或加方法，权限中间件一起复用；一旦分叉，两边的判断迟早不一致 |
| 登录 | 只有 `/api/login` 一处。改登录规则（比如加图形验证码）会同时影响 Web 与小程序，这是**想要的**效果——两边共用同一套账号 |
| 不要做的事 | 别在小程序页面里写死电话 / 地址 / 医师名（`test:mp` 会红）；别加 `wx.request` 直连（必须走 `utils/request.js`）；别在页面里读写 storage（token 只在网络层）；别引入 UI 库；别把 `urlCheck` 改回 `true`（本地 HTTP 会全部失败）；别让 Bearer 失败时回落 cookie（§18.9） |

---

## 19. 小程序端范围声明（阶段二收尾）

**一句话：小程序只覆盖病人端；医生工作台留在 Web 端。模拟支付两端都有（同一套接口），真实微信支付两端都没有。这是有意为之的分层，不是「没做完」。**

### 19.1 每个功能落在哪一端

| 功能 | 小程序 | Web 官网 | 为什么这样放 |
| --- | --- | --- | --- |
| 诊所信息 / 服务 / 医师 / 项目详情 | ✅ | ✅ | 两端同一份 `data.js`，没有第二套内容 |
| 病人注册 / 登录 | ✅ | ✅ | 同一个 `/api/register`、`/api/login`；注册一律落 `patient` |
| 选医师 → 选日期 → 选时段 → 提交预约 | ✅ | ✅ | 同一套 `/api/schedules`、`/api/appointments`，防双订仍靠数据库唯一索引 |
| 我的预约（列表 / 取消） | ✅ | ✅ | 同一个 `/api/patient/appointments`；取消受同一套「时段开始前可取消」规则约束 |
| 模拟支付 / 退款 | ✅ 我的预约页内联 | ✅ `payment.html` | 同一套 `/api/patient/orders/*`；两端都是**模拟**支付，不接微信支付、不产生真实扣款（见 §19.2） |
| 医生工作台（确认 / 完成 / 未到诊 / 恢复） | ❌ | ✅ `dashboard.html` | 见 §19.2 |
| 管理员审核（病人 / 医生申请） | ❌ | ✅ `dashboard.html` | 见 §19.2 |
| 医生申请（`/api/doctor/apply`） | ❌ | ✅ `register.html` | 需要上传执业证、填执业范围，表单重、审核重 |
| `openid` 登录 / 手机号一键授权 / 订阅消息 | ❌ | ❌ | 都要真实 `appid`、类目审核与隐私协议；本项目不发布 |

### 19.2 为什么医生端**不**迁到小程序（模拟支付已迁）

1. **医生端是「审核制 + 高风险写操作」，与小程序的分发模型不合。** 医生账号要邮箱、要执业证、要管理员审核（`status: pending → active`）。小程序端如果开放医生登录，就得把审核流、证照上传、执业范围校验一起搬过去；而「确认 / 完成 / 未到诊 / 恢复」每一个都是改别人排班的写操作，手机上误触的代价比网页高。留在 Web 后台，等于把高权限操作关在一个「需要坐下、登录、看清列表」的环境里。
2. **模拟支付可以进小程序，真实微信支付不行 —— 这是两件事。** 本项目全线是**模拟支付**（§16）：没有商户号、没有回调、不产生真实资金，小程序里做的只是「把订单状态 `unpaid` 改成 `paid`」的一次普通接口调用。它**没有**调用 `wx.requestPayment`、没有 `prepay_id`、没有商户资质。真正接微信支付则立刻要求商户号、真实 `appid` 与类目审核 —— 那是换一个合规身份，红线不允许（§17.8 第 1 条）。所以「小程序里有支付按钮」不等于「接了微信支付」，两端调的是同一个 `/api/patient/orders/:id/pay`。
3. **分层本身是正确架构，不是妥协。** 病人端要「随时随地、少步骤」，所以做成小程序；医生端要「看得全、点得准、有审计」，所以做成后台。两端**共用同一个后端、同一套鉴权、同一份数据**（§18.12），只是入口不同——这比「所有功能硬塞进一个端」更容易做对权限。

**因此本期的验收边界是：** 小程序能完成「注册 → 登录 → 预约 → 查看 → 取消 → 模拟支付 / 退款」整条病人链路，且医生端在 Web 端功能不退化。超出这个范围的，都不属于「漏做」。

### 19.3 最终文件结构（`miniprogram/`，44 个文件）

```
miniprogram/
├── app.js                          # 全局入口：clinic 缓存（5 分钟）+ 登录用户缓存（不含 token）
├── app.json                        # 9 个页面（5 tab + 4 非 tab）+ 导航栏配色 + lazyCodeLoading
├── app.wxss                        # 全局样式：卡片 / 按钮 / 标签 / 表单 / 登录引导（rpx）
├── project.config.json             # 开发配置：urlCheck=false、appid=wx89cbf3e1c05215cf、miniprogramRoot=./
├── sitemap.json                    # 全站 disallow（不参与微信搜索）
├── config.js                       # 后端地址（唯一一处环境配置；部署后改云端 HTTPS）
├── utils/
│   ├── request.js                  # BASE_URL 唯一来源、token 存取、Bearer 头、401 统一跳登录
│   └── api.js                      # 11 个语义封装：3 公开 + 4 认证 + 4 预约
└── pages/                          # 9 个页面 × 四件套（.js / .json / .wxml / .wxss）
    ├── index/                      # 首页：诊所卡 + 6 项服务 + 3 位医师 + 预约 CTA（tab 1）
    ├── services/                   # 服务列表：8 项（tab 2）
    ├── doctors/                    # 医师团队：4 位（tab 3）
    ├── appointment/                # 预约：医师 → 日期 → 时段 → 项目 → 提交（需登录，tab 4）
    ├── mine/                       # 我的：登录态 / 入口 / 退出（tab 5）
    ├── service-detail/             # 项目详情：?id=cleaning（navigateTo，不进 tabBar）
    ├── my-appointments/            # 我的预约：列表 + 两次确认后取消
    ├── login/                      # 手机号 + 密码（与 Web 同一接口）
    └── register/                   # 只注册病人（没有角色选择）
```

文件数口径：`6`（根级 app.js / app.json / app.wxss / config.js / project.config.json / sitemap.json）+ `2`（utils）+ `9 × 4 = 36`（页面四件套）= **44**（第九期加了 `config.js`）。

> 微信开发者工具**导入项目后会自动生成** `project.private.config.json`（记录本机 `libVersion` 与编译选项）。它是本地文件，已在 `.gitignore` 排除，不算在上面这 44 个里；删掉也不影响项目，工具下次打开会重新生成。`npm run test:mp` 会逐页检查四件套有没有缺。

### 19.4 `urlCheck: false` 是开发配置，不是上线配置

`project.config.json` 里 `setting.urlCheck` 为 `false`，原因是**本地调试时客户端连的是本机 HTTP 后端**（`BASE_URL = http://localhost:3000` 或局域网 IP）：微信开发者工具默认会校验「request 合法域名」，HTTP、localhost、内网 IP 都在白名单之外，开着就一个请求都发不出去。仓库默认值现在指向云端 HTTPS 域名（`https://springboot-vaij-353722-13-1540473897.sh.run.tcloudbase.com`），这个开关留着是为了模拟器随时切回本机后端。

- 只在**开发者工具 / 预览**阶段成立，且只影响本机；
- 真机**不必**依赖它：小程序走微信云托管通道（`wx.cloud.callContainer`），请求不经过「request 合法域名」校验，体验版与正式版都不受 `urlCheck` 影响；
- **本项目已提交正式版审核**（`appid` 为 `wx89cbf3e1c05215cf`，当前处于名称整改阶段，见 §3.2），这条开发配置只在本地调试时生效；`sitemap.json` 仍为全站 `disallow`（页面含个人预约数据，不需要被搜索索引）。

> **AppID 与 AppSecret 不是一回事。** `appid`（`wx89cb…15cf`）是公开标识，写在 `project.config.json` 里没问题，别人拿到也做不了什么；`AppSecret` 是**服务端密钥**，一旦泄露就能换取 `access_token`、调用该小程序的服务端接口——本项目**根本没有使用**它，也绝不要写进小程序代码、仓库或 `project.config.json`。真要用（比如 `code2session`），只能放服务端环境变量。

**上线不需要走"买域名 + 配白名单"这条路**：只要 `config.js` 的 `CLOUD` 三项齐备（`enabled` / `env` / `service`），请求就由微信云托管通道发出；`BASE_URL` 只在云通道不可用时作为降级地址。发布前要确认的是：① 云托管环境属于本小程序；② 后台「基础库最低版本」≥ 2.23.0；③ 名称与页面文案不出现机构经营信息（本次整改项，见 §3.2）。

#### 按需注入（`lazyCodeLoading`）

`app.json` 里配了 `"lazyCodeLoading": "requiredComponents"`。这是微信「代码质量」检测的必查项——没开的话，上传时会在代码质量报告里提示「未开启按需注入」。

**为什么这个项目开启后是安全的**：全局与 9 个页面的 `usingComponents` 都是空的（零自定义组件，全部用 `view` / `text` / `button` 原生节点），也没有「动态路径声明组件」「`this.selectComponent` 取子组件」这类依赖静态注入的写法。所以「只注入当前页面用到的代码」不会漏掉任何东西。包体积 220 KB（无图片资源），远低于 2 MB 主包上限，不需要分包。

**它只解决「代码质量检测」这一项。** 代码质量报告变绿 ≠ 能过审：能否上线还取决于账号层面（小程序备案、服务类目与名称表述），与代码检测是两回事。

### 19.5 最终验证（`npm run test:all`，六套，退出码 0）

| # | 脚本 | 命令 | 组 | 断言 | 覆盖 |
| --- | --- | --- | --- | --- | --- |
| 1 | 接口回归 | `npm run test:api` | 22 | **266** | 真实 HTTP + 临时库；第 22 组是 Bearer 通道（32 条） |
| 2 | 并发回归 | `npm run test:race` | 2 | **7** | 单进程 8 并发 + 双进程 TOCTOU |
| 3 | 展示页回归 | `npm run test:ui` | 7 | **31** | `file://` + 真浏览器；导航 / 表单 / 联动 / 价格渲染 |
| 4 | 端到端回归 | `npm run test:e2e` | 9 | **45** | 真服务 + 真浏览器，含 Network 自检（外部请求 0 条） |
| 5 | 小程序静态体检 | `npm run test:mp` | 6 | **46** | 9 页四件套 / 无 DOM / 无硬编码 / token 只在网络层 |
| 6 | 小程序页面模拟 | `npm run mock:mp` | 7 | **44** | wx 垫片跑真实 `onLoad`；登录 → 预约 → 取消 + 过期 token 跳登录 |

```
合计 266/266 + 7/7 + 31/31 + 45/45 + 46/46 + 44/44 = 439 条断言，全部通过
六套串跑 npm run test:all → exit 0
```

日志：`.workbuddy/test-all-final-round9.log`（本轮）、`.workbuddy/bearer-assertions.log`（Bearer 断言节选）、`.workbuddy/mp-mock-round8.log`（小程序流程）。

### 19.6 工作区清洁度

| 检查项 | 结果 |
| --- | --- |
| `.workbuddy/tmp/` 残留 | **空目录（0 项，含隐藏文件）**。上一轮 XSS 验证用的 `xss.db` 已随临时服务退出释放，本轮复查未再出现 |
| 临时服务端口（3000 / 3101 / 3102 / 3107 / 3111） | `netstat` 复查**无一个 LISTENING**；刚跑完的测试会留下少量 `TIME_WAIT` 连接状态（客户端侧 socket），内核几十秒内自行回收，不占端口 |
| `data/` 里的演示库 | `app.db` + `.session-secret` 保留（这是运行时数据，不是临时垃圾）；`app.db-wal` 是 SQLite WAL 正常副产物，随连接关闭合并 |
| 版本控制外的证据文件 | 全部在 `.workbuddy/`（日志 / 截图），不参与静态托管（白名单只放行 9 个页面 + `/assets`） |

> 说明：`xss.db` 这类文件在 Windows 上偶发「进程已退出但句柄未释放」，表现为删不掉。处理方式是一律不阻塞收尾——记一笔、下次清理即可。本轮复查 `.workbuddy/tmp/` 为空，说明上一轮确实释放了。

---

**小程序端阶段二到此收尾。** 病人端链路完整（注册 / 登录 / 预约 / 取消 / 我的预约），医生端明确留在 Web 端（模拟支付后来补进小程序，见 §19.2），六套回归 439 条断言全绿，没有「以后再说」的悬空项。

---

## 20. 部署到云端（Koyeb 免费实例 · Docker）

> **已降级为备选**：当前线上跑的是 §21 的 WorkBuddy 应用托管（免服务器、免绑卡、免备案）。
> 本节保留完整步骤，作为「以后要自有服务器 / 要持久化数据库」时的参考。

> **怎么一步步点**写在 `DEPLOY.md`（Koyeb 主方案 + Render 备选，含 git 命令、控制台路径、种子账号表、常见报错）。
> 本节只讲三件事：**镜像怎么构建**、**代码为云端做了什么适配**、**云端和本地差在哪**。
>
> 目标平台原定 Render，其免费层创建服务要验证信用卡、国内卡不被接受，故改用 **Koyeb 免费实例**
> ——同一份代码，构建方式从「原生 Node」换成「Dockerfile」，`render.yaml` 保留作备选。

### 20.1 镜像：`Dockerfile` 两段构建

| 阶段 | 内容 | 为什么 |
| --- | --- | --- |
| builder | `node:22-slim` + `apt-get install python3 make g++` + 先 `COPY package*.json` 再 `npm ci --omit=dev` | `better-sqlite3` 是原生模块（node-gyp / C++）：平台没有对应 Node ABI 的预编译包时要本地编译，缺 python3 / make / g++ 会直接 build 失败。先拷依赖清单再装，改 HTML / JS 不会让这层缓存失效 |
| runtime | `node:22-slim` + `tzdata`，只拷 `node_modules` 与源码，`USER node`，`EXPOSE 8000`，`ENV NODE_ENV=production PORT=8000 TZ=Asia/Shanghai` | 镜像里不留编译器；非 root 运行；`tzdata` 是为了「今日门诊」「时段是否已过」「默认预约日期」这类按服务器本地时间算的逻辑（容器默认 UTC，国内凌晨会看到「昨天」） |

- `EXPOSE 8000` 与 `ENV PORT=8000` 对齐 Koyeb 的默认端口；Koyeb 另外会把 `PORT` 注入容器，
  代码本来就是 `Number(process.env.PORT || 3000)`，**这一行没改**。
- **`data/` 不在镜像里**：`Dockerfile` 只做 `mkdir -p /app/data && chown node:node /app/data`。
  容器启动时 `server/db.js` 自己建表、写种子，`.session-secret` 也生成在这个目录（跟库同目录）。
- 写了 `HEALTHCHECK`（node 自带的 `fetch` 打 `/api/health`），给本地 `docker run` 用；
  Koyeb 用自己的健康检查（HTTP `/api/health`）。

### 20.2 `.dockerignore` 排掉什么

| 排除 | 为什么 |
| --- | --- |
| `node_modules` | 必须在 linux 里重装：Windows 上装的 `better-sqlite3` / `@node-rs/bcrypt` 是 win32 二进制，进容器会报 `invalid ELF header` |
| `data`、`*.db`、`*.db-wal`、`*.db-shm` | 本机演示库 + `.session-secret`，绝不进镜像 |
| `.git`、`.github`、`.gitignore`、`.workbuddy` | 版本控制与本地日志 |
| `miniprogram`、`scripts` | 另一个客户端；本地回归脚本要本机浏览器（Edge / CDP），容器里跑不了 |
| `README.md`、`DEPLOY.md`、`render.yaml`、`Dockerfile`、`.dockerignore` | 文档与平台配置，运行时不读 |
| `.env`、`.env.*`、`*.log` | 密钥与日志 |

实测（按 `.dockerignore` 的语义把仓库文件过了一遍）：**必带 21 项全部保留**（9 个页面、`assets` 的关键文件、`server` 的 6 个模块、`package.json`、`package-lock.json`），**必排 10 项全部命中**（`node_modules` / `data` / `.git` / `.workbuddy` / `scripts` / `miniprogram` / 三份文档与蓝图）。
另外在干净目录跑过 `npm ci --omit=dev`：**123 个包，5 个依赖全部 `require` 成功**（`better-sqlite3` / `@node-rs/bcrypt` / `express` / `jsonwebtoken` / `express-session`）。

### 20.3 为云端改的五处（业务代码零改动）

| 文件 | 改动 | 为什么必须改 |
| --- | --- | --- |
| `server/db.js` | 库路径改成 `DB_PATH` → `DB_FILE` → `data/app.db` 三级，相对路径按仓库根解析 | 云端用 `DB_PATH` 指定位置（Koyeb 环境变量里显式设 `data/app.db`）；回归脚本继续用 `DB_FILE` 指临时库，两条互不干扰 |
| `server/db.js` | **空库自举**（原有逻辑，未新增第二份建表/播种代码） | 免费层没有持久盘、`data/` 又不进 git 与镜像，首次启动必须能自己建表 + 写种子。`CREATE ... IF NOT EXISTS` + 按邮箱/排班条数判重天然可重复执行 |
| `server/app.js` | 生产模式 `app.set('trust proxy', 1)` | 不设的话 `req.ip` 全是平台代理地址：按 IP 的限流会把所有访客算成一个人（60 次/分钟全站共享），`secure` cookie 的协议判断也不准。只信一跳，不写 `true`（否则客户端可自带 `X-Forwarded-For` 伪造 IP） |
| `server/app.js` | `.session-secret` 改为**跟随数据库目录**（默认仍是 `data/`） | 以后挂持久卷时，库和密钥在同一块盘上，不会出现「库持久、密钥在容器里」的半持久状态；容器里就是 `/app/data/.session-secret` |
| `miniprogram/config.js`（新增） | 小程序地址从 `request.js` 挪到独立配置，`request.js` 只 `require` 它 | 换环境（本地 / 真机 / 云端）只改一行，且 `test:mp` 仍能断言「地址只有一个来源」 |

另外两处是「确认无需改」而不是改：`PORT` 早就读 `process.env.PORT`（Koyeb 注入 8000）；`package.json` 的 `engines.node` 已从 `>=22` **收紧成 `22.x`**，因为 `better-sqlite3` 是原生模块，Node 大版本跳了可能没有对应预编译包。

### 20.4 云端与本地不一样的地方

| 维度 | 本地（`npm start`） | Koyeb 免费实例 |
| --- | --- | --- |
| 端口 | 3000 | 8000（服务里配 Port 8000，平台注入 `PORT`） |
| 运行方式 | 直接 `node` | Docker 容器，非 root（`USER node`），根文件系统只读语义下只有 `/app/data` 可写 |
| 数据库 | `data/app.db`，长期存在 | 容器内临时文件，**重启/重新部署/缩容唤醒后重建**，重新播种 |
| 会话密钥 | `data/.session-secret`，长期存在 | 每次冷启动新生成 → **已登录用户掉线，需重新登录（预期）** |
| 首次访问 | 立即响应 | 缩容到 0 后唤醒需**十几秒到一分钟** |
| 实例数 | 1 | 1（免费层），`express-session` 的 MemoryStore 够用 |
| HTTPS | 无 | 全站 HTTPS；`NODE_ENV=production` 下 cookie 带 `Secure` |

### 20.5 等价环境实测（模拟镜像内容，端口 8000）

开发机没装 Docker，所以「镜像里跑起来是什么样」是用等价方式验的：
按 `.dockerignore` 的规则把文件挑进一个干净目录（**没有 `data/`**）、装上干净依赖，再以容器同款环境变量启动：

```
PORT=8000 DB_PATH=data/app.db NODE_ENV=production TZ=Asia/Shanghai node server/app.js

  齿记工具助手演示站已启动  http://localhost:8000
  数据库：…\app\data\app.db          ← data/ 不存在也能自建（db.js 的 mkdirSync recursive）
  已创建种子账号：admin@demo.local, liu-implant@demo.local, liu-ortho@demo.local,
                  liu-general@demo.local, liu-kid@demo.local
  已生成种子排班：196 个时段（4 位医生 × 未来 14 天）

GET /api/health          → 200 {"ok":true,"db":"app.db","users":5}
GET /                    → 200       /services.html → 200    /login.html → 200
GET /payment.html        → 200       /api/public/doctors → 200（4 位）
GET /README.md           → 404       /Dockerfile → 404
GET /server/app.js       → 404       /data/app.db → 404
POST /api/login（带 X-Forwarded-Proto: https）
                         → 200 + token + Set-Cookie: lsd.sid=…; HttpOnly; Secure
```

真正的镜像构建由 Koyeb 执行（`docker build` 的日志怎么读见 `DEPLOY.md` §5）。

### 20.6 部署完的验收（三条，顺序别换）

1. `https://<服务名>-<组织>.koyeb.app/api/health` → `{"ok":true,"db":"app.db","users":5}`（`users: 5` 说明种子写进去了）
2. 首页 `/` 正常：电话、地址、今日门诊、8 项服务、4 位医师都在
3. `admin@demo.local` / `Demo@1234` 能登录并进 `dashboard.html`

顺手确认 `/README.md`、`/Dockerfile` 都是 **404**——静态白名单没有因为换环境失守。

### 20.7 边界

- **Docker 只用于云端构建，不进本地开发流程**：本地仍是 `npm install && npm start`；
  镜像只在 Koyeb 侧构建，`render.yaml`（原生 Node）保留作备选；
- **不接托管数据库**：SQLite 就地重建是这期的取舍，换 Postgres 属于架构改造；
- **不做多实例 / 不做持久卷（付费项）**：免费层单实例 + 每次播种，正好适合「老师看演示」；
- **不发布小程序**：云端只托管网站；小程序地址要在 `config.js` 里手动改成 HTTPS 才能连云端（`DEPLOY.md` §10）；
- **不碰业务逻辑**：本期只新增 `Dockerfile` / `.dockerignore` 与文档，代码侧仍是路径解析、代理信任、密钥位置、配置外置那四处——
  权限、状态机、计价、防双订一行没改，六套回归仍是 266 / 7 / 31 / 45 / 46 / 44。

---

## 21. 当前线上地址：WorkBuddy 应用托管（Koyeb / Render 转为备选）

> **一句话**：网站现在是 WorkBuddy 自带的应用托管跑起来的，**不买服务器、不绑卡、不备案**，
> 地址 `https://liu-dental.app.workbuddy.host/?sharecode=VN5PSCMXE4`。
> §20 的 Koyeb（Docker）与 `render.yaml` 全部保留，只是不再作为主路径。

### 21.1 为什么换

| 方案 | 卡在哪 |
| --- | --- |
| Render 免费层 | 创建服务要验证信用卡，国内卡不被接受 |
| Koyeb 免费实例 | 控制台与 GitHub 授权在国内网络下反复超时，且免费实例唤醒慢 |
| **WorkBuddy 应用托管** | 对话里一句「发布这个项目」即可，自动装依赖、起服务、给 HTTPS 链接；Node + Express + **SQLite 原生支持**（单端口 HTTP 服务即可，不需要外部数据库） |

### 21.2 发布目录为什么不是仓库根

`.workbuddy/deploy/web/` 是发布用的干净副本（9 个页面 + `assets` + `server` + `package.json` + `package-lock.json`，共 33 个文件）。

**不能直接发布仓库根**：根目录下的 `miniprogram/` 带 `project.config.json` / `app.json`，
平台会把整个目录判定为「小程序项目」并直接拒收。所以发布前把网页那部分挑出来：

```bash
rm -rf .workbuddy/deploy/web
mkdir -p .workbuddy/deploy/web
cp -R index.html login.html register.html doctors.html services.html \
      appointment.html contact.html dashboard.html payment.html \
      assets server package.json package-lock.json .workbuddy/deploy/web/
```

`data/` 故意不带：容器里首次启动由 `server/db.js` 建表 + 播种（5 个种子账号 + 196 个时段），
`.session-secret` 也在那里生成。

### 21.3 线上踩到的坑：网关会塞一条别人的 `Authorization`

平台的分享网关会给**每一个**请求加一条自己的凭证，并**覆盖**客户端带的那一条：

```
authorization: Bearer eyJhbGciOiJIUzI1NiIs...   ← iss=cloudstudio.net，不是本服务签的
x-forwarded-proto: https
```

我们原有规则是「请求里出现 `Authorization` 就只认 Bearer，验签失败即 401，绝不回落 cookie」——
这条规则本身是对的（防「过期 token + 有效 cookie 静默通过」），但它把网关的 token 当成了自己的，
结果是**线上所有登录态接口 401**：登录能成功、`/api/me` 立刻变 `null`，控制台与预约全废。

**排查证据**（不是猜的）：临时发布了一个 20 行的「头部探针」，回显收到的请求头；
匿名、带 `Basic abc`、带 `Bearer MYTOKEN` 三种情况，应用收到的都是同一条 `Bearer <平台 JWT>`。
探针已下线。

### 21.4 修复：先认签发方，再决定认不认

| 文件 | 改动 |
| --- | --- |
| `server/jwt.js` | 签发时带 `iss = 'liu-dental-demo'`；新增 `isForeignToken(token)`：能解出 payload 且 `iss` 明确是别人的 → `true` |
| `server/auth.js` | `readBearer()` 遇到外来 token 直接当作「没带 Bearer」，继续看 cookie |

边界没有放宽，反而更精确：

| 情况 | 结果 |
| --- | --- |
| 平台注入的第三方 Bearer（`iss=cloudstudio.net`）单独出现 | 当匿名 → `/api/me` 200 + `user:null` |
| 第三方 Bearer + 有效 cookie | 回落 cookie → 200（线上登录态恢复正常） |
| 自己的 token 被改过 payload / 换密钥 / 已过期 | **仍然 401**（`TOKEN_INVALID` / `TOKEN_EXPIRED`），不回落 |
| 结构不是 JWT 的垃圾串、缺 `Bearer` 前缀 | **仍然 401** |

第 22 组新增 2 条断言固化前两行（32 条），「好 cookie + 坏 Bearer 必须 401」那条一条没动。

### 21.5 线上实测（httpx/curl 真打，非本地）

| 项 | 结果 |
| --- | --- |
| 9 个页面 | 全部 `200` |
| `/api/health` | `{"ok":true,"db":"app.db","users":5}`（空库自举成功） |
| 匿名 `/api/me` | `200 {"user":null}` |
| 登录 → 带 cookie `/api/me` | `200`，`auth=cookie`（修复前是 `401 TOKEN_INVALID`） |
| 病人全链路 | 注册 201 → 登录 200 → 公开医师 200 → 查时段 200 → 下单 201 `pending` → 列表 200 → 取消 200 `cancelled` |
| 公开接口 | `/api/public/{clinic,doctors,services}` 均 `200` |
| 越权与泄露面 | 病人调医生接口 `403`；`/README.md`、`/server/app.js`、`/package.json` → `404`；`/Dockerfile`、`/data/app.db` → `403` |

### 21.6 这个托管的边界（必须知道）

- **链接必须带 `?sharecode=`**：少了参数网关直接返回 403「链接不完整」，所以分享时整条链接一起发；
- **SQLite 在沙箱里是容器本地文件**：重新发布或实例回收后数据回到种子状态（5 个账号 + 196 时段），
  演示够用，**不能当正式库**；要持久化只有两条路——接云数据库（要改 SQL 层）或换带持久卷的云托管；
- **不是小程序**：托管的是网页；小程序仍走微信开发者工具（本期不上传、不提审，见 §19.2）；
- **每次重新发布前先同步 `.workbuddy/deploy/web/`**，否则线上跑的还是旧代码；
- **这个域名不能当小程序的 `BASE_URL`**：网关会把每个请求的 `Authorization` 换成平台自己的令牌，而 `auth.js`
  只把「签发方是本服务」的 token 当真，外来令牌一律当「没带」。Web 端有 cookie 兜底所以登录正常；小程序没有
  cookie、只剩 Bearer，于是**带合法 token 也会被当成匿名**——实测 `Bearer <本服务 token>` 调 `/api/me`
  返回 `{"user":null}`，调 `/api/patient/appointments` 直接 401。小程序要连线上，必须换一个不改写
  `Authorization` 的服务端（云托管 / 自建），见 §19.4 的发布改动顺序。

### 21.7 回归（本轮）

`266 / 7 / 31 / 45 / 46 / 44 = 439 条断言 / 53 组`，`npm run test:all` 全绿——
代码改动只涉及 `jwt.js` 的 `iss` 与 `auth.js` 的 `readBearer`，第 1–21 组 222 条一条没改。

