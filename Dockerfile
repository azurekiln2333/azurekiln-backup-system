FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY shared ./shared
COPY web ./web
RUN npm run build

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates rclone 7zip tar sqlite3 postgresql-client mariadb-client tzdata \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY shared ./shared
COPY server ./server
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p /data /sources /system-config
ENV NODE_ENV=production BACKUP_HOST=0.0.0.0 BACKUP_PORT=16323 DATA_DIR=/data SOURCE_ROOTS=/sources
USER root
EXPOSE 16323
CMD ["node", "server/app.mjs"]
