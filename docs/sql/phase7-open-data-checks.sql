-- Phase 7 — open data checks (BUG-05, BUG-21, BUG-28, BUG-30). READ-ONLY.
--
-- Run it in one go against the PLATFORM database (the one holding `tenants` and `gym_listings`),
-- as a user that can SELECT from the platform database and every tenant database. The tenant
-- databases are on the same MySQL server (checked 2026-10-26: PLATFORM_DB_HOST = TENANT_DB_HOST),
-- named in `tenants.db_name`.
--
-- What it does: SELECTs only. It also sets session variables (@...) and PREPAREs / EXECUTEs
-- SELECT statements it builds from `tenants.db_name`, because branches and plans live in each
-- tenant's own database. Session variables and prepared statements disappear when the session
-- ends. No INSERT, UPDATE, DELETE, CREATE, ALTER or DROP anywhere.
--
-- Send the agent the result grids. Personal data: none is selected (no e-mail, phone, owner name).
--
-- Names below are the gyms named in the owner's walkthrough (2026-10-24). If a check returns no
-- row, the name is spelled differently in the data: check 0 lists every gym to pick the right one.

SET SESSION group_concat_max_len = 1000000;

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Every gym (tenant) with its database and city, so the names below can be matched.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  t.id            AS tenant_id,
  t.tenant_code,
  t.business_name,
  t.gym_name,
  t.status        AS tenant_status,
  t.kyc_status,
  t.db_name,
  t.city_id,
  (SELECT c.name FROM cities c WHERE c.id = t.city_id) AS city_name,
  JSON_EXTRACT(t.main_branch_data_json, '$.cityId') AS onboarding_city_id,
  t.created_at
FROM tenants t
ORDER BY t.created_at DESC;
-- NEW-113: approval now refuses a gym with no known city (422 city_required). A row with
-- city_name NULL and no onboarding_city_id that exists in `cities` cannot be approved until its
-- city is set.


-- ─────────────────────────────────────────────────────────────────────────────
-- BUG-21 — "savayora": Gyms & Operations shows no branch, "1 of 1 branches used" next to
-- "0 branches · Limit reached". The banner counts tenant-wide used capacity (ACTIVE branches +
-- every organization's reserved_slots); each organization chip counts ACTIVE branches whose
-- gym_listing_id is that organization (branch-quota.service.js). These show which one is off.
-- ─────────────────────────────────────────────────────────────────────────────
SET @bug21_tenant := (
  SELECT id FROM tenants
  WHERE LOWER(business_name) LIKE '%savayora%' OR LOWER(gym_name) LIKE '%savayora%'
  ORDER BY created_at DESC LIMIT 1
);
SET @bug21_db := (SELECT db_name FROM tenants WHERE id = @bug21_tenant);

-- 21a. The tenant, its plan rows (what the banner's maximum comes from).
SELECT
  t.id AS tenant_id, t.business_name, t.gym_name, t.status AS tenant_status, t.db_name,
  s.id AS subscription_id, s.status AS subscription_status, s.payment_status, s.platform,
  s.branch_count, s.over_quota_count, s.created_at AS subscription_created_at
FROM tenants t
LEFT JOIN tenant_subscriptions s ON s.tenant_id = t.id
WHERE t.id = @bug21_tenant
ORDER BY s.created_at DESC;

-- 21b. Its organizations (listings) with the reserved, unbuilt slots each one holds.
SELECT id AS listing_id, title, status AS listing_status, reserved_slots, created_at, updated_at
FROM gym_listings
WHERE tenant_id = @bug21_tenant
ORDER BY created_at;

-- 21c. Its branches: status, traveller visibility and which organization each one is filed under
-- (gym_listing_id NULL or pointing at a listing not in 21b = the chip counts it nowhere).
SET @sql := IF(@bug21_db IS NULL,
  'SELECT ''BUG-21: no tenant matched savayora, or it has no database yet'' AS note',
  CONCAT(
    'SELECT b.id AS branch_id, b.branch_name, b.status AS branch_status, ',
    'b.traveler_visibility_status, b.admin_suspended, b.gym_listing_id, ',
    '(SELECT l.title FROM gym_listings l WHERE l.id = b.gym_listing_id) AS listing_title, ',
    '(SELECT l.status FROM gym_listings l WHERE l.id = b.gym_listing_id) AS listing_status, ',
    'b.created_at, b.updated_at ',
    'FROM `', @bug21_db, '`.branches b ORDER BY b.created_at'));
PREPARE q FROM @sql; EXECUTE q; DEALLOCATE PREPARE q;


-- ─────────────────────────────────────────────────────────────────────────────
-- BUG-28 — "Inovetta fitness" and "savesto": most gym cards have no photo although photos were
-- uploaded. Discovery uses the branch's images_json[0], else the gym's (organization's) cover,
-- else its images_json (discovery.service.js). Onboarding photos are stored on the tenant
-- (main_branch_data_json.imagesJson) and copied only to the first branch at approval.
-- ─────────────────────────────────────────────────────────────────────────────

-- 28a. Tenant and listing image fields.
SELECT
  t.id AS tenant_id, t.business_name, t.gym_name, t.status AS tenant_status, t.db_name,
  t.cover_image_url AS tenant_cover, t.logo_url AS tenant_logo,
  JSON_EXTRACT(t.main_branch_data_json, '$.imagesJson') AS onboarding_images,
  l.id AS listing_id, l.title AS listing_title, l.status AS listing_status,
  l.cover_image_url AS listing_cover, l.logo_url AS listing_logo, l.images_json AS listing_images
FROM tenants t
LEFT JOIN gym_listings l ON l.tenant_id = t.id
WHERE LOWER(t.business_name) REGEXP 'inovetta|savesto'
   OR LOWER(t.gym_name) REGEXP 'inovetta|savesto'
   OR LOWER(l.title) REGEXP 'inovetta|savesto'
ORDER BY t.business_name, l.created_at;

-- 28b. Their branches' and gyms' image fields, from each tenant database.
SET @sql := (
  SELECT GROUP_CONCAT(
    CONCAT(
      'SELECT ', QUOTE(t.business_name), ' AS business_name, b.id AS branch_id, b.branch_name, ',
      'b.status AS branch_status, b.traveler_visibility_status, b.gym_listing_id, ',
      'b.images_json AS branch_images, g.cover_image_url AS gym_cover, g.images_json AS gym_images ',
      'FROM `', t.db_name, '`.branches b LEFT JOIN `', t.db_name, '`.gyms g ON g.id = b.gym_id'
    ) SEPARATOR ' UNION ALL ')
  FROM tenants t
  WHERE t.db_name IS NOT NULL
    AND (LOWER(t.business_name) REGEXP 'inovetta|savesto' OR LOWER(t.gym_name) REGEXP 'inovetta|savesto')
);
SET @sql := IFNULL(@sql, 'SELECT ''BUG-28: no tenant matched inovetta / savesto with a database'' AS note');
PREPARE q FROM @sql; EXECUTE q; DEALLOCATE PREPARE q;


-- ─────────────────────────────────────────────────────────────────────────────
-- BUG-30 — "Near You" showed a "Submitted! Your gym is under review" card. The app never draws
-- that text on Home; the likely cause is a screenshot of that screen uploaded as a gym photo.
-- These are the image URLs travellers can see: open the ones of the gym in the screenshot.
-- ─────────────────────────────────────────────────────────────────────────────

-- 30a. Every live organization's own images.
SELECT
  l.id AS listing_id, l.title, t.business_name, l.status AS listing_status,
  l.cover_image_url, l.logo_url, l.images_json, l.updated_at
FROM gym_listings l
JOIN tenants t ON t.id = l.tenant_id
WHERE l.status = 'ACTIVE' AND t.status = 'ACTIVE'
ORDER BY l.updated_at DESC;

-- 30b. Every live branch's own images (the first one is the card photo).
SET @sql := (
  SELECT GROUP_CONCAT(
    CONCAT(
      'SELECT ', QUOTE(t.business_name), ' AS business_name, b.id AS branch_id, b.branch_name, ',
      'JSON_UNQUOTE(JSON_EXTRACT(b.images_json, ''$[0]'')) AS card_photo, b.images_json, b.updated_at ',
      'FROM `', t.db_name, '`.branches b ',
      'WHERE b.status = ''ACTIVE'' AND b.traveler_visibility_status = ''active'''
    ) SEPARATOR ' UNION ALL ')
  FROM tenants t
  WHERE t.status = 'ACTIVE' AND t.db_name IS NOT NULL
);
SET @sql := IFNULL(@sql, 'SELECT ''BUG-30: no ACTIVE tenant with a database'' AS note');
PREPARE q FROM @sql; EXECUTE q; DEALLOCATE PREPARE q;


-- ─────────────────────────────────────────────────────────────────────────────
-- BUG-05 — branches with no plan travellers can see. Same rule as discovery
-- (discovery.service.js): a plan counts when status = 'ACTIVE' and is_public = 1, and it is
-- either for this branch or for every branch (branch_id NULL). is_deactivated is shown too.
-- Listed: every ACTIVE branch of every ACTIVE or under-review tenant with a database. A branch
-- with visible_plans = 0 is hidden from travellers today; these are the rows to fix (P4).
-- ─────────────────────────────────────────────────────────────────────────────
SET @sql := (
  SELECT GROUP_CONCAT(
    CONCAT(
      'SELECT ', QUOTE(t.id), ' AS tenant_id, ', QUOTE(t.business_name), ' AS business_name, ',
      QUOTE(t.status), ' AS tenant_status, b.id AS branch_id, b.branch_name, ',
      'b.traveler_visibility_status, ',
      '(SELECT COUNT(*) FROM `', t.db_name, '`.membership_plans p ',
      ' WHERE (p.branch_id = b.id OR p.branch_id IS NULL)) AS all_plans, ',
      '(SELECT COUNT(*) FROM `', t.db_name, '`.membership_plans p ',
      ' WHERE (p.branch_id = b.id OR p.branch_id IS NULL) AND p.status = ''ACTIVE'' AND p.is_public = 1) AS visible_plans, ',
      '(SELECT COUNT(*) FROM `', t.db_name, '`.membership_plans p ',
      ' WHERE (p.branch_id = b.id OR p.branch_id IS NULL) AND p.status = ''ACTIVE'' AND p.is_public = 1 ',
      ' AND p.is_deactivated = 0) AS visible_and_not_deactivated ',
      'FROM `', t.db_name, '`.branches b WHERE b.status = ''ACTIVE'''
    ) SEPARATOR ' UNION ALL ')
  FROM tenants t
  WHERE t.db_name IS NOT NULL
    AND t.status IN ('ACTIVE', 'APPROVED', 'PENDING_REVIEW', 'UNDER_REVIEW')
);
SET @sql := IFNULL(@sql, 'SELECT ''BUG-05: no tenant with a database'' AS note');
SET @sql := CONCAT('SELECT * FROM (', @sql, ') x ORDER BY x.visible_plans, x.business_name, x.branch_name');
PREPARE q FROM @sql; EXECUTE q; DEALLOCATE PREPARE q;

-- 05b. Applications not yet approved (no tenant database yet): the plans entered in onboarding
-- and how many are marked visible. Onboarding keeps them in main_branch_data_json.plans
-- (older drafts: .packages); the key for visibility there is isPublic.
SELECT
  t.id AS tenant_id, t.business_name, t.status AS tenant_status,
  JSON_LENGTH(COALESCE(JSON_EXTRACT(t.main_branch_data_json, '$.plans'),
                       JSON_EXTRACT(t.main_branch_data_json, '$.packages'))) AS onboarding_plans,
  JSON_EXTRACT(t.main_branch_data_json, '$.plans[*].isPublic') AS plans_is_public
FROM tenants t
WHERE t.db_name IS NULL
  AND t.status IN ('DRAFT', 'PENDING_REVIEW', 'UNDER_REVIEW', 'APPROVED')
ORDER BY t.created_at DESC;
