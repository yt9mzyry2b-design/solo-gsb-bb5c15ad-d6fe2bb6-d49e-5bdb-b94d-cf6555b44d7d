# ---- 构建阶段：在完整镜像中编译 better-sqlite3 原生模块 ----
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# better-sqlite3 无预编译包时需要 python3 + 编译工具链
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci || npm install

# ---- 运行阶段 ----
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

# 复制依赖（含已编译的原生 .node）与源码
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public

# SQLite 数据库持久化目录
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

# 简易健康检查：静态首页可访问即视为健康
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
