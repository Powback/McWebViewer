# Build the static bundle, then serve it with nginx.
#
# The app has no server component — nginx only serves the bundle plus, optionally, a
# read-only view of a world directory so `?auto=1` works without drag-and-drop.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
# public/ holds the entity geometry extracted by harness/ (entity-index.json,
# entity-models.json). Vite copies it into dist verbatim; without it the mob path
# 404s at runtime and every entity silently draws nothing.
COPY public ./public
# vite.config.ts imports node:fs for the dev-only mount; it is not part of the bundle.
RUN npx vite build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/entrypoint.sh /docker-entrypoint.d/40-mcwv-manifest.sh
RUN chmod +x /docker-entrypoint.d/40-mcwv-manifest.sh
EXPOSE 80
