# API image. Runs anywhere that runs a container: Render, Railway, Fly, ECS.
#
# The API needs a persistent process — its risk loop is what keeps collateral
# valuations current, and card authorization fails closed without a fresh
# snapshot — so this is a long-running server, not a function.

# --- build ------------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# Manifests first: the dependency layer is then only rebuilt when they change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/adapters/package.json packages/adapters/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/simulator/package.json apps/simulator/

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json tsconfig.build.json ./
COPY packages/ packages/
COPY apps/api/ apps/api/

RUN pnpm exec tsc -b tsconfig.build.json

# Drop devDependencies from the tree that ships. The runtime needs no
# TypeScript loader: migrations compile to dist alongside the server.
# CI=true keeps pnpm from prompting, which would hang a non-interactive build.
RUN CI=true pnpm prune --prod

# --- run --------------------------------------------------------------------
FROM node:22-slim AS run
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules node_modules/
COPY --from=build /app/package.json ./
COPY --from=build /app/packages packages/
COPY --from=build /app/apps/api apps/api/
COPY db/ db/

# Never run as root.
RUN useradd --system --uid 10001 wealth && chown -R wealth:wealth /app
USER wealth

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The server migrates on boot, so a redeploy and a schema change are one step.
CMD ["node", "apps/api/dist/main.js"]
