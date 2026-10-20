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

## 4. Adding a secret to the scan allow-list

Do not. If the scan flags a fake value in a test, change the fake so it does not look like a real token. A real finding means: rotate the secret first, then fix the commit.
