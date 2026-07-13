# ---- Build stage ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
# VITE_* are baked at build; runtime override handled by entrypoint below.
RUN npm run build --workspace @policymanager/web

# ---- Production stage (nginx) ----
FROM nginx:alpine AS prod
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/docker-entrypoint.sh /docker-entrypoint.d/40-policymanager-env.sh
RUN chmod +x /docker-entrypoint.d/40-policymanager-env.sh
EXPOSE 80
# nginx:alpine's own entrypoint runs /docker-entrypoint.d/*.sh then starts nginx.
