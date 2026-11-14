# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY client/package.json ./client/
RUN pnpm install --frozen-lockfile
COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY client ./client
RUN pnpm build
# 런타임에 필요한 서버 의존성만 별도 디렉터리로 추출한다(클라이언트 의존성 제외).
RUN pnpm deploy --filter onemoments --prod --legacy /prod

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# 서버 런타임 의존성만 복사한다(pnpm 불필요).
COPY --from=build /prod/package.json ./package.json
COPY --from=build /prod/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/client/dist ./client/dist
COPY drizzle ./drizzle
COPY scripts ./scripts
EXPOSE 8080
USER node
CMD ["node", "scripts/start.mjs"]
