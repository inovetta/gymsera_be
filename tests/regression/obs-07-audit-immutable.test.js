/**
 * OBS-07 — audit trails are append-only (spec §12.12).
 *
 * The three audit tables (platform `audit_logs`, `platform_audit_logs`, and each tenant's `audit_logs`)
 * can be created and read, never updated or deleted through their models, singly or in bulk. Raw SQL
 * is not caught by model hooks, so a source guard also fails if code issues UPDATE / DELETE / TRUNCATE
 * on an audit table. The existing deletion / retention / orphan-database suites run with these hooks on:
 * they are the proof that no real flow needs to change an audit row.
 */
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases } = require('../harness');
const { AuditLog, PlatformAuditLog } = require('../../src/models/platform');

describe('OBS-07: audit models are append-only', () => {
  let db;
  const cases = [];

  beforeAll(async () => {
    db = await setupTestDatabases();
    cases.push(
      {
        name: 'AuditLog (platform, HTTP mutation audit)',
        model: () => AuditLog,
        make: () =>
          AuditLog.create({ method: 'POST', path: '/api/v1/x', statusCode: 200, durationMs: 5, createdAt: new Date() }),
        change: { statusCode: 500 },
      },
      {
        name: 'PlatformAuditLog (platform admin actions)',
        model: () => PlatformAuditLog,
        make: () => PlatformAuditLog.create({ action: 'TENANT_SUSPENDED', targetType: 'TENANT', targetId: uuidv4(), createdAt: new Date() }),
        change: { action: 'SOMETHING_ELSE' },
      },
      {
        name: 'AuditLog (tenant database)',
        model: () => db.tenant1.models.AuditLog,
        make: () => db.tenant1.models.AuditLog.create({ action: 'payment.refund', targetType: 'PAYMENT', targetId: 'p-1' }),
        change: { action: 'tampered' },
      }
    );
  });
  afterAll(async () => {
    await teardownTestDatabases();
  });
  beforeEach(async () => {
    await resetTestDatabases();
  });

  const caseNames = ['AuditLog (platform, HTTP mutation audit)', 'PlatformAuditLog (platform admin actions)', 'AuditLog (tenant database)'];

  describe.each(caseNames)('%s', (name) => {
    const c = () => cases.find((x) => x.name === name);

    test('create and read still work', async () => {
      const row = await c().make();
      expect(row.id).toBeDefined();
      expect(await c().model().count()).toBe(1);
    });

    test('an instance cannot be updated or saved with changes', async () => {
      const row = await c().make();
      await expect(row.update(c().change)).rejects.toThrow(/append-only/i);
      row.set(c().change);
      await expect(row.save()).rejects.toThrow(/append-only/i);
    });

    test('an instance cannot be destroyed', async () => {
      const row = await c().make();
      await expect(row.destroy()).rejects.toThrow(/append-only/i);
    });

    test('bulk update, bulk destroy and truncate are refused', async () => {
      await c().make();
      const Model = c().model();
      await expect(Model.update(c().change, { where: {} })).rejects.toThrow(/append-only/i);
      await expect(Model.destroy({ where: {} })).rejects.toThrow(/append-only/i);
      await expect(Model.destroy({ truncate: true })).rejects.toThrow(/append-only/i);
    });

    test('after every refused attempt the row is exactly as written', async () => {
      const row = await c().make();
      const before = JSON.stringify((await c().model().findByPk(row.id)).toJSON());
      await row.update(c().change).catch(() => {});
      await row.destroy().catch(() => {});
      await c().model().update(c().change, { where: {} }).catch(() => {});
      await c().model().destroy({ where: {} }).catch(() => {});
      expect(JSON.stringify((await c().model().findByPk(row.id)).toJSON())).toBe(before);
    });
  });
});

describe('OBS-07: no code issues raw UPDATE / DELETE / TRUNCATE on an audit table', () => {
  const ROOT = path.join(__dirname, '../..');
  const SKIP_DIRS = new Set(['node_modules', 'tests', 'docs', 'scratch', '.git', 'public', 'storage', 'iisnode']);
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && !entry.name.includes('socket-bundle')) files.push(full);
    }
  };

  test('source scan: SQL that changes or removes audit rows does not exist', () => {
    walk(ROOT);
    const sql = /\b(UPDATE|DELETE\s+FROM|TRUNCATE(\s+TABLE)?|REPLACE\s+INTO)\s+[`"]?(\w+[`"]?\.[`"]?)?(platform_)?audit_logs\b/i;
    const model = /\b(AuditLog|PlatformAuditLog)\.(update|destroy|bulkCreate|upsert|truncate|findOrCreate|increment|decrement)\b/;
    const offenders = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (sql.test(line) || model.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test('the scan can actually see a violation (guard is not vacuous)', () => {
    const sql = /\b(UPDATE|DELETE\s+FROM|TRUNCATE(\s+TABLE)?|REPLACE\s+INTO)\s+[`"]?(\w+[`"]?\.[`"]?)?(platform_)?audit_logs\b/i;
    expect(sql.test('await q("DELETE FROM `audit_logs` WHERE id = 1")')).toBe(true);
    expect(sql.test('UPDATE platform_audit_logs SET action = 1')).toBe(true);
    expect(sql.test('INSERT INTO platform_audit_logs (id) VALUES (1)')).toBe(false);
  });
});
