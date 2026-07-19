FROM node:22-bookworm-slim AS deps
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build
RUN pnpm prune --prod

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
RUN npm install -g @openai/codex@0.144.6

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
