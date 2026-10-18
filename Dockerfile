# syntax=docker/dockerfile:1
# Single image for the provider and the agent (different command in compose.yml).
# No secret in the image: everything comes from the environment at runtime.

FROM node:20-bookworm-slim AS deps
WORKDIR /app
# Build tools, in this stage only: no prebuilt better-sqlite3 binary was
# found for this Node version, so node-gyp compiles it.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# Full dependencies: the TypeScript code is run by tsx (a devDependency),
# as with `npm start`.
RUN npm ci

FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY server ./server
COPY agent ./agent
COPY ledger ./ledger
COPY observability ./observability
# Runtime data (ledger, replay store): a volume, owned by the non-root user.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8787
CMD ["node", "--import", "tsx", "server/index.ts"]
