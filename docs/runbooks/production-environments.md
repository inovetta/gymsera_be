# Production and staging on one server (NEW-127, NEW-131, NEW-134)

`api.gymsera.com` (production) and `apistaging.gymsera.com` (staging) run as two IIS sites on the same
Windows server. On 2026-10-24 the staging site's `.env` named the production platform database
(`PLATFORM_DB_NAME=gymsera`) and the production tenant server (`TENANT_DB_HOST=209.209.42.64`), so a
staging API with older code wrote into production. A gym was approved without its migrations (spec §13,
"NEW-127 / NEW-134 root cause 2026-10-28"). These rules stop that from happening again.

## Rules

1. **Staging gets its own platform and tenant databases before it is turned on.**
   - Its own platform database: `PLATFORM_DB_NAME` is not `gymsera`, and preferably it is on its own
     `PLATFORM_DB_HOST`.
   - Its own tenant databases: `TENANT_DB_HOST` is not the production tenant server (`209.209.42.64`), or
     its `TENANT_DB_ADMIN_USER` / `TENANT_DB_USER` have no rights on production's `gymsera_*` databases.
     Tenant databases are named `gymsera_<tenant code>` whatever the platform database is, so a separate
     platform name alone does not keep staging off production's tenant server. The startup guard does
     not check this yet (NEW-135).
   - Its own MySQL users and passwords, not production's.
   - Sandbox keys only (Stripe test keys, Apple sandbox, Play test track), as for every non-production site.
   - Staging stays stopped until all of the above is true and the checks below pass.
2. **`.env` files are never copied between sites.** Not production to staging, not staging to production,
   not from a developer machine to the server. A copied file brings the other site's database names,
   hosts, passwords and `APP_URL` with it. Build each site's `.env` from `.env.example` in the repo and
   fill in that site's own values by hand.
3. **One site, one folder, one `.env`.** Each IIS site points at its own folder, with its own git checkout
   and its own `.env`. No site reads another site's folder.
4. **`NODE_ENV`, `GYMSERA_ENV` and `APP_URL` tell the truth.** Production: `NODE_ENV=production`,
   `APP_URL=https://api.gymsera.com`. Staging: `GYMSERA_ENV=staging`, `APP_URL=https://apistaging.gymsera.com`.
   The startup guard uses these to recognise staging.
5. **A variable set on the server or the IIS app pool beats `.env`** (dotenv never overrides a variable
   that is already set). Do not set database variables at server level; a server-level value reaches
   every site on the machine.

## Checks before a site is turned on, and after every deploy

Run these in the site's own folder.

1. `node src\scripts\check-environment.js`. Production: `staging: no`, `platform database: gymsera (...)`,
   `OK`. Staging: `staging: yes`, a platform database that is **not** `gymsera`, `OK`. `REFUSED` (exit 2)
   means the site will not start; fix that site's own `.env`. The script prints names and sources only,
   never a password. A shell cannot see variables set only on the IIS app pool, so also do check 2.
2. Start or restart the site and read its boot line (iisnode stdout file or the error journal):
   `[ErrorJournal] boot ... commit=<12> built=<..> started=<..> platformDb=<name> (<source>)`.
   - `commit` must be the commit just deployed.
   - `platformDb` must be the site's own database. On staging it must never be `gymsera`.
   - The source says where the name came from: `.env`, the process environment, the process
     environment overriding `.env` (it quotes the `.env` value), or the built-in default.
3. `GET https://<site>/api/v1/health`: `data.build.commit` is the deployed commit and `data.startedAt` is
   after the deploy. If not, the site is still running old code: restart it in IIS (or touch `web.config`)
   and check again.
4. Production only, after a backend deploy: the fresh-approval check in spec §13 (approve a test gym, run
   `docs\sql\new-127-fresh-approval-check.sql`, expect `PASS`; then
   `node src\scripts\run-tenant-migrations.js --check`, expect `OK`).

## When searching a `.env`

Search without anchoring to the start of the line. ` PLATFORM_DB_NAME=gymsera` (with a leading space)
is a valid setting, and `findstr /b PLATFORM_DB_NAME` or `grep '^PLATFORM_DB_NAME'` misses it. Use
`findstr /n PLATFORM_DB_NAME .env` (Windows) or `grep -n PLATFORM_DB_NAME .env`. Better still, use the
`platformDb=` boot line, which shows what the process actually uses.

## If staging is found on production's databases again

1. Stop the staging site in IIS at once. Production keeps running.
2. Read production's boot line and `/health` to confirm production itself is on the right commit.
3. Run `node src\scripts\run-tenant-migrations.js --check` on production. For any tenant it reports,
   follow [tenant-schema.md](tenant-schema.md).
4. Fix staging's own `.env` under the rules above. Do not copy production's. Then run the checks before
   starting it again.
5. Record it in spec §13.
