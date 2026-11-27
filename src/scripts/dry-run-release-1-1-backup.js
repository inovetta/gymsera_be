#!/usr/bin/env node
/**
 * Release 1.1.0 dry-run and invariant check against a restored production backup copy
 * in a local throwaway database (e.g. `gymsera_local_walk` on 127.0.0.1:3308).
 *
 * What it does:
 *   1. Refuses production hosts/databases unless `--verify-only --allow-nonlocal` is passed.
 *   2. Captures row counts across platform and per-organization tables BEFORE migrations.
 *   3. Runs platform migrations (`p001`..`p038`, dry-run preview then live) FIRST, then
 *      per-organization migrations (`001`..`032`, dry-run preview then live) across all
 *      restored local organization databases found in `organizations.db_name`.
 *   4. Captures row counts AFTER migrations and verifies mapped tables kept 1:1 counts.
 *   5. Verifies key invariants:
 *        - Every business has a listing id (Option S: `businesses.id = business_listings.id`,
 *          `gym_listing_id` dropped, every branch has a valid `business_id`)
 *        - No unexpected NULL `organization_id` across all 19 `p035` tables (and no leftover `tenant_id`)
 *        - Indexes and tables renamed (`p033`, `p034`, `p035`, `030`) with zero legacy index/table names left
 *        - Schema versions at target (`p038` / `032`), enum/string value renames applied, branch refund cols moved (`032`)
 *   6. Prints a clear "What to look at" summary. Never prints passwords, tokens or secrets.
 *
 * Usage:
 *   node src/scripts/dry-run-release-1-1-backup.js
 *   node src/scripts/dry-run-release-1-1-backup.js --platform-db gymsera_local_walk --host 127.0.0.1 --port 3308
 *   node src/scripts/dry-run-release-1-1-backup.js --verify-only
 *
 * Exit codes: 0 = all checks passed, 1 = migration or invariant failure, 2 = safety refusal / bad args.
 */
require('dotenv').config();
const { Sequelize, QueryTypes } = require('sequelize');
const dbConfig = require('../config/database.config');
const { runPlatformMigrations, PLATFORM_TARGET_VERSION } = require('../database/platform-migrations');
const { runTenantMigrations, isUnbaselinedTenantDb, TARGET_SCHEMA_VERSION } = require('../database/tenant-migration-runner');

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const getArg = (name) => {
  const idx = argv.indexOf(name);
  return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
};

const VERIFY_ONLY = hasFlag('--verify-only');
const SKIP_TENANT_MIGRATIONS = hasFlag('--skip-tenant-migrations');
const ALLOW_NONLOCAL = hasFlag('--allow-nonlocal');

const PLATFORM_HOST = getArg('--host') || dbConfig.platform.host || '127.0.0.1';
const PLATFORM_PORT = parseInt(getArg('--port') || String(dbConfig.platform.port || 3308), 10);
const PLATFORM_DB = getArg('--platform-db') || process.env.PLATFORM_DB_NAME || 'gymsera_local_walk';

const TENANT_HOST = getArg('--tenant-host') || dbConfig.tenantServer.host || PLATFORM_HOST;
const TENANT_PORT = parseInt(getArg('--tenant-port') || String(dbConfig.tenantServer.port || PLATFORM_PORT), 10);
const TENANT_USER = dbConfig.tenantServer.adminUser || dbConfig.platform.username || 'root';
const TENANT_PASS = dbConfig.tenantServer.adminPass !== undefined ? dbConfig.tenantServer.adminPass : (dbConfig.platform.password || '');

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', 'mysql', 'db']);
const SAFE_DB_NAME = /^[A-Za-z0-9_]+$/;
const MIGRATABLE_STATUSES = new Set(['ACTIVE', 'SUSPENDED', 'PENDING_DELETION']);

// Platform table pairs (pre-p033/p034 -> post-p034)
const PLATFORM_TABLE_PAIRS = [
  ['tenants', 'organizations'],
  ['tenant_subscriptions', 'organization_subscriptions'],
  ['tenant_invitations', 'organization_invitations'],
  ['user_org_index', 'user_organization_index'],
  ['gym_listings', 'business_listings'],
  ['saved_gyms', 'saved_businesses'],
  ['gym_reviews', 'business_reviews'],
  ['user_gym_memberships', 'member_subscription_index'],
  ['users', 'users'],
  ['billing_plans', 'billing_plans'],
  ['billing_plan_prices', 'billing_plan_prices'],
  ['platform_packages', 'platform_packages'],
  ['cities', 'cities'],
  ['areas', 'areas'],
  ['capacity_events', 'capacity_events'],
  ['billing_events', 'billing_events'],
  ['audit_logs', 'audit_logs'],
  ['platform_audit_logs', 'platform_audit_logs'],
  ['conversations', 'conversations'],
  ['messages', 'messages'],
  ['payout_accounts', 'payout_accounts'],
  ['plan_payment_requests', 'plan_payment_requests'],
  ['platform_invoices', 'platform_invoices'],
  ['devices', 'devices'],
  ['device_members', 'device_members'],
  ['access_devices', 'access_devices'],
  ['user_blocks', 'user_blocks'],
  ['content_reports', 'content_reports'],
  ['area_requests', 'area_requests'],
  ['area_request_links', 'area_request_links'],
  ['area_aliases', 'area_aliases'],
];

// Tenant table pairs (pre-030 -> post-030)
const TENANT_TABLE_PAIRS = [
  ['gyms', 'businesses'],
  ['branches', 'branches'],
  ['membership_plans', 'membership_plans'],
  ['expense_categories', 'expense_categories'],
  ['member_profiles', 'member_profiles'],
  ['member_subscriptions', 'member_subscriptions'],
  ['payments', 'payments'],
  ['invoices', 'invoices'],
  ['refund_requests', 'refund_requests'],
  ['role_assignments', 'role_assignments'],
  ['role_assignment_branches', 'role_assignment_branches'],
  ['gym_staff', 'gym_staff'],
];

// All 19 platform tables from p035_organization_id_columns
const P035_NON_NULL_ORG_ID_TABLES = [
  'area_request_links',
  'capacity_events',
  'conversations',
  'devices',
  'device_members',
  'business_listings',
  'business_reviews',
  'payout_accounts',
  'plan_payment_requests',
  'platform_invoices',
  'organization_subscriptions',
  'user_blocks',
  'member_subscription_index',
  'user_organization_index',
  'access_devices',
];

// Nullable by schema design; reported for operator review
const P035_NULLABLE_ORG_ID_TABLES = [
  'audit_logs',
  'billing_events',
  'content_reports',
  'organization_invitations',
];

// Expected renamed indexes on platform DB (table, acceptable new names, legacy names that must be absent)
const PLATFORM_INDEX_CHECKS = [
  { table: 'business_listings', expectedAny: ['business_listings_city_id_area_id_status'], legacy: ['gym_listings_city_id_area_id_status'] },
  { table: 'business_listings', expectedAny: ['business_listings_organization_id'], legacy: ['gym_listings_tenant_id', 'business_listings_tenant_id'] },
  { table: 'business_listings', expectedAny: ['business_listings_is_featured'], legacy: ['gym_listings_is_featured'] },
  { table: 'business_listings', expectedAny: ['business_listings_gender_type'], legacy: ['gym_listings_gender_type'] },
  { table: 'saved_businesses', expectedAny: ['saved_businesses_user_id_business_id'], legacy: ['saved_gyms_user_id_gym_listing_id'] },
  { table: 'saved_businesses', expectedAny: ['saved_businesses_user_id'], legacy: ['saved_gyms_user_id'] },
  { table: 'business_reviews', expectedAny: ['business_reviews_business_id_status'], legacy: ['gym_reviews_gym_listing_id_status'] },
  { table: 'business_reviews', expectedAny: ['business_reviews_branch_id_status'], legacy: ['gym_reviews_branch_id_status'] },
  { table: 'business_reviews', expectedAny: ['business_reviews_user_id'], legacy: ['gym_reviews_user_id'] },
  { table: 'business_reviews', expectedAny: ['business_reviews_branch_user_unique'], legacy: ['gym_reviews_branch_user_unique'] },
  { table: 'member_subscription_index', expectedAny: ['member_subscription_index_user_id_status'], legacy: ['user_gym_memberships_user_id_status'] },
  { table: 'member_subscription_index', expectedAny: ['member_subscription_index_organization_id'], legacy: ['user_gym_memberships_tenant_id', 'member_subscription_index_tenant_id'] },
  { table: 'member_subscription_index', expectedAny: ['member_subscription_index_subscription_id'], legacy: ['user_gym_memberships_subscription_id'] },
  { table: 'member_subscription_index', expectedAny: ['member_subscription_index_business_id'], legacy: ['user_gym_memberships_gym_listing_id'] },
  { table: 'payout_accounts', expectedAny: ['payout_accounts_business_id'], legacy: ['payout_accounts_organization_id'] },
  { table: 'payout_accounts', expectedAny: ['payout_accounts_organization_scope_provider'], legacy: ['payout_accounts_tenant_scope_provider'] },
  { table: 'capacity_events', expectedAny: ['capacity_events_business_id'], legacy: ['capacity_events_listing_id'] },
  { table: 'capacity_events', expectedAny: ['capacity_events_organization_id'], legacy: ['capacity_events_tenant_id'] },
  { table: 'organizations', expectedAny: ['organizations_organization_code_unique'], legacy: ['tenants_tenant_code_unique'] },
  { table: 'organizations', expectedAny: ['organizations_owner_user_id'], legacy: ['tenants_owner_user_id'] },
  { table: 'organizations', expectedAny: ['organizations_status'], legacy: ['tenants_status'] },
  { table: 'organizations', expectedAny: ['organizations_city_id'], legacy: ['tenants_city_id'] },
  {
    table: 'organization_invitations',
    expectedAny: ['organization_invitations_token_hash', 'idx_organization_invitations_token_hash'],
    legacy: ['tenant_invitations_token_hash', 'idx_tenant_invitations_token_hash'],
  },
  {
    table: 'organization_invitations',
    expectedAny: ['organization_invitations_owner_email', 'idx_organization_invitations_owner_email'],
    legacy: ['tenant_invitations_owner_email', 'idx_tenant_invitations_owner_email'],
  },
  {
    table: 'organization_invitations',
    expectedAny: ['organization_invitations_status', 'idx_organization_invitations_status'],
    legacy: ['tenant_invitations_status', 'idx_tenant_invitations_status'],
  },
  { table: 'organization_subscriptions', expectedAny: ['organization_subscriptions_organization_id'], legacy: ['tenant_subscriptions_tenant_id', 'organization_subscriptions_tenant_id'] },
  { table: 'organization_subscriptions', expectedAny: ['organization_subscriptions_status'], legacy: ['tenant_subscriptions_status'] },
  { table: 'organization_subscriptions', expectedAny: ['organization_subscriptions_end_date'], legacy: ['tenant_subscriptions_end_date'] },
  { table: 'organization_subscriptions', expectedAny: ['organization_subscriptions_external_original_transaction_id'], legacy: ['tenant_subscriptions_external_original_transaction_id'] },
  { table: 'organization_subscriptions', expectedAny: ['organization_subscriptions_platform_external_unique'], legacy: ['tenant_subscriptions_platform_external_unique'] },
  { table: 'platform_invoices', expectedAny: ['platform_invoices_organization_subscription_id'], legacy: ['platform_invoices_tenant_subscription_id'] },
  { table: 'platform_invoices', expectedAny: ['platform_invoices_organization_id'], legacy: ['platform_invoices_tenant_id'] },
  { table: 'user_organization_index', expectedAny: ['user_organization_index_user_id_status'], legacy: ['user_org_index_user_id_status'] },
  { table: 'user_organization_index', expectedAny: ['user_organization_index_organization_id_status'], legacy: ['user_org_index_tenant_id_status', 'user_organization_index_tenant_id_status'] },
  { table: 'devices', expectedAny: ['devices_organization_id'], legacy: ['devices_tenant_id'] },
  { table: 'device_members', expectedAny: ['device_members_organization_id'], legacy: ['device_members_tenant_id'] },
  { table: 'conversations', expectedAny: ['conversations_organization_id'], legacy: ['conversations_tenant_id'] },
  { table: 'billing_events', expectedAny: ['billing_events_organization_status'], legacy: ['billing_events_tenant_status'] },
  { table: 'audit_logs', expectedAny: ['audit_logs_organization_id'], legacy: ['audit_logs_tenant_id'] },
  { table: 'plan_payment_requests', expectedAny: ['plan_payment_requests_organization_id_status'], legacy: ['plan_payment_requests_tenant_id_status'] },
  { table: 'user_blocks', expectedAny: ['user_blocks_organization_id'], legacy: ['user_blocks_tenant_id'] },
];

const TENANT_INDEX_CHECKS = [
  { table: 'branches', expectedAny: ['branches_business_id'], legacy: ['branches_gym_id'] },
  { table: 'membership_plans', expectedAny: ['membership_plans_business_id'], legacy: ['membership_plans_gym_id'] },
];

function assertSafeTarget() {
  if (!SAFE_DB_NAME.test(PLATFORM_DB)) {
    console.error(`REFUSED: invalid platform database name "${PLATFORM_DB}".`);
    process.exit(2);
  }
  const prodHost = String(process.env.PRODUCTION_TENANT_DB_HOST || '209.209.42.64').toLowerCase();
  const isProdTarget =
    process.env.NODE_ENV === 'production' ||
    String(process.env.APP_URL || '').includes('api.gymsera.com') ||
    PLATFORM_HOST.toLowerCase() === prodHost ||
    TENANT_HOST.toLowerCase() === prodHost ||
    PLATFORM_DB === 'gymsera' ||
    !LOCAL_HOSTS.has(PLATFORM_HOST.toLowerCase()) ||
    !LOCAL_HOSTS.has(TENANT_HOST.toLowerCase());

  if (isProdTarget && !(VERIFY_ONLY && ALLOW_NONLOCAL)) {
    console.error(
      `REFUSED: dry-run target (${PLATFORM_HOST}:${PLATFORM_PORT}/${PLATFORM_DB}, tenantHost=${TENANT_HOST}) ` +
        'looks non-local or production. This script mutates migrations and must run only on a local throwaway database ' +
        '(pass --verify-only --allow-nonlocal only for read-only verification).'
    );
    process.exit(2);
  }
}

function makeSequelize({ host, port, database, username, password }) {
  return new Sequelize(database, username, password, {
    host,
    port,
    dialect: 'mysql',
    logging: false,
    pool: { max: 4, min: 0, acquire: 20000, idle: 10000 },
    dialectOptions: { connectTimeout: 15000 },
  });
}

async function listTables(sequelize) {
  const rows = await sequelize.query(
    'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = \'BASE TABLE\'',
    { type: QueryTypes.SELECT }
  );
  return new Set(rows.map((r) => r.name));
}

async function listColumns(sequelize, table) {
  const rows = await sequelize.query(
    'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    { replacements: [table], type: QueryTypes.SELECT }
  );
  return new Set(rows.map((r) => r.name));
}

async function listIndexesByTable(sequelize) {
  const rows = await sequelize.query(
    'SELECT TABLE_NAME AS tbl, INDEX_NAME AS idx FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()',
    { type: QueryTypes.SELECT }
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.tbl)) map.set(r.tbl, new Set());
    map.get(r.tbl).add(r.idx);
  }
  return map;
}

async function snapshotCounts(sequelize, tablePairs) {
  const tables = await listTables(sequelize);
  const counts = {};
  for (const [oldName, newName] of tablePairs) {
    const activeName = tables.has(newName) ? newName : tables.has(oldName) ? oldName : null;
    if (!activeName) {
      counts[newName] = null;
      continue;
    }
    const [row] = await sequelize.query(`SELECT COUNT(*) AS n FROM \`${activeName}\``, { type: QueryTypes.SELECT });
    counts[newName] = Number(row.n);
  }
  return { tables, counts };
}

async function readLocalOrganizations(platformSeq) {
  const tables = await listTables(platformSeq);
  const orgTable = tables.has('organizations') ? 'organizations' : tables.has('tenants') ? 'tenants' : null;
  if (!orgTable) return [];
  const cols = await listColumns(platformSeq, orgTable);
  const codeCol = cols.has('organization_code') ? 'organization_code' : 'tenant_code';
  const nameCol = cols.has('first_business_name') ? 'first_business_name' : cols.has('gym_name') ? 'gym_name' : codeCol;
  return platformSeq.query(
    `SELECT id, \`${codeCol}\` AS organizationCode, \`${nameCol}\` AS firstBusinessName, status, db_name AS dbName FROM \`${orgTable}\` ORDER BY \`${codeCol}\``,
    { type: QueryTypes.SELECT }
  );
}

async function databaseExists(sequelize, dbName) {
  if (!dbName || !SAFE_DB_NAME.test(dbName)) return false;
  const rows = await sequelize.query(
    'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
    { replacements: [dbName], type: QueryTypes.SELECT }
  );
  return rows.length > 0;
}

function compareCounts(beforeCounts, afterCounts, label, warnings, failures) {
  const diffs = [];
  for (const [key, beforeVal] of Object.entries(beforeCounts)) {
    const afterVal = afterCounts[key];
    if (beforeVal === null && afterVal === null) continue;
    if (beforeVal === null && afterVal !== null) {
      diffs.push(`${key}: (new table) -> ${afterVal}`);
      continue;
    }
    if (beforeVal !== null && afterVal === null) {
      failures.push(`${label} table "${key}" missing after migration (had ${beforeVal} rows)`);
      continue;
    }
    if (beforeVal !== afterVal) {
      if (key === 'moderation_words') {
        warnings.push(`${label} ${key}: ${beforeVal} -> ${afterVal} (starter seed rows expected in p031)`);
      } else {
        failures.push(`${label} row count changed for "${key}": before=${beforeVal}, after=${afterVal}`);
      }
    }
  }
  return diffs;
}

async function verifyIndexChecks(sequelize, checks, scopeLabel, failures) {
  const tables = await listTables(sequelize);
  const idxMap = await listIndexesByTable(sequelize);
  let checked = 0;
  for (const rule of checks) {
    if (!tables.has(rule.table)) continue;
    checked += 1;
    const present = idxMap.get(rule.table) || new Set();
    const hasExpected = rule.expectedAny.some((name) => present.has(name));
    if (!hasExpected) {
      failures.push(`${scopeLabel}: ${rule.table} missing renamed index [${rule.expectedAny.join(' or ')}]`);
    }
    for (const oldIdx of rule.legacy) {
      if (present.has(oldIdx)) {
        failures.push(`${scopeLabel}: ${rule.table} still has legacy index "${oldIdx}"`);
      }
    }
  }
  return checked;
}

async function main() {
  assertSafeTarget();

  console.log('=== Release 1.1.0 Restored-Backup Dry-Run & Invariant Check ===');
  console.log(`Mode: ${VERIFY_ONLY ? 'VERIFY-ONLY (read-only)' : 'MIGRATE + VERIFY'}`);
  console.log(`Platform DB: ${PLATFORM_HOST}:${PLATFORM_PORT}/${PLATFORM_DB}`);
  console.log(`Tenant host: ${TENANT_HOST}:${TENANT_PORT} (connecting via local organizations.db_name copies)\n`);

  const platformSeq = makeSequelize({
    host: PLATFORM_HOST,
    port: PLATFORM_PORT,
    database: PLATFORM_DB,
    username: dbConfig.platform.username || 'root',
    password: dbConfig.platform.password || '',
  });

  const failures = [];
  const warnings = [];
  const observations = [];
  const orgConnections = [];

  try {
    await platformSeq.authenticate();

    const prePlatform = await snapshotCounts(platformSeq, PLATFORM_TABLE_PAIRS);
    const orgsBefore = await readLocalOrganizations(platformSeq);
    const orgBeforeSnapshots = new Map();

    for (const org of orgsBefore) {
      if (!org.dbName) continue;
      if (!(await databaseExists(platformSeq, org.dbName))) {
        warnings.push(`Org ${org.organizationCode} (${org.status}): db_name "${org.dbName}" not found on ${TENANT_HOST}:${TENANT_PORT}`);
        continue;
      }
      const seq = makeSequelize({
        host: TENANT_HOST,
        port: TENANT_PORT,
        database: org.dbName,
        username: TENANT_USER,
        password: TENANT_PASS,
      });
      await seq.authenticate();
      orgConnections.push({ org, seq });
      orgBeforeSnapshots.set(org.id, await snapshotCounts(seq, TENANT_TABLE_PAIRS));
    }

    console.log(`[1/5] Pre-migration snapshot: ${prePlatform.tables.size} platform tables, ${orgConnections.length}/${orgsBefore.length} local org DBs reachable.`);

    if (!VERIFY_ONLY) {
      console.log(`\n[2/5] Running platform migrations (target v${PLATFORM_TARGET_VERSION})...`);
      const pDry = await runPlatformMigrations(platformSeq, { dryRun: true });
      console.log(`  Dry-run: at v${pDry.initialVersion}, pending: ${(pDry.wouldRun || []).join(', ') || 'none'}`);
      const pLive = await runPlatformMigrations(platformSeq, { dryRun: false });
      console.log(`  Applied: v${pLive.initialVersion} -> v${pLive.finalVersion} (${(pLive.applied || []).length} applied)`);
      if (pLive.skipped && pLive.skipped.length) {
        failures.push(`Platform migration skipped due to conflicts: ${JSON.stringify(pLive.skipped)}`);
      }
      if (pLive.finalVersion < PLATFORM_TARGET_VERSION) {
        failures.push(`Platform version v${pLive.finalVersion} is below target v${PLATFORM_TARGET_VERSION}`);
      }

      if (!SKIP_TENANT_MIGRATIONS) {
        console.log(`\n[3/5] Running per-organization migrations (target v${TARGET_SCHEMA_VERSION})...`);
        for (const { org, seq } of orgConnections) {
          if (!MIGRATABLE_STATUSES.has(org.status)) {
            observations.push(`Skipped non-migratable org ${org.organizationCode} (status=${org.status})`);
            continue;
          }
          if (await isUnbaselinedTenantDb(seq)) {
            failures.push(`${org.organizationCode} (${org.dbName}) has no schema_migrations table; run repair-tenant-schema.js first`);
            continue;
          }
          const tDry = await runTenantMigrations(seq, {
            organizationId: org.id,
            organizationCode: org.organizationCode,
            gymName: org.firstBusinessName,
            dryRun: true,
          });
          const tLive = await runTenantMigrations(seq, {
            organizationId: org.id,
            organizationCode: org.organizationCode,
            gymName: org.firstBusinessName,
            dryRun: false,
          });
          console.log(
            `  ${org.organizationCode} (${org.dbName}): v${tDry.initialVersion} -> v${tLive.finalVersion} ` +
              `(${(tLive.applied || []).length} applied)`
          );
          if (tLive.skipped && tLive.skipped.length) {
            failures.push(`Org ${org.organizationCode} skipped migrations: ${JSON.stringify(tLive.skipped)}`);
          }
          if (tLive.finalVersion < TARGET_SCHEMA_VERSION) {
            failures.push(`Org ${org.organizationCode} at v${tLive.finalVersion} < target v${TARGET_SCHEMA_VERSION}`);
          }
        }
      }
    } else {
      console.log('\n[2/5 & 3/5] Skipped migrations (--verify-only).');
    }

    console.log('\n[4/5] Verifying row counts...');
    const postPlatform = await snapshotCounts(platformSeq, PLATFORM_TABLE_PAIRS);
    if (!VERIFY_ONLY) {
      compareCounts(prePlatform.counts, postPlatform.counts, 'Platform DB', warnings, failures);
    }
    console.log(
      `  Platform core counts: users=${postPlatform.counts.users ?? 'n/a'}, ` +
        `organizations=${postPlatform.counts.organizations ?? 'n/a'}, ` +
        `business_listings=${postPlatform.counts.business_listings ?? 'n/a'}, ` +
        `organization_subscriptions=${postPlatform.counts.organization_subscriptions ?? 'n/a'}`
    );

    const orgPostSnapshots = new Map();
    for (const { org, seq } of orgConnections) {
      const postOrg = await snapshotCounts(seq, TENANT_TABLE_PAIRS);
      orgPostSnapshots.set(org.id, postOrg);
      if (!VERIFY_ONLY && !SKIP_TENANT_MIGRATIONS) {
        compareCounts(orgBeforeSnapshots.get(org.id).counts, postOrg.counts, `Org ${org.organizationCode}`, warnings, failures);
      }
    }

    console.log('\n[5/5] Verifying release 1.1.0 invariants...');

    // 5a. Platform schema version & legacy table absence
    const [pVerRow] = await platformSeq.query('SELECT MAX(version) AS maxVer FROM schema_migrations', { type: QueryTypes.SELECT });
    const pVer = Number(pVerRow?.maxVer || 0);
    if (pVer < PLATFORM_TARGET_VERSION) {
      failures.push(`Platform schema_migrations MAX(version) is ${pVer}, expected ${PLATFORM_TARGET_VERSION}`);
    }
    for (const legacyTbl of ['tenants', 'tenant_subscriptions', 'tenant_invitations', 'user_org_index', 'gym_listings', 'saved_gyms', 'gym_reviews', 'user_gym_memberships']) {
      if (postPlatform.tables.has(legacyTbl)) {
        failures.push(`Platform legacy table "${legacyTbl}" still exists after migrations`);
      }
    }

    // 5b. No NULL organization_id on required tables & no leftover tenant_id columns
    const nullOrgReport = [];
    for (const table of [...P035_NON_NULL_ORG_ID_TABLES, ...P035_NULLABLE_ORG_ID_TABLES]) {
      if (!postPlatform.tables.has(table)) continue;
      const cols = await listColumns(platformSeq, table);
      if (cols.has('tenant_id')) {
        failures.push(`Platform table "${table}" still has legacy column "tenant_id"`);
      }
      if (!cols.has('organization_id')) {
        failures.push(`Platform table "${table}" is missing column "organization_id"`);
        continue;
      }
      const [row] = await platformSeq.query(
        `SELECT COUNT(*) AS n FROM \`${table}\` WHERE organization_id IS NULL`,
        { type: QueryTypes.SELECT }
      );
      const nullCount = Number(row.n);
      if (P035_NON_NULL_ORG_ID_TABLES.includes(table) && nullCount > 0) {
        failures.push(`Invariant violation: "${table}" has ${nullCount} row(s) with NULL organization_id`);
      } else if (nullCount > 0) {
        nullOrgReport.push(`${table}=${nullCount}`);
      }
    }
    if (nullOrgReport.length) {
      observations.push(`Nullable-by-design NULL organization_id rows (review if unexpected): ${nullOrgReport.join(', ')}`);
    }

    // 5c. Value & enum renames in p033/p034
    if (postPlatform.tables.has('capacity_events')) {
      const [badCap] = await platformSeq.query(
        'SELECT COUNT(*) AS n FROM `capacity_events` WHERE `action` IN (\'ORG_DELETED\', \'ORG_BRANCHES_MOVED\')',
        { type: QueryTypes.SELECT }
      );
      if (Number(badCap.n) > 0) failures.push(`capacity_events still has ${badCap.n} legacy ORG_* action row(s)`);
    }
    if (postPlatform.tables.has('user_blocks')) {
      const [badBlock] = await platformSeq.query(
        'SELECT COUNT(*) AS n FROM `user_blocks` WHERE `blocked_by` = \'TENANT\'',
        { type: QueryTypes.SELECT }
      );
      if (Number(badBlock.n) > 0) failures.push(`user_blocks still has ${badBlock.n} row(s) with blocked_by = 'TENANT'`);
    }
    if (postPlatform.tables.has('payout_accounts')) {
      const [badPayout] = await platformSeq.query(
        'SELECT COUNT(*) AS n FROM `payout_accounts` WHERE `scope_key` = \'TENANT\'',
        { type: QueryTypes.SELECT }
      );
      if (Number(badPayout.n) > 0) failures.push(`payout_accounts still has ${badPayout.n} row(s) with scope_key = 'TENANT'`);
    }
    if (postPlatform.tables.has('area_request_links')) {
      const [badLink] = await platformSeq.query(
        'SELECT COUNT(*) AS n FROM `area_request_links` WHERE `target` IN (\'tenant\', \'main_branch\', \'listing\')',
        { type: QueryTypes.SELECT }
      );
      if (Number(badLink.n) > 0) failures.push(`area_request_links still has ${badLink.n} legacy target enum row(s)`);
    }

    // 5d. Platform indexes renamed
    const platformIdxChecked = await verifyIndexChecks(platformSeq, PLATFORM_INDEX_CHECKS, 'Platform DB', failures);

    // 5e. Business <-> Listing 1:1 invariant & per-organization invariants
    const listingRows = postPlatform.tables.has('business_listings')
      ? await platformSeq.query(
        'SELECT id, organization_id AS organizationId, status, kyc_status AS kycStatus, primary_branch_id AS primaryBranchId FROM `business_listings`',
        { type: QueryTypes.SELECT }
      )
      : [];
    const listingsById = new Map(listingRows.map((l) => [l.id, l]));
    const notSubmittedListings = listingRows.filter((l) => l.status === 'ACTIVE' && l.kycStatus !== 'APPROVED').length;
    if (notSubmittedListings > 0) {
      observations.push(
        `${notSubmittedListings} ACTIVE business_listings row(s) have kyc_status != APPROVED (expected pre-M2 backup rows without backfill; hidden in discovery until approved or wiped)`
      );
    }

    let totalBusinesses = 0;
    let tenantIdxChecked = 0;
    const connectedOrgIds = new Set(orgConnections.map((c) => c.org.id));

    for (const { org, seq } of orgConnections) {
      const postOrg = orgPostSnapshots.get(org.id);
      if (postOrg.tables.has('gyms')) {
        failures.push(`${org.organizationCode}: legacy table "gyms" still exists`);
      }
      if (!postOrg.tables.has('businesses') || !postOrg.tables.has('branches')) {
        failures.push(`${org.organizationCode}: missing core table "businesses" or "branches"`);
        continue;
      }

      const [tVerRow] = await seq.query('SELECT MAX(version) AS maxVer FROM schema_migrations', { type: QueryTypes.SELECT });
      const tVer = Number(tVerRow?.maxVer || 0);
      if (tVer < TARGET_SCHEMA_VERSION) {
        failures.push(`${org.organizationCode}: tenant schema version v${tVer} < target v${TARGET_SCHEMA_VERSION}`);
      }

      // Check 031 (gym_listing_id dropped) & 032 (refund policy moved to branch)
      const bizCols = await listColumns(seq, 'businesses');
      const brCols = await listColumns(seq, 'branches');
      if (bizCols.has('gym_listing_id')) failures.push(`${org.organizationCode}: businesses.gym_listing_id still present`);
      if (brCols.has('gym_listing_id')) failures.push(`${org.organizationCode}: branches.gym_listing_id still present`);
      if (bizCols.has('refunds_allowed') || bizCols.has('refund_window_days')) {
        failures.push(`${org.organizationCode}: businesses still has refund policy column(s) after migration 032`);
      }
      if (!brCols.has('refunds_allowed') || !brCols.has('refund_window_days') || !brCols.has('hours_json')) {
        failures.push(`${org.organizationCode}: branches missing refunds_allowed, refund_window_days, or hours_json`);
      }
      if (brCols.has('gym_id')) failures.push(`${org.organizationCode}: branches still has legacy column gym_id`);
      if (!brCols.has('business_id')) failures.push(`${org.organizationCode}: branches missing business_id`);

      // Check every business in tenant DB has a matching listing id in platform business_listings
      const bizRows = await seq.query('SELECT id, name FROM `businesses`', { type: QueryTypes.SELECT });
      totalBusinesses += bizRows.length;
      const tenantBizIds = new Set();
      for (const biz of bizRows) {
        tenantBizIds.add(biz.id);
        const listing = listingsById.get(biz.id);
        if (!listing) {
          failures.push(`${org.organizationCode}: business ${biz.id} has no matching row in platform business_listings (Option S violated)`);
        } else if (listing.organizationId !== org.id) {
          failures.push(`${org.organizationCode}: business ${biz.id} belongs to listing organization ${listing.organizationId}, expected ${org.id}`);
        }
      }
      for (const listing of listingRows) {
        if (listing.organizationId === org.id && !tenantBizIds.has(listing.id)) {
          failures.push(`${org.organizationCode}: platform listing ${listing.id} (${listing.status}) has no matching row in tenant businesses`);
        }
      }

      // Every branch must have a non-null business_id present in businesses
      const [orphanBranches] = await seq.query(
        'SELECT COUNT(*) AS n FROM `branches` br LEFT JOIN `businesses` b ON b.id = br.business_id WHERE br.business_id IS NULL OR b.id IS NULL',
        { type: QueryTypes.SELECT }
      );
      if (Number(orphanBranches.n) > 0) {
        failures.push(`${org.organizationCode}: ${orphanBranches.n} branch row(s) with NULL or dangling business_id`);
      }

      tenantIdxChecked += await verifyIndexChecks(seq, TENANT_INDEX_CHECKS, `Org ${org.organizationCode}`, failures);
    }

    const uncheckedListings = listingRows.filter((l) => !connectedOrgIds.has(l.organizationId)).length;
    if (uncheckedListings > 0) {
      warnings.push(`${uncheckedListings} business_listings row(s) belong to organizations whose local DB copy was missing or unprovisioned and could not be cross-checked`);
    }

    // 6. Report
    console.log('\n================ WHAT TO LOOK AT ================');
    console.log(`Platform schema version   : v${pVer} (target v${PLATFORM_TARGET_VERSION})`);
    console.log(`Organizations checked     : ${orgConnections.length} / ${orgsBefore.length} (target v${TARGET_SCHEMA_VERSION})`);
    console.log(`Platform listings checked : ${listingRows.length} | Tenant businesses checked: ${totalBusinesses}`);
    console.log(`Index checks evaluated    : ${platformIdxChecked} platform rules, ${tenantIdxChecked} tenant rules`);

    if (observations.length) {
      console.log('\nObservations (expected / inspect carefully):');
      for (const item of observations) console.log(`  - ${item}`);
    }
    if (warnings.length) {
      console.log('\nWarnings:');
      for (const w of warnings) console.log(`  ! ${w}`);
    }
    if (failures.length) {
      console.log('\nFAILURES (block cut-over until resolved):');
      for (const f of failures) console.log(`  x ${f}`);
      console.log('=================================================\n');
      process.exitCode = 1;
    } else {
      console.log('\nRESULT: PASS — migrations, row counts, Option S listing IDs, non-null organization_id, and index renames all verified.');
      console.log('=================================================\n');
      process.exitCode = 0;
    }
  } finally {
    await platformSeq.close().catch(() => {});
    for (const { seq } of orgConnections) {
      await seq.close().catch(() => {});
    }
  }
}

main().catch((err) => {
  console.error('Dry-run failed:', err.message);
  process.exit(1);
});

