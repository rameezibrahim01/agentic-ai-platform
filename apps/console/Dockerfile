# Console image (ticket 011): Next.js standalone output, minimal runtime stage.
FROM node:22-bookworm-slim AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps/console ./apps/console

RUN pnpm install --frozen-lockfile --filter @platform/console...
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @platform/console build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0

COPY --from=builder /app/apps/console/.next/standalone ./
COPY --from=builder /app/apps/console/.next/static ./apps/console/.next/static

EXPOSE 3000
CMD ["node", "apps/console/server.js"]
