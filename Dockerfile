# ═══════════════════════════════════════════════════════════════════════
# WeGo Backend — Dockerfile
# Node.js / Express / Socket.IO / Sequelize / Redis
# ═══════════════════════════════════════════════════════════════════════

# ── Stage 1: deps ────────────────────────────────────────────────────
# Install production dependencies only in a clean layer so the final
# image doesn't carry dev tools (nodemon, eslint, etc.).
FROM node:20-alpine AS deps

WORKDIR /app

# Copy only the package manifests first so Docker can cache this layer.
# The layer is invalidated only when package.json or package-lock.json changes.
COPY package.json package-lock.json* ./

RUN npm ci --omit=dev

# ── Stage 2: runner ──────────────────────────────────────────────────
FROM node:20-alpine AS runner

# Security: run as a non-root user
RUN addgroup -S wego && adduser -S wego -G wego

WORKDIR /app

# Copy installed production modules from the deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY . .

# Create the uploads directory the app writes to locally
RUN mkdir -p uploads && chown -R wego:wego /app

USER wego

# ── Port ─────────────────────────────────────────────────────────────
EXPOSE 8000

# ── Health check ─────────────────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:8000/health || exit 1

# ── Entrypoint ───────────────────────────────────────────────────────
CMD ["node", "src/server.js"]