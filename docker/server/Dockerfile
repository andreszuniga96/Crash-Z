# ── ZombieRun Server — Production Dockerfile ─────────────────────────────────
# Multi-stage build: builder compiles TypeScript; runner is a minimal image.

# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy root workspace manifest + lock file
COPY package.json package-lock.json ./

# Copy server package manifest (for workspace-aware install)
COPY packages/server/package.json ./packages/server/

# Install ALL workspace deps (including devDependencies for tsc)
RUN npm ci --workspace=packages/server

# Copy server source
COPY packages/server ./packages/server

# Compile TypeScript → dist/
RUN npm run build --workspace=packages/server

# Prune devDependencies (keeps only production modules)
RUN npm prune --production --workspace=packages/server

# ── Stage 2: Production Runner ────────────────────────────────────────────────
FROM node:20-alpine AS runner

# Security: run as non-root user
RUN addgroup -g 1001 -S zombierun \
 && adduser  -S zombierun -u 1001 -G zombierun

WORKDIR /app

# Copy compiled output from builder
COPY --from=builder --chown=zombierun:zombierun /app/packages/server/dist      ./dist
COPY --from=builder --chown=zombierun:zombierun /app/node_modules              ./node_modules
COPY --from=builder --chown=zombierun:zombierun /app/packages/server/package.json ./package.json

# wget is needed for the healthcheck
RUN apk add --no-cache wget

USER zombierun

EXPOSE 3001

# Node handles SIGTERM for graceful shutdown
CMD ["node", "dist/index.js"]
