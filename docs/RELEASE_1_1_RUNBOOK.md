# GymsEra API v1.1.0 (`feat/naming-v2-r2`) — Production Cut-Over Runbook

> **Scope:** Coordinating backend release `1.1.0` (`origin/main` `e966d2e` → `feat/naming-v2-r2`), platform migrations `p033`–`p038` (`v32` → `v38`), and organization (tenant) migrations `030`–`032` (`v29` → `v32`).
> **Rule D14 (no old-build compatibility):** Old mobile/CMS/web clients are incompatible once `p033`–`p035` and `030`–`032` land. Release API, CMS, website, and mobile builds together and raise the force-update gate (`MIN_APP_VERSION_IOS`, `MIN_APP_VERSION_ANDROID`) at cut-over.
> **NEW-302 (`+` email aliases):** Cherry-picked from `fix/email-plus-space` (`7f9dc17`) into `feat/naming-v2-r2` (`emailField()` in `src/validators/auth.validator.js`).

Target host: Windows / IIS (`iisnode`) with MySQL 5.7. Run commands in an elevated **Command Prompt (`cmd.exe`)** inside the production API checkout (for example `C:\inetpub\gymsera_be`) unless noted otherwise. Never run `iisreset`, and never use PowerShell `>` / `<` for `mysqldump` or `mysql` (UTF-16 mangling).

---

## 1. Environment Variables (Names Only — Never Print or Commit Values)

Compare `origin/main` (`e966d2e`) → `feat/naming-v2-r2` (`fb47422`):

### New Environment Variables

| Variable Name | Production Setting | Notes |
|---|---|---|
| `PLACES_PROVIDER` | **Do NOT set** (leave unset) | Local/dev only (`fake` serves `/places/*` from seeded `cities`/`areas`). Explicitly ignored when `NODE_ENV=production`. |
| `TEST_LOCAL_UPLOAD_DIR` | **Do NOT set** (leave unset) | Automated test harness only (`NODE_ENV=test`). |

### Removed Environment Variables

- **None** (0 environment variables removed since `origin/main`).

### Existing Cut-Over / Gate Variables to Verify Before & During Cut-Over

- `NODE_ENV` (must be `production`), `APP_URL`, `PLATFORM_DB_HOST`, `PLATFORM_DB_NAME`, `TENANT_DB_HOST`, `TENANT_CONN_ENCRYPTION_KEY`, `BIOMETRIC_DATA_KEY`, `JWT_SECRET`, `JWT_REFRESH_SECRET`
- `APPLE_IAP_ENVIRONMENT` (must NOT be `Sandbox` for live customer purchases) and `SANDBOX_PURCHASES_GO_LIVE` (must remain **unset** in production)
- `GOOGLE_MAPS_SERVER_KEY` (required on production for `/places/*` autocomplete, details, reverse-geocode)
- `MIN_APP_VERSION_IOS`, `MIN_APP_VERSION_ANDROID`, `APP_STORE_URL_IOS`, `APP_STORE_URL_ANDROID` (keep old values until step 7/8, then raise to the approved 1.1.0 mobile build)

---

## 2. Pre-Cut-Over Checks & Maintenance Window Freeze

1. **Dry-run rehearsal completed:** Ensure the restored backup dry-run script (`node src/scripts/dry-run-release-1-1-backup.js`, see §10) passed locally on a throwaway copy of production dumps before touching production.
2. **Release gate alignment:** Confirm the new iOS and Android builds (`v1.1.0`) are approved and ready for manual release in App Store Connect and Google Play Console, and CMS/web releases are staged.
3. **Verify environment config (before stopping):**
   ```cmd
   node src\scripts\check-environment.js
   ```
   Expected: `staging: no`, `platform database: gymsera (...)`, `tenant database server: 209.209.42.64 (...)`, `OK: the API would start with these settings.` (exit `0`).
4. **Check disk space:** Confirm the backup drive has free space ≥ 2× total database size.
5. **Stop writers (IIS site, app pool, and scheduled jobs) before backups & table-rename migrations:**
   ```cmd
   %windir%\system32\inetsrv\appcmd stop site /site.name:"<GymsEra API site>"
   %windir%\system32\inetsrv\appcmd stop apppool /apppool.name:"<GymsEra API pool>"
   schtasks /Query /FO TABLE | findstr /I GymsEra
   ```
   Disable each scheduled task (`daily`, `billing-inbox`, `device-watchdog`, `device-sync`, `device-audit`, `device-retention`):
   ```cmd
   schtasks /Change /TN "GymsEra\<name>" /DISABLE
   ```

---

## 3. Backup Platform Database & Every Organization Database

> **Table name note before `p034`:** Before migration `p034_organization_naming` runs, the platform database still names the table `tenants` (`tenant_code`, `db_name`) and `gym_listings` (instead of `organizations` / `business_listings`). Read `db_name` directly from the database — never infer database names.

1. Create a dated backup directory and capture pre-cut-over inventory (adjust script path depending on whether platform is pre-`p033` or post-`p034`):
   ```cmd
   set BK=D:\gymsera-backups\release-1-1-YYYY-MM-DD
   mkdir "%BK%"
   node src\scripts\run-sql-check.js docs\sql\launch-wipe-inventory-before-p033.sql > "%BK%\inventory-before.txt"
   ```
   Extract every non-NULL `db_name` value into `%BK%\org-dbs.txt` (one database name per line, exact spelling from `inventory-before.txt`). Also list any orphan databases not linked to a row in case ops wants a snapshot.

2. Prepare a restricted MySQL 5.7 options file `C:\gymsera-secure\dump.cnf` (do **not** store `.env`, `BIOMETRIC_DATA_KEY`, or `TENANT_CONN_ENCRYPTION_KEY` in `%BK%`):
   ```ini
   [client]
   host=<platform or tenant DB host>
   user=<backup user with SELECT, LOCK TABLES, SHOW VIEW, TRIGGER, EVENT>
   # add `password=` line with restricted file permissions only on the server
   default-character-set=utf8mb4
   ```
   (Create a second `dump-tenant.cnf` if `TENANT_DB_HOST` differs from `PLATFORM_DB_HOST`.)

3. **Dump the platform database AND every organization database:**
   ```cmd
   set MYSQL_BIN=C:\Program Files\MySQL\MySQL Server 5.7\bin
   set OPTS=--single-transaction --quick --routines --triggers --events --hex-blob --set-gtid-purged=OFF

   "%MYSQL_BIN%\mysqldump.exe" --defaults-extra-file=C:\gymsera-secure\dump.cnf %OPTS% gymsera --result-file="%BK%\platform.sql"

   for /f "usebackq delims=" %D in ("%BK%\org-dbs.txt") do ^
     "%MYSQL_BIN%\mysqldump.exe" --defaults-extra-file=C:\gymsera-secure\dump-tenant.cnf %OPTS% %D --result-file="%BK%\org-%D.sql"
   ```

4. **Verify dump integrity & checksums:**
   ```cmd
   dir "%BK%\*.sql"
   findstr /M /C:"-- Dump completed on" "%BK%\*.sql"
   for %F in ("%BK%\*.sql") do certutil -hashfile "%F" SHA256 >> "%BK%\SHA256SUMS.txt"
   ```
   Every `.sql` file must be non-empty and listed by `findstr`. Copy encrypted archive off-server before proceeding.

---

## 4. Pull & Install

In the production API folder (`C:\inetpub\gymsera_be`):

```cmd
git fetch origin
git status
git checkout main
git pull --ff-only origin main
git rev-parse HEAD
```

Install production Node dependencies cleanly:

```cmd
npm ci --omit=dev
```

Re-verify environment safety and new optional variables:

```cmd
node src\scripts\check-environment.js
```

Expected: `OK: the API would start with these settings.` (exit `0`). Ensure `PLACES_PROVIDER` and `TEST_LOCAL_UPLOAD_DIR` are **not** set in `.env` or IIS app pool settings.

---

## 5. Run Migrations in Exact Order

> **CRITICAL ORDERING:** Run **platform migrations FIRST (`p033`→`p038`)**, then **per-organization migrations (`030`→`032`)** (`origin/main` `e966d2e` is already at platform `v32` and tenant `v29`; any older target runs pending earlier steps automatically).
> `run-tenant-migrations.js` calls `platform.js#connect()` and queries `organizations` / `organization_code`, which requires `p033`–`p035` to be applied on the platform database first. Never run tenant migrations before platform migrations.

### 5.1 Platform Migrations (`v32` → `v38`: `p033`–`p038`)

1. Preview pending platform migrations (read-only; uses `sequelize.authenticate()`, zero writes):
   ```cmd
   node src\scripts\run-platform-migrations.js --dry-run
   ```
   Verify pending list ends at target `v38` (`p033_business_naming`, `p034_organization_naming`, `p035_organization_id_columns`, `p036_member_index_branch_id`, `p037_held_first_branch`, `p038_business_kyc_verification`).

2. Apply platform migrations:
   ```cmd
   node src\scripts\run-platform-migrations.js
   ```
   Expected: `From v32 to v38` (or `v<prev> to v38`), zero `SKIPPING` warnings. If any rename conflict is logged (`both tables/columns hold data`), stop, resolve manually, and re-run before proceeding.

3. Re-check platform dry run:
   ```cmd
   node src\scripts\run-platform-migrations.js --dry-run
   ```
   Expected: `UP TO DATE (no migrations needed)`.

### 5.2 Per-Organization (Tenant) Migrations (`v29` → `v32`: `030`–`032`)

1. Check all `ACTIVE`, `SUSPENDED`, and `PENDING_DELETION` organization databases (read-only):
   ```cmd
   node src\scripts\run-tenant-migrations.js --check
   ```
   If any organization prints `NO schema_migrations table`, stop and baseline it first per [runbooks/tenant-schema.md](runbooks/tenant-schema.md) using `repair-tenant-schema.js`.

2. Preview pending per-organization migrations:
   ```cmd
   node src\scripts\run-tenant-migrations.js --dry-run
   ```
   Verify every organization lists up to target `v32` (`030_business_naming`, `031_business_one_id`, `032_branch_refund_policy`).

3. Apply per-organization migrations across all organizations:
   ```cmd
   node src\scripts\run-tenant-migrations.js
   ```
   Expected: `Failed: 0`, every organization `OK`.

4. Run the deploy gate check (must exit `0`):
   ```cmd
   node src\scripts\run-tenant-migrations.js --check
   ```
   Expected: `OK: every tenant database is at the target.` (exit `0`).

5. Capture post-migration read-only inventory & invariant check:
   ```cmd
   node src\scripts\run-sql-check.js docs\sql\launch-wipe-inventory.sql > "%BK%\inventory-after.txt"
   node src\scripts\dry-run-release-1-1-backup.js --verify-only --allow-nonlocal
   ```
   Wait: only pass `--allow-nonlocal` with `--verify-only` if performing read-only post-migration invariant verification on production, or run the full verification first against the restored staging/local copy (§10).

---

## 6. Start / Restart ONLY via Touching `web.config` (Never `iisreset`)

> **IIS / iisnode rule:** Do **not** run `iisreset`. Always recycle the API worker strictly by touching `web.config` (`watchedFiles="web.config;server.js"` in `web.config`).

1. If the site/app pool were stopped in §2, start them first, and recycle/restart the worker cleanly by touching `web.config`:
   ```cmd
   %windir%\system32\inetsrv\appcmd start apppool /apppool.name:"<GymsEra API pool>"
   %windir%\system32\inetsrv\appcmd start site /site.name:"<GymsEra API site>"
   powershell -NoProfile -Command "(Get-Item 'C:\inetpub\gymsera_be\web.config').LastWriteTime = Get-Date"
   ```
   (If the site remained running or to recycle cleanly after config changes, touching `web.config` alone triggers `iisnode` to spawn a fresh `node.exe` process.)

2. Re-enable all `GymsEra\*` Task Scheduler jobs disabled in §2:
   ```cmd
   schtasks /Change /TN "GymsEra\<name>" /ENABLE
   ```

3. Deploy matching CMS (`gymsera_cms`), website (`gymsera_web`), and release mobile builds (`gyms_era`), then set `MIN_APP_VERSION_IOS` and `MIN_APP_VERSION_ANDROID` to the new release build (touch `web.config` if updated inside `.env`).

---

## 7. Health Checks

1. **Boot log verification (`iisnode\` stdout / `logs\`):**
   Confirm a fresh boot line exists with the new commit hash and expected hosts:
   ```
   [ErrorJournal] boot ... commit=<new 12-char sha> ... platformDb=gymsera (.env) tenantDbHost=209.209.42.64 (.env)
   ```
   And confirm zero `[Deploy Warning] Platform schema version ... is behind target` messages.

2. **Liveness & version check:**
   ```cmd
   curl -fsS https://api.gymsera.com/api/v1/health
   ```
   Verify:
   - HTTP `200`
   - `data.version` is `"1.1.0"`
   - `data.build.commit` equals the deployed commit
   - `data.startedAt` is after touching `web.config`

3. **Organization (tenant) schema health check:**
   ```cmd
   curl -fsS https://api.gymsera.com/api/v1/health/tenant-schema
   ```
   Verify: HTTP `200`, `data.tenantSchema.status === "ok"`, `behindCount === 0`, `failedCount === 0`.

4. **Internal path security check:**
   ```cmd
   curl -i -s https://api.gymsera.com/iisnode/index.html
   ```
   Verify HTTP `404` (`web.config` keeps `iisnode`, `logs`, `storage` hidden and `devErrorsEnabled="false"`).

---

## 8. Smoke Tests

1. **Discovery (public + privacy D3/D11):**
   - `GET /api/v1/cities` → `200`, cities/areas load.
   - `GET /api/v1/discovery/businesses` and `GET /api/v1/discovery/top-businesses` → `200`, keys are `businesses` / `branches` (`displayName`, `businessVerified`), and **zero** `organizationName` or `tenant` keys appear in traveller responses.
   - `GET /api/v1/discovery/businesses/:businessId` → `200`, includes `businessVerified` and only `ACTIVE` + `APPROVED` businesses.
2. **Auth & JWT claims:**
   - Sign in with a host/member account (`POST /api/v1/auth/login`) and decode JWT / call `GET /api/v1/me/context` → token carries `organizationId` (no `tenantId` claim); old JWTs without `organizationId` receive `401`.
3. **Host APIs (`X-Organization-Id`):**
   - `GET /api/v1/host/status` → `200`, includes `organizationId`, `organizationName`, `nextStep` (`null` or `{ key, businessId }`).
   - `GET /api/v1/host/businesses` → `200`, each item includes `branchCount`, `businessVerified`, `kycStatus`, `missingForApproval`.
4. **Admin review & verification:**
   - `GET /api/v1/admin/review-queue?kind=BUSINESS&page=1&limit=20` → `200`, `{ items, page, total }`.
   - `GET /api/v1/admin/organizations/:organizationId` → `200`, lists `organization.businesses` (no compound `id1:id2` ids).
   - `DELETE /api/v1/admin/businesses/:businessId/verify` (if tested on a staging/test business) → sets `verifiedAt: null` and rejects `BUSINESS_REGISTRATION` document(s) with `"Verification revoked"`.
5. **Force-update check (`GET /api/v1/meta/app-config`):**
   - Verify `minAppVersion.ios` / `minAppVersion.android` reflect the raised `1.1.0` build once set, and an older build shows the update gate.
6. **Scheduled jobs & fresh-approval invariant:**
   - Run `node src\scripts\run-scheduled-job.js daily` → exit `0`.
   - If approving a fresh test organization, confirm `why-not-live.js --branch <name>` and `run-sql-check.js docs\sql\new-127-fresh-approval-check.sql` pass (`PASS`).

---

## 9. Rollback Procedure

> **Why database restore is the authoritative rollback:** Migrations `031_business_one_id` (drops `gym_listing_id`) and `032_branch_refund_policy` (drops `businesses.refunds_allowed`, `businesses.refund_window_days`) remove columns without backfill, and `p033`–`p035` / `030` rename core tables, columns, indexes, and enum values. Code rollback **must** accompany database rollback so app code and schema stay aligned.

1. **Stop writes immediately:**
   ```cmd
   %windir%\system32\inetsrv\appcmd stop site /site.name:"<GymsEra API site>"
   %windir%\system32\inetsrv\appcmd stop apppool /apppool.name:"<GymsEra API pool>"
   schtasks /Change /TN "GymsEra\<name>" /DISABLE
   ```
   Lower `MIN_APP_VERSION_IOS` / `MIN_APP_VERSION_ANDROID` back to pre-cut-over values if needed.

2. **Revert application code to pre-cut-over `origin/main` (`e966d2e` or exact SHA recorded before pull):**
   ```cmd
   cd C:\inetpub\gymsera_be
   git checkout <pre-cutover-sha>
   npm ci --omit=dev
   ```

3. **Restore platform DB and all organization DB dumps taken in §3:**
   > If any organization DB schema or tables were renamed (`gyms` → `businesses`), drop/recreate cleanly or restore directly from the `--single-transaction` dump (mysqldump emits `DROP TABLE IF EXISTS` for existing tables, so any newly named tables created by `p033`/`p034`/`030` such as `organizations`, `business_listings`, `businesses` should be dropped or the target database recreated clean from the pre-cut-over dump):
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
   (Verify any database storing ZKTeco biometrics with `node src\scripts\rotate-biometric-key.js` dry run.)

4. **Restart ONLY via touching `web.config`:**
   ```cmd
   %windir%\system32\inetsrv\appcmd start apppool /apppool.name:"<GymsEra API pool>"
   %windir%\system32\inetsrv\appcmd start site /site.name:"<GymsEra API site>"
   powershell -NoProfile -Command "(Get-Item 'C:\inetpub\gymsera_be\web.config').LastWriteTime = Get-Date"
   schtasks /Change /TN "GymsEra\<name>" /ENABLE
   ```

5. **Confirm rollback health:**
   - `GET https://api.gymsera.com/api/v1/health` → `200`, `data.build.commit` matches `<pre-cutover-sha>`.
   - Revert CMS/website deploys if they had switched to v2 contract endpoints.

---

## 10. Pre-Release Dry-Run on Restored Local Throwaway Copy

Run the dry-run verification script against a local MySQL (`127.0.0.1:3308`) restored copy before the production window:

```sh
node src/scripts/dry-run-release-1-1-backup.js --platform-db gymsera_local_walk
```

See `src/scripts/dry-run-release-1-1-backup.js` header comments for options (`--verify-only`, `--skip-tenant-migrations`, `--allow-nonlocal`) and the **What to Look At** checklist printed at the end of each run.

