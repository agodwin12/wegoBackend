# WeGo Backend — Implementation Action Book (Part B)

**Repo:** `wegobackend` · derived from `00-AUDIT-backend.md` (don't re-read the review here)
**Frame:** what we implement next, in what order, why, and how — to reach a safe production launch.
**Roles referenced:** BE = backend engineer · DevOps · QA · Acct/Ops = finance/operations owner.

---

## B1. Confirm product understanding

WeGo is a multi-vertical super-app for Douala/Cameroon (XAF), five verticals — **ride-hailing, parcel delivery, services marketplace (classifieds: listing-plan revenue, tap-to-call, no buyer↔seller mediation), car rental, support** — with three roles (**PASSENGER / DRIVER / DELIVERY_AGENT**) and mode-switching. Money flows through **CamPay** (MTN MoMo + Orange Money) for collections and disbursements, realtime via **Socket.IO** (Redis-adapter), maps/routing via **Mapbox**, files in **Cloudflare R2**, push via **Firebase FCM**, admin via the **Next.js backoffice**. French-first UX.

**Open product questions to resolve before building B2 items:**
1. **Listing plans** — one-time entitlement, or recurring subscription? (Affects whether `plan_expires_at` auto-renews and whether we need a renewal cron.)
2. **Quota** — is a plan's quota *total listings granted* or *max concurrent active*? (Affects the quota check at listing creation.)
3. **Free tier** — modeled as a zero-price plan that skips CamPay (there's already an `activateFreePlan` path), confirmed?
4. **Refunds** — is manual ops-side reversal acceptable at launch, or do we need an in-app refund flow for cancelled paid trips/deliveries? (See B-action A11.)

---

## B2. Immediate actions — stop the bleeding (deployment blockers)

### ACT-01 · Fix the broken digital payout (C3)
- **Why / problem solved:** every MOMO/OM driver payout currently throws and returns 502 — drivers can't be paid digitally.
- **Do nothing →** no digital payouts at all; manual cash only; driver churn + accounting drift.
- **Approach:** in `controllers/backoffice/payout.controller.js:262-269`, rename `disburseType`→`type`, `approvedBy`→`initiatedBy`; drop or formally support `payoutRef`. Add a unit test that mocks `campayClient.disburse` and asserts it's called with `type` defined.
- **Affected:** `payout.controller.js`, `services/campay/campayService.js` (signature is fine — caller is wrong).
- **Dependencies:** none. **Risk if done badly:** passing the wrong `type` enum → wrong cashout category in the ledger. **Tests:** disbursement integration test (the regression). **DoD:** a sandbox MOMO payout reaches `campayClient.disburse` and flips the request to `PAID`.
- **Priority: Critical · Owner: BE · Complexity: XS (≈1h) · Impact: restores payouts.**

### ACT-02 · Verify webhook amount before finalizing (C2)
- **Why:** finalizers run purely on `payload.status`; a spoofed/mismatched amount is accepted.
- **Do nothing →** services delivered / wallets credited with no/*partial* money. Fraud + revenue loss.
- **Approach:** in `_processWebhook` (`campayWebhook.controller.js:97`), before computing `newStatus==='SUCCESSFUL'` finalize, assert `Number(payload.amount) === payment.amount && (payload.currency||'XAF')==='XAF'`. On mismatch: set `status='FAILED'`, `failure_reason='amount_mismatch'`, alert, do **not** finalize.
- **Affected:** `campayWebhook.controller.js`. **Dependencies:** none (works alongside C4). **Risk:** false negatives if CamPay sends amount as string/decimal — normalize with `Number()` and floor. **Tests:** webhook test with mismatched amount asserts no finalizer call. **DoD:** mismatched-amount webhook never triggers a vertical action.
- **Priority: Critical · Owner: BE · Complexity: S.**

### ACT-03 · Fail closed on missing webhook secret in production (C1)
- **Approach:** in `_validateSignature` (`campayWebhook.controller.js:492-499`), if `!secret && NODE_ENV==='production'` → `return false` (currently `return true`). Add a boot assertion (see ACT-09) so the app refuses to start in prod without `CAMPAY_WEBHOOK_SECRET`.
- **Affected:** `campayWebhook.controller.js`, `server.js` (boot assertion). **Tests:** unit test: prod + no secret ⇒ `false`. **DoD:** no unsigned webhook is ever processed in prod.
- **Priority: Critical · Owner: BE · Complexity: XS.**

### ACT-04 · Confirm & align CamPay's real webhook auth (C4)
- **Why:** the HMAC-header scheme likely doesn't match CamPay (they typically sign a JWT in the body). If so, real webhooks are being rejected (secret set) and the system silently depends on polling.
- **Approach:** (1) Acct/Ops pulls CamPay's current webhook doc. (2) If body-JWT: replace the HMAC block with `jwt.verify(payload.signature, CAMPAY_WEBHOOK_SECRET)` and use the **verified** claims (status, amount, reference) as the trust source — which also satisfies C2. (3) Keep the poll finalizer as backstop.
- **Affected:** `campayWebhook.controller.js`, `routes/webhook.routes.js` (raw body may be unnecessary if switching to body-JWT). **Dependencies:** CamPay doc (blocks implementation). **Risk:** mis-implementing JWT verify locks out real callbacks → rely on polling (degraded but not unsafe). **Tests:** replay a real sandbox webhook payload through the verifier. **DoD:** a genuine CamPay sandbox callback is accepted and finalizes.
- **Priority: Critical · Owner: BE + Acct/Ops · Complexity: M · NEEDS the CamPay spec first.**

### ACT-05 · Rotate & purge secrets
- **Approach:** `git rm --cached google-services.json && commit`; run `git log --all --full-history -- '*serviceAccountKey*' '*google-services*'`; if ever committed, **git-filter-repo** to purge and **rotate** the Firebase key. Rotate JWT secrets and CamPay credentials in the live environment (new `.env.production` already has strong JWT values — rotate again post-exposure). Restrict the Mapbox token + Google Maps key to domains/app-signature.
- **Affected:** repo history, Firebase console, CamPay dashboard, `.env.production`. **Risk:** rotating JWT secret invalidates all sessions (acceptable pre-launch). **Tests:** confirm app boots with rotated values; `git ls-files` shows no secrets. **DoD:** no secret in working tree or history; all exposed creds rotated.
- **Priority: Critical · Owner: DevOps + BE · Complexity: M.**

### ACT-06 · CORS / rate-limit / body-limit confirmation
- **Status: ALREADY ADDRESSED in code** (`config/security.js`). **Remaining:** set real `CORS_ORIGIN`/`SOCKET_CORS_ORIGIN` in `.env.production`; add explicit `express.json({ limit: '100kb' })`; tune `AUTH_RATE_LIMIT_MAX`. **Owner: DevOps · Complexity: XS · Priority: High.**

### ACT-07 · Remove `sequelize.sync()` from prod boot (drift hazard)
- **Approach:** delete/guard `sequelize.sync({ alter:false })` at `server.js:100` behind `NODE_ENV!=='production'`; make `migrations/` authoritative; reconcile current model↔table drift (re-check `listing_quota`, `topUpStatus`, and any factory-model columns) with a `sequelize-cli db:migrate:status` check.
- **Affected:** `server.js`, `migrations/`. **Dependencies:** a clean migration set. **Risk:** removing sync exposes pre-existing drift as 500s — that's the point; fix the drift via migrations first. **Tests:** boot against a freshly-migrated DB; smoke the verticals. **DoD:** prod boot runs no `sync()`; `db:migrate:status` is clean.
- **Priority: High · Owner: BE · Complexity: M.**

### ACT-08 · Highest-risk ownership/IDOR fixes first
- **Approach:** add `middleware/requireOwnership(model, idParam, ownerField)`; apply to payments (already scoped — verify), trips, deliveries, rentals, listings, chat first. Produce a route inventory (every `:id` route) and check each scopes by `req.user.uuid`.
- **Affected:** `middleware/`, all vertical route files. **Tests:** for each, user A cannot read/mutate user B's resource (403). **DoD:** no mutating `:id` route is unscoped. **Priority: High · Owner: BE · Complexity: M-L.**

### ACT-09 · Boot-time config assertion + kill debug routes
- **Approach:** at `server.js` startup assert required env (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `CAMPAY_*`, `DB_*`) and that `NODE_ENV==='production'` in prod; `process.exit(1)` if missing. Grep for and remove/guard any `/seed`,`/debug`,`/test` routes.
- **Tests:** start with a missing var ⇒ refuses to boot. **DoD:** app fails fast on misconfig; no debug routes in prod. **Priority: High · Owner: BE · Complexity: S.**

*(Flutter token storage + `deactivateTokenOnLogout` are tracked in the Flutter action book, not here.)*

---

## B3. Technical debt action register

| Debt | Current shortcut | Why dangerous | 1 month | 6 months | At scale | Action | Containment | Long-term | Cx | Timing |
|------|------------------|---------------|---------|----------|----------|--------|-------------|-----------|----|--------|
| Monolithic `app.js` | public + admin in one process/policy | admin bug or heavy query degrades customer API | annoying | risky | outages bleed across surfaces | split into public/admin routers, then processes | per-surface rate-limit (partly done) | 2 services behind Caddy | M | Phase 3 |
| Stateless JWT, no revocation | can't kill a token on logout | stolen token valid till expiry | low (15m TTL) | medium | medium | refresh rotation + Redis jti blacklist | short TTL (done) | full session mgmt | M | Phase 4 |
| Ad-hoc ownership checks | scattered/missing | IDOR across verticals | high | high | data-leak incident | `requireOwnership` middleware (ACT-08) | audit top routes now | authz layer | M-L | Phase 1 |
| Swallowed finalizer errors | `console.error`/`.catch(()=>{})` | money moves, action lost, no trace | high | high | unreconcilable ledger | reconciliation table + admin retry (ACT-12) | grep+alert on these logs | DLQ/queue | M | Phase 1 |
| Unbounded tables (`TripEvent`, chat, `DriverLocation`, `WegoPayment`) | no retention | slow queries, big backups | none | noticeable | query/backup pain | archival + partition jobs | add indexes now | partitioning | M | Phase 2 |
| DECIMAL-as-string | inconsistent `parseFloat` | money math corruption | medium | high | wrong payouts | typed getters/`toNum()` | parse at known consumers | model-level coercion | M | Phase 1-2 |
| Mixed model patterns | factory vs class init | hard to maintain/associate | low | medium | onboarding drag | standardize on `Model.init()` | leave working models | migrate all | M | Phase 3 |
| Associations in `index.js` | 186 calls centralized | per-model reasoning hard | low | low | medium | move to `associate()` | none | with model migration | M | Phase 3 |
| No tests | placeholder script | every change is a gamble | high | high | regressions at scale | CamPay+auth+fare suites (ACT-13) | manual smoke | full CI gate | M-L | Phase 1/5 |
| No CI test gate / staging | deploy from main | bad deploys reach prod | medium | high | incidents | gate CI on tests; add staging | manual review | full pipeline | M | Phase 5 |
| No observability | console logs only | blind to failures | medium | high | slow incident response | structured logs + error tracking + alerts | log levels | metrics/tracing | M | Phase 5 |
| Reconciliation via `console.error` | no durable surface | silent money loss | high | high | unbookable revenue | ACT-12 | log alerting | queue + dashboard | M | Phase 1 |
| Dual socket room names (`passenger:`/`user:`) | redundant emits | confusion/bugs | low | low | low | converge on `user:` | none | refactor | S | Phase 3 |
| Residual marketplace commission code | possibly dead paths | accidental charge logic | low | medium | trust/finance bug | confirm dead; delete | feature-flag off | remove | S | Phase 3 |
| Scratch/large files in repo (`index.html` 114KB, `WEGO_FIXES.html`) | committed noise | bloat/confusion | low | low | low | move to `docs/` or delete | none | clean repo | S | Phase 3 |

---

## B4. Cost & scale actions (Cameroon context)

- **Driver-location writes:** already Redis-first (`geoadd`) — **keep it**; do **not** start writing a `DriverLocation` row per ping. Add a low-frequency snapshot (e.g. every N seconds or on trip events) if history is needed. *Cost benefit: avoids the #1 GPS write-amplification cost. Complexity: none/low. Risk: low.*
- **`TripEvent`/chat/`WegoPayment` growth:** monthly archival to cold storage + partition by month; retention policy (e.g. raw events 90d). *Benefit: bounded hot tables, cheap backups. Cx: M. Risk: archival bug loses history — test restores.*
- **Mapbox cost:** WeGo already migrated off Google — **do not go back**. Reduce calls: cache directions per (origin,dest) rounded to ~50m for a short TTL; only call `driving-traffic` when a trip is active; lazy-load maps in the app. *Benefit: fewer billable calls. Cx: M. Risk: stale ETAs — short TTL.*
- **Geocoding/labels (the expensive-at-$200/day lesson):** build a fallback chain and **never** geocode every GPS point:
  1. **Cached label** keyed by rounded coords (4 dp ≈ 11m) in Redis (long TTL).
  2. **Known zone/landmark/depot** — match against a curated Douala zones table (quartiers, axes, depots) before any paid call.
  3. **City/district** coarse label when nothing matches.
  4. **Paid reverse-geocode only for trip start/end**, never intermediate pings, and only on cache miss.
  - **Providers (cheaper than Google for CM):** Photon/Pelias or **self-hosted Nominatim** (free, OSM has decent Douala coverage) as primary; **LocationIQ / Geoapify / OpenCage** as cheap paid fallback; Mapbox you already pay for. Add **daily budget caps, quota counters in Redis, alerts, and provider failover**.
  - *Benefit: collapses geocoding cost from ~$200/day toward near-zero. Cx: M-L. Risk: OSM label quality — mitigate with the curated zones table, which is also better UX for locals.*
- **Socket.IO scaling:** adapter done; size Redis for pub/sub fan-out before many concurrent drivers. *Cx: S.*
- **MySQL:** add the A17 indexes; plan archival. *Cx: S-M.*
- **Logging cost:** replace per-request console banners with leveled structured logs (info in prod) — cuts log volume and bill. *Cx: M.*

---

## B5. File organization actions (backend)

- **Keep:** `services/campay/*`, `services/*Service.js`, `models/*`, `migrations/*`, `middleware/*`, `config/*` (incl. new `config/security.js`), `deploy/*`, `docs/audit/*`.
- **Split:** `src/app.js` → `routes/index.public.js` + `routes/index.backoffice.js` mounted by `app.js`; group vertical routers. Isolate the payment module under `modules/payments/` (controller+service+routes+webhook together).
- **Move:** `index.html` (114KB), `WEGO_FIXES.html`, `DATABASE_CONSISTENCY_FIXES.md` → `docs/`. Move `serviceAccountKey.json`/`google-services.json` out of repo entirely (mounted at runtime — already in `.dockerignore`).
- **Delete:** confirmed-dead marketplace commission/booking code (after ACT verification); the stray `models/ src/models` nested path if it's not loaded (**verify first**); duplicate `bcrypt`+`bcryptjs` (pick one).
- **Create docs:** `docs/architecture.md`, `docs/payment-flow.md` (collect + webhook + disburse + reconciliation), `docs/runbook.md`, `docs/deploy.md` (already have `DEPLOYMENT.md` at workspace root — link it).
- **Add tests:** `tests/payments/*`, `tests/auth/*`, `tests/fare/*` (see ACT-13).
- **Ownership boundary:** payments code is owned by one BE; no other module imports CamPay internals except via `campayService`.

---

## B6. Implementation roadmap

**Phase 0 — Emergency payment & security containment** (launch-blocking)
ACT-01 → ACT-02 → ACT-03 → ACT-04 → ACT-05. *DoD:* unsigned/mismatched webhooks rejected; CamPay auth aligned; digital payouts work; no secrets in repo/history. *Validation:* the B-end go/no-go gate below.

**Phase 1 — Production stability**
ACT-06, ACT-07, ACT-08, ACT-09, ACT-12 (reconciliation), money-math getters, transactional disbursement (C6). *DoD:* no `sync()` in prod; ownership enforced; finalizer failures land on an admin surface; payouts are transactional. *Validation:* IDOR tests + reconciliation test + disbursement crash-recovery test.

**Phase 2 — Data growth & cost control**
A17 indexes; archival/partition for `TripEvent`/chat/`WegoPayment`/`DriverLocation`; geocoding fallback chain + budgets (B4); Mapbox call reduction. *DoD:* hot tables bounded; geocoding behind cache+budget. *Validation:* load test write volume at 1k/10k drivers; budget-cap test.

**Phase 3 — Code organization & maintainability**
Split `app.js`; isolate payment module; standardize model pattern + move associations; retire dead marketplace code; repo cleanup. *DoD:* public/admin routers separated; one model pattern. *Validation:* full smoke + tests green.

**Phase 4 — Multi-role/data hardening**
Authz layer maturity; JWT refresh rotation + jti blacklist; converge socket room naming; verify driver-tier gating. *DoD:* forced logout works; role gating proven. *Validation:* role-matrix tests.

**Phase 5 — Testing, CI/CD & observability**
Expand test suites; gate CI on tests; add staging; structured logging + error tracking + alerts + payment metrics. *DoD:* no deploy to prod without green tests; dashboards live. *Validation:* a deliberately failing test blocks deploy.

**Phase 6 — Scaling architecture**
Horizontal scaling validated (sockets via adapter, jobs single-runner via `RUN_JOBS`), capacity targets set before onboarding many drivers/partners. *DoD:* N instances behind Caddy with one job-runner. *Validation:* multi-instance socket + cron test.

---

## B7. Action backlog table

| ID | Title | Priority | Phase | Owner | Cx | Risk if delayed | Cost if delayed | Files/modules | Deps | Acceptance |
|----|-------|----------|-------|-------|----|-----------------|-----------------|---------------|------|------------|
| ACT-01 | Fix disbursement param mismatch | Critical | 0 | BE | XS | drivers unpaid digitally | churn + manual ops cost | `payout.controller.js`, `campayService.js` | — | sandbox MOMO payout succeeds |
| ACT-02 | Webhook amount verification | Critical | 0 | BE | S | free service / fraud | direct revenue loss | `campayWebhook.controller.js` | — | mismatch ⇒ no finalize |
| ACT-03 | Fail closed on missing secret | Critical | 0 | BE | XS | spoofed webhooks | fraud | `campayWebhook.controller.js`,`server.js` | — | prod+no secret ⇒ reject |
| ACT-04 | Align CamPay webhook auth | Critical | 0 | BE+Ops | M | webhooks rejected/insecure | broken realtime or fraud | `campayWebhook.controller.js` | CamPay doc | real callback accepted |
| ACT-05 | Rotate & purge secrets | Critical | 0 | DevOps+BE | M | key compromise | breach | git history, Firebase/CamPay | — | no secrets tracked; rotated |
| ACT-06 | Set CORS origins + body limit | High | 0/1 | DevOps | XS | open CORS / large bodies | abuse | `.env.production`,`app.js` | — | allowlist enforced |
| ACT-07 | Remove prod `sync()` | High | 1 | BE | M | schema drift 500s | outages | `server.js`,`migrations/` | clean migrations | `db:migrate:status` clean |
| ACT-08 | Ownership/IDOR middleware | High | 1 | BE | M-L | cross-user data access | breach/trust | `middleware/`, route files | — | A can't touch B's data |
| ACT-09 | Boot config assertion | High | 1 | BE | S | silent misconfig | outages | `server.js` | — | missing var ⇒ no boot |
| ACT-12 | Payment reconciliation surface | High | 1 | BE | M | silent money loss | unbookable revenue | `campayWebhook.controller.js`, new model+admin route | — | failed finalize is retryable |
| ACT-13 | Test suite (pay/auth/fare) | High | 1/5 | QA+BE | M-L | regressions | incidents | `tests/*`,`package.json` | — | CI runs real tests |
| ACT-14 | DECIMAL money getters | High | 1/2 | BE | M | money math bugs | wrong payouts | money models + consumers | — | arithmetic on numbers only |
| ACT-15 | Indexes + archival | High | 2 | BE | M | slow/bloated DB | infra cost | `migrations/`, jobs | — | indexed; tables bounded |
| ACT-16 | Geocoding fallback + budgets | Medium | 2 | BE | M-L | cost blow-up | $/day | label cache, zones table, provider client | zones data | budget cap holds |
| ACT-17 | Split app.js / isolate payments | Medium | 3 | BE | M | coupling | maintenance | `app.js`,`routes/`,`modules/payments/` | — | public/admin separated |

---

## B8. What not to build yet

Defer until Phase 0-1 are green — adding these now multiplies risk on an unsafe payment core:
- **New verticals or new payment methods** (Stripe/cards, new providers) — the existing CamPay path isn't trustworthy yet.
- **WhatsApp / Meta Cloud API notifications** — nice, but FCM/SMS already work; not launch-critical.
- **Video upload on listings / heavy media** — storage cost + moderation before revenue is proven.
- **Advanced analytics / BI dashboards** — build after the ledger is reconcilable (ACT-12/14), or you'll report wrong numbers.
- **Horizontal autoscaling** — the foundation (adapter, job guard) is in place, but don't scale an unverified payment path; finish Phase 0-1 first.

---

## Deployment GO / NO-GO gate (must all be ✅ before taking real payments)

| Gate | Validation test |
|------|-----------------|
| ACT-01 payouts work | Sandbox MOMO payout reaches `campayClient.disburse`, request → `PAID` |
| ACT-02 amount checked | Webhook with wrong amount ⇒ payment `FAILED`, no finalizer ran |
| ACT-03 fail closed | Prod env, no `CAMPAY_WEBHOOK_SECRET` ⇒ webhook rejected |
| ACT-04 CamPay auth aligned | A genuine CamPay sandbox callback is accepted and finalizes |
| ACT-05 secrets clean | `git ls-files` shows no keys; Firebase/JWT/CamPay rotated |
| ACT-06 CORS locked | Request from a non-allowlisted origin is blocked |
| ACT-07 no prod `sync()` | Prod boot logs no `sync`; `db:migrate:status` clean |
| ACT-09 fail fast | Boot with a missing required env var exits non-zero |
| ACT-12 reconciliation | A forced finalizer error appears on the admin reconciliation view |

Until every row is ✅, WeGo stays **NO-GO** for real money.
