# Secrets: rotation and what is already burned (SEC-05)

Not tied to an alert code. Nothing here is automatic: a person with access to the servers does each step.

## 1. Already burned: rotate if they were ever live

These values were committed to git and must be treated as public:

| Value | Where it was | What to do |
|---|---|---|
| The `/system/*` maintenance keys (`gymsera-fix-socket-2026`, `gymsera-fcm-test-2026`) | `src/routes/index.js` | The routes are deleted (R-35). Nothing to rotate except the case where the same string was reused elsewhere: change it there. |
| `TENANT_CONN_ENCRYPTION_KEY` demo value (`0123456789abcdef` repeated) | removed scratch scripts, and the local `.env` | **Check that no deployed environment uses it** (section 2). If one does, rotate (section 3). |
| The four seeded platform admin passwords (`@gymsera.com`, from `seed.js`) | removed from `seed.js` and `SEEDER_GUIDE.md`; still in git history | If a deployed database was ever seeded, change those four passwords or delete the accounts. Seeders now refuse `NODE_ENV=production`. |
| The old SMTP mailbox password | git history (SEC-SMTP-FALLBACK) | Changed when email is set up (out of scope for 5A). |

History is not rewritten. The CI secret scan (`.github/workflows/secret-scan.yml`) looks only at the commits a change adds, so these old findings do not fail the build.

## 2. Check which key a server uses

Compare the first 8 characters of `TENANT_CONN_ENCRYPTION_KEY` with the demo value (`01234567`). Do not paste the key anywhere. Use a different key in every environment (local, staging, production).

## 3. Rotate `TENANT_CONN_ENCRYPTION_KEY`

The key protects `tenants.connection_string_encrypted` and `users.apple_refresh_token_encrypted`. Rotating needs a short maintenance window: the API must restart with the new key right after the data is re-encrypted.

1. Back up: `mysqldump <platform_db> tenants users > keyrotation_pre.sql` (stored somewhere that is not the repo).
2. Generate the new key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Store it in the secret manager (KMS, vault or the host's protected settings), never in git.
3. Dry run: `TENANT_CONN_ENCRYPTION_KEY_OLD=... TENANT_CONN_ENCRYPTION_KEY_NEW=... node src/scripts/rotate-encryption-key.js`. It must report `0 unreadable`. If not, stop: the old key is not the one the data was written with.
4. Apply: same command with `--apply` (one transaction; either everything changes or nothing).
5. Set `TENANT_CONN_ENCRYPTION_KEY` to the new key on every API process and restart. Tenant connection strings are cached in Redis for up to 1 hour, encrypted with the old key: restart, then clear the tenant connection cache keys or wait one hour, or tenant routes answer 500 until then.
6. Check: log in as a host, open the dashboard, and read one tenant in the admin.

**Rollback:** set `TENANT_CONN_ENCRYPTION_KEY` back to the old key and restart if step 4 has not run. If step 4 ran, run the script again with OLD and NEW swapped, or restore `keyrotation_pre.sql`.

**Escalate:** if tenant routes fail after step 5 and swapping the key back does not help, restore the backup and stop; do not retry blindly.

## 3b. Rotate the tenant database password (`TENANT_DB_PASS`, row 1 of section 5)

Every tenant's stored connection string (`tenants.connection_string_encrypted`) holds the tenant MySQL
user's password. Changing the password in MySQL alone breaks every tenant route; the stored strings must
be rebuilt with `src/scripts/rebuild-tenant-connection-strings.js` (NEW-203). Needs a short window: from
step 2 to step 6 new tenant connections fail. If row 2 (the encryption key) is rotated in the same window,
do this section first, then section 3.

1. Back up: `mysqldump <platform_db> tenants > tenantpass_pre.sql` (somewhere that is not the repo).
2. On the tenant MySQL server, as the admin user, change the password of `TENANT_DB_USER` for both hosts
   provisioning creates: `ALTER USER '<user>'@'%' IDENTIFIED BY '<new>';` and
   `ALTER USER '<user>'@'localhost' IDENTIFIED BY '<new>';` (skip a host that does not exist). Keep the new
   value in the server's protected settings only (R-55).
3. Put the new password in `TENANT_DB_PASS` in the API `.env`. Do not restart yet.
4. Dry run: `node src/scripts/rebuild-tenant-connection-strings.js`. Read it: every tenant must say
   `REBUILD (new password connects)`, `ALREADY CURRENT`, or `LEFT ALONE` (another MySQL user, R-25: check
   it with `gymsera-r25-tenant-db-credentials-check.js`), and the last line must say `0 failed`. Optional:
   `--tenant=<code>` to look at one tenant. Failures and what they mean:
   - `unreadable`: `TENANT_CONN_ENCRYPTION_KEY` in `.env` is not the key the data was written with. Stop.
   - `db_name_mismatch`: the stored database name differs from `tenants.db_name` (or it is empty). The
     tool never guesses a name (R-79); look at that tenant by hand before going on.
   - `cannot_connect`: the new password does not open that database (step 2 missed a host, a typo, or
     the user lacks a grant on it).
   A run with any failure writes nothing.
5. Apply: same command with `--apply` (one transaction: everything changes or nothing).
6. Restart the API (`iisreset`): open pools keep the old connections until then. With R-88 there is no
   Redis; if Redis is ever on, the tool clears the `tenant:<id>:connStr` keys itself.
7. Check: log in as a host and open the dashboard; `node src/scripts/check-environment.js`.

**Rollback:** before step 5, set the old password back in MySQL and in `.env`; nothing else changed. After
step 5, restore `tenantpass_pre.sql` and set the old password back in MySQL and `.env`, then restart.

## 3c. Rotate `BIOMETRIC_DATA_KEY` (ZKTeco access devices, Phase 2)

Face, fingerprint and palm templates (`member_biometrics.template_enc`) and the photo files of
`member_biometric_photos` are AES-256-GCM under this key. The setting is a comma list of `<version>:<64 hex>`;
the **first** entry encrypts, every entry decrypts, and each value records its key version, so rotation needs
no downtime.

1. Generate the new key (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). Pick the
   next version number.
2. Set `BIOMETRIC_DATA_KEY=<new version>:<new hex>,<old version>:<old hex>` on every API process and restart.
   New data uses the new key; old data still reads.
3. Dry run: `node src/scripts/rotate-biometric-key.js`. Each tenant line must say `0 unreadable`. If not, a key
   that data was written with is missing from the list: stop and find it.
4. `node src/scripts/rotate-biometric-key.js --apply`. Templates are rewritten per tenant in one transaction
   (nothing is written for a tenant with an unreadable value); photo files are rewritten in place.
5. Run the dry run again: every tenant `0 … on an older key`.
6. Remove the old entry (`BIOMETRIC_DATA_KEY=<new version>:<new hex>`) and restart.

**Rollback:** before step 4, put the old key back first in the list (or alone) and restart. After step 4, keep
both keys in the list: everything is readable whichever comes first.

**Escalate:** a value that no key reads is lost (encrypted with a key nobody has). Delete that member's
biometric data (`DELETE /host/devices/members/:memberId/biometric-consent` withdraws and deletes) and enrol again.

## 4. Adding a secret to the scan allow-list

Do not. If the scan flags a fake value in a test, change the fake so it does not look like a real token. A real finding means: rotate the secret first, then fix the commit.

## 5. Rotation list before launch (P10, 2026-11-03)

Why now: NEW-195 (P9b) found that host tenant answers sent the tenant's `connectionStringEncrypted` and
`dbName` to its owner (fixed in be `77a18e1`). The ciphertext alone is useless without
`TENANT_CONN_ENCRYPTION_KEY`, but anyone who saved one and ever learns the key can read the tenant
database password. Rotating the key re-encrypts the **same** password, so the tenant database password is
rotated too. Everything else below is routine hygiene before real customers. Values never go in git, a doc
or a chat; they go in the server's protected settings (R-55).

| # | Secret (env) | Where | Why | How | Check after |
|---|---|---|---|---|---|
| 1 | `TENANT_DB_PASS` (MySQL user `TENANT_DB_USER`) | tenant MySQL server; inside every `tenants.connection_string_encrypted` | NEW-195 ciphertexts left the server | section 3b: change the MySQL user's password, then `rebuild-tenant-connection-strings.js` (dry run first, `--apply`, NEW-203), restart; before row 2 if both are done in one window | open a tenant dashboard; `node src/scripts/check-environment.js` |
| 2 | `TENANT_CONN_ENCRYPTION_KEY` | API `.env` | NEW-195; the demo key check of section 1 | section 3 (`rotate-encryption-key.js`, dry run first, `--apply`), restart; with R-88 there is no Redis cache to clear | section 3 step 6 |
| 3 | `JWT_SECRET`, `JWT_REFRESH_SECRET` | API `.env` | launch hygiene; signs every session | new 64-byte random values, restart. **Every user is signed out** (mobile asks to sign in again); do it in the launch window | sign in on app, CMS, web |
| 4 | `TENANT_DB_ADMIN_PASS`, `PLATFORM_DB_PASS` | MySQL; API `.env` | launch hygiene | change in MySQL, then `.env`, restart | `/health` |
| 5 | Google: `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` key, `FIREBASE_SERVICE_ACCOUNT_JSON` key, `GOOGLE_MAPS_SERVER_KEY` | Google Cloud console; API `.env` | launch hygiene; the Maps key moves to GymsEra's own project anyway (R-76a) | create a new key for each service account, deploy it, then delete the old key in the console; Maps: R-76a keys | a sandbox purchase sync; a push; a Places search |
| 6 | Apple: `APPLE_IAP_PRIVATE_KEY_PATH` (.p8, `APPLE_IAP_KEY_ID`), `APPLE_SIGNIN_PRIVATE_KEY_PATH` | App Store Connect → Keys; API server file | launch hygiene | create a new In-App Purchase key (and Sign in with Apple key), copy the .p8 to the server, update the key id, restart, then revoke the old key | `POST /billing/ios/sync` with a sandbox purchase |
| 7 | `SMTP_USER` / `SMTP_PASS` | mail provider; API `.env` | the old mailbox password is in git history (section 1); NEW-73 moves to a transactional provider | set when NEW-73 moves to ZeptoMail or SES (`SMTP_*` only) | team welcome e-mail arrives |
| 8 | `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Cloudflare R2; API `.env` | launch hygiene; KYC bucket shares the credentials (R-27) | new API token, deploy, delete the old one | upload a photo and a KYC document |
| 9 | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe; API `.env` | sandbox only today (R-7, web card off) | roll in the Stripe dashboard when a live key is first set | n/a until R-39 |
| 10 | `METRICS_KEY`, `CRON_SECRET`, `DEVICE_API_KEY`, `PAYMENT_TEST_KEY` | API `.env` | launch hygiene | new random values; `DEVICE_API_KEY` must also be set on each gym device | `/metrics` with the new key |
| 11 | Apple / Google client keys in the app (`GOOGLE_MAPS_API_KEY` in `android/local.properties`, `ios/Flutter/MapsKey.xcconfig`) | build machine only | R-76a: new restricted keys in GymsEra's project | build with the new keys; the friend's project deletes the old key after the new build is live | map shows on both phones |
| 12 | `BIOMETRIC_DATA_KEY` | API `.env` | new with ZKTeco Phase 2; set before the first device stores a template | section 3c (the first one is just `1:<hex>`; no rotation needed) | a template upload is stored (`member_biometrics`) |

Order on the day: 4, 1 + 2 (one maintenance window, backup first), 3 (signs everyone out), then 5, 6, 8, 10
while the API runs; 7 with NEW-73; 11 with the next store build. `firebase-service-account.json` is
git-ignored (`.gitignore:17`) and was never committed (checked `git log --all` 2026-11-03).
