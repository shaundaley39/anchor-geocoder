# syntax=docker/dockerfile:1
#
# Two stages, three targets.
#
#   builder  compiles the TypeScript and resolves production dependencies
#   runtime  slim image, ~expects the index mounted at /index  (default)
#   bundled  runtime + the 254 MB index baked in, self-contained
#
# The index is deliberately NOT built inside Docker. Building it needs 2.8 GB of
# OSM extracts and ~6 minutes of CPU, which does not belong in an image build:
# it is a data pipeline with its own cadence, and the artifact it produces is
# immutable and shared by every replica. Build it once on the host or in CI
# (`make index`), then either mount it or bake it in.

# ---------------------------------------------------------------- builder ----
FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.28.1 --activate

# Dependency layer, cached until the manifests change.
COPY server/package.json server/pnpm-lock.yaml server/.npmrc ./
RUN pnpm install --frozen-lockfile

COPY server/tsconfig.json ./
COPY server/src ./src
RUN pnpm exec tsc -p tsconfig.json

# A clean production-only tree so devDependencies never reach the runtime image.
# The node_modules directory must be removed first: `pnpm install --prod` fixes
# up the top-level symlinks but leaves the packages themselves in the virtual
# store, which kept 74 MB of TypeScript, esbuild, vite and rollup in the image.
RUN rm -rf node_modules && pnpm install --frozen-lockfile --prod --ignore-scripts

# ---------------------------------------------------------------- runtime ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    INDEX_DIR=/index \
    HOST=0.0.0.0 \
    PORT=3000

# Run unprivileged. The node image already ships a `node` user.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/package.json ./

USER node
EXPOSE 3000

# The k-d tree build makes boot a second or two; give it room before probing.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]

# ---------------------------------------------------------------- bundled ----
# Self-contained: no volume, no external dependency at run time. Requires
# `make index` to have run on the host first.
FROM runtime AS bundled
COPY --chown=node:node build/index /index
