# LocaleContract runtime image
# better-sqlite3 ships prebuilt binaries; the build toolchain below is a
# fallback so `npm install` can compile the native addon if no prebuild
# matches the runtime/platform or the prebuild host is unreachable.
FROM node:20-slim

WORKDIR /app

# Native build dependencies (can be pruned later; kept for image simplicity)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install dependencies first for better layer caching
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Application sources
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    LC_DATA_DIR=/data

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

# Lightweight healthcheck against the projects API
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/projects',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/server.js"]
