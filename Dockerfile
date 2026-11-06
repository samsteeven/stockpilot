# syntax=docker/dockerfile:1.7
# Images de StockPilot, construites dans la CI (jamais sur un poste) :
#   --target runtime : l'API et le worker (même image, commande différente), dépendances de production seulement ;
#   --target migrate : migrations et rôles PostgreSQL, lancée une fois par déploiement avant les services.
# Image de base épinglée par empreinte : une étiquette peut être déplacée, une empreinte non.
ARG NODE_IMAGE=node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4

FROM ${NODE_IMAGE} AS build
WORKDIR /src
ENV CYPRESS_INSTALL_BINARY=0 NX_NO_CLOUD=true NX_DAEMON=false
COPY . .
RUN npm ci --no-audit --no-fund && npx nx run-many -t build -p api worker

# Migrations : outillage complet (Prisma CLI), lancé avec le rôle propriétaire des tables.
FROM build AS migrate
USER node
CMD ["sh", "-c", "node scripts/preparer-base.mjs && npx prisma migrate deploy"]

# Dépendances de production : sans scripts d'installation (le client Prisma est déjà intégré au bundle), puis
# sans l'outillage que npm y range comme pairs (CLI et Studio de Prisma, TypeScript, React) : 370 Mo → 186 Mo.
FROM build AS deps
RUN rm -rf node_modules \
  && npm ci --omit=dev --ignore-scripts --workspaces=false --no-audit --no-fund \
  && rm -rf node_modules/prisma node_modules/@prisma/studio-core node_modules/@prisma/dev \
    node_modules/@prisma/fetch-engine node_modules/@prisma/engines node_modules/typescript node_modules/effect \
    node_modules/@electric-sql node_modules/react node_modules/react-dom node_modules/@radix-ui node_modules/.bin

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps --chown=node:node /src/node_modules ./node_modules
COPY --from=build --chown=node:node /src/apps/api/dist/main.js ./api/main.js
COPY --from=build --chown=node:node /src/apps/worker/dist/main.js ./worker/main.js
# Utilisateur sans privilèges ; le système de fichiers peut être monté en lecture seule.
USER node
EXPOSE 3000 9464 9465
CMD ["node", "api/main.js"]
