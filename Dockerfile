# 零运行时依赖：仅需 Node（内置 http/fs）。
FROM node:20-alpine

WORKDIR /app

# 先拷贝清单（若将来引入依赖可在此利用层缓存），再拷贝全部源码
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test

# 构建期产出 dist/；失败则镜像构建失败
RUN node scripts/build.mjs

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    STATIC_DIR=dist

EXPOSE 8080

# alpine 无 curl/wget，使用 Node 内置 fetch 做容器内健康检查
HEALTHCHECK --interval=10s --timeout=3s --retries=5 --start-period=3s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "scripts/serve.mjs"]
