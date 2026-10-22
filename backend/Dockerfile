FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile
COPY src ./src
COPY db ./db
RUN pnpm build

FROM base AS production-dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --gid 10001 ies && useradd --uid 10001 --gid ies --create-home ies
COPY --from=production-dependencies --chown=ies:ies /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=ies:ies /app/package.json ./package.json
COPY --from=build --chown=ies:ies /app/dist ./dist
COPY --from=build --chown=ies:ies /app/db ./db
USER ies

FROM runtime AS api
EXPOSE 8080
CMD ["node", "dist/services/api/server.js"]

FROM runtime AS processor
EXPOSE 8081
CMD ["node", "dist/services/processor/server.js"]
