# ---- Build stage ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
# @policymanager/shared resolves via its "types"/"main" fields to dist/, which
# is gitignored and only produced by this workspace's own build — every file
# under apps/web that imports it needs this to exist first.
RUN npm run build --workspace @policymanager/shared
# VITE_API_BASE_URL is baked into the built JS at compile time (Vite inlines
# import.meta.env.* as literals). Baking in a sentinel instead of a real URL
# lets one image serve any environment: the container entrypoint below
# rewrites this exact string to the runtime API_BASE_URL on startup.
ARG VITE_API_BASE_URL=__API_BASE_URL__
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build --workspace @policymanager/web

# ---- Production stage (nginx) ----
FROM nginx:alpine AS prod
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/docker-entrypoint.sh /docker-entrypoint.d/40-policymanager-env.sh
RUN chmod +x /docker-entrypoint.d/40-policymanager-env.sh
EXPOSE 80
# nginx:alpine's own entrypoint runs /docker-entrypoint.d/*.sh then starts nginx.
