# Local test image: runs the account daemon in the foreground (no systemd).
# Build and start from the repository root:  docker compose -f docker/compose.yaml up -d --build
# Guide: docs/runbooks/docker.md
FROM node:22-bookworm-slim

WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund \
 && npm run build --workspace=@kakao-mcp/protocol \
 && npm cache clean --force

COPY docker/bin/ /usr/local/bin/
RUN chmod 0755 /usr/local/bin/kakao* \
 && mkdir -p /data \
 && chown node:node /data \
 && chmod 0700 /data

USER node
# Account settings live in /data/.env.local and the message store in /data/store (one volume).
ENV HOME=/data/home \
    KAKAO_DATA_DIR=/data/store \
    KAKAO_MCP_LISTEN=127.0.0.1:8787
WORKDIR /data
VOLUME ["/data"]

ENTRYPOINT ["kakao-entrypoint"]
