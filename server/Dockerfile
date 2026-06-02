# =============================================================================
# Korean Master API server (TypeScript / Express / Postgres) — multi-stage build
# =============================================================================
# The source is TypeScript (src/index.ts). The previous single-stage image
# never compiled it and ran `node src/index.js`, a file that does not exist —
# so the container exited immediately and crash-looped at deploy. Here we
# compile in a build stage and ship only the compiled JS + production deps.
#
# Stage 1 (build): install ALL deps (TypeScript is a devDependency) and run
#   `npm run build` -> dist/index.js (tsconfig.build.json, rootDir=src).
# Stage 2 (runtime): install production deps only and copy the compiled dist.
#   No TypeScript sources, dev deps, or tests reach the runtime image.
# =============================================================================

# ----- build -----------------------------------------------------------------
FROM node:20-alpine AS build

WORKDIR /app

# Copy manifests first so the npm layer caches across source-only changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ----- runtime ---------------------------------------------------------------
FROM node:20-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only (drops typescript, eslint, vitest, @types, …).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled application (dist/index.js + the rest of the compiled tree).
COPY --from=build /app/dist ./dist

EXPOSE 4000

CMD ["node", "dist/index.js"]
