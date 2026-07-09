# Worker image (ticket 011). Runs TypeScript directly via tsx — acceptable for
# the Phase 1 artifact; compiled-image hardening belongs to Phase 4 packaging.
FROM node:22-bookworm-slim
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker

RUN pnpm install --frozen-lockfile --filter @platform/worker...

WORKDIR /app/apps/worker
CMD ["./node_modules/.bin/tsx", "src/worker.ts"]
