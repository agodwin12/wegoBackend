-- WeGo Services Marketplace — Classifieds Re-Architecture Migration
-- Run once against the production database.
-- Safe to run multiple times (uses IF NOT EXISTS / IF EXISTS guards).

-- 1. service_ratings: make request_id nullable (ratings now anchor to listings, not requests)
ALTER TABLE service_ratings
    MODIFY COLUMN request_id INT NULL COMMENT 'Deprecated — now null for listing-based reviews';

-- Remove the unique constraint on request_id if it exists
-- (MySQL: find constraint name first or use this pattern)
ALTER TABLE service_ratings
    DROP INDEX IF EXISTS `request_id`;

-- 2. service_listing_plans: add listing_quota column
ALTER TABLE service_listing_plans
    ADD COLUMN IF NOT EXISTS listing_quota INT NULL DEFAULT NULL
        COMMENT 'Total listings this plan entitles the seller to post. NULL = unlimited.'
    AFTER duration_days;

-- 3. Verify service_listings has plan-related columns (added by ServiceListing.sync in prior sessions)
--    These should already exist; run only if missing:
-- ALTER TABLE service_listings ADD COLUMN IF NOT EXISTS boost_priority INT NOT NULL DEFAULT 0;
-- ALTER TABLE service_listings ADD COLUMN IF NOT EXISTS plan_expires_at DATETIME NULL;
-- ALTER TABLE service_listings ADD COLUMN IF NOT EXISTS plan_activated_at DATETIME NULL;
-- ALTER TABLE service_listings ADD COLUMN IF NOT EXISTS current_plan_id INT NULL;

-- 4. (Optional) Add index on service_listings.boost_priority for fast ranked queries
CREATE INDEX IF NOT EXISTS idx_service_listings_boost
    ON service_listings (boost_priority DESC, created_at DESC);
