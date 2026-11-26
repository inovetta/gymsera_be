/**
 * NEW-303 M3, audit findings checked at the schema and the source so they cannot come back:
 *  F3  `organization_id` holds an organization id and `business_id` a business id, in access_devices and payout_accounts;
 *  F6  user_blocks.blocked_by is wide enough for ORGANIZATION;
 *  F8  one organization-code generator, ORG- prefix, nothing else builds a code;
 *  G10 payout account scope is ORGANIZATION | BUSINESS (no TENANT).
 */
const fs = require('fs');
const path = require('path');
const { setupTestDatabases, teardownTestDatabases, setupPersonas } = require('../harness');
const { GymListing, UserBlock, PayoutAccount, Tenant } = require('../../src/models/platform');
const rename = require('../../src/database/rename-helpers');
const { generateOrganizationCode } = require('../../src/utils/organization-code.utils');

let seq;
beforeAll(async () => {
  const h = await setupTestDatabases();
  await setupPersonas(h);
  seq = GymListing.sequelize;
});
afterAll(async () => teardownTestDatabases());

test('F3: access_devices and payout_accounts keep the organization and the business in two columns', async () => {
  for (const table of ['access_devices', 'payout_accounts']) {
    expect(await rename.columnInfo(seq, table, 'organization_id')).toBeTruthy();
    expect(await rename.columnInfo(seq, table, 'business_id')).toBeTruthy();
  }
  expect(PayoutAccount.rawAttributes.organizationId).toBeTruthy();
  expect(PayoutAccount.rawAttributes.businessId.field).toBe('business_id');
  // every organization_id in either table is an organization, every business_id a business
  for (const table of ['access_devices', 'payout_accounts']) {
    const [badOrg] = await seq.query(`SELECT COUNT(*) AS n FROM ${table} t LEFT JOIN organizations o ON o.id = t.organization_id WHERE o.id IS NULL`);
    expect(Number(badOrg[0].n)).toBe(0);
    const [badBiz] = await seq.query(`SELECT COUNT(*) AS n FROM ${table} t LEFT JOIN business_listings b ON b.id = t.business_id WHERE t.business_id IS NOT NULL AND b.id IS NULL`);
    expect(Number(badBiz[0].n)).toBe(0);
  }
});

test('F6: user_blocks.blocked_by holds ORGANIZATION', async () => {
  const [[col]] = await seq.query("SELECT CHARACTER_MAXIMUM_LENGTH AS len FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_blocks' AND COLUMN_NAME = 'blocked_by'");
  expect(Number(col.len)).toBeGreaterThanOrEqual('ORGANIZATION'.length);
  expect(UserBlock.rawAttributes.blockedBy.type.options.length).toBeGreaterThanOrEqual('ORGANIZATION'.length);
});

test('F8: one generator builds organization codes, with the ORG- prefix', () => {
  expect(generateOrganizationCode()).toMatch(/^ORG-[0-9A-F]{8}$/);
  const hits = [];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    if (!p.endsWith('.js') || p.endsWith('organization-code.utils.js')) return undefined;
    const text = fs.readFileSync(p, 'utf8');
    if (/[`'"]GYM-\$\{|['"]GYM-['"]\s*\+|randomBytes\(4\)\.toString\('hex'\)\.toUpperCase\(\)/.test(text)) hits.push(path.relative(path.join(__dirname, '../..'), p));
    return undefined;
  });
  walk(path.join(__dirname, '../../src'));
  expect(hits).toEqual([]);
});

test('G10: no payout account is scoped TENANT; the organization-wide scope is ORGANIZATION', async () => {
  expect(PayoutAccount.scopeKeyFor(null)).toBe('ORGANIZATION');
  const [rows] = await seq.query("SELECT COUNT(*) AS n FROM payout_accounts WHERE scope_key = 'TENANT'");
  expect(Number(rows[0].n)).toBe(0);
  expect(Tenant).toBeTruthy();
});
