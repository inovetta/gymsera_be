# gymsera_be

GymsEra Backend API service.

## Deployment & Database Migrations

### Tenant Database Migration Policy (spec §6.5)

Schema changes and data updates on tenant databases are executed through versioned, idempotent migrations managed by `src/database/tenant-migration-runner.js`.

Tenant migrations are **never** executed as a side-effect of request handling or database connection establishment (`getConnection`).

### Exact Deploy Order

When deploying a new version of the API, follow this strict deployment order:

1. **Run tenant database migrations first**:
   ```bash
   node src/scripts/run-tenant-migrations.js
   ```
   This script applies all pending migrations across all active tenant databases, updates `schema_migrations`, and produces a per-tenant status report.

2. **Start the new API version**:
   ```bash
   npm start
   ```
   At startup, the API executes a read-only schema version check (`checkTenantSchemaVersions`). If any active tenant database is behind the required schema version, a clear warning is logged without performing writes or crashing the server.
