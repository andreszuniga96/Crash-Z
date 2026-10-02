# ── ZombieRun Client — Production Dockerfile ─────────────────────────────────
# Builds the Vite app and serves it with Nginx.

# ── Stage 1: Build Vite App ───────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/client/package.json ./packages/client/

RUN npm ci --workspace=packages/client

COPY packages/client ./packages/client

RUN npm run build --workspace=packages/client

# ── Stage 2: Nginx Static Server ─────────────────────────────────────────────
FROM nginx:1.25-alpine AS runner

# Copy build output
COPY --from=builder /app/packages/client/dist /usr/share/nginx/html

# SPA routing: all non-asset paths → index.html
COPY docker/client/nginx-spa.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
