# Launch-day wipe: removing test data before real customers

> **Status (2026-11-15):** runbook prepared from the code on `main` (`54fc742`), read-only. Nothing has been run on
> production. The real run is the owner's.
> **P10 check (2026-11-03):** `reset-platform-data.js` defaults to a dry run, the real run needs `--confirm --db --host`
> and `--keep-admin`, tenant drops use only `tenants.db_name` (R-79), and `tests/regression/reset-platform-data.test.js`
> passes in the full suite.

> **R-120 / Release 1.1.0 (2026-11-27): schema & keep-list.** Platform migrations `p033`–`p038` renamed `tenants` → `organizations`, `tenant_subscriptions` → `organization_subscriptions`, `tenant_invitations` → `organization_invitations`, `user_org_index` → `user_organization_index`, `gym_listings` → `business_listings` (adding `first_branch_draft_json`, `kyc_*`), `gym_reviews` → `business_reviews`, `saved_gyms` → `saved_businesses`, and `user_gym_memberships` → `member_subscription_index`; organization DB migrations `030`–`032` renamed `gyms` → `businesses` and moved refund columns to `branches`. `platform-reset.service.js` classifies every base table in `information_schema.tables` (`KEEP_TABLES`, `users` `KEEP_ADMINS_ONLY`, or `EMPTY`), including keeping `moderation_words` (`p031`). Use `docs/sql/launch-wipe-inventory.sql` and `docs/sql/tenant-db-name-before-drop.sql` after `p033`–`p038`.

Owner: Amir. Script: `src/scripts/reset-platform-data.js` (service `src/services/platform-reset.service.js`).
Target: the Windows / IIS API server with MySQL 5.7. The database holds TEST data only (R-19), but the wipe cannot be
undone except from the dumps in section 4. Do the steps in order and tick them.

All commands are for **Command Prompt (cmd.exe)**, run as an administrator, in the API folder (the one with
`server.js` and `.env`; below `C:\inetpub\gymsera_be`, use yours). Do not use PowerShell for the `mysqldump` and
`mysql` lines: PowerShell's `>` writes UTF-16 and it has no `<`.

Contents: [1 Where test data lives](#1-where-test-data-lives-and-what-to-keep) ·
[2 Decide before the day](#2-decide-before-the-day) · [3 Preconditions](#3-preconditions) ·
[4 Backup and restore proof](#4-backup-and-restore-proof) · [5 The wipe](#5-the-wipe) ·
[6 Object storage](#6-object-storage-r2) · [7 Everything else](#7-everything-else) ·
[8 Verify](#8-verify-after-the-wipe) · [9 First day](#9-first-day-after-the-wipe) ·
[10 Old users on the access device](#10-clearing-the-old-users-from-the-access-device) ·
[Rollback](#rollback) · [Escalate](#escalate)

---

## 1. Where test data lives, and what to keep

| Place | What is there | Removed by | Keep |
|---|---|---|---|
| Platform database (`PLATFORM_DB_NAME`, 41 base tables at `v38`) | `organizations`, `organization_subscriptions`, `organization_invitations`, `user_organization_index`, `business_listings`, `business_reviews`, `saved_businesses`, `member_subscription_index`, messages, conversations, notifications, OTPs, refresh tokens, `device_tokens`, `access_devices`/`devices`/`device_members`/`unclaimed_device_contacts`, `content_reports`, `user_blocks`, `area_requests`/`area_request_links`/`area_aliases`, `billing_events`, `billing_offers`, `billing_plan_price_checks`, `capacity_events`, `payout_accounts`, `plan_payment_requests`, `platform_invoices`, `audit_logs`, `platform_audit_logs`, `idempotency_records`, non-admin `users` | the script (section 5): every base table outside `KEEP_TABLES` is emptied (`EMPTY`), and `users` keeps only named admins (`KEEP_ADMINS_ONLY`) | `schema_migrations`, `billing_plans`, `billing_plan_prices`, `platform_packages`, `cities`, `areas`, `moderation_words`, and the `PLATFORM_ADMIN` rows named with `--keep-admin` |
| Organization databases (one per org, name in `organizations.db_name`, `030`–`032` `businesses`, `branches`, …) | members' subscriptions, payments, invoices, ledger, staff, roles, device commands, biometric templates (encrypted), import staging, attendance | **dropped** (`DROP DATABASE IF EXISTS`) by the script with `--drop-tenant-databases` (or left in place if omitted) | nothing (each new organization gets a clean DB provisioned at `v32` when approved) |
| Databases on the server that no organization names (orphans, half-provisioned, scratch copies) | anything | **not** touched by the script | owner decides each one (2.4) |
| R2 public bucket (`R2_BUCKET`) | business/branch/organization photos, plan posters, staging uploads (`hosts/`, `users/`), profile photos | by hand (section 6) | `cities/`, `areas/`, `profiles/<kept admin id>.*` |
| R2 private bucket (`R2_KYC_BUCKET`, else `<R2_BUCKET>-kyc`) | organization & business KYC documents (`PROOF_OF_PREMISES`, `BUSINESS_REGISTRATION`, `OWNER_ID`), payment proofs, plan-payment proofs, biometric photos, door capture photos | by hand (section 6) | nothing |
| API server disk | `logs\` (error journal `errors-*.jsonl`, `scheduled-*.log`), `iisnode\` stdout/stderr logs, `%TEMP%\gymsera-logs\`; local fallbacks `public\uploads\` and `storage\private\kyc\` (must be empty in production, SEC-08) | by hand (section 7) | `logs\reset-*.jsonl` from this wipe; `.env` |
| Redis | not used in production (R-88, `DISABLE_REDIS=true`) | nothing to do | n/a |
| Scheduled jobs | Task Scheduler tasks `GymsEra\*`. Job locks are MySQL `GET_LOCK` (held only while a job runs, nothing stored); job work rows live in the databases above | disabled before, enabled after | the tasks themselves |
| Push / Firebase | FCM tokens are stored only in platform `device_tokens` (emptied). Firebase holds **no user accounts**: the app uses `firebase_messaging` only, and Google sign-in is verified by the API, not Firebase Auth | the script | the Firebase project and its keys |
| QR codes | none stored: attendance QR codes are signed tokens valid 60 s, made on request (`src/utils/qr.utils.js`); replay nonces are in process memory | n/a | n/a |
| Store / Stripe sandbox | test subscriptions in Stripe test mode, Apple sandbox, Google Play license testers | by hand (section 7) | production keys and products |
| Access devices (ZKTeco) | old device users (test members, fingerprints, faces), attendance punches, device administrators | on the device (section 10) | at least one device administrator |
| Settings | there is no platform settings table: settings are the API `.env` and the IIS / Task Scheduler setup | not touched | all of it |

---

## 2. Decide before the day

- [ ] **2.1** Keep `billing_offers` and `billing_plan_price_checks`? Default: emptied. To keep them, add them to
  `KEEP_TABLES` in `platform-reset.service.js` (with a test) before the day.
- [ ] **2.2** Which platform admins stay: at least two, so one can recover the other. Not the seeded accounts from
  `src/seeders/seed.js` (spec §16 "Before adding real data"); a seeded admin that is not named is removed by the wipe.
- [ ] **2.3** Are the R2 buckets used by this production API only, or shared with staging or a developer machine?
  Compare `R2_BUCKET` and `R2_KYC_BUCKET` in the production and staging `.env`. Shared means section 6 deletes **per
  tenant id**, never whole top-level folders.
- [ ] **2.4** Every database that inventory list (3) shows ("no tenant names it"): drop by hand, keep, or leave.
  Decide while the tenant rows still exist; after the wipe nothing links a database to a tenant.
- [x] **2.5** How to clear the old users from the access device: **decided R-104 (2026-11-15): A, the device menu**
  (section 10).
- [ ] **2.6** The `noreply@gymsera.com` mailbox password has been changed (spec §16).

---

## 3. Preconditions

- [ ] **3.1** Release freeze: no mobile / CMS / web release is rolling out. The API on the server is a build that
  holds this runbook's script (`src\scripts\reset-platform-data.js` and `docs\sql\launch-wipe-inventory.sql` exist).
- [ ] **3.2** Every platform and tenant migration has run (new tenants are provisioned at the latest schema):
  ```
  node src\scripts\run-platform-migrations.js --dry-run
  node src\scripts\run-tenant-migrations.js --check
  ```
  Expected: the first lists nothing pending; the second exits 0 (`echo %ERRORLEVEL%`).
- [ ] **3.3** The configuration points where you think (prints names and hosts only, no secrets):
  ```
  node -e "require('dotenv').config();const c=require('./src/config/database.config');console.log('platform', c.platform.database, '@', c.platform.host, '| tenant server', c.tenantServer.host)"
  ```
  Write down the platform database name and host exactly as printed: they are `--db` and `--host` in 5.2.
- [ ] **3.4** The tenant admin account can drop databases. The dry run does **not** open this connection, so a wrong
  `TENANT_DB_ADMIN_USER` / `TENANT_DB_ADMIN_PASS` would only show in the real run, **after** the platform rows are
  gone (see [Escalate](#escalate)). Prove it now:
  ```
  node -e "require('dotenv').config();const c=require('./src/config/database.config').tenantServer;require('mysql2/promise').createConnection({host:c.host,port:c.port,user:c.adminUser,password:c.adminPass}).then(async x=>{const [r]=await x.query('SHOW GRANTS');r.forEach(o=>console.log(Object.values(o)[0]));await x.end()}).catch(e=>{console.error('FAILED',e.code);process.exit(1)})"
  ```
  Expected: `GRANT … DROP … ON …` lines that cover every tenant database (for example `ON *.*`, or a pattern that
  matches each `db_name` from 3.6). `FAILED`, or no `DROP`: stop and fix the account first.
- [ ] **3.5** Disk space: free space on the backup drive is at least twice the total size of the databases.
- [ ] **3.6** Inventory (read-only), saved next to the backup:
  ```
  mkdir D:\gymsera-wipe\2026-MM-DD
  node src\scripts\run-sql-check.js docs\sql\launch-wipe-inventory.sql > D:\gymsera-wipe\2026-MM-DD\inventory-before.txt
  type D:\gymsera-wipe\2026-MM-DD\inventory-before.txt
  ```
  It prints (1) every tenant: `id` (a UUID, the R2 folder name), `tenant_code`, `status`, `provisioning_state`,
  `db_name`; (2) tenants with no `db_name`; (3) databases on this MySQL server that no tenant names; (4) the platform
  admins' ids; (5) exact row counts. Exit code 0. Keep this file: sections 4, 6 and 8 use it.
- [ ] **3.7** Copy the `db_name` column of list (1) into `D:\gymsera-wipe\2026-MM-DD\tenant-dbs.txt`, one name per
  line, exactly as printed (R-79: copy, never type). Leave out rows where it is `NULL`.
- [ ] **3.8** Stop everything that writes (the API, the device endpoints, the jobs):
  ```
  %windir%\system32\inetsrv\appcmd stop site /site.name:"<GymsEra API site>"
  %windir%\system32\inetsrv\appcmd stop apppool /apppool.name:"<GymsEra API pool>"
  schtasks /Query /FO TABLE | findstr /I GymsEra
  ```
  Then for each task listed (`daily`, `billing-inbox`, `device-watchdog`, `device-sync`, `device-audit`,
  `device-retention`): `schtasks /Change /TN "GymsEra\<name>" /DISABLE`. Expected: `"<site>" successfully stopped`,
  `"<pool>" successfully stopped`, and `SUCCESS: The parameters of scheduled task … have been changed.` for each task.
  The node scripts below still run: they are separate processes. Devices keep their punches while the API is down.

---

## 4. Backup and restore proof

Taken after 3.8 (nothing writes), before section 5.

> **Never store `BIOMETRIC_DATA_KEY` with the dumps**, nor `ENCRYPTION_KEY` or anything else from `.env`. A dump
> holds the biometric templates and the tenant connection strings encrypted; a dump plus its key is the cleartext.
> Do not copy `.env` into the backup folder. Keep the key versions in the password manager, in a different entry from
> the archive password.

**4.1 Credentials file** (keeps the password off the command line). `C:\gymsera-secure\dump.cnf`, readable only by
you (`icacls C:\gymsera-secure /inheritance:r /grant:r "%USERNAME%":F`):
```
[client]
host=<platform DB host from 3.3>
user=<an account with SELECT, LOCK TABLES, SHOW VIEW, TRIGGER, EVENT on every GymsEra database>
password=YOUR_PASSWORD_HERE
default-character-set=utf8mb4
```
If the tenant server (3.3) is another host, make a second file for it. Delete the file(s) at the end of the day.

**4.2 Dump the platform database and every tenant database.** Use the MySQL 5.7 client tools
(`C:\Program Files\MySQL\MySQL Server 5.7\bin`). With an 8.0 `mysqldump` against 5.7, add `--column-statistics=0`.
`--databases` is left out on purpose: the files then restore into any database name, which the restore drill needs.
```
set MYSQL_BIN=C:\Program Files\MySQL\MySQL Server 5.7\bin
set BK=D:\gymsera-wipe\2026-MM-DD
set OPTS=--single-transaction --quick --routines --triggers --events --hex-blob --set-gtid-purged=OFF

"%MYSQL_BIN%\mysqldump.exe" --defaults-extra-file=C:\gymsera-secure\dump.cnf %OPTS% <platform db name from 3.3> --result-file="%BK%\platform.sql"

for /f "usebackq delims=" %D in ("%BK%\tenant-dbs.txt") do "%MYSQL_BIN%\mysqldump.exe" --defaults-extra-file=C:\gymsera-secure\dump.cnf %OPTS% %D --result-file="%BK%\tenant-%D.sql"
```
(`%D` at the prompt, `%%D` inside a `.bat`. `--defaults-extra-file` must stay the first option.)
Expected: no output and exit code 0. Any `mysqldump: Got error`: stop.

**4.3 Check the files.**
```
dir "%BK%\*.sql"
findstr /M /C:"-- Dump completed on" "%BK%\*.sql"
for %F in ("%BK%\*.sql") do certutil -hashfile "%F" SHA256 >> "%BK%\SHA256SUMS.txt"
```
Expected: one `platform.sql` plus one `tenant-<db_name>.sql` per line of `tenant-dbs.txt`, none of size 0, and
`findstr` lists **every** file (a dump cut short has no "Dump completed" line).

**4.4 Store them off the server, encrypted.** With 7-Zip (AES-256, file names hidden):
```
"C:\Program Files\7-Zip\7z.exe" a -t7z -mhe=on -p "D:\gymsera-wipe\gymsera-wipe-2026-MM-DD.7z" "%BK%\*"
```
It asks for a password: a new one, kept in the password manager (not in the `BIOMETRIC_DATA_KEY` entry). Copy the
`.7z` to two places off the server (for example the owner's encrypted drive and a private cloud folder). Keep it at
least until the first real month is closed. The plain `.sql` files stay on the server only until the drill passes; then
`del "%BK%\*.sql"`, keeping `inventory-before.txt`, `SHA256SUMS.txt` and the `.7z`.

**4.5 Restore proof on staging** (never on production). Copy the `.7z` to the staging MySQL 5.7 machine, extract it,
check a checksum (`certutil -hashfile platform.sql SHA256` equals its line in `SHA256SUMS.txt`), then, with a
`staging.cnf` made like 4.1 for the staging server:
```
mysql --defaults-extra-file=C:\gymsera-secure\staging.cnf -e "CREATE DATABASE wipe_restore_platform CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
mysql --defaults-extra-file=C:\gymsera-secure\staging.cnf wipe_restore_platform -e "source D:/restore/platform.sql"
mysql --defaults-extra-file=C:\gymsera-secure\staging.cnf -e "CREATE DATABASE wipe_restore_tenant CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
mysql --defaults-extra-file=C:\gymsera-secure\staging.cnf wipe_restore_tenant -e "source D:/restore/tenant-<the largest db_name>.sql"
```
(`source` takes forward slashes.) Then compare:
- Query 5 of `docs/sql/launch-wipe-inventory.sql`, pasted into `mysql … wipe_restore_platform`: every count equals
  the one in `inventory-before.txt`.
- `SELECT COUNT(*) FROM tenants;` equals the number of rows in list (1).
- On `wipe_restore_tenant`: `SELECT MAX(version) FROM schema_migrations; SELECT COUNT(*) FROM member_subscriptions;
  SELECT COUNT(*) FROM payments;` all return numbers, not errors.

Pass = every count matches. Record "launch-wipe restore drill passed, <date>, counts match" in spec §13 (it is also
§17 item 12). Then, on staging only, `DROP DATABASE wipe_restore_platform; DROP DATABASE wipe_restore_tenant;` and
delete the extracted files there.

**4.6 Object storage is not in the dumps.** R2 deletions (section 6) cannot be undone. If anything there might be
wanted later, copy it first (`rclone copy gymsera-r2:<bucket> D:\gymsera-wipe\r2-<bucket>`, rclone set up as in 6.1)
and add it to the encrypted archive.

---

## 5. The wipe

### Database names: read them, never infer them (R-79)

A tenant database name is **never inferred**: not from the `gymsera_<tenant code>` naming rule, not from this
runbook, not from memory. The only source is `tenants.db_name` for that `tenant_code`, read **immediately before the
drop**:
```sql
-- Read-only. On the platform database. The same query: docs/sql/tenant-db-name-before-drop.sql
SELECT tenant_code, status, provisioning_state, db_name FROM tenants WHERE tenant_code = 'GYM-XXXXXXXX';
```
On the server: `node src\scripts\run-sql-check.js docs\sql\tenant-db-name-before-drop.sql` after setting the code in
its `SET` line. Stop, do not drop, if no row or more than one row comes back, or `db_name` is NULL (the owner decides
by hand).

### 5.1 Dry run

```
node src\scripts\reset-platform-data.js --keep-admin <admin1@…>,<admin2@…> --drop-tenant-databases
```
Expected (one JSON line each, prefixed `[reset]`):
```
[reset] {"at":"…","event":"start","mode":"DRY_RUN","database":"<platform db>","host":"<host>","dropTenantDatabases":true}
[reset] {"at":"…","event":"plan","tables":[{"name":"areas","rows":N,"action":"KEEP"}, …],"users":{"total":N,"keep":2,"remove":N},"adminIdsKept":["…","…"],"tenantDatabases":[{"organizationId":"…","organizationCode":"GYM-…","status":"…","dbName":"…","droppable":true}, …]}
[reset] {"at":"…","event":"dry_run_done","note":"nothing was changed; …"}

DRY_RUN: log written to C:\inetpub\gymsera_be\logs\reset-<time>.jsonl
Nothing was changed.
```
Tick:
- [ ] All seven keep tables (`schema_migrations`, `billing_plans`, `billing_plan_prices`, `platform_packages`, `cities`, `areas`, `moderation_words`) say `KEEP`, `users` says `KEEP_ADMINS_ONLY`, every other table says `EMPTY`.
- [ ] `users.keep` = the number of admins you named; `adminIdsKept` are ids from inventory list (4).
- [ ] `tenantDatabases` holds exactly the non-NULL rows of list (1), each `organizationCode` with the same `dbName`, all
  `droppable: true` (a `droppable: false` name is left in place and logged `tenant_database_refused`).
- [ ] It includes the production-check test gym **GYM-16516973** (approved 2026-10-28, NEW-127), with the `db_name`
  the R-79 query prints for it. Its name is not written here on purpose.

`REFUSED/FAILED: …` instead (exit code 2): nothing changed. The message names the problem (`--keep-admin is required`,
`N named admin(s) were not found in users`, `… are not PLATFORM_ADMIN`).

### 5.2 Real run

Only after section 4 passed. Run the R-79 query again for any tenant if anything changed since the dry run (nothing
should: the API is stopped). Then, **in one command** (the script reads the names from `tenants.db_name` before it
deletes the rows, so a second run cannot find them):
```
node src\scripts\reset-platform-data.js --keep-admin <admin1@…>,<admin2@…> --drop-tenant-databases --confirm --db <platform db from 3.3> --host <host from 3.3>
```
Expected:
```
[reset] {"event":"start","mode":"APPLY", …}
[reset] {"event":"plan", …}                                              the same as the dry run
[reset] {"event":"emptied","table":"<name>","rows":N}                     one per EMPTY table
[reset] {"event":"users_removed","rows":N,"kept":2}
[reset] {"event":"tenant_database_dropped","tenantId":"…","dbName":"…"}   one per tenant database
[reset] {"event":"done","mode":"APPLY","removed":N,"droppedDatabases":N}

APPLY: log written to C:\inetpub\gymsera_be\logs\reset-<time>.jsonl
```
- [ ] The last `[reset]` line is `done`, `droppedDatabases` = the number of lines in `tenant-dbs.txt`, exit code 0.
- [ ] Copy both `logs\reset-<time>.jsonl` files (dry run and real run) into the backup folder. They hold ids, names
  and counts, no e-mails.

`REFUSED/FAILED: --db … does not match …` or `--host …` (exit 2): nothing changed; use the values 3.3 printed.
Any other `REFUSED/FAILED` (exit 1): [Escalate](#escalate).

### 5.3 Leftover databases

For each database from inventory list (3) that the owner decided to drop (2.4): there is no tenant row for it, so
`drop-orphan-tenant-database.js` refuses it ("no tenant row maps to"). Drop it by hand in the mysql client, the name
copied from `inventory-before.txt`, and only once its dump is in the archive (dump it like 4.2 first if it is not):
```sql
DROP DATABASE `<name copied from inventory list 3>`;
```

---

## 6. Object storage (R2)

The script does not touch R2. Folder names use the tenant **id** (`tenants.id`, a UUID from inventory list (1)), not
the `GYM-…` code. Check that before deleting anything: the folder names under `biometrics/` must be ids from list (1).

**6.1 Tool.** rclone for Windows, with a **temporary** R2 API token (Cloudflare › R2 › Manage API tokens: Object Read
& Write, limited to the two buckets). `rclone config` › new remote `gymsera-r2`, type `s3`, provider `Cloudflare`,
endpoint `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`. Delete the token at the end of the day.

**6.2 Look first.**
```
rclone lsf gymsera-r2:<R2_BUCKET> --dirs-only
rclone lsf gymsera-r2:<R2_KYC_BUCKET> --dirs-only
rclone lsf gymsera-r2:<R2_KYC_BUCKET>/biometrics --dirs-only
```

**6.3 Private bucket** (`R2_KYC_BUCKET`, else `<R2_BUCKET>-kyc`): **everything is tenant-owned; nothing is kept.**
`<T>` = each tenant id from list (1).

| Prefix | What | Written by |
|---|---|---|
| `biometrics/<T>/` | members' comparison and profile photos from devices (encrypted) | `services/devices/biometric.service.js` |
| `device-captures/<T>/` | door capture photos, per branch (encrypted) | `services/devices/device-screens.service.js` |
| `tenants/<T>/kyc/` | KYC documents | `services/kyc-storage.service.js` |
| `tenants/<T>/payment-proofs/` | member payment proofs | `services/payment-proof.service.js` |
| `tenants/<T>/plan-payment-proofs/` | host plan bank-transfer receipts | `services/plan-payment.service.js` |

Every delete first with `--dry-run`, then without, then `rclone lsf` the same path (expected: nothing):
```
rclone delete gymsera-r2:<R2_KYC_BUCKET>/biometrics/<T>/ --dry-run
rclone delete gymsera-r2:<R2_KYC_BUCKET>/biometrics/<T>/
rclone delete gymsera-r2:<R2_KYC_BUCKET>/device-captures/<T>/
rclone delete gymsera-r2:<R2_KYC_BUCKET>/tenants/<T>/
```
If the bucket is production-only (2.3), delete the whole folders instead (`…/biometrics/`, `…/device-captures/`,
`…/tenants/`). Expected at the end: `rclone lsf gymsera-r2:<R2_KYC_BUCKET> -R` prints nothing.

**6.4 Public bucket** (`R2_BUCKET`):

| Prefix | What | Action |
|---|---|---|
| `gyms/logos/gym-<T>.*`, `gyms/covers/gym-<T>.*`, `gyms/<T>/images/` | gym logo, cover, photos | delete |
| `tenants/logos/tenant-<T>.*`, `tenants/covers/tenant-<T>.*`, `tenants/<T>/onboarding-images/` | onboarding logo, cover, photos | delete |
| `hosts/<T>/organizations/staging/` | photos of an additional business before approval | delete |
| `users/<user id>/staging/` | stateless first-time host photos (`POST /host/staging-images`) | delete the folder |
| `gym-listings/logos/`, `gym-listings/covers/`, `gym-listings/<listing id>/images/` | business listing images | delete the folders |
| `branches/<branch id>/images/` | branch photos | delete the folder |
| `plans/posters/` | membership plan posters | delete the folder |
| `profiles/<user id>.*` | every user's profile photo | delete all **except** `profiles/<kept admin id>.*` (ids from the dry run's `adminIdsKept`) |
| `cities/`, `areas/` | city and area images (their tables are kept) | **keep** |

Listing, branch and plan ids are in no kept table, so on a production-only bucket delete these folders whole:
```
rclone delete gymsera-r2:<R2_BUCKET>/gyms/ --dry-run
rclone delete gymsera-r2:<R2_BUCKET>/gyms/
rclone delete gymsera-r2:<R2_BUCKET>/tenants/
rclone delete gymsera-r2:<R2_BUCKET>/hosts/
rclone delete gymsera-r2:<R2_BUCKET>/users/
rclone delete gymsera-r2:<R2_BUCKET>/gym-listings/
rclone delete gymsera-r2:<R2_BUCKET>/branches/
rclone delete gymsera-r2:<R2_BUCKET>/plans/
rclone delete gymsera-r2:<R2_BUCKET>/profiles/ --exclude "<kept admin id 1>.*" --exclude "<kept admin id 2>.*" --dry-run
```
Read the `profiles/` dry run carefully: only the kept admins' files may remain; then run it without `--dry-run`.
Expected at the end: `rclone lsf gymsera-r2:<R2_BUCKET> --dirs-only` shows `areas/`, `cities/`, `profiles/` only.
If the bucket is shared (2.3), stop after the `<T>` rows for the public bucket and ask: listing, branch and plan ids
then have to come from the dumps, one tenant at a time.

---

## 7. Everything else

- [ ] **Server disk.** Add `logs\errors-*.jsonl`, `logs\scheduled-*.log`, the `iisnode\` folder's logs and
  `%TEMP%\gymsera-logs\` to the encrypted archive, then delete them so day one starts clean. Keep `logs\reset-*.jsonl`.
  `public\uploads\` and `storage\private\kyc\` must be empty on production (SEC-08); if not, archive them, then empty.
- [ ] **Redis.** Nothing (R-88). If Redis was added since: `FLUSHDB` on the app's database number only, never
  `FLUSHALL`.
- [ ] **Push / Firebase.** Nothing in Firebase: the tokens were only in `device_tokens` (emptied). Test phones get no
  push until someone logs in again and the app registers a new token.
- [ ] **Stripe test mode:** cancel the active test subscriptions (Dashboard in test mode › Subscriptions). **Google
  Play:** cancel license-tester subscriptions (Order management). **Apple sandbox:** they stop renewing by themselves.
  Store notifications for deleted tenants may still arrive for a while; if the billing inbox shows failures for them,
  see `billing-events.md`.
- [ ] **Keys.** Production (not sandbox) keys for Apple, Google Play and Stripe are set, per spec §16. Do not set
  `SANDBOX_PURCHASES_GO_LIVE` on production.
- [ ] **Start again.**
  ```
  %windir%\system32\inetsrv\appcmd start apppool /apppool.name:"<GymsEra API pool>"
  %windir%\system32\inetsrv\appcmd start site /site.name:"<GymsEra API site>"
  ```
  then `schtasks /Change /TN "GymsEra\<name>" /ENABLE` for each task disabled in 3.8, and
  `node src\scripts\run-scheduled-job.js daily` once by hand (expected `[ScheduledJob] daily finished in N ms`, exit 0).

---

## 8. Verify after the wipe

- [ ] `node src\scripts\run-sql-check.js docs\sql\launch-wipe-inventory.sql`: list (1) empty; list (4) = the kept
  admins; counts: `users` = the kept admins, `organizations`, `organization_subscriptions`, `business_listings`, `device_tokens` = `0` (and `business_reviews`, `saved_businesses`, `member_subscription_index`, `user_organization_index` = `0`);
  `billing_plans`, `billing_plan_prices`, `platform_packages`, `cities`, `areas`, `moderation_words`, `schema_migrations` unchanged from
  `inventory-before.txt`.
- [ ] Inventory list (3) no longer shows the dropped organization databases, nor any leftover you decided to drop (5.3).
- [ ] Log in to the CMS as a kept admin. `GET /api/v1/billing/plans` returns the plans; cities and areas load in the app.
- [ ] `auditCapacity` (`capacity-audit.md`): zero findings on an empty platform.
- [ ] The traveller app shows no gyms.
- [ ] R2 as at the end of section 6.
- [ ] The next morning: Task Scheduler "Last Run Result" is `0x0` for `GymsEra\daily`.

---

## 9. First day after the wipe

In this order (matching the 1.1.0 Organization → Business → First Branch onboarding flow). Mobile is the reference; the CMS can do the same steps where noted.

1. **The host signs up** in the GymsEra app: account, Become a Host (`POST /organizations/register`), first business + first branch (`POST /organizations/:organizationId/first-business` with `firstBranch` and ≥3 photos), package selection, owner ID KYC, and finalize. Use a real store account (not a sandbox tester) for production, or fake names + `+` alias emails (`name+host@…`) if creating App Store review / demo data.
2. **Approve the organization** as a platform admin in the CMS (`POST /admin/organizations/:organizationId/approve`): provisioning creates the fresh organization database at `v32` and creates the held `PENDING` first business. Check: the R-79 query for `organization_code` returns `provisioning_state = ACTIVE` and a `db_name`; `node src\scripts\run-tenant-migrations.js --check` exits 0.
3. **Upload proof of premises & approve the business:** the host uploads `PROOF_OF_PREMISES` (and optional `BUSINESS_REGISTRATION` for verified badge) via `/host/businesses/:businessId/kyc-documents`; platform admin approves the business (`POST /admin/businesses/:businessId/approve`), which builds the held first branch cleanly.
4. **Activate plan & membership plans:** activate the subscription (paid / manual grant in CMS), then create at least one public membership plan with **Show to Travellers** on. Check: `node src\scripts\why-not-live.js --branch <branch name>` passes every condition; the demo/first branch appears in traveller discovery.
5. **Refund policy.** CMS › Subscriptions › Refund policy, or app › Profile › Refund policy. It is off by default
   (`refunds_allowed = 0`); turn it on with the window the gym wants, or leave it off on purpose.
6. **Clear the old users from the access device** (section 10, method A), **before** it is added.
7. **Add the access device fresh, no import.** CMS › Access devices › Add device; do **not** tick "This device already
   has members on it from GymBioSync". Type the server address and key from the setup card on the device. Check: the
   device page says Online, the device type is right (T&A PUSH for the SpeedFace-V5L), Users on device = the device
   administrators only, Unlinked users empty.
8. **First real member** at the desk: create, record the payment, enrol the face or finger with consent, scan at the
   door. Check: one visit in Today; the member is listed on the device page.

**Final check list (end of day one)**
- [ ] Platform: only the kept admins plus the real host, staff and members; inventory list (1) holds only the real
  tenant.
- [ ] Tenant: plan Active; `why-not-live.js` passes; refund policy as the gym wants it.
- [ ] Device: Online; no Unlinked users after its first audit (from 02:00 branch time, or Full audit on the device
  page); no failed commands on the Commands tab.
- [ ] Jobs: all six `GymsEra\*` tasks enabled, last result `0x0`.
- [ ] Billing: no failed events in the billing inbox; the real purchase entitles (not "only a test purchase").
- [ ] Push: the host got the approval notification on their phone.
- [ ] Backup: the `.7z` is in two places off the server; the restore drill is recorded in §13; the `.sql` files,
  `dump.cnf` / `staging.cnf` and the temporary R2 token are deleted.

---

## 10. Clearing the old users from the access device

After the wipe GymsEra has no members, so every non-administrator user on the device is an old test user: still able
to open the door (a device user has no end date unless GymsEra set one), and holding a PIN that a new member may get.

### A. Device menu "Delete all data"

On the device: Main menu › Data Mgt. › Delete Data › **Delete All Data** (the wording differs a little by firmware).

- Removes, per the ZKTeco manuals for this family: every user **including administrators**, their fingerprints,
  faces, cards and passwords, **attendance logs**, and attendance / blacklist photos. ("Delete Admin Role" is the
  separate item that only takes the role away.) Communication settings (server address, network) stay.
- Afterwards the device menu is open to anyone until an administrator is enrolled again: enrol the gym owner as
  administrator at once, before the device is left alone.
- Done before the device is added (9.7), the device uploads nothing old: no old users in Unlinked users, no old punches
  stored as history.
- **Proven by tests:** nothing. It is the device's own function; GymsEra has no test of it, and it has not been tried
  on the gym's SpeedFace-V5L. Confirm on the screen: after the delete the device shows 0 users and 0 attendance
  records.

### B. GymsEra import, go-live, "remove unmatched device users"

Add the device with "already has members from GymBioSync" ticked (import hold), Start import, Apply with nothing
matched, then Go live with **"Also remove the N device users not matched to a member (device administrators stay)"**
ticked. CMS only: the app has no cut-over screen.

- Removes: every non-administrator device user, each by template deletes per type, photo delete, authorization delete
  (where used) and user delete (`goLive` in `src/services/devices/device-import.service.js`).
- Keeps: device administrators (`privilege > 0`) are never removed, and are remembered in `device_admin_pins` so
  GymsEra never sends them anything later (NEW-248d).
- Does **not** remove attendance logs on the device: GymsEra has no "clear log" command. A T&A PUSH device uploads its
  old punches on first contact; they are stored as history (not visits), but they are old test data in the new tenant.
- More steps and more waiting (import, apply, go-live, the deletes), and it relies on the device reporting each user's
  privilege correctly.
- **Proven by tests** (device simulator, not the real device):
  - `tests/integration/zkteco-p4-import.test.js` "go-live: only the marked users are deleted; members sent; admin and
    unmatched untouched": with the box **not** ticked, unmatched users and the device admin stay.
  - `tests/integration/zkteco-att-device-admins.test.js` "the import's admins are remembered at go-live and never
    sent anything".
  - `zkteco-p4-import.test.js` "users list is paged; the admin is flagged and cannot be matched".
- **Not proven by tests:** the ticked box itself (`removeUnmatched: true`): no test sends it. The code excludes
  administrators (`removePins` keeps only `!u.isAdmin`), but that is code reading, not evidence. Also untested: apply
  and go-live with **zero** matched users, and the whole path on the real SpeedFace-V5L.

### Decision: A (R-104, owner, 2026-11-15)

Use A. It clears everything the wipe is meant to clear (users and punches), uses no untested GymsEra path, and is done
before GymsEra talks to the device. Its one cost, losing the device administrators, is fixed by enrolling the gym owner
as administrator straight after. B is not used. Reopening B would first need a test for `removeUnmatched: true` (admins
stay, every unmatched user gets a user delete, zero matches works), and old punches would still arrive as history.

---

## Rollback

Stop the API (3.8). Restore the dumps from section 4 into the **same** database names, the ones
`inventory-before.txt` lists (the R-79 read before the wipe):
```
mysql --defaults-extra-file=C:\gymsera-secure\dump.cnf -e "CREATE DATABASE `<name>` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
mysql --defaults-extra-file=C:\gymsera-secure\dump.cnf <name> -e "source D:/gymsera-wipe/2026-MM-DD/tenant-<name>.sql"
```
The platform database still exists after the wipe (only its rows went): restore `platform.sql` into it the same way
(the dump drops and re-creates each table). R2 deletions cannot be undone unless they were copied in 4.6. If only part
of the wipe ran: the platform-row delete is one transaction and is rolled back on error; tenant database drops are
not, so restore those from the dumps. After a restore with biometric data: `node src\scripts\rotate-biometric-key.js`
(dry run) must show 0 unreadable (`devices.md` "Backup and restore of biometric tables").

## Escalate

- `REFUSED/FAILED` with exit code 2: refused, nothing changed; fix the flag it names.
- `FAILED` with `"where":"platform_rows"` in the log: the platform transaction was rolled back; nothing changed. Note
  the error, fix it, start again at 5.1.
- `FAILED` with `"where":"drop_tenant_database"`: **the platform rows are already gone**, the databases after that one
  were not dropped, and a second run cannot find their names. Stop; do not start the API. The plan line of this run's
  `logs\reset-<time>.jsonl` is the record of what `tenants.db_name` held; the owner decides whether to drop the rest by
  hand from it (R-79 has no tenant row left to read) or to restore everything from the dumps. Step 3.4 is there to
  prevent this.
