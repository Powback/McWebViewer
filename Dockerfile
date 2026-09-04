# Build the static bundle, then serve it with nginx.
#
# The app has no server component — nginx only serves the bundle plus, optionally, a
# read-only view of a world directory so `?auto=1` works without drag-and-drop.
#
# Three targets share one dependency layer:
#   build    the Vite bundle (intermediate)
#   baker    `bake-assets --watch`: keeps .cache/baked in step with a LIVE world
#   (last)   nginx serving the bundle — what a plain `docker build` produces
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
# public/ holds the entity geometry extracted by harness/ (entity-index.json,
# entity-models.json). Vite copies it into dist verbatim; without it the mob path
# 404s at runtime and every entity silently draws nothing. The bake reads it too, for
# the mob sprites.
COPY public ./public

FROM deps AS build
# vite.config.ts imports node:fs for the dev-only mount; it is not part of the bundle.
RUN npx vite build

# The baker: the same sources run as a tool under tsx, not built into a page. The paths
# are the compose mounts; MCWV_REGIONS and MCWV_BAKE_MS come from compose. Shell form so
# the variable expands; compose's `init: true` forwards the stop signal through the shell.
FROM deps AS baker
ENV MCWV_REGIONS=r.-1.0.mca MCWV_BAKE_MS=30000
CMD npx tsx src/tools/bake-assets.ts --world /data/world --mods /data/mods \
    --client /data/client --out /data/client/baked --watch "$MCWV_BAKE_MS"

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/entrypoint.sh /docker-entrypoint.d/40-mcwv-manifest.sh
RUN chmod +x /docker-entrypoint.d/40-mcwv-manifest.sh
EXPOSE 80
