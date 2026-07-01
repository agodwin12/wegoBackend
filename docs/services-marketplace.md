# WeGo Services Marketplace — How it Works & What Changed

A Craigslist-style classifieds marketplace: providers (any user) **post a service**,
**moderators approve** it, and customers **browse and contact** the provider directly.
WeGo never brokers the job or the money between customer and provider — it monetises
by selling **listing plans** (subscriptions) and ranking paid posts above free ones.

This document explains the end-to-end flow and the work done in this pass.

---

## 1. The model (unchanged core, now consistent)

| Concept | Table | Notes |
|---|---|---|
| A post | `service_listings` | title, description, price, photos, city, status, plan, boost, stats |
| A category | `service_categories` | bilingual name + **`icon_url`** (the image the backoffice sets) |
| A plan/subscription | `service_listing_plans` | price, `duration_days`, **`listing_quota`**, `max_photos`, `boost_priority`, `is_hero_placement` |
| A payment | `service_ad_payments` | full money trail: who paid, which plan, amount, period, CamPay link |
| A push/inbox message | `notifications` | one row per recipient + FCM push |

---

## 2. Posting flow (provider)

1. **Buy a plan.** Posting is gated: a provider must have an **active**
   `service_ad_payments` row. Free plans (`price_xaf = 0`) are allowed; paid plans
   give more quota, more photos, and search priority.
2. **Quota check.** If the plan's `listing_quota` is set, the provider can't exceed
   that many posts. `null` = unlimited. The number is **set by the backoffice** per plan.
3. **Create the post** → status **`pending_review`**. It is *not* visible yet.
4. **Moderation** (below) decides `active` or `rejected`.
5. **Expiry.** A daily cron expires posts past `plan_expires_at` → `expired` (hidden).

## 3. Moderation flow (backoffice moderators)

`super_admin` / `admin` / `manager` employees work a FIFO queue:

```
pending_review ──approve──▶ active   (goes live immediately, plan boost+expiry applied)
               └─reject───▶ rejected (reason required; provider edits & resubmits)
```

- **Approve** (`POST …/approve`) sets `active`, stamps `approved_by/at`, copies the
  paid plan's `boost_priority` and `plan_expires_at` onto the listing, and **pushes
  the provider**: *"Your post is live!"*
- **Reject** (`POST …/reject`) requires a ≥10-char reason, sets `rejected`, and
  **pushes the provider** with that reason so they can fix and resubmit.
- An edited post (`PUT …/:id`) returns to `pending_review` automatically.

> 🐞 **Bug fixed this pass:** the old code wrote the status `'pending'`, which is **not
> a valid ENUM value**, so MySQL silently stored an empty string — every new post was
> invisible to moderators, and approvals set `'approved'` (which the public browse
> never shows). The whole vocabulary is now reconciled to `pending_review → active /
> rejected`, in **both** moderation controllers, the provider create/edit paths, the
> stats endpoint, and the Flutter status parser. A migration repairs the broken rows.

## 4. Free vs paid — priority ranking

The public browse is ordered, in this exact precedence:

```
ORDER BY is_hero DESC,          -- featured (hero) posts first
         boost_priority DESC,   -- then paid boost tiers (premium=2, standard=1)
         <chosen sort> DESC     -- then newest / rating / price
```

Because **free plans carry `boost_priority = 0` and `is_hero = false`**, a paid post
**always** outranks a free one. The backoffice controls each plan's `boost_priority`
and `is_hero_placement`, so the paid/free gap is fully configurable.

## 5. "Someone requested my service" (new)

There was no way for a customer to signal interest. Added:

`POST /api/services/listings/:id/contact` (authenticated)
- bumps `contact_count` atomically,
- **pushes the provider**: *"New service request — {customer} is interested in {title}"*
  (with the customer's phone in the payload),
- returns the provider's contact details to the customer.

On mobile, tapping **Call provider** now records this lead (fire-and-forget) before
opening the dialer, so the provider is notified even if the customer calls directly.

## 6. Push notifications (new)

All go through the single `NotificationService.send()` (DB inbox row + FCM data push).
New notification types (added to the `notifications.type` ENUM via migration):

| Type | Recipient | When |
|---|---|---|
| `SERVICE_LISTING_APPROVED` | provider | moderator approves the post |
| `SERVICE_LISTING_REJECTED` | provider | moderator rejects the post (incl. reason) |
| `SERVICE_NEW_REQUEST` | provider | a customer taps "contact" on their post |

Pushes are fire-and-forget — they never block or fail the API response.

## 7. Category images (already end-to-end; verified)

"Use images, not icons" is already wired:
- **Backoffice** → *Services ▸ Categories* uploads an image; the backend stores it to
  Cloudflare R2 and saves the URL in `service_categories.icon_url`.
- **Mobile** renders `Image.network(category.iconUrl)` with a graceful icon fallback
  when a category has no image yet.

So setting a category image in the backoffice is all that's required for it to show
in the app.

## 8. Backoffice traceability

Everything is recorded and reportable:
- **Posts** — `service_listings` with full moderation audit (`approved_by/at`,
  `rejected_by/at`, reason) + stats (`view_count`, `contact_count`, `booking_count`).
- **Money** — `service_ad_payments` stores every plan purchase (payer, plan snapshot,
  amount, period, CamPay payment id). The reports endpoint aggregates **total revenue,
  revenue-by-day, revenue-by-plan, plans sold this month, and growth rate**, with
  CSV/Excel/PDF export.

## 9. Scaling to millions of posts

| Problem | Fix |
|---|---|
| 23 duplicate `listing_id` indexes (old `sync({alter})` bug, heading for MySQL's 64-index cap) | dropped, one unique index kept |
| Ranked browse filesorted the whole active set | composite index `(status, is_hero, boost_priority, created_at)` + a category-scoped twin → index-ordered, no filesort |
| Search used `LIKE '%term%'` (full scan) | **FULLTEXT** index on `(title, description)` + `MATCH … AGAINST` |
| `search` filter silently dropped the plan-expiry filter (duplicate `Op.or`) | rebuilt the WHERE with `Op.and` |
| Unbounded lists | every list endpoint is paginated (`findAndCountAll`, default 20) |

### Benchmark (real load test)

Generated a synthetic dataset of **~128k+ active listings** on local MySQL and timed
the real queries (best of 6, after `ANALYZE TABLE`):

| Query | Index used | Plan | Time |
|---|---|---|---|
| Ranked browse (default marketplace) | `sl_browse_rank` | `Using where`, **no filesort** | **21 ms** |
| Category-scoped ranked browse | `sl_cat_browse_rank` | `Using index` (covering), **no filesort** | **64 ms** |
| FULLTEXT search, realistic term | `ft_listing_search` | index match | **50 ms** |
| FULLTEXT search, term matching 10% of rows | `ft_listing_search` | filesort over 13k matches | 1098 ms* |

\* artifact of test data using only 10 distinct words. Search latency scales with the
size of the **match set**, not the table — selective (real) terms stay ~50 ms.

**Why this holds at 5M:** the browse paths are served entirely by ordered indexes
(`EXPLAIN` shows no filesort and no full scan), so retrieving page 1 is an index seek
that costs the same at 5M rows as at 128k. Writes stay cheap too now that the 23
duplicate indexes are gone. (Note: the FULLTEXT index slows bulk inserts — for a
one-off mass import, drop `ft_listing_search`, load, then re-add it.)

---

## 10. Known follow-ups (honest notes)

- There are **two** moderation controllers (`serviceListingAdmin.controller.js` and
  `backoffice/serviceListingAdmin.controller.js`). Both are now consistent, but they
  should be consolidated into one to avoid future drift.
- City filter still uses a leading-wildcard `LIKE` (not index-friendly). At extreme
  scale, consider a normalized `city_id` or a FULLTEXT/exact-match column.
- The mobile changes are analyzer-clean but not device-run here; smoke-test the
  contact button + the moderation status labels on a device before release.
