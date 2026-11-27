# GymsEra API v1.1.0 (`feat/naming-v2-r2`) — Production Cut-Over Runbook

> **Scope:** Coordinating backend release `1.1.0` (`origin/main` `e966d2e` → `feat/naming-v2-r2`), platform migrations `p033`–`p038` (`v32` → `v38`), and organization (tenant) migrations `030`–`032` (`v29` → `v32`).
> **Rule D14 (no old-build compatibility):** Old mobile/CMS/web clients are incompatible once `p033`–`p035` and `030`–`032` land. Release API, CMS, website, and mobile builds together and raise the force-update gate (`MIN_APP_VERSION_IOS`, `MIN_APP_VERSION_ANDROID`) at cut-over.
> **Target host:** Windows Server / IIS (`iisnode`) + MySQL 5.7. Run commands in an elevated **Command Prompt (`cmd.exe`)** inside `C:\inetpub\gymsera_be` unless noted otherwise. Never run `iisreset`, and never use PowerShell `>` / `<` for `mysqldump` or `mysql` (PowerShell defaults to UTF-16 and corrupts SQL streams).

---

## Pre-Cut-Over Checklist

1. **Local rehearsal passed:** Confirm `node src\scripts\dry-run-release-1-1-backup.js` passed against a local throwaway MySQL copy (§8).
2. **Environment safety & disk space check (read-only):**
   ```cmd
   cd C:\inetpub\gymsera_be
   node src\scripts\check-environment.js
   git rev-parse HEAD
   ```
   Confirm `staging: no`, expected platform DB / tenant DB host, `OK: the API would start with these settings.` (exit `0`), and free disk space ≥ 2× total database size.
3. **Stop IIS site, app pool, and scheduled jobs before backing up and migrating:**
   ```cmd
   %windir%\system32\inetsrv\appcmd stop site /site.name:"<GymsEra API site>"
   %windir%\system32\inetsrv\appcmd stop apppool /apppool.name:"<GymsEra API pool>"
   schtasks /Query /FO TABLE | findstr /I GymsEra
   for %T in (daily billing-inbox device-watchdog device-sync device-audit device-retention) do schtasks /Change /TN "GymsEra\%T" /DISABLE
   ```

---

## Cut-Over Checklist (Exact Order)

### 1. Backup Platform Database & Every Organization Database (`mysqldump`)

> **Pre-`p034` table name note:** Before `p034_organization_naming` runs, the platform DB stores organization database names in `tenants.db_name` (and businesses in `gym_listings`). Never guess or derive database names from organization names or codes.

1. Create a dated backup directory, capture the current commit + pre-migration inventory, and **list every organization database** into `%BK%\org-dbs.txt`:
   ```cmd
   set BK=D:\gymsera-backups\release-1-1-YYYY-MM-DD
   mkdir "%BK%"
   git rev-parse HEAD > "%BK%\pre-cutover-sha.txt"
   node src\scripts\run-sql-check.js docs\sql\launch-wipe-inventory-before-p033.sql > "%BK%\inventory-before.txt"
   ```
2. Prepare restricted MySQL 5.7 option files (`C:\gymsera-secure\dump.cnf` for platform DB and `C:\gymsera-secure\dump-tenant.cnf` for tenant DB server if distinct) readable only by Administrators — never store credentials inside `%BK%`:
   ```ini
   [client]
   host=<db host>
   user=<backup user with SELECT, LOCK TABLES, SHOW VIEW, TRIGGER, EVENT>
   # add `password=...` only in C:\gymsera-secure\ on the server
   default-character-set=utf8mb4
   ```
3. **List all non-NULL organization database names directly from MySQL:**
   ```cmd
   set MYSQL_BIN=C:\Program Files\MySQL\MySQL Server 5.7\bin
   "%MYSQL_BIN%\mysql.exe" --defaults-extra-file=C:\gymsera-secure\dump.cnf -N -B gymsera -e "SELECT DISTINCT db_name FROM tenants WHERE db_name IS NOT NULL AND db_name <> '' ORDER BY db_name;" > "%BK%\org-dbs.txt"
   type "%BK%\org-dbs.txt"
   ```
   (If the platform DB is on a separate host from tenant DBs, also run `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA` against `dump-tenant.cnf` to verify no orphan organization DBs are missing from `%BK%\org-dbs.txt`.)
4. **Dump the platform database AND every organization database with `mysqldump`:**
   ```cmd
   set OPTS=--single-transaction --quick --routines --triggers --events --hex-blob --set-gtid-purged=OFF

   "%MYSQL_BIN%\mysqldump.exe" --defaults-extra-file=C:\gymsera-secure\dump.cnf %OPTS% gymsera --result-file="%BK%\platform.sql"

   for /f "usebackq delims=" %D in ("%BK%\org-dbs.txt") do ^
     "%MYSQL_BIN%\mysqldump.exe" --defaults-extra-file=C:\gymsera-secure\dump-tenant.cnf %OPTS% %D --result-file="%BK%\org-%D.sql"
   ```
5. **Verify every dump finished cleanly & record SHA-256 checksums:**
   ```cmd
   dir "%BK%\*.sql"
   findstr /M /C:"-- Dump completed on" "%BK%\*.sql"
   for %F in ("%BK%\*.sql") do certutil -hashfile "%F" SHA256 >> "%BK%\SHA256SUMS.txt"
   ```
   Copy `%BK%` off-server before continuing.

---

### 2. Pull Release Code & Install Dependencies (`npm ci --omit=dev`)

Run from `C:\inetpub\gymsera_be` (`main` after merging `feat/naming-v2-r2`, or `feat/naming-v2-r2` directly if deploying the release branch prior to merge):

```cmd
cd C:\inetpub\gymsera_be
git fetch origin
git status
git checkout feat/naming-v2-r2
git pull --ff-only origin feat/naming-v2-r2
git rev-parse HEAD
npm ci --omit=dev
node src\scripts\check-environment.js
```
(Replace `feat/naming-v2-r2` with `main` if `feat/naming-v2-r2` has already been merged to `main`.) Confirm `check-environment.js` exits `0` and `PLACES_PROVIDER` / `TEST_LOCAL_UPLOAD_DIR` remain **unset** in `.env` and IIS settings.

---

### 3. Apply Migrations on Production (CLI Scripts Only — Platform BEFORE Organization)

> **How migrations run on production:** Migrations do **NOT** run automatically at server start-up. `server.js` runs only read-only version checks (`checkPlatformSchemaVersion()` and `runTenantSchemaCheck()`), which log `[Deploy Warning]` and return `503` on `/api/v1/health/tenant-schema` if behind. You **must** apply migrations via CLI scripts before starting IIS.
> **Strict order:** **Platform DB FIRST (`p033`–`p038`)**, then **Organization DBs SECOND (`030`–`032`)**. `run-tenant-migrations.js` reads `organizations.db_name`, which does not exist until platform migration `p034_organization_naming` completes.

1. **Platform migrations FIRST (`v32` → `v38`: `p033`–`p038`):**
   ```cmd
   node src\scripts\run-platform-migrations.js --dry-run
   node src\scripts\run-platform-migrations.js
   node src\scripts\run-platform-migrations.js --dry-run
   ```
   Confirm the first `--dry-run` lists `p033`–`p038`, live run prints zero `SKIPPING` warnings, and the second `--dry-run` prints `UP TO DATE (no migrations needed)`.

2. **Per-organization migrations SECOND (`v29` → `v32`: `030`–`032`):**
   ```cmd
   node src\scripts\run-tenant-migrations.js --check
   node src\scripts\run-tenant-migrations.js --dry-run
   node src\scripts\run-tenant-migrations.js
   node src\scripts\run-tenant-migrations.js --check
   ```
   If `--check` flags any organization with `NO schema_migrations table`, repair it per [runbooks/tenant-schema.md](runbooks/tenant-schema.md) before applying. Confirm the live run prints `Failed: 0` and the final `--check` prints `OK: every tenant database is at the target.` (exit `0`).

3. **Keep existing production test/demo businesses visible in discovery (test data only):**
   `p038_business_kyc_verification` adds `business_listings.kyc_status DEFAULT 'NOT_SUBMITTED'` without a backfill, which hides every existing `ACTIVE` test business from discovery (`status = 'ACTIVE' AND kyc_status = 'APPROVED'`). Preview first, then approve those existing `ACTIVE` + `NOT_SUBMITTED` rows (update-only, zero deletes):
   ```cmd
   node tools\release-1-1-approve-existing-test-businesses.js
   node tools\release-1-1-approve-existing-test-businesses.js --apply
   ```

4. **Post-migration read-only invariant check:**
   ```cmd
   node src\scripts\run-sql-check.js docs\sql\launch-wipe-inventory.sql > "%BK%\inventory-after.txt"
   node src\scripts\dry-run-release-1-1-backup.js --verify-only --allow-nonlocal
   ```

---

### 4. Start & Restart ONLY via Touching `web.config` (Never `iisreset`)

> **IIS / `iisnode` rule:** **Never** run `iisreset`. Always recycle/restart the Node worker strictly by updating `web.config` (`watchedFiles="web.config;server.js"` in `web.config`).

1. Start the app pool and site if stopped in Pre-Cut-Over, then trigger a clean `iisnode` worker recycle via PowerShell:
   ```cmd
   %windir%\system32\inetsrv\appcmd start apppool /apppool.name:"<GymsEra API pool>"
   %windir%\system32\inetsrv\appcmd start site /site.name:"<GymsEra API site>"
   ```
   ```powershell
   (Get-Item web.config).LastWriteTime = Get-Date
   ```
   (From `cmd.exe`, run: `powershell -NoProfile -Command "(Get-Item 'C:\inetpub\gymsera_be\web.config').LastWriteTime = Get-Date"`.)
2. Re-enable Task Scheduler jobs:
   ```cmd
   for %T in (daily billing-inbox device-watchdog device-sync device-audit device-retention) do schtasks /Change /TN "GymsEra\%T" /ENABLE
   ```
3. Release matching CMS (`gymsera_cms`), website (`gymsera_web`), and mobile (`gyms_era` `1.1.0`) builds, then raise `MIN_APP_VERSION_IOS` and `MIN_APP_VERSION_ANDROID` and re-touch `web.config` if `.env` changed.

---

### 5. Health Checks & Smoke Tests

1. **Health checks (all must pass immediately after `web.config` touch):**
   - **Boot log (`iisnode\` stdout / `logs\`):** confirm `[ErrorJournal] boot ... commit=<new 12-char sha> ...` and **zero** `[Deploy Warning] Platform schema version ... is behind target`.
   - **API liveness & version:**
     ```cmd
     curl -fsS https://api.gymsera.com/api/v1/health
     ```
     Expect HTTP `200`, `data.version === "1.1.0"`, `data.build.commit` matches deployed SHA, and `data.startedAt` is after touching `web.config`.
   - **Organization schema gate:**
     ```cmd
     curl -fsS https://api.gymsera.com/api/v1/health/tenant-schema
     ```
     Expect HTTP `200`, `data.tenantSchema.status === "ok"`, `behindCount === 0`, `failedCount === 0`.
   - **Hidden internal paths:**
     ```cmd
     curl -i -s https://api.gymsera.com/iisnode/index.html
     ```
     Expect HTTP `404`.

2. **Smoke test list:**
   - **Public discovery:** `GET /api/v1/cities` (`200`); `GET /api/v1/discovery/businesses` and `GET /api/v1/discovery/top-businesses` (`200`, existing approved demo businesses visible, `businesses`/`branches` keys, `displayName`, `businessVerified`, **no** `organizationName` or nested `tenant`); `GET /api/v1/discovery/businesses/:businessId` (`200`, includes `businessVerified`).
   - **Auth & `+` email aliases (`NEW-302`):** `POST /api/v1/auth/login` + `GET /api/v1/me/context` (`200`, JWT contains `organizationId` claim and no `tenantId`; stale pre-1.1.0 tokens return `401`).
   - **Host organization/business flows:** `GET /api/v1/host/status` (`200`, `organizationId`, `organizationName`, `nextStep`); `GET /api/v1/host/businesses` (`200`, each item has `branchCount`, `canReceiveBranches`, `businessVerified`, `kycStatus`, `missingForApproval`).
   - **CMS / Admin flows:** `GET /api/v1/admin/review-queue?kind=BUSINESS&page=1&limit=20` (`200`, `{ items, page, total }`); `GET /api/v1/admin/organizations/:organizationId` (`200`, `organization.businesses[]` includes `canReceiveBranches`); `DELETE /api/v1/admin/businesses/:businessId/verify` (on a test business) sets `verifiedAt: null` and rejects registration doc with `"Verification revoked"`.
   - **Force-update config:** `GET /api/v1/meta/app-config` reflects the raised `1.1.0` `minAppVersion.ios` / `minAppVersion.android`.
   - **Scheduled jobs:** `node src\scripts\run-scheduled-job.js daily` exits `0`.

---

### 6. Rollback

> **Full DB restore is mandatory when rolling back:** `031_business_one_id` drops `gym_listing_id`, `032_branch_refund_policy` drops `businesses.refunds_allowed`/`refund_window_days`, and `p033`–`p035` / `030` rename tables, columns, indexes, and enum values. Never revert code without restoring the pre-cut-over dumps.

1. **Stop IIS & scheduled tasks immediately:**
   ```cmd
   %windir%\system32\inetsrv\appcmd stop site /site.name:"<GymsEra API site>"
   %windir%\system32\inetsrv\appcmd stop apppool /apppool.name:"<GymsEra API pool>"
   for %T in (daily billing-inbox device-watchdog device-sync device-audit device-retention) do schtasks /Change /TN "GymsEra\%T" /DISABLE
   ```
   Revert `MIN_APP_VERSION_IOS` / `MIN_APP_VERSION_ANDROID` if they were raised.
2. **Revert application code to `%BK%\pre-cutover-sha.txt` (`e966d2e`) and reinstall deps:**
   ```cmd
   cd C:\inetpub\gymsera_be
   set /p PREV_SHA=<"%BK%\pre-cutover-sha.txt"
   git checkout %PREV_SHA%
   npm ci --omit=dev
   ```
3. **Drop newly renamed databases cleanly and restore platform + every organization dump from `%BK%`:**
   ```cmd
   set MYSQL_BIN=C:\Program Files\MySQL\MySQL Server 5.7\bin
   set BK=D:\gymsera-backups\release-1-1-YYYY-MM-DD

   "%MYSQL_BIN%\mysql.exe" --defaults-extra-file=C:\gymsera-secure\dump.cnf -e "DROP DATABASE gymsera; CREATE DATABASE gymsera CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
   "%MYSQL_BIN%\mysql.exe" --defaults-extra-file=C:\gymsera-secure\dump.cnf gymsera < "%BK%\platform.sql"

   for /f "usebackq delims=" %D in ("%BK%\org-dbs.txt") do (
     "%MYSQL_BIN%\mysql.exe" --defaults-extra-file=C:\gymsera-secure\dump-tenant.cnf -e "DROP DATABASE `%D`; CREATE DATABASE `%D` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
     "%MYSQL_BIN%\mysql.exe" --defaults-extra-file=C:\gymsera-secure\dump-tenant.cnf %D < "%BK%\org-%D.sql"
   )
   ```
4. **Restart ONLY via touching `web.config` (never `iisreset`) & re-enable jobs:**
   ```cmd
   %windir%\system32\inetsrv\appcmd start apppool /apppool.name:"<GymsEra API pool>"
   %windir%\system32\inetsrv\appcmd start site /site.name:"<GymsEra API site>"
   powershell -NoProfile -Command "(Get-Item 'C:\inetpub\gymsera_be\web.config').LastWriteTime = Get-Date"
   for %T in (daily billing-inbox device-watchdog device-sync device-audit device-retention) do schtasks /Change /TN "GymsEra\%T" /ENABLE
   ```
5. **Verify rollback:** `curl -fsS https://api.gymsera.com/api/v1/health` returns `200` with `data.build.commit` matching `%PREV_SHA%`, and revert CMS/web deploys if switched to v2 routes.

---

## 7. Environment Variables (Names Only — Never Print or Commit Values)

Baseline `origin/main` (`e966d2e`) → `feat/naming-v2-r2`:

| Change | Variable Name | Production Setting | Notes |
|---|---|---|---|
| **New** | `PLACES_PROVIDER` | **Do NOT set** (leave unset) | Local/dev only (`fake` serves `/places/*` from seeded `cities`/`areas`); ignored when `NODE_ENV=production`. |
| **New** | `TEST_LOCAL_UPLOAD_DIR` | **Do NOT set** (leave unset) | Automated test harness only (`NODE_ENV=test`). |
| **Removed** | *(none)* | — | 0 variables removed since `origin/main`. |

Existing critical variables to verify: `NODE_ENV=production`, `APP_URL`, `PLATFORM_DB_HOST`, `PLATFORM_DB_NAME`, `TENANT_DB_HOST`, `TENANT_CONN_ENCRYPTION_KEY`, `BIOMETRIC_DATA_KEY`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `GOOGLE_MAPS_SERVER_KEY`, `APPLE_IAP_ENVIRONMENT`, `SANDBOX_PURCHASES_GO_LIVE` (unset), `MIN_APP_VERSION_IOS`, `MIN_APP_VERSION_ANDROID`, `APP_STORE_URL_IOS`, `APP_STORE_URL_ANDROID`.

---

## 8. Pre-Release Dry-Run on Restored Local Throwaway Copy

Verify migrations and post-migration invariants locally against MySQL 5.7 (`127.0.0.1:3308`) on a restored throwaway copy before the production window:

```sh
node src/scripts/dry-run-release-1-1-backup.js --platform-db gymsera_local_walk
```
