# One image, three roles: the web app, the ingest worker, and the one-shot
# migration step. They differ only by command, so building once and running it
# three ways keeps them from drifting apart — a worker built from a different
# commit than the app is a very confusing bug.
#
# node:24-slim rather than alpine: the Tailwind build pulls a native
# lightningcss binary, and the musl variants of those are a recurring source of
# build failures for no benefit here.
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------- deps
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Dev dependencies are kept: the worker and the migration step run TypeScript
# directly through tsx, so a production-only install would leave both unable
# to start.
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------- build
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# env.ts throws on a missing variable at import time, and `next build` imports
# it while collecting routes. These placeholders exist only to get the build
# past that check — every one is replaced at runtime by the env file, and none
# is read during the build itself.
ENV DATABASE_URL=postgres://build:build@127.0.0.1:5432/build \
    QDRANT_URL=http://127.0.0.1:6333 \
    QDRANT_COLLECTION=build \
    OLLAMA_URL=http://127.0.0.1:11434 \
    EMBED_MODEL=bge-large \
    EMBED_DIM=1024 \
    AUTH_SECRET=build-only-not-a-secret \
    NEXT_TELEMETRY_DISABLED=1

RUN pnpm build

# ---------------------------------------------------------------- runtime
FROM base AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts
# The worker and the migration/bootstrap scripts run from source via tsx.
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts

# .data holds uploaded books awaiting indexing and the cached Gutenberg
# catalog. It is a mounted volume in compose; created here so the image also
# runs standalone, and owned by node because the container drops root.
RUN mkdir -p /app/.data/uploads && chown -R node:node /app/.data
USER node

EXPOSE 3000
CMD ["pnpm", "start"]
