# ---- Build stage ----
FROM node:20-alpine AS build
WORKDIR /app
# Copy manifests first for cached installs
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN npm ci
# Source
COPY prisma ./prisma
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
RUN npx prisma generate
RUN npm run build --workspace @policymanager/api

# ---- Production stage ----
FROM node:20-alpine AS prod
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN npm ci --omit=dev && npm cache clean --force
# Prisma client (generated) + schema/migrations for deploy-time migrate
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY apps/api/docker-entrypoint.sh ./apps/api/docker-entrypoint.sh
RUN chmod +x ./apps/api/docker-entrypoint.sh
EXPOSE 3000
# Entrypoint runs prisma migrate deploy then starts the API
ENTRYPOINT ["./apps/api/docker-entrypoint.sh"]
