# syntax=docker/dockerfile:1
# Image unique pour le provider et l'agent (commande différente dans compose.yml).
# Aucun secret dans l'image : tout vient de l'environnement à l'exécution.

FROM node:20-bookworm-slim AS deps
WORKDIR /app
# Outils de compilation, uniquement dans cet étage : pas de binaire précompilé
# de better-sqlite3 pour cette version de Node, node-gyp compile.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# Dépendances complètes : le code TypeScript est exécuté par tsx (devDependency),
# comme en `npm start`.
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
# Données d'exécution (ledger, anti-rejeu) : volume, propriété de l'utilisateur non-root.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8787
CMD ["node", "--import", "tsx", "server/index.ts"]
