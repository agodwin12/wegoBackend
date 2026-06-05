# ── Stage 1: deps ────────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ── Stage 2: runner ──────────────────────────────────────────────────
FROM node:20-alpine AS runner

RUN addgroup -S wego && adduser -S wego -G wego

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN mkdir -p uploads && chown -R wego:wego /app

USER wego

EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:10000/health || exit 1

CMD ["node", "index.js"]