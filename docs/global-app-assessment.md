# WeGo — Global App Assessment & Scale Verdict

Whole-system review across backend (Node/Express/Sequelize/MySQL/Redis/Socket.IO),
mobile (Flutter, passenger + driver + delivery-agent in one app), and backoffice
(Next.js 14). Based on a deep code audit + empirical tests run against the real
localhost DB/Redis.

---

## 1. Empirical health (measured, not claimed)

| Surface | Result |
|---|---|
| Backend unit/integration tests | **19/19 pass** (~0.5s) |
| Backend boot | **clean** |
| Backend migrations | 10, all idempotent, applied |
| Mobile `dart analyze` | **0 errors, 0 warnings**, ~1,489 info-level lints (cosmetic) |
| Load test — service listings @ 130k rows | ranked browse + FULLTEXT search **10–15 ms**, index-served |
| Load test — deliveries @ 128k rows | active-check / history / admin list **10–15 ms**, index-served |
| Settlement correctness | ride commission-reduction + delivery bonus idempotency **verified** |

---

## 2. Subsystem ratings

| Subsystem | Score | Notes |
|---|:---:|---|
| **Architecture & scalability** | 9/10 | Stateless API, Redis socket-adapter, Redis-geo matching, shared R2 storage, single-runner crons. Horizontal-ready — the hard part is done right. |
| **Ride-hailing** | 8.5/10 | Central state machine, Redis matching, commission-only P2P settlement, trip-resume, coupons (new). |
| **Delivery** | 8.5/10 | State machine, Redis matching, express/regular tracking, PIN hand-off, coupons + agent bonus (new). |
| **Payments & wallets** | 8/10 | Deposit-only model, append-only ledger, idempotency via unique constraints. CamPay still on sandbox creds. |
| **Auth** | 8.5/10 | JWT access/refresh, Google OAuth, rate-limited, bcrypt (login optimized 513→193 ms). |
| **Vehicle rental** | 8/10 | Indexed + paginated for 50k+, MoMo/OM via CamPay. |
| **Services marketplace** | 7.5/10 | Solid after this pass — moderation flow was **broken** (fixed), priority + 5M-scale indexes added. |
| **Backoffice** | 8/10 | Broad CRUD: moderation, pricing zones, surge (peak hours), coupons, wallets, analytics, tracing. |
| **Notifications** | 7/10 | FCM + socket + inbox. Inbox persistence was **fully broken** app-wide (fixed this pass). |
| **Data layer (MySQL)** | 5.5/10 | **The ceiling.** Single primary, pool 10/instance, no read replicas/partitioning. Recurring `sync({alter})` duplicate-index bomb (now disabled). |
| **Automated testing / QA** | 3/10 | Only 3 backend test files. Biggest risk for a money app. |
| **Security posture** | 7/10 | helmet, locked CORS, global + auth rate limiting, bcrypt, PIN. But secrets were committed to history → must rotate. |
| **Observability** | 3/10 | Rich console logging, but no APM / metrics / tracing / alerting. |

**Weighted overall: ~7.5/10** — a well-architected, feature-complete super-app with
excellent scaling *bones*, held back by thin test coverage, a single-DB ceiling,
and no observability.

---

## 3. Strengths (top 7)

1. **It's genuinely horizontally scalable.** Stateless JWT API + `@socket.io/redis-adapter` + Redis-geo matching + R2 shared storage. Most apps fail here; WeGo got it right — you can run N API instances behind a load balancer today.
2. **Matching is MySQL-free.** Driver matching for rides *and* delivery runs on Redis geo, so the highest-frequency operation never touches the database.
3. **Sound money model.** Deposit-only wallets, append-only transaction ledger, idempotency enforced by DB unique constraints (trip receipts, bonus awards), commission-only P2P settlement, platform-funded coupons that never let WeGo pay a driver.
4. **Central state machines** for rides and deliveries make the lifecycle robust and resumable (recover an active trip after the phone dies).
5. **Real-time done properly** — Socket.IO for live updates + FCM for push, with reconnect handling.
6. **Comprehensive backoffice** — moderation, pricing/surge config, coupons, wallet oversight, analytics, and a payment audit trail.
7. **Security baseline is present** — not an afterthought (helmet, CORS allowlist, brute-force limits on auth, hashed PINs).

## 4. Weaknesses (top 7, honest)

1. **Automated testing is thin (3 files).** For an app that moves money, correctness currently leans on manual testing. This is the #1 gap.
2. **Silently-broken paths keep surfacing.** This session alone I found and fixed: services moderation (every new post was invisible), the notification inbox (never persisted — app-wide), ride promo validation (always failed), and a coupon `isValid()` quirk. Untested code hides bugs — expect more until coverage improves.
3. **Single MySQL primary is the hard ceiling.** No read replicas, no partitioning, pool of 10/instance. Everything else scales horizontally; the DB doesn't (yet).
4. **Migration discipline was weak.** The `sync({alter:true})` duplicate-index bomb hit 4+ tables (accounts, vehicles, service_listings, deliveries). Root cause disabled, but it signals schema drift risk.
5. **Duplicate / dead code.** Two moderation controllers, a dead `requestTrip`, a stub `promotionsController`. Maintenance hazard and a source of the "which path is live?" bugs above.
6. **Payments are pre-production.** CamPay on demo/sandbox credentials; committed secrets need rotation before go-live.
7. **No observability.** No metrics/APM/tracing means you'll be debugging production blind. Console logs don't scale.

---

## 5. Can it scale? — Verdict

**Yes — architecturally it scales. The bottleneck is the data tier, not the app.**

The API and websocket tiers are stateless and Redis-backed, so they scale out
linearly. The scale question reduces almost entirely to **MySQL**.

### What you can serve *as-is* (single primary + 2–4 API replicas + managed Redis)

| Metric | Realistic capacity |
|---|---|
| **Registered users** | **200k – 500k** comfortably (big-table queries are indexed; proven fast at 130k rows) |
| **Concurrent active users** (live sockets: online drivers + active riders/senders) | **~10k – 20k** (Redis adapter + a couple of API instances) |
| **Peak trip/delivery creations** | **~1,000 – 3,000 / sec** before write contention on one strong primary (8–16 vCPU) |

### The "200k requesting deliveries *simultaneously*" target

Literally 200k create-requests in the same instant is **beyond a single-primary
design**. Redis matching would cope, but 200k concurrent `INSERT`s would saturate
one MySQL primary. That target is reachable, but needs data-tier work (below) — it's
an **evolution, not a rewrite**, precisely because the app is already stateless.

### To reach millions of users / true 200k-simultaneous

1. **MySQL read replicas** + a connection pooler (ProxySQL) — offload all read paths.
2. **A write queue** for trip/delivery creation to absorb bursts (accept → enqueue → persist).
3. **Partition/shard** the hot tables (`trips`, `deliveries`) by time and/or region.
4. **Redis Cluster** for the adapter + matching + locks.
5. **Real load tests + observability** (APM, metrics, alerting) before you trust the numbers.

---

## 6. Go-live readiness gates (do these first)

1. **Build a real test suite** — unit + integration for every money path (settlement, wallet, commission, coupons, top-ups). This is non-negotiable for a payments app.
2. **Rotate all committed secrets**; move CamPay to production credentials.
3. **Add DB read replicas + a connection pooler + APM/metrics.**
4. **Delete the dead/duplicate controllers** to remove the "which path is live?" bug class.
5. **A load test at 5–10× expected launch traffic** to validate the numbers above.

## 7. One-line answer

> The architecture is production-grade and horizontally scalable; on the current
> single-database setup plan for **~200k–500k registered users and ~10k–20k
> concurrent**. Reaching millions / 200k-simultaneous is a straightforward data-tier
> scale-out (replicas, pooler, write queue, sharding) — but **fix test coverage,
> rotate secrets, and add observability before you push real volume.**
