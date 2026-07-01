# ── Stage 1: deps ────────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Build deps for native modules (bcrypt, sharp) on alpine
RUN apk add --no-cache python3 make g++ vips-dev

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ── Stage 2: runner ──────────────────────────────────────────────────
FROM node:20-alpine AS runner

# Runtime libs for sharp (libvips) + wget for healthcheck (busybox provides wget)
RUN apk add --no-cache vips

RUN addgroup -S wego && adduser -S wego -G wego

WORKDIR /app

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# uploads/ is mounted as a volume in production (or replaced by R2);
# create it so the app can boot even without the volume.
RUN mkdir -p uploads logs && chown -R wego:wego /app

USER wego

# Must match the PORT env (compose sets PORT=10000)
EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-10000}/health || exit 1

# Real entrypoint is server.js in the project root (there is no index.js)
CMD ["node", "server.js"]
