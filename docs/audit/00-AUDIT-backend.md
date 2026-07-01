# WeGo Backend — Deep Production-Readiness Audit (Part A)

**Repo:** `wegobackend` (Node 20 / Express 5 / Sequelize 6 / MySQL / Redis / Socket.IO)
**Entry:** `server.js` → `src/app.js`
**Audited:** 2026-06-30 · read-only · target = safe production launch in Douala (XAF, CamPay)
**Scope of this run:** backend only. Flutter (`wego_new_app`) and backoffice (`backoffice`) get their own audit files. Frontend-specific sections below (A5 UX, A13 Flutter i18n) are covered only at the backend boundary.

> **Important context for the reader.** In a prior task on this same tree, several issues this kind of audit usually finds "open" were already changed: CORS allowlist, rate limiting, Socket.IO Redis adapter, single-runner cron guard, JWT secret strength + TTL. This report audits the code **as it is now** and labels each such item **ALREADY ADDRESSED** with the proof. Everything else is current, unfixed state. Where I could not verify something from static code (CamPay's real webhook format, git history, runtime env), it is marked **NEEDS VERIFICATION** rather than asserted.

---

## 0. Verdict up front

**GO / NO-GO for taking real payments in production: NO-GO.**

Four payment-integrity defects block launch, and one of them means **driver payouts are currently broken**, not just insecure:

| # | Blocker | Proof | Type |
|---|---------|-------|------|
| C1 | Webhook accepts unsigned requests in production | `controllers/payment/campayWebhook.controller.js:492-499` | Fraud |
| C2 | Webhook never verifies `amount` against the stored payment | `campayWebhook.controller.js:97-115` | Fraud |
| C3 | Digital (MOMO/OM) payouts throw on every call — param mismatch | `controllers/backoffice/payout.controller.js:262-269` vs `services/campay/campayService.js:189` | Broken feature |
| C4 | Webhook signature scheme likely doesn't match CamPay's real format | `campayWebhook.controller.js:501-526` | Broken/insecure (NEEDS VERIFICATION) |

Details and the full list follow.

---

## A1. Software architecture

**Working well**
- Clean service layer for the money path: business logic lives in `services/campay/campayService.js`, not in controllers. Controllers (`initiatePayment.controller.js`) stay thin.
- `WegoPayment` is a genuine single source of truth — one ledger row per collect/disburse across all five verticals, polymorphic via `vertical` + `vertical_id` (`models/WegoPayment.js:55-66`).
- Webhook is correctly isolated and mounted before `express.json()` (`src/app.js:129`), with its own raw-body capture (`routes/webhook.routes.js`).

**Weak / risky**
- **One monolithic `src/app.js` mounts ~60 route files** — public app surfaces and backoffice/admin surfaces share the same process, the same global middleware, and (until now) the same policies. Blast radius: an admin route bug or a heavy admin query degrades the customer-facing API. Public and admin should be separate routers with separate rate-limit/log/error policy, ideally separable into two processes later. **Priority: Medium.**
- **Cross-vertical reach in the webhook:** `campayWebhook.controller.js` imports and drives `tripMatchingService`, `deliveryEarningsService`, `walletTopUpService`, and `delivery.controller.searchForDriver` directly. It is the de-facto orchestrator for all verticals. Acceptable for now, but it concentrates risk — every finalizer failure mode lands in one file. **Priority: Low** (revisit when splitting `app.js`).
- **Background jobs** (`jobs/cleanup.job.js`, `services/balanceSheetCron.js`, `jobs/paymentExpiry.job.js`, the daily `expireListings` cron) start at module load in `app.js:307-318`. **ALREADY ADDRESSED:** they are now wrapped in a `RUN_JOBS !== 'false'` guard so they don't double-fire across instances (`src/app.js:307`, `server.js:114`). Keep `RUN_JOBS=true` on exactly one instance.

## A2. Data architecture & database design

**Working well**
- `WegoPayment.amount` is `DataTypes.INTEGER` (XAF, `models/WegoPayment.js:143-146`) — the payment ledger itself has **no** DECIMAL-as-string hazard, and CamPay rejects decimals anyway.
- Real migrations exist under `migrations/` and `src/migrations/`.

**Weak / risky**
- **`sequelize.sync({ alter: false })` is in the boot path** — `server.js:100`. With `alter:false` it won't silently ALTER columns (so it's less dangerous than `alter:true`), but it still **creates** missing tables outside migration control and **masks** model↔table drift instead of failing loudly. This is exactly the class of problem that caused the past `listing_quota` / `topUpStatus` production 500s. **Recommendation:** remove `sync()` from production boot; make migrations the sole schema authority; add a startup assertion that pending migrations = 0. **Priority: High.**
- **Inconsistent model definition pattern.** `WegoPayment` uses the class-based `Model.init()` pattern, but a large set of models use the **factory pattern** `module.exports = (sequelize) => {…}` — confirmed in `models/CouponUsage.js`, `Delivery.js`, `DeliveryCategory.js`, `DeliveryDispute.js`, `DeliveryPayoutRequest.js`, `DeliveryPricing.js`, `DeliverySurgeRule.js`, `DeliveryTracking.js`, `DeliveryWallet.js`, `DeliveryWalletTopUp.js`, and more. Mixed patterns make associations, hooks, and onboarding harder. **Recommendation:** standardize on class-based `Model.init()`; migrate the factory models incrementally. **Priority: Medium.**
- **Associations are centralized in `models/index.js`** (186 `hasMany/belongsTo/...` calls there), not in per-model `associate()`. This contradicts the intended "associations only in `associate()`" standard. It boots cleanly (so no duplicate-alias crash, meaning they are not *also* declared in `associate()`), but it's a maintainability smell and makes per-model reasoning hard. **Recommendation:** move associations into `associate()` as part of the class-based migration. **Priority: Low.** *(No duplication found — NEEDS VERIFICATION only if you add `associate()` methods without removing the index.js copies.)*
- **DECIMAL-as-string, system-wide.** ~20 models declare `DataTypes.DECIMAL` money columns (`Trip`, `Delivery`, `DeliveryWallet`, `DeliveryWalletTopUp`, `DeliveryWalletTransaction`, `ServiceAdPayment`, `ServiceListing`, `DriverWallet`/`Driver`, `EarningRule`, `PriceRule`, `TripReceipt`, …). Sequelize returns these as **strings** at runtime. The CamPay path handles it correctly (`parseFloat` in `campayService.js:376,422,447`), but every *other* consumer that does arithmetic — earnings engine, balance-sheet cron, wallet debits/credits — must be checked. String concatenation bugs here corrupt money. **Recommendation:** add a typed getter (`get() { return this.getDataValue(x) == null ? null : Number(...) }`) on money columns, or a `toNum()` at every ingestion point; then grep for arithmetic on these fields. **Priority: High.**
- **Unbounded high-growth tables, no archival:** `TripEvent` (`driver.controller.js:748`), `DriverLocation`, chat messages, and `WegoPayment` grow without retention/partitioning. Quantified in A9. **Priority: High** (before scale).

## A3. Backend logic & APIs

**State machines (observed):**
- **Trip:** `SEARCHING → MATCHED → DRIVER_ASSIGNED → … → COMPLETED/CANCELLED`. Payment is only allowed while `SEARCHING|MATCHED|DRIVER_ASSIGNED` (`campayService.js:355`). Good gate.
- **Delivery:** `payment_status: pending → paid`; driver search only fires on `paid` (`campayWebhook.controller.js:198-200`).
- **Rental:** `paymentStatus: → paid`, then awaits admin approval.
- **Listing fee:** `pending_payment → active | pending_review | hero_pending` (`campayWebhook.controller.js:267-291`).

**Weak / risky**
- **Validation coverage is uneven.** `initiatePayment.controller.js` validates well, but many route files trust `req.body` directly. There is a `middleware/validate.js` + `validators/` but they are not applied uniformly. **Recommendation:** require a validator on every state-changing route. **Priority: Medium.** *(Per-route inventory: NEEDS VERIFICATION across all 60 route files — out of scope for one pass; flag as a checklist item.)*
- **Idempotency is partial.** `middleware/idempotency.js` + `IdempotencyKey` exist, but the money-moving endpoints rely on ad-hoc guards (duplicate-PENDING check on initiate; `isResolved` on finalize) rather than the idempotency middleware. Disbursement has **no** idempotency key. **Priority: High** (see A4/C3, A4 disbursement).
- **Response envelope is inconsistent** — some controllers return `{ success, message, code }`, others `{ success, data, meta }`, others `{ success, error }`. Harmless but increases client-side branching. **Priority: Low.**

## A4. CamPay payment integrity — **CRITICAL TRACK**

### What is already correct (do NOT "fix" these)
- Amount is **always** re-fetched from the DB per vertical (`campayService._resolveAmountAndDescription`, `campayService.js:347-462`) — never from the client.
- `WegoPayment` audit row is created **before** the CamPay call (`campayService.js:115`), so failed calls still leave a PENDING ledger row for the expiry job.
- Duplicate-PENDING guard on initiate (`initiatePayment.controller.js:72-93`).
- Ownership check on status polling (`initiatePayment.controller.js:188-194`).
- Raw body is captured and the webhook is mounted before `express.json()` (`routes/webhook.routes.js`, `app.js:129`) — so HMAC-over-raw-bytes is *possible* (the scheme itself is the issue, see C4).
- Poll finalizer backstops a missed webhook (`initiatePayment.controller.js:210-244` → `campayWebhook.controller._finalizeFromPoll`).

### C1 — Unsigned webhook accepted in production *(Critical, confirmed)*
`_validateSignature()` returns `true` when `CAMPAY_WEBHOOK_SECRET` is unset — and in production it only logs an error, then still returns `true` (`campayWebhook.controller.js:492-499`). Combined with C2, a single forged POST to `/api/webhooks/campay` with `{status:'SUCCESSFUL', external_reference:<known ref>}` triggers driver matching, marks deliveries paid, confirms rentals, and credits agent wallets — with no money received.
**Fix:** in production, fail **closed** — if the secret is missing, reject (500/return without processing). Never `return true`.

### C2 — No amount verification *(Critical, confirmed)*
`_processWebhook` sets status purely from `payload.status` (`campayWebhook.controller.js:97`) and finalizes. It **never** compares `payload.amount` to `payment.amount`. A spoofed or mismatched-amount webhook is accepted.
**Fix:** before finalizing, assert `Number(payload.amount) === payment.amount` (and currency XAF); on mismatch, mark the payment `FAILED`/flag for review and do **not** run the finalizer.

### C3 — Digital payouts are broken *(Critical, confirmed — real bug, not just risk)*
`confirmPayoutRequest` calls the disburser with the wrong parameter names:
```js
// payout.controller.js:262-269
campayService.initiateDisbursement({
  disburseType: DISBURSE_TYPES.DRIVER_CASHOUT,  // service expects `type`
  recipientId, amount, phone,
  approvedBy: String(req.user.id),              // service expects `initiatedBy`
  payoutRef: request.referenceNumber,
});
```
But the service destructures `{ type, recipientId, amount, phone, initiatedBy }` and immediately throws when `type` is undefined (`campayService.js:189-196`). So **every MOMO/OM payout** throws `Unknown disbursement type: "undefined"`, is caught at `payout.controller.js:291`, and returns `502 CamPay disbursement error`. Drivers cannot be paid digitally today.
**Fix:** rename caller keys to `type` and `initiatedBy` (and accept/ignore `payoutRef`). Add an integration test that asserts a disbursement actually reaches `campayClient.disburse`.

### C4 — Webhook signature scheme likely misaligned with CamPay *(Critical, NEEDS VERIFICATION)*
The code expects an **HMAC-SHA256 hex digest** in a `signature` / `x-campay-signature` **header** (`campayWebhook.controller.js:501-516`). CamPay's documented webhook commonly delivers a **signed JWT token inside the JSON body** (`payload.signature`), not an HMAC header. If that's true here:
- With `CAMPAY_WEBHOOK_SECRET` **set** and no header present, production **rejects every real webhook** (`:508-509`) → payments only ever finalize via the polling path (`checkStatus`/`paymentExpiry.job`). Realtime "payment confirmed → find driver" then depends entirely on the app polling.
- With the secret **unset**, C1 makes it accept everything.
**Action:** confirm CamPay's current webhook auth from their docs/dashboard. If it's a body JWT, verify `jwt.verify(payload.signature, CAMPAY_WEBHOOK_SECRET)` and decode the transaction claims instead of HMAC-over-rawBody. This is the single most important correctness check before launch.

### C5 — Finalizer failures are silently swallowed *(High, confirmed)*
After money has moved (status persisted SUCCESSFUL), every finalizer runs in a `try/catch` that only `console.error`s (`campayWebhook.controller.js:139-141`, `:67-69`), and several sub-steps use `.catch(() => {})` (`:162, :444, :452`). No dead-letter queue, no admin alert, no reconciliation surface. A driver-match or wallet-credit that throws is lost.
**Fix:** on finalizer failure, write a durable `payment_reconciliation` row (payment id, vertical, error, attempts) and surface it on an admin "needs reconciliation" screen with a retry button.

### C6 — Disbursement lacks balance check, idempotency, and a transaction *(High, confirmed)*
`initiateDisbursement` (`campayService.js:189`) does **not** call `getBalance()` first, has **no** idempotency guard against double-payout at the service level, and the caller's flow (`payout.controller.js:259-339`) does the CamPay call, then sets `status=PAID`, then debits `DriverWallet`, then updates the balance sheet — **not** inside one DB transaction. The status guard at `:242` blocks a *sequential* re-confirm but not two *concurrent* confirms (no row lock). A crash between disburse-success and wallet-debit pays the driver without debiting.
**Fix:** wrap confirm in `sequelize.transaction` with `SELECT … FOR UPDATE` on the payout request; check CamPay balance pre-disburse; make disburse idempotent on `payoutRef`/`external_ref`.

### C7 — Concurrent webhook + poll race *(Medium, confirmed)*
`_processWebhook` reads `payment.isResolved` then `update`s (`campayWebhook.controller.js:92-110`) non-atomically; `checkStatus` re-reads `freshPayment.isResolved` (`initiatePayment.controller.js:217-218`) but also non-atomically. A webhook and a poll arriving together can both pass the guard and double-run a finalizer. The per-vertical guards (`delivery.payment_status==='paid'`, top-up `alreadyCredited`) mitigate but don't fully prevent it.
**Fix:** make the PENDING→resolved transition a conditional `UPDATE … WHERE status='PENDING'` and only finalize if `affectedRows === 1`.

### Sandbox/production separation *(NEEDS VERIFICATION)*
`CAMPAY_BASE_URL=https://demo.campay.net/api` and `CAMPAY_ENV=DEV` are the current values. The 25 XAF sandbox cap and test MSISDNs must not ship to prod. Confirm `.env.production` flips to `https://www.campay.net/api` + `CAMPAY_ENV=PROD` with live credentials before launch.

## A5. Frontend structure & UX (backend boundary only)
Deferred to the Flutter and backoffice audit runs. Backend-relevant note: user-facing strings are emitted from the backend in **English** (e.g. `"Payment confirmed! Finding you a driver..."`, `campayWebhook.controller.js:176`) for a French-first product — see A13. **Priority: Medium.**

## A6. Security & access control

**ALREADY ADDRESSED**
- **CORS** is no longer wide open: `app.use(cors(corsOptions))` with an env allowlist (`src/app.js`, `src/config/security.js`). Set `CORS_ORIGIN` to the real backoffice origin in prod.
- **Rate limiting** is mounted: a global limiter + a stricter `authLimiter` on `/api/auth` and `/api/backoffice/auth` (`src/config/security.js`, `app.js`). Tune `AUTH_RATE_LIMIT_MAX`.
- **`trust proxy`** is set for correct client IPs behind Caddy (`app.js`).
- **Secrets**: `serviceAccountKey.json` and `google-services.json` added to `.dockerignore` so they aren't baked into the image.

**Still open**
- **`google-services.json` is tracked in git** (`git ls-files` confirms). `serviceAccountKey.json` is present in the working tree but **not** tracked (good). **Action:** `git rm --cached google-services.json`; run a full-history scan (`git log --all --full-history -- '*serviceAccountKey*'`) and, if it was ever committed, **purge with git-filter-repo and rotate the Firebase key**. **Priority: Critical** (history scan = NEEDS VERIFICATION).
- **Body size limit:** `express.json()` (`app.js:138`) has no explicit `limit`. Express defaults to **100 kb** (so not unlimited — the common "DoS via huge body" framing overstates it here), but uploads go through `multer` memory storage, not JSON, so a tight explicit limit (`{ limit: '100kb' }`) is safe and clearer. **Priority: Low.**
- **Verbose per-request logging:** `middleware/auth.middleware.js` prints a banner and token metadata on every authenticated request (`:55-79`); controllers log heavily. This is a log-volume/cost problem and leaks token prefixes. *(The specific claim that email+phone are logged here is **NEEDS VERIFICATION** — I did not find them in `auth.middleware.js`; they may be logged in controllers.)* **Recommendation:** structured leveled logger (pino/winston) with redaction; drop per-request banners. **Priority: Medium.**
- **`morgan('dev')`** is used in the prod path (`app.js`). Switch to `combined` + a transport in production. **Priority: Low.**
- **Static `/uploads`** is served from local disk (`app.js`) although storage is Cloudflare R2 (`utils/r2Upload.js`, all uploads use memory→R2). Confirm nothing still writes there; otherwise remove the static mount to avoid serving stray files. **Priority: Low.**
- **JWT secret:** `utils/jwt.js` is env-driven and throws if unset (`:80,:86`) — no insecure hardcoded default in the verify path (good). The previously-deployed `JWT_ACCESS_SECRET=wegocameroon` was weak; the new env files set strong secrets. **Rotate in the live environment.** **Priority: High** (operational).

## A7. Authentication & authorization

**Working well**
- Single token verifier shared by HTTP and sockets (`utils/jwt.verifyAccessToken`, used in `auth.middleware.js` and `sockets/index.js`) — secret/issuer/audience stay consistent.
- Payment status endpoint enforces ownership (`initiatePayment.controller.js:188`).
- Backoffice/employee auth is separate (`middleware/employeeAuth.middleware.js`, `routes/backoffice/authRoutes.js`) and uses its own secret path.

**Weak / risky**
- **Stateless JWT, no revocation.** Logout cannot invalidate an issued access token; there is a standing client-side TODO to call `deactivateTokenOnLogout()`. With access TTL now short (15m prod), exposure is bounded, but there is no server blacklist/rotation-on-logout. **Recommendation:** short access TTL (done) + refresh-token rotation + optional jti blacklist in Redis for forced logout. **Priority: Medium.**
- **No generic ownership/authorization layer.** Confirmed: no `owner`/`resource`/`acl` middleware exists (`ls src/middleware/`). Ownership is checked ad-hoc inside some controllers and missing in others. This is the systemic IDOR risk: every `:id` route across trips, deliveries, rentals, listings, chat, ratings, payouts must scope by the caller. The payment path does; the rest **NEEDS VERIFICATION route-by-route**. **Recommendation:** add a reusable `requireOwnership(model, idParam, ownerField)` middleware and apply it; treat any unscoped mutating `:id` route as High. **Priority: High.**
- **Driver gating tiers** (`requireDriverApproval`, `requireActiveDriver`/`requireDriver`/`requireDeliveryAgent` in `middleware/driver.middleware.js`): confirm `DELIVERY_AGENT` is never blocked by ride-only `requireDriver`, and that mode transitions key on `[user_type][active_mode]` (nested), not flat `user_type`. **NEEDS VERIFICATION** (read `driver.middleware.js` + `switchMode.routes.js`). **Priority: High** (multi-role correctness).

## A8. Multi-role / data isolation
- The IDOR question (A7) **is** the isolation question here — WeGo is multi-role, not multi-org. Resolve A7 systemically and this closes.
- **Socket.IO rooms** are keyed by Account UUID (`sockets/index.js`: `user:${uuid}`, `driver:${uuid}`, `passenger:${uuid}`). The webhook emits to both `passenger:{uuid}` and `user:{uuid}` (`campayWebhook.controller.js:530-531`). Confirm a client only ever `join`s its own UUID rooms (it does — rooms are derived from the authenticated socket, not client input, `sockets/index.js`). **Looks correct.** Minor: dual room naming (`passenger:` vs `user:`) is redundant; converge on `user:` to reduce confusion. **Priority: Low.**

## A9. Performance & scalability

**Working well**
- **Driver location is Redis-first, not DB-per-ping.** Hot path uses `redisClient.geoadd(DRIVERS_GEO, …)` (`sockets/locationHandlers.js:50`, `driver.controller.js:165,329,425`). No `DriverLocation.create` in the ping path. This is the right design and avoids the classic GPS write-amplification problem. **Good.**
- **ALREADY ADDRESSED — Socket.IO Redis adapter** is attached (`sockets/index.js`, `@socket.io/redis-adapter`), so sockets survive horizontal scaling.

**Weak / risky**
- **`TripEvent` and chat tables grow unbounded** (`TripEvent.create`, `driver.controller.js:748`); `WegoPayment` grows forever. No archival/partitioning. At scale this slows hot queries and bloats backups. **Recommendation:** monthly partition or archival job + retention policy. **Priority: High** (before scale).
- **Indexing:** confirm indexes on hot lookups — `WegoPayment.external_ref`, `WegoPayment.campay_ref`, `WegoPayment.status`, plus FK/status columns on trips/deliveries. The webhook looks up by `external_ref` on every callback (`campayWebhook.controller.js:86`). **NEEDS VERIFICATION** against migrations; add a unique index on `external_ref` and a non-unique on `campay_ref`. **Priority: High.**
- **N+1** risk in admin list endpoints (trips/deliveries/dashboards) — **NEEDS VERIFICATION**; spot-check the backoffice list controllers. **Priority: Medium.**
- **Redis config:** `config/redis.js` uses `REDIS_URL` with sane retry strategy; single shared client + per-adapter duplicates. Looks fine. **Priority: Low.**

## A10. Error handling & reliability
- Global handler returns a generic 500 in prod, leaks stack only in dev (`app.js`) — good.
- **Biggest reliability gap = C5** (swallowed finalizer errors) and **C6** (non-transactional disbursement).
- **External-call resilience:** confirm timeouts/retries around CamPay (`campayClient.js`), Mapbox, Twilio, FCM, R2. `campayTokenManager.js` caches the token — confirm it refreshes on 401. **NEEDS VERIFICATION** (read `campayClient.js`). **Priority: Medium.**

## A11. Testing & QA
- **There are zero backend tests.** `find` for `*.test.js` / `*.spec.js` / `__tests__` returns nothing; `package.json` `test` script is the placeholder `echo "Error: no test specified" && exit 1`. For a payments app this is **High**. Minimum viable suite before launch: CamPay collection + webhook (signature, amount, idempotency) + disbursement (the C3 regression), auth/ownership, and `fareCalculatorService`. **Priority: High.**

## A12. DevOps, deployment & environment config
- **ALREADY ADDRESSED:** `Dockerfile` entrypoint fixed (`node server.js`), `.dockerignore` keeps secrets out, env split into `.env.development`/`.env.production`/`.env.example`, unified `deploy/` stack with Caddy auto-HTTPS + external host MySQL (`host.docker.internal` + `host-gateway`).
- **Confirm at deploy time:** `NODE_ENV=production` is actually set in the running container (the code branches on it for signature/log behavior — see C1); `/health` is wired to the orchestrator (it is, in compose); no seed/debug routes are reachable in prod (**NEEDS VERIFICATION** — grep for any `/seed`, `/debug`, `/test` routes). **Priority: High.**
- `.env*` are gitignored (`.gitignore` updated); prod secrets injected via `.env.production`, not baked. Good.

## A13. Internationalization (backend-originated strings)
- Server emits **English** user-facing strings for a French-first app: socket messages (`campayWebhook.controller.js:176,209,237,307`), and likely SMS/push bodies. **Recommendation:** centralize user-facing copy in a fr-first message catalog; pass locale from the client or default to French. **Priority: Medium.**

## A14. Business logic & workflow consistency
- **Services marketplace = classifieds:** the pay path resolves listing revenue from `ServiceAdPayment` (plan price), and `_finalizeListingFee` only flips listing/plan status — **no buyer↔seller payment mediation** in the CamPay finalizers. Consistent with the classifieds/listing-plan model. **However**, `commission`/`booking` strings still appear in `controllers/serviceListing.controller.js` and several services — **NEEDS VERIFICATION** whether these are dead code paths or just comments/other verticals (delivery commission is legitimately separate via `deliveryCommission.service.js`). **Priority: Medium** — confirm no residual service-marketplace commission/escrow path can execute.
- **Refunds:** the CamPay path has **no** refund/reversal flow. For launch, define what happens when a paid trip/delivery is cancelled (manual disbursement vs credit). **Priority: Medium** (decide before launch; may be acceptable as manual ops at first).
- **Earnings/payouts/balance-sheet** reconcile through `DriverWallet` + `DailyBalanceSheet`, but the disbursement bug (C3) and non-transactional debit (C6) mean the numbers can't be trusted until those are fixed. **Priority: High.**

---

## A15. Consolidated urgent fixes (ranked)
1. **C3** — Fix the disbursement param mismatch (payouts are broken today). *Critical, ~1h.*
2. **C2** — Verify webhook `amount` against the ledger before finalizing. *Critical.*
3. **C1** — Fail closed on missing webhook secret in production. *Critical.*
4. **C4** — Confirm & align CamPay's real webhook auth mechanism. *Critical, NEEDS VERIFICATION.*
5. **C5** — Durable payment reconciliation (no more swallowed finalizer errors). *High.*
6. **C6** — Transactional, balance-checked, idempotent disbursement. *High.*
7. **Secrets** — `git rm --cached google-services.json`, history scan, rotate Firebase + JWT + CamPay in live env. *Critical (history = verify).*
8. **Remove `sequelize.sync()` from prod boot**; migrations-only + drift assertion. *High.*
9. **Ownership/IDOR** middleware + route-by-route application. *High.*
10. **Money math** — typed getters/`toNum()` for DECIMAL consumers. *High.*
11. **Tests** — CamPay + auth/ownership + fare suite; turn the `test` script real. *High.*

## A16. Recommended implementation order
Payments first (C3 → C2 → C1 → C4 → C5 → C6), because they are both the launch blocker and the highest-impact-if-wrong. Then secrets/history, then `sync()` removal + drift check, then the IDOR layer, then money-math hardening, then the test suite (which should encode all of the above as regressions).

## A17. Missing safeguards to add
- Conditional `UPDATE … WHERE status='PENDING'` for the resolve transition (C7).
- Unique index on `WegoPayment.external_ref`; index on `campay_ref`, `status`.
- Startup assertion: required env present (`JWT_*`, `CAMPAY_*`, `DB_*`) and `NODE_ENV=production`.
- Admin "needs reconciliation" view backed by C5.
- Retention/archival jobs for `TripEvent`, chat, `DriverLocation`, `WegoPayment`.

## A18. Final readiness assessment
**NO-GO for real payments.** The architecture, the Redis-first location design, the DB-resolved amounts, and the recent hardening (CORS/rate-limit/adapter/cron/env/Docker) are genuinely solid foundations. But the webhook trust model (C1/C2/C4), the broken digital payout path (C3), and the absence of reconciliation (C5) mean WeGo can currently (a) be tricked into delivering services without payment and (b) cannot reliably pay drivers. None of these are large changes — they are precise, and they are blocking.

## A19. Suggested next steps before continuing development
1. Run the same audit from `wego_new_app` (Flutter) and `backoffice` to produce their `00-AUDIT-*.md`.
2. Get CamPay's current webhook spec in writing (resolves C4).
3. Freeze new feature work until Phase 0 of the Action Book (`01-ACTION-BOOK-backend.md`) is green.
