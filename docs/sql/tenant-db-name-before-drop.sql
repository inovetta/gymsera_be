-- R-120: names after migrations p033 / p034 (organizations, organization_subscriptions, business_listings). For a database
-- before them use the `-before-p033` / `-before-p034` copy next to this file.
-- R-79 — which database belongs to this tenant? READ-ONLY. Run it immediately before any drop.
--
-- A tenant database name is never inferred: not from the gymsera_<tenant code> naming rule, not from a
-- doc, not from memory. The only source is organizations.db_name for that organization_code, read just now.
--
-- 1. Replace the tenant code in the SET below.
-- 2. From the app folder that holds server.js and .env (the API server has no mysql client):
--      node src/scripts/run-sql-check.js docs/sql/tenant-db-name-before-drop.sql
--    or paste the SELECT into any MySQL client connected to the platform database.
--
-- Use the db_name value exactly as printed. Stop and do not drop if: no row comes back, more than one
-- row comes back, or db_name is NULL (provisioning never recorded a database; the owner decides by hand).

SET @organization_code = 'GYM-XXXXXXXX';

SELECT organization_code, status, provisioning_state, db_name
FROM organizations
WHERE organization_code = @organization_code;
