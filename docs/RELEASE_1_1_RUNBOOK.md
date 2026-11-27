# GymsEra API v1.1.0 (`feat/naming-v2-r2`) — Production Cut-Over & Launch-Wipe Runbook

> **Scope:** Deploy Release `1.1.0` (`origin/main` `e966d2e` → `feat/naming-v2-r2` via PR #247), apply platform migrations `p033`–`p038` (`v32` → `v38`) and per-organization migrations `030`–`032` (`v29` → `v32`), wipe all pre-release test data, and re-create clean demo + Apple/Google review accounts through the real 1.1.0 onboarding flow.
> **Rule D14:** Old mobile/CMS/web clients are incompatible once `p033`–`p035` and `030`–`032` land. Release CMS and website alongside the API at cut-over; keep `MIN_APP_VERSION_IOS` and `MIN_APP_VERSION_ANDROID` unchanged during cut-over and raise each one **only later once 1.1.0 is live in that store**.
> **Target host:** Windows Server / IIS (`iisnode`) + MySQL 5.7. Run commands in an elevated **Command Prompt (`cmd.exe`)** inside `C:\inetpub\gymsera_be` unless noted otherwise. **Owner rule:** never stop or recycle IIS application pools and never run `iisreset`; restart only our API app by touching `web.config`. Never use PowerShell `>` / `<` for `mysqldump` or `mysql` (UTF-16 mangling).

---

## Pre-Cut-Over Preparation

1. Run local rehearsal first against a throwaway local MySQL copy (§9): `node src\scripts\dry-run-release-1-1-backup.js --platform-db gymsera_local_walk`.
2. Check environment safety and disk space (free space ≥ 2× DB size):
   ```cmd
   cd C:\inetpub\gymsera_be
   node src\scripts\check-environment.js
   git rev-parse HEAD
   ```
3. Disable GymsEra scheduled tasks before backups, migrations, and wipe (stopping **only our IIS site** is optional if you want zero HTTP traffic during backup/migration — never stop or recycle the app pool):
   ```cmd
   schtasks /Query /FO TABLE | findstr /I GymsEra
   for %T in (daily billing-inbox device-watchdog device-sync device-audit device-retention) do schtasks /Change /TN "GymsEra\%T" /DISABLE
   REM Optional (our site only — never touch app pools):
   REM %windir%\system32\inetsrv\appcmd stop site /site.name:"<GymsEra API site>"
   ```

---

## Cut-Over Sequence (Exact Order: Backup → Deploy → Migrate → Wipe → Restart → Re-create Demo Data & Verify)

### 1. Backup Platform Database & Every Organization Database (`mysqldump`)

> **Pre-`p034` table name note:** Before `p034` runs, database names live in `tenants.db_name`. Read them directly from MySQL — never guess database names.

1. Record pre-cut-over commit and inventory:
   ```cmd
   set BK=D:\gymsera-backups\release-1-1-YYYY-MM-DD
   mkdir "%BK%"
   git rev-parse HEAD > "%BK%\pre-cutover-sha.txt"
   node src\scripts\run-sql-check.js docs\sql\launch-wipe-inventory-before-p033.sql > "%BK%\inventory-before.txt"
   ```
2. Put MySQL 5.7 dump credentials in restricted `C:\gymsera-secure\dump.cnf` (and `dump-tenant.cnf` if `TENANT_DB_HOST` differs) — never store credentials or `.env` inside `%BK%`:
   ```ini
   [client]
   host=<db host>
   user=<backup user with SELECT, LOCK TABLES, SHOW VIEW, TRIGGER, EVENT>
   # password=... set only on server in restricted folder
   default-character-set=utf8mb4
   ```
3. **List all organization databases into `%BK%\org-dbs.txt`:**
   ```cmd
   set MYSQL_BIN=C:\Program Files\MySQL\MySQL Server 5.7\bin
   "%MYSQL_BIN%\mysql.exe" --defaults-extra-file=C:\gymsera-secure\dump.cnf -N -B gymsera -e "SELECT DISTINCT db_name FROM tenants WHERE db_name IS NOT NULL AND db_name <> '' ORDER BY db_name;" > "%BK%\org-dbs.txt"
   type "%BK%\org-dbs.txt"
   ```
4. **Dump the platform database AND every organization database:**
   ```cmd
   set OPTS=--single-transaction --quick --routines --triggers --events --hex-blob --set-gtid-purged=OFF

   "%MYSQL_BIN%\mysqldump.exe" --defaults-extra-file=C:\gymsera-secure\dump.cnf %OPTS% gymsera --result-file="%BK%\platform.sql"

   for /f "usebackq delims=" %D in ("%BK%\org-dbs.txt") do ^
     "%MYSQL_BIN%\mysqldump.exe" --defaults-extra-file=C:\gymsera-secure\dump-tenant.cnf %OPTS% %D --result-file="%BK%\org-%D.sql"
   ```
5. Verify completion markers and checksums, then copy `%BK%` off-server (if R2 backups are desired prior to wipe, `rclone copy` buckets into `%BK%` too per [runbooks/launch-wipe.md](runbooks/launch-wipe.md) §4.6):
   ```cmd
   dir "%BK%\*.sql"
   findstr /M /C:"-- Dump completed on" "%BK%\*.sql"
   for %F in ("%BK%\*.sql") do certutil -hashfile "%F" SHA256 >> "%BK%\SHA256SUMS.txt"
   ```

---

### 2. Deploy (`git status`, `git pull`, `npm ci --omit=dev`)

From `C:\inetpub\gymsera_be` (after PR #247 merges `feat/naming-v2-r2` into `main`):

```cmd
cd C:\inetpub\gymsera_be
git status
git fetch origin
git checkout main
git pull --ff-only origin main
git rev-parse HEAD
npm ci --omit=dev
node src\scripts\check-environment.js
```
(If deploying directly from `feat/naming-v2-r2` before PR #247 merges, substitute `feat/naming-v2-r2` for `main` above.) Confirm `check-environment.js` exits `0` and `PLACES_PROVIDER` / `TEST_LOCAL_UPLOAD_DIR` remain **unset** in production.

---

### 3. Migrate (CLI Scripts Only — Order: Platform FIRST, Organization SECOND)

> **How migrations get applied:** Migrations do **NOT** run automatically at server start-up. `server.js` runs only read-only checks (`checkPlatformSchemaVersion()`, `runTenantSchemaCheck()`), which log `[Deploy Warning]` / return `503` on `/api/v1/health/tenant-schema` if behind. Run the CLI scripts below **after** backup and **before** restarting IIS or running the wipe.
> **Strict order:** Platform `p033`–`p038` **first**, then per-organization `030`–`032` **second** (`run-tenant-migrations.js` reads `organizations.db_name`, created by `p034`).

1. **Platform migrations (`v32` → `v38`: `p033`–`p038`):**
   ```cmd
   node src\scripts\run-platform-migrations.js --dry-run
   node src\scripts\run-platform-migrations.js
   node src\scripts\run-platform-migrations.js --dry-run
   ```
   Expected: first dry-run lists `p033`–`p038`; live run completes with zero `SKIPPING` warnings; second dry-run reports `UP TO DATE (no migrations needed)`.

2. **Per-organization migrations (`v29` → `v32`: `030`–`032`):**
   ```cmd
   node src\scripts\run-tenant-migrations.js --check
   node src\scripts\run-tenant-migrations.js --dry-run
   node src\scripts\run-tenant-migrations.js
   node src\scripts\run-tenant-migrations.js --check
   ```
   Expected: `Failed: 0`, final `--check` exits `0` (`OK: every tenant database is at the target.`).

---

### 4. Wipe All Test Data & Clean Uploads, Then Restart IIS (`web.config` Only)

See [runbooks/launch-wipe.md](runbooks/launch-wipe.md) for full details and checklists. Confirm admin emails and host/DB values cleanly first:

```cmd
node -e "require('dotenv').config();const c=require('./src/config/database.config');console.log('platform', c.platform.database, '@', c.platform.host, '| tenant', c.tenantServer.host)"
node src\scripts\run-sql-check.js docs\sql\launch-wipe-inventory.sql > "%BK%\inventory-post-migrate.txt"
```

1. **Dry-run wipe first (no changes):**
   ```cmd
   node src\scripts\reset-platform-data.js --keep-admin <admin1@domain>,<admin2@domain> --drop-tenant-databases
   ```
   Verify the plan JSON output:
   - **KEPT (`7` tables + named admins):** `schema_migrations`, `billing_plans`, `billing_plan_prices`, `platform_packages`, `cities`, `areas`, `moderation_words`, plus ONLY the `PLATFORM_ADMIN` rows listed in `--keep-admin` (`KEEP_ADMINS_ONLY`).
   - **EMPTIED (`33` tables):** all other platform tables including `organizations`, `organization_subscriptions`, `organization_invitations`, `user_organization_index`, `business_listings`, `business_reviews`, `saved_businesses`, `member_subscription_index`, `area_requests`/`area_request_links`/`area_aliases`, `content_reports`, `user_blocks`, `billing_events`, `billing_offers`, `billing_plan_price_checks`, `capacity_events`, `payout_accounts`, `plan_payment_requests`, `platform_invoices`, `access_devices`/`devices`/`device_members`/`unclaimed_device_contacts`, `conversations`, `messages`, `notifications`, `device_tokens`, `otps`, `refresh_tokens`, `audit_logs`, `platform_audit_logs`, `idempotency_records`, and all non-admin `users`.
   - **Organization DBs (`organizations.db_name`):** listed under `tenantDatabases` (`droppable: true`).

2. **Execute live wipe (`--confirm --db ... --host ... --drop-tenant-databases`):**
   ```cmd
   node src\scripts\reset-platform-data.js --keep-admin <admin1@domain>,<admin2@domain> --drop-tenant-databases --confirm --db <platform db> --host <platform host>
   ```
   - **What happens to organization DBs:** every mapped database in `organizations.db_name` is **DROPPED** (`DROP DATABASE IF EXISTS`, not truncated table-by-table); orphan schemas not referenced by `organizations` stay untouched unless dropped manually per `inventory-before.txt` list (3).

3. **Uploaded files & server disk cleanup (R2 + disk — see [runbooks/launch-wipe.md](runbooks/launch-wipe.md) §§6–7):**
   - **Private R2 (`R2_KYC_BUCKET`):** delete everything (`biometrics/`, `device-captures/`, `tenants/` including `tenants/<orgId>/kyc/` proof-of-premises/registration docs, `payment-proofs/`, `plan-payment-proofs/`).
   - **Public R2 (`R2_BUCKET`):** keep `cities/`, `areas/`, `profiles/<kept admin id>.*`; delete `gyms/`, `tenants/`, `hosts/`, `users/` (staging uploads), `gym-listings/`, `branches/`, `plans/`, and non-admin `profiles/`.
   - **API server disk:** archive then clear `logs\errors-*.jsonl`, `logs\scheduled-*.log`, `iisnode\`, `%TEMP%\gymsera-logs\`, and verify `public\uploads\` and `storage\private\kyc\` are empty (keep `.env` and `logs\reset-*.jsonl`).
   - Cancel active test subscriptions in Stripe test mode & Google Play tester console, clear any ZKTeco test devices per `launch-wipe.md` §10.

4. **Restart ONLY our app by touching `web.config` (NEVER stop/recycle app pools, NEVER `iisreset`) and Re-Enable Jobs:**
   ```powershell
   (Get-Item web.config).LastWriteTime = Get-Date
   ```
   ```cmd
   REM If you optionally stopped ONLY our site in Pre-Cut-Over Step 3, start our site again:
   REM %windir%\system32\inetsrv\appcmd start site /site.name:"<GymsEra API site>"
   powershell -NoProfile -Command "(Get-Item 'C:\inetpub\gymsera_be\web.config').LastWriteTime = Get-Date"
   for %T in (daily billing-inbox device-watchdog device-sync device-audit device-retention) do schtasks /Change /TN "GymsEra\%T" /ENABLE
   ```
   Deploy matching `gymsera_cms` and `gymsera_web` builds. Leave `MIN_APP_VERSION_IOS` and `MIN_APP_VERSION_ANDROID` alone until Step 7 (`Later Step`).

---

### 5. Post-Wipe Checks & Re-Create Demo Data Through Real 1.1.0 Flow

1. **Immediate post-wipe health & baseline verification (empty discovery):**
   - `curl -fsS https://api.gymsera.com/api/v1/health` → `200`, `data.version === "1.1.0"`, `data.build.commit` matches deployed SHA, zero `[Deploy Warning]` in boot log.
   - `curl -fsS https://api.gymsera.com/api/v1/health/tenant-schema` → `200`, `status === "ok"`, `behindCount === 0`, `failedCount === 0`.
   - `curl -i -s https://api.gymsera.com/iisnode/index.html` → `404`.
   - **Admin login works:** log into CMS as a kept admin; verify `cities`, `areas`, `billing_plans`, `billing_plan_prices`, `platform_packages`, `moderation_words` are intact and `auditCapacity` has 0 findings.
   - **Discovery empty:** `GET /api/v1/discovery/businesses` and `GET /api/v1/discovery/branches` return `[]` (no test gyms).

2. **Re-create clean demo data through the real 1.1.0 flow (fake business/person names + Gmail `+` alias emails):**
   - **Host & organization onboarding:** register demo host (`<alias>+host@gmail.com`) via app → Become a Host (`POST /organizations/register`, `first-business` with `firstBranch` + ≥3 photos, `select-package`, owner ID KYC, `finalize`).
   - **Approve organization:** platform admin approves organization in CMS → verify fresh organization DB provisioned at `v32` (`run-tenant-migrations.js --check` exits `0`) and first business exists in `PENDING` with `heldFirstBranch: true`.
   - **Upload proof & approve business:** demo host uploads `PROOF_OF_PREMISES` (and optional `BUSINESS_REGISTRATION` for verified badge) via `/host/businesses/:businessId/kyc-documents` → admin approves business (`POST /admin/businesses/:id/approve`) → confirm first branch is built (`canReceiveBranches`, `branchCount: 1`).
   - **Activate subscription & public plan:** activate plan for the demo organization and ensure ≥1 public membership plan is active on the demo branch (`why-not-live.js --branch "<demo branch>"` passes).

3. **Post-demo smoke & cron checks:**
   - **Discovery live:** `GET /api/v1/discovery/businesses` and `GET /api/v1/discovery/branches` now show the demo branch (`displayName`, `businessVerified`, zero `organizationName`/`tenant` keys).
   - **Cron jobs:** run `node src\scripts\run-scheduled-job.js daily` → exit `0`; confirm all 6 `GymsEra\*` scheduled tasks show enabled (`0x0` after next run).
   - **iOS / Store Review Accounts (kept ready cleanly with fake names & `+` alias emails, passwords stored only in password manager):**
     - **Host review account (`<alias>+reviewhost@gmail.com`):** verified sign-in via `+` alias, owns the approved demo organization/business/branch, can access `/host/status`, `/host/businesses`, and branch management.
     - **Traveller review account (`<alias>+reviewmember@gmail.com`):** `MEMBER` account registered/verified via `+` alias, able to browse discovery and subscribe/check in to the live demo branch.

---

### 6. Rollback

> Pre-1.1.0 restoration requires restoring code **and** restoring all pre-cut-over database dumps (`031`/`032` drop columns and `p033`–`p035`/`030` rename schemas).

1. Disable scheduled tasks (and optionally stop **only our IIS site** during restore — never stop or recycle any app pool):
   ```cmd
   for %T in (daily billing-inbox device-watchdog device-sync device-audit device-retention) do schtasks /Change /TN "GymsEra\%T" /DISABLE
   REM Optional (our site only — never touch app pools):
   REM %windir%\system32\inetsrv\appcmd stop site /site.name:"<GymsEra API site>"
   ```
2. Revert code and dependencies:
   ```cmd
   cd C:\inetpub\gymsera_be
   set /p PREV_SHA=<"%BK%\pre-cutover-sha.txt"
   git checkout %PREV_SHA%
   npm ci --omit=dev
   ```
3. Restore platform and every organization database from `%BK%`:
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
   (Restore R2 objects from `%BK%\r2-*` if cleared before deciding to roll back.)
4. Restart ONLY our app by touching `web.config` (never touch app pools, never `iisreset`), re-enable tasks, and verify `/api/v1/health` returns `%PREV_SHA%`:
   ```cmd
   REM If you optionally stopped our site above, start our site first:
   REM %windir%\system32\inetsrv\appcmd start site /site.name:"<GymsEra API site>"
   powershell -NoProfile -Command "(Get-Item 'C:\inetpub\gymsera_be\web.config').LastWriteTime = Get-Date"
   for %T in (daily billing-inbox device-watchdog device-sync device-audit device-retention) do schtasks /Change /TN "GymsEra\%T" /ENABLE
   curl -fsS https://api.gymsera.com/api/v1/health
   ```

---

## 7. Later Step (Only When 1.1 Is Live in a Store): Raise `MIN_APP_VERSION`

Do **not** run this during cut-over. Raise each platform's variable in `.env` **only when `1.1.0` is live and downloadable in that store** (App Store Connect / Google Play Console), then restart our API app by touching `web.config`:

1. Set `MIN_APP_VERSION_IOS=<1.1.0 store version>` once iOS 1.1.0 is live on the App Store, and/or `MIN_APP_VERSION_ANDROID=<1.1.0 store version>` once Android 1.1.0 is live on Google Play.
2. Touch `web.config` so `iisnode` reloads `.env` (never stop/recycle app pools):
   ```powershell
   (Get-Item web.config).LastWriteTime = Get-Date
   ```
3. Verify `curl -fsS https://api.gymsera.com/api/v1/meta/app-config` reflects the updated `minAppVersion`.

---

## 8. Environment Variables (Names Only — Never Print or Commit Values)

Baseline `origin/main` (`e966d2e`) → `feat/naming-v2-r2`:

| Change | Variable Name | Production Setting | Notes |
|---|---|---|---|
| **New** | `PLACES_PROVIDER` | **Do NOT set** (leave unset) | Local/dev only (`fake` serves `/places/*` from seeded `cities`/`areas`); ignored when `NODE_ENV=production`. |
| **New** | `TEST_LOCAL_UPLOAD_DIR` | **Do NOT set** (leave unset) | Automated test harness only (`NODE_ENV=test`). |
| **Removed** | *(none)* | — | 0 variables removed since `origin/main`. |

Verify critical variables remain set: `NODE_ENV=production`, `APP_URL`, `PLATFORM_DB_HOST`, `PLATFORM_DB_NAME`, `TENANT_DB_HOST`, `TENANT_CONN_ENCRYPTION_KEY`, `BIOMETRIC_DATA_KEY`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `GOOGLE_MAPS_SERVER_KEY`, `APPLE_IAP_ENVIRONMENT`, `SANDBOX_PURCHASES_GO_LIVE` (unset), `MIN_APP_VERSION_IOS`, `MIN_APP_VERSION_ANDROID`, `APP_STORE_URL_IOS`, `APP_STORE_URL_ANDROID`.

---

## 9. Pre-Release Dry-Run on Restored Local Throwaway Copy

Verify migrations and post-migration invariants locally against MySQL 5.7 (`127.0.0.1:3308`) before the production window:

```sh
node src/scripts/dry-run-release-1-1-backup.js --platform-db gymsera_local_walk
```
