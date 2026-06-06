# GymsEra — Seeder Guide & Staging Credentials

## What Was Seeded

### Platform Database

| Entity | Count | Details |
|---|---|---|
| Cities | 30 | Complete Pakistan coverage |
| Areas | 290+ | Real neighbourhood names per city |
| Platform Packages | 3 | Starter / Professional / Enterprise |
| Admin Users | 4 | Super Admin, Platform Admin, Ops, Support |
| Gym Hosts | 5 | One per tenant |
| Members | 15 | Spread across all tenants |
| Tenants | 5 | All ACTIVE + KYC APPROVED |
| Gym Listings | 9 | 8 ACTIVE + 1 PENDING |
| Tenant Subscriptions | 5 | All PAID |
| Member Gym Memberships | 15 | Cross-tenant index records |
| Gym Reviews | 14 | 13 APPROVED + 1 PENDING |

### Per-Tenant Databases (5 DBs)

| Tenant | DB Name | City | Branches | Plans | Trainers | Members |
|---|---|---|---|---|---|---|
| Iron Peak Fitness | `gymsera_ironpeak` | Karachi | 3 | 6 | 3 | 5 |
| Vitality Fit Studio | `gymsera_vitalityfit` | Lahore | 2 | 6 | 3 | 4 |
| PowerZone Gym | `gymsera_powerzone` | Rawalpindi | 2 | 7 | 3 | 2 |
| FitLife Studio | `gymsera_fitlife` | Islamabad | 1 | 6 | 2 | 2 |
| Champions Athletic Club | `gymsera_champions` | Faisalabad | 2 | 6 | 3 | 2 |

Each tenant DB contains: gym profile, branches (real addresses + GPS coordinates), membership plans (Daily → Annual), trainers with bios + schedules, staff, member health profiles, active subscriptions, PAID invoices, and ~90 days of attendance history.

---

## Staging Credentials

> **Keep this file out of public repos.** Rotate passwords before production launch.

### Admin Accounts

| Role | Email | Password |
|---|---|---|
| **Super Admin** | superadmin@gymsera.com | `SuperAdmin@GymsEra1` |
| **Platform Admin** | admin@gymsera.com | `Admin@GymsEra1` |
| **Ops Admin** | ops@gymsera.com | `Ops@GymsEra1` |
| **Support Admin** | support@gymsera.com | `Support@GymsEra1` |

### Gym Host Accounts

| Gym | Email | Password |
|---|---|---|
| Iron Peak Fitness | ahmed@ironpeak.com | `GymHost@1234` |
| Vitality Fit Studio | sara@vitalityfit.com | `GymHost@1234` |
| PowerZone Gym | usman@powerzone.com | `GymHost@1234` |
| FitLife Studio | nadia@fitlife.com | `GymHost@1234` |
| Champions Athletic Club | zain@champions.com | `GymHost@1234` |

### Member Accounts (all password: `Member@1234`)

| Name | Email | Active At |
|---|---|---|
| Ali Hassan | ali.hassan@example.com | Iron Peak DHA |
| Fatima Zahra | fatima.z@example.com | Iron Peak DHA |
| Omar Farooq | omar.farooq@example.com | Iron Peak Clifton |
| Ayesha Noor | ayesha.noor@example.com | Vitality Fit DHA |
| Bilal Chaudhry | bilal.c@example.com | Vitality Fit DHA |
| Hira Sheikh | hira.sheikh@example.com | Vitality Fit Gulberg |
| Kamran Baig | kamran.baig@example.com | PowerZone DHA |
| Sana Iqbal | sana.iqbal@example.com | FitLife F-8 |
| Tariq Mehmood | tariq.m@example.com | FitLife F-8 |
| Zara Qureshi | zara.q@example.com | Champions Peoples Colony |
| Hamza Raza | hamza.raza@example.com | Champions Peoples Colony |
| Mahnoor Butt | mahnoor.b@example.com | Vitality Fit DHA |
| Asad Javed | asad.javed@example.com | Iron Peak DHA (Expired) |
| Rimsha Anwar | rimsha.anwar@example.com | PowerZone DHA |
| Waqar Shah | waqar.shah@example.com | Iron Peak Clifton |

---

## Running Seeders Locally (Development)

This is the standard flow for local dev or when pointing at a remote staging DB from your machine.

### Step 1 — Platform data (cities, users, tenants, listings, reviews)

```bash
node src/seeders/seed.js
```

Idempotent — safe to re-run. Uses `findOrCreate` throughout.

### Step 2 — Provision tenant databases

Creates each tenant's MySQL database, grants privileges, and syncs the schema.

```bash
node src/scripts/provision-seeded-tenants.js
```

> **Prerequisite:** The MySQL user `gymsera_tenant` must exist before this step runs.
> If it doesn't, create it first:
> ```sql
> CREATE USER IF NOT EXISTS 'gymsera_tenant'@'%' IDENTIFIED BY '<TENANT_DB_PASS>';
> FLUSH PRIVILEGES;
> ```

### Step 3 — Tenant data (gyms, branches, plans, trainers, members, payments, attendance)

```bash
# All tenants
node src/seeders/seed-tenant.js

# Single tenant only
node src/seeders/seed-tenant.js IRONPEAK
```

---

## Running Seeders on Vercel (Staging)

Vercel is a serverless platform — there is no persistent server to SSH into and run scripts. The recommended approach is to **run the seeders locally while pointing at the staging database**.

### Option A — Run locally against the staging DB (Recommended)

This is the safest, simplest approach. You run the scripts on your machine but the database connections point to staging.

**1. Pull Vercel env vars (if you use Vercel for env management)**

```bash
npm i -g vercel
vercel login
vercel link          # link to your Vercel project
vercel env pull .env.staging
```

**2. Override DB env vars in a `.env.staging` file**

Create `.env.staging` (never commit this):

```env
NODE_ENV=production

PLATFORM_DB_HOST=209.209.42.64
PLATFORM_DB_PORT=3306
PLATFORM_DB_NAME=gymsera
PLATFORM_DB_USER=gymsera
PLATFORM_DB_PASS=Samsung@831

TENANT_DB_HOST=209.209.42.64
TENANT_DB_PORT=3306
TENANT_DB_ADMIN_USER=root
TENANT_DB_ADMIN_PASS=<staging-root-password>
TENANT_DB_USER=gymsera_tenant
TENANT_DB_PASS=<staging-tenant-password>

TENANT_CONN_ENCRYPTION_KEY=<same-key-as-vercel-env>
```

**3. Run the seeders with the staging env file**

```bash
# Step 1 — platform data
NODE_ENV=production dotenv -e .env.staging -- node src/seeders/seed.js

# Step 2 — provision tenant DBs
NODE_ENV=production dotenv -e .env.staging -- node src/scripts/provision-seeded-tenants.js

# Step 3 — tenant data
NODE_ENV=production dotenv -e .env.staging -- node src/seeders/seed-tenant.js
```

> Install `dotenv-cli` if you don't have it: `npm i -g dotenv-cli`

---

### Option B — Protected Seeder API Endpoint

If you need to trigger seeding from a browser or CI pipeline without local DB access, add a one-time protected endpoint.

**1. Create `src/routes/seed.route.js`** (remove this file after seeding):

```js
const router = require('express').Router();
const { execFile } = require('child_process');
const path = require('path');

router.post('/trigger', (req, res) => {
  const secret = req.headers['x-seed-secret'];
  if (secret !== process.env.SEED_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const script = path.join(__dirname, '../../seeders/seed.js');
  execFile('node', [script], { timeout: 120000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: err.message, stderr });
    res.json({ success: true, output: stdout });
  });
});

module.exports = router;
```

**2. Register the route temporarily in `app.js`:**

```js
app.use('/api/internal/seed', require('./src/routes/seed.route'));
```

**3. Add `SEED_SECRET` to Vercel environment variables.**

**4. Trigger via curl:**

```bash
curl -X POST https://your-app.vercel.app/api/internal/seed/trigger \
  -H "x-seed-secret: your-secret-here"
```

**5. Remove the route immediately after seeding.**

> ⚠️ Never leave this endpoint live in production.

---

### Option C — GitHub Actions / CI Pipeline

Add a one-time workflow that runs on manual trigger:

```yaml
# .github/workflows/seed-staging.yml
name: Seed Staging DB

on:
  workflow_dispatch:   # manual trigger only

jobs:
  seed:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - run: npm ci

      - name: Run platform seeder
        env:
          NODE_ENV: production
          PLATFORM_DB_HOST: ${{ secrets.STAGING_DB_HOST }}
          PLATFORM_DB_PORT: ${{ secrets.STAGING_DB_PORT }}
          PLATFORM_DB_NAME: ${{ secrets.STAGING_DB_NAME }}
          PLATFORM_DB_USER: ${{ secrets.STAGING_DB_USER }}
          PLATFORM_DB_PASS: ${{ secrets.STAGING_DB_PASS }}
          TENANT_DB_HOST: ${{ secrets.STAGING_DB_HOST }}
          TENANT_DB_PORT: ${{ secrets.STAGING_DB_PORT }}
          TENANT_DB_ADMIN_USER: ${{ secrets.STAGING_TENANT_ADMIN_USER }}
          TENANT_DB_ADMIN_PASS: ${{ secrets.STAGING_TENANT_ADMIN_PASS }}
          TENANT_DB_USER: ${{ secrets.STAGING_TENANT_USER }}
          TENANT_DB_PASS: ${{ secrets.STAGING_TENANT_PASS }}
          TENANT_CONN_ENCRYPTION_KEY: ${{ secrets.TENANT_CONN_ENCRYPTION_KEY }}
        run: node src/seeders/seed.js

      - name: Provision tenant DBs
        env: # same env block as above
          # ...
        run: node src/scripts/provision-seeded-tenants.js

      - name: Seed tenant data
        env: # same env block as above
          # ...
        run: node src/seeders/seed-tenant.js
```

Store all DB credentials as **GitHub Actions secrets** (Settings → Secrets → Actions).

---

## Important Notes

- **`TENANT_CONN_ENCRYPTION_KEY`** must be identical between local and staging. If it differs, decryption of existing tenant connection strings will fail.
- **All seeders are idempotent** — re-running them will not create duplicates.
- `seed-tenant.js` requires provisioned tenants. Always run `provision-seeded-tenants.js` first.
- `NODE_ENV=production` disables `sequelize.sync({ alter: true })` on the platform DB — use migrations in production.
- The staging DB host `209.209.42.64` must allow inbound connections from your IP (or the CI runner IP) on port 3306.
