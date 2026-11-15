# 可选：容器化运行。本机自用/分享走 `npm run serve:share` 即可，不需要 Docker。
# 构建：docker build -t study-review .
# 运行：docker run -p 3000:3000 -v $PWD/data:/app/data -e APP_PASSWORD=xxx study-review

FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# standalone 输出只在显式开启时生效，否则本机 next start 会失效
ENV NEXT_OUTPUT=standalone
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000
CMD ["node", "server.js"]
