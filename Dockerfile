# =========================================================
# 刘氏口腔演示站 · 容器镜像（Koyeb 免费实例用）
# ---------------------------------------------------------
# 两段构建，为了「能编译原生模块」但「镜像里不留编译器」：
#   builder  —— 装 python3 / make / g++，npm ci 编译 better-sqlite3
#   runtime  —— 只带走 node_modules 与源码
#
# 本地开发**不需要** Docker：npm install && npm start 照旧。
# 这个文件只在部署时被 Koyeb 使用（Builder 选 Dockerfile）。
# =========================================================

# ---------- ① 构建阶段：装依赖（含原生模块编译） ----------
FROM node:22-slim AS builder

# better-sqlite3 是原生模块（node-gyp + C++）：
# 平台没有对应 Node ABI 的预编译包时会在本地从源码编译，
# 需要 python3 + make + g++，缺一个就报 "gyp ERR! find Python"。
# 先装工具链、再 npm ci，顺序不能反。
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

# 只拷依赖清单：以后改 HTML / JS 不会让这一层缓存失效，构建更快
COPY package.json package-lock.json ./

# npm ci 严格按 package-lock.json 安装（版本可复现，不像 npm install 会浮动解析）
# --omit=dev：不装 devDependencies（本项目目前没有，写出来是防止以后加了混进镜像）
RUN npm ci --omit=dev

# ---------- ② 运行阶段：只带运行时需要的东西 ----------
FROM node:22-slim AS runtime

# tzdata：容器默认 UTC，而本站的「今日门诊」「时段是否已过」「默认预约日期」
# 都按服务器本地时间算。不装这个包，下面 ENV TZ 不生效（/usr/share/zoneinfo 不存在），
# 国内用户在北京时间 0:00–8:00 访问会看到「昨天」。
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tzdata \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8000 \
    TZ=Asia/Shanghai

WORKDIR /app

# 已编译好的依赖从构建阶段搬过来，不重新下载、不重新编译
COPY --from=builder --chown=node:node /app/node_modules ./node_modules

# 源码 + 9 个静态页 + assets
# .dockerignore 已排除 node_modules / data / .git / .workbuddy / miniprogram / scripts
COPY --chown=node:node . .

# 数据库目录：镜像里**不存** data/（.dockerignore 排除了，避免把本机演示库和
# .session-secret 打进镜像）。容器首次启动时 server/db.js 会自己建表 + 写种子，
# 所以这里先把目录建好、把属主给 node，否则非 root 用户 mkdir 会 EACCES。
RUN mkdir -p /app/data && chown node:node /app/data

# 不用 root 跑应用：容器被拿到 shell 也只能写 /app/data
USER node

# Koyeb 默认端口 8000（服务里也要把 Port 设成 8000）
EXPOSE 8000

# Koyeb 用自己的健康检查（HTTP /api/health），这条是给本地 docker run 用的
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/app.js"]
