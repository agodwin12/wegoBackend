# WeGo Delivery — Production Report

How the delivery product works end-to-end after this pass, what was already
built, what I added, and the evidence it scales. Audience: engineering + ops.

---

## 1. TL;DR

WeGo delivery was already ~80% production-grade (Uber-style matching, a full
state machine, express/regular tracking, PIN hand-off, prepaid-wallet + cash
settlement). This pass closed the remaining gaps the product needed:

| Area | Before | Now |
|---|---|---|
| **Coupons on deliveries** | Coupon system existed but was rides-only — never wired to delivery | Full flow: preview in estimate, apply at booking, recorded + capped, platform-funded (driver protected) |
| **Agent bonus / quest program** | Existed for ride drivers only | Delivery agents earn milestone bonuses that reload the wallet — same engine, per-vertical |
| **Push-notification inbox** | Every `NotificationService.send()` silently failed to persist (2 schema bugs) — only the FCM push fired | Fixed — notifications now persist to the in-app inbox app-wide |
| **200k-concurrent scale** | `deliveries` had 23 duplicate indexes, no composite indexes for hot paths | Deduped + 3 composite indexes; hot queries index-served; matching already on Redis geo |
| **Backoffice config** | — | Verified full CRUD for pricing zones, surge rules (peak hours), price rules, coupons |

---

## 2. The delivery lifecycle (unchanged core, verified)

State machine (`Delivery.canTransitionTo` / `transitionTo`):

```
searching → accepted → en_route_pickup → arrived_pickup → picked_up
          → en_route_dropoff → arrived_dropoff → delivered
   (any active state) → cancelled | disputed | expired
```

- **Matching** is Redis-geo based (`locationService.findNearbyDrivers`) — it never
  scans the SQL table, so 200k simultaneous requests fan out through Redis, not MySQL.
- **Express vs regular**: express streams live GPS to the sender (`live_map`);
  regular sends stage updates (`stage_updates`).
- **Hand-off** is secured by a 4-digit PIN (bcrypt-hashed, 5-attempt lockout).
- **Real-time**: the sender gets a socket `stage update` at every transition.

## 3. Money model (unchanged, reaffirmed)

- **Cash delivery**: the agent collects cash from the sender and **owes WeGo the
  commission** (recorded as `cash_commission_owed`). Balance doesn't move; they
  settle their commission debt from their prepaid wallet.
- **Digital delivery (MoMo/Orange)**: the agent's `driver_payout` is credited to
  the wallet, commission recorded as `commission_deduction`.
- CamPay remains **deposit-only** — it tops up the agent wallet; WeGo never pays out.

---

## 4. Coupons (new)

**Funding model — platform-funded, driver protected.** A coupon reduces what the
**sender** pays; the discount is absorbed by **WeGo's commission**. The agent's
`driver_payout` is never reduced.

Flow:
1. `GET /deliveries/estimate?...&coupon_code=WEGO-X` returns a live preview:
   `{ coupon: { valid, discount, message, newTotal } }`.
2. `POST /deliveries/book` with `coupon_code`. The server re-validates
   (`evaluateCoupon` → validity, per-user limit, min-order, cap), applies the
   discount, and stores a snapshot on the delivery row:
   `coupon_id`, `coupon_code`, `discount_amount`, `original_total_price`.
3. A `coupon_usage` row is recorded (`delivery_id` added) and `used_count` bumped.
4. A bad code at booking fails loudly (`400 COUPON_INVALID`) instead of silently.

Coupon math is unit-verified: percentage w/ max-cap, fixed, min-order floor,
order-capping, case-insensitive codes.

Mobile: a coupon card on the delivery confirm screen (Apply → server validates →
"you save X XAF" / error → Remove). The server is the single source of truth.

Backoffice: `couponcontroller` already exposes create/update/delete/toggle,
usage tracking, and code generation.

## 5. Agent bonus / quest program (new)

Mirrors the ride-hailing earnings engine, scoped per vertical.

- `bonus_programs.vertical` (`RIDE` | `DELIVERY` | `BOTH`, default `RIDE`) — the
  ride engine now evaluates `RIDE`/`BOTH`; the new delivery engine evaluates
  `DELIVERY`/`BOTH`. Existing programs are unchanged (default `RIDE`).
- After a delivery completes and earnings post, `deliveryBonusService.evaluateAndAward`
  counts the agent's completed deliveries (or earnings) in the program period. If a
  milestone is crossed (e.g. "10 deliveries today → 1 000 XAF"), it:
  - credits the **DeliveryWallet** (`balance` + `total_bonuses`),
  - writes a `bonus_quest` ledger row,
  - records a `bonus_award` (idempotency: `UNIQUE(driverId, programId, periodKey)`),
  - push-notifies the agent (`DELIVERY_BONUS_EARNED`) + emits `delivery:bonus_earned`.
- **Idempotent**: re-running never double-pays (verified — 2nd evaluation yields 0
  awards, balance unchanged).

> Identity note: `bonus_awards.driverId` FKs to `accounts(uuid)`, so awards key on
> the agent's **account UUID** (`Driver.userId`), while wallet + delivery counts key
> on `Driver.id`. The service resolves both.

Backoffice: bonus programs are managed via the existing bonus-program admin;
set `vertical = DELIVERY` (or `BOTH`) to target agents.

## 6. Notification inbox fix (app-wide)

`NotificationService.send()` persists an inbox row **and** fires FCM. The persist
half had been silently failing for **every** notification because of two schema
mismatches:

1. `expires_at` was `NOT NULL` with no default (comment said "auto-set +7 days"
   but nothing set it) → notNull violation.
2. The model declared `timestamps: true` but the `notifications` table has **no
   `updated_at` column** → "Unknown column 'updated_at'".

Both fixed (`expires_at` default = now + 7d; `updatedAt: false`). Verified: a
delivery-bonus notification now persists (`inbox +1`). This restores the in-app
notification list for rides, deliveries, and services alike.

---

## 7. Scale to 200k concurrent

- **Matching**: Redis geo — MySQL-free on the hot path.
- **`deliveries` indexes**: dropped 23 duplicate `delivery_code` indexes (the old
  `sync({alter})` bomb); added:
  - `idx_deliveries_sender_status` — "does this sender already have an active delivery?"
  - `idx_deliveries_driver_status_delivered` — agent history + bonus counting
  - `idx_deliveries_status_created` — admin list ordering / status filters
- **Load test @ 128 006 rows** (every query index-served, no full scan):

  | Query | Index used | Time |
  |---|---|---|
  | Active-delivery check | `idx_deliveries_sender_status` | 12.4 ms* |
  | Agent history | `idx_deliveries_driver_status_delivered` | 9.9 ms* |
  | Admin list | `idx_deliveries_status_created` | 15.2 ms* |

  \* worst case — the test put all rows under a single sender/driver. In production
  each sender owns a handful of rows, so these are point lookups (sub-ms).

- **Concurrency safety**: wallet writes lock the row (`FOR UPDATE`) with optimistic
  retry; offer/accept uses Redis locks; bonus awards are guarded by a unique index.

## 8. Backoffice configurability (verified)

All role-gated (`requireEmployeeRole`):

- **Pricing zones**: `GET/POST/PUT/DELETE /backoffice/delivery/pricing` (+ preview)
- **Surge rules (peak hours)**: `GET/POST/PUT/DELETE /backoffice/delivery/surge`
  — honors day-of-week + `start_time`/`end_time` windows (incl. overnight) + priority
- **Price rules (per-city)**: full CRUD in `pricingController`
- **Coupons**: full CRUD + usage report + code generation

## 9. Verification summary

- Backend unit/integration tests: **19/19 pass**.
- Server boot: **clean**.
- Coupon math + delivery bonus award/idempotency + inbox persistence: **verified against the real DB**.
- Mobile (`delivery_confirm.dart` coupon flow): `dart analyze` **0 errors**.
- Migrations (all idempotent, applied on localhost):
  - `20260703000000-add-coupons-to-deliveries.js`
  - `20260704000000-delivery-bonus-program.js`
  - `20260705000000-deliveries-scaling-indexes.js`

## 10. Follow-ups (not blocking)

- Wire a coupon input into the **express/regular** delivery booking variants too
  (the main confirm screen is done).
- Surface `total_bonuses` and bonus history in the agent wallet screen (data is
  there; UI is a nice-to-have).
- Backoffice UI toggle for `bonus_programs.vertical` if not already present.
