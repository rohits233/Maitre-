# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM public.ecr.aws/docker/library/node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Stage 2: Run ──────────────────────────────────────────────────────────────
FROM public.ecr.aws/docker/library/node:20-alpine AS runner

WORKDIR /app

# Install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 8080

STOPSIGNAL SIGTERM

CMD ["node", "dist/index.js"]
