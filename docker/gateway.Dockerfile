# Build from the repository root:
#   docker build -f docker/gateway.Dockerfile -t zsoft/open-rocket-chat-gateway .
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------------------
# Dependencies — cached independently of source so a code edit does not force
# a full reinstall.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/gateway/package.json apps/gateway/
COPY packages/api-contract/package.json packages/api-contract/
COPY packages/rc-rest-client/package.json packages/rc-rest-client/
COPY packages/rc-realtime-client/package.json packages/rc-realtime-client/
COPY packages/rc-adapter/package.json packages/rc-adapter/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm run build

# ---------------------------------------------------------------------------
# Runtime — production dependencies plus compiled output only.
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production

COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/.npmrc ./
COPY --from=build /app/apps/gateway/package.json apps/gateway/
COPY --from=build /app/packages/api-contract/package.json packages/api-contract/
COPY --from=build /app/packages/rc-rest-client/package.json packages/rc-rest-client/
COPY --from=build /app/packages/rc-realtime-client/package.json packages/rc-realtime-client/
COPY --from=build /app/packages/rc-adapter/package.json packages/rc-adapter/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod

COPY --from=build /app/apps/gateway/dist apps/gateway/dist
COPY --from=build /app/packages/api-contract/dist packages/api-contract/dist
COPY --from=build /app/packages/rc-rest-client/dist packages/rc-rest-client/dist
COPY --from=build /app/packages/rc-realtime-client/dist packages/rc-realtime-client/dist
COPY --from=build /app/packages/rc-adapter/dist packages/rc-adapter/dist

# The stock `node` user, so the process never runs as root.
USER node
EXPOSE 4000

# Liveness only — readiness against Rocket.Chat is `/api/v1/health/upstream`,
# which must not be wired to a restart policy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/v1/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "apps/gateway/dist/main.js"]
