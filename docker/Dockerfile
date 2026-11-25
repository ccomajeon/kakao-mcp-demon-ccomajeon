# Local test image: runs the account daemon in the foreground (no systemd).
# Build and start from the repository root:  docker compose -f docker/compose.yaml up -d --build
# Guide: docs/runbooks/docker.md
#
# Two stages: the build stage installs dev dependencies and compiles the protocol package; the runtime
# stage installs only production dependencies without running any package lifecycle script and copies
# the compiled protocol output. Both use the same base tag; to pin a digest, replace the tag with
# `node:22-bookworm-slim@sha256:<digest>` from `docker buildx imagetools inspect node:22-bookworm-slim`.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm ci --no-audit --no-fund --ignore-scripts \
 && npm run build --workspace=@kakao-mcp/protocol

FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
# The apps run their TypeScript sources with Node's type stripping; tests are not shipped.
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts \
 && npm cache clean --force \
 && find apps packages -name '*.test.ts' -delete
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
RUN find packages/protocol/dist -name '*.test.*' -delete

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
