-- NEW-124 — is every live tenant database at tenant schema v19? READ-ONLY.
--
-- Run it in one go against the PLATFORM database (the one holding `tenants`), as a user that can
-- SELECT from the platform database and from information_schema. Tenant databases are on the same
-- MySQL server, named in `tenants.db_name` (NEW-122).
--
-- SELECTs only, over information_schema and `tenants`. No INSERT, UPDATE, DELETE, CREATE, ALTER,
-- DROP, no prepared statements. No personal data is selected.
--
-- Send the agent both result grids.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Per live tenant: does `branches.currency` exist (tenant migration 019, GLB-02), and does
--    the database have `schema_migrations` at all? has_branches_currency = 0 confirms NEW-124.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  t.id         AS tenant_id,
  t.tenant_code,
  t.gym_name,
  t.db_name,
  t.updated_at AS tenant_updated_at,
  (SELECT COUNT(*) FROM information_schema.TABLES x
     WHERE x.TABLE_SCHEMA = t.db_name AND x.TABLE_NAME = 'schema_migrations') AS has_schema_migrations,
  (SELECT COUNT(*) FROM information_schema.COLUMNS c
     WHERE c.TABLE_SCHEMA = t.db_name AND c.TABLE_NAME = 'branches' AND c.COLUMN_NAME = 'currency') AS has_branches_currency
FROM tenants t
WHERE t.status = 'ACTIVE'
ORDER BY t.updated_at DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Every column the code selects from `branches` and `gyms` (generated from
--    src/models/tenant/Branch.model.js and Gym.model.js on 2026-10-26) that a live tenant
--    database does NOT have. No row = that tenant is fine for the Gyms tab.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  t.tenant_code,
  t.db_name,
  e.table_name,
  e.column_name AS missing_column
FROM tenants t
JOIN (
  SELECT 'branches' AS table_name, 'id' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'gym_id' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'gym_listing_id' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'branch_name' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'address' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'city_id' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'area_id' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'latitude' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'longitude' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'opening_time' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'closing_time' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'phone' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'timezone' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'currency' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'facilities_json' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'images_json' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'tagline' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'category' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'tags_json' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'description' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'established_year' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'floor_area' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'address_line1' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'address_line2' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'postal_code' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'country' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'status' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'traveler_visibility_status' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'deactivation_reason' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'deactivated_at' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'deactivated_by' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'admin_suspended' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'admin_suspended_reason' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'admin_suspended_at' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'admin_suspended_by' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'billing_locked_at' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'billing_lock_reason' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'created_at' AS column_name
  UNION ALL SELECT 'branches' AS table_name, 'updated_at' AS column_name
  UNION ALL SELECT 'gyms' AS table_name, 'id' AS column_name
  UNION ALL SELECT 'gyms' AS table_name, 'name' AS column_name
  UNION ALL SELECT 'gyms' AS table_name, 'description' AS column_name
  UNION ALL SELECT 'gyms' AS table_name, 'contact_phone' AS column_name
  UNION ALL SELECT 'gyms' AS table_name, 'contact_email' AS column_name
  UNION ALL SELECT 'gyms' AS table_name, 'website' AS column_name
  UNION ALL SELECT 'gyms' AS table_name, 'gender_type' AS column_name
  UNION ALL SELECT 'gyms' AS table_name, 'logo_url' AS column_name
  UNION ALL SELECT 'gyms' AS table_name, 'cover_image_url' AS column_name
  UNION ALL SELECT 'gyms' AS table_name, 'social_links_json' AS column_name
  UNION ALL SELECT 'gyms' AS table_name, 'images_json' AS column_name
  UNION ALL SELECT 'gyms' AS table_name, 'gym_listing_id' AS column_name
  UNION ALL SELECT 'gyms' AS table_name, 'created_at' AS column_name
  UNION ALL SELECT 'gyms' AS table_name, 'updated_at' AS column_name
) e
WHERE t.status = 'ACTIVE'
  AND EXISTS (SELECT 1 FROM information_schema.TABLES x
                WHERE x.TABLE_SCHEMA = t.db_name AND x.TABLE_NAME = e.table_name)
  AND NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS c
                    WHERE c.TABLE_SCHEMA = t.db_name AND c.TABLE_NAME = e.table_name
                      AND c.COLUMN_NAME = e.column_name)
ORDER BY t.tenant_code, e.table_name, e.column_name;
