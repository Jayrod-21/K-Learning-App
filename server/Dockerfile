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
# node:22-alpine (current LTS): Node 20 reached EOL 2026-04-30, and uuid@14
# (ESM-only, no `engines` field) needs Node >= 20.19 for require(esm) — an
# under-versioned base fails only at runtime (ERR_REQUIRE_ESM crash-loop), not
# at build. Pinning the major keeps base-tag drift from silently moving the
# runtime below that floor. Both stages MUST use the same base.
FROM node:22-alpine AS build

WORKDIR /app

# Copy manifests first so the npm layer caches across source-only changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ----- runtime ---------------------------------------------------------------
# Same base as the build stage — see the note above the build FROM.
FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

# poppler-utils (pdftoppm + pdfinfo) — U1a book-upload rework:
# routes/uploads.ts's PDF upload path shells out to `pdftoppm`
# (services/pdfPageRender.ts) to rasterize an uploaded PDF's pages into page
# images, and to `pdfinfo` (same package) to read the PDF's page count for the
# page-count-bomb guard before rendering. (The ZIP-of-images/vFlat path needs
# no external tool — pure-JS `yauzl`.) Same dependency the corpus ingest
# tooling already leans on for PDF handling (see Deploy/loader.Dockerfile's
# header comment), just needed here at RUNTIME instead of at a one-off
# loader-image build time.
#
# ffmpeg — F-210 v2 multi-voice story audio: services/audioConcat.ts shells
# out to `ffmpeg` (concat-demuxer stream-copy join of the per-turn TTS mp3s)
# and `ffprobe` (exact per-turn durations for the cumulative segment
# timeline). The single Alpine `ffmpeg` package installs BOTH binaries on
# PATH (/usr/bin/ffmpeg, /usr/bin/ffprobe — verified on node:22-alpine).
RUN apk add --no-cache poppler-utils ffmpeg

# Production dependencies only (drops typescript, eslint, vitest, @types, …).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled application (dist/index.js + the rest of the compiled tree).
COPY --from=build /app/dist ./dist

EXPOSE 4000

CMD ["node", "dist/index.js"]
