/**
 * Device timestamps are stored as UTC (src/services/devices/sql-time.js).
 *
 * Sequelize 6 writes a Date inside raw `replacements` in the server's local zone, while the mysql2
 * connection reads DATETIME as UTC. On a server not set to UTC (this Mac runs Asia/Karachi) a
 * device seen now read back 5 hours in the future: "online" for hours after it went silent, and the
 * offline watchdog never fired. Found in Phase 2; the Phase 1 registry was affected.
 */
const { QueryTypes } = require('sequelize');
const { createWorld } = require('../harness/zkteco-world');
const { utc, utcString } = require('../../src/services/devices/sql-time');
const { sequelize: platformDb } = require('../../src/database/platform');

let w;
beforeAll(async () => { w = await createWorld(); });
afterAll(async () => { await w.settled(); await require('../harness').teardownTestDatabases(); });

test('a device seen now reads back as now (last_seen_at, registered_at), whatever the server time zone', async () => {
  const branch = await w.branch(w.db1, { gymId: (await w.gym(w.db1)).id });
  const d = await w.device(w.db1, { branch });
  const [row] = await platformDb.query('SELECT last_seen_at, registered_at FROM access_devices WHERE id = ?', { replacements: [d.id], type: QueryTypes.SELECT });
  expect(Math.abs(new Date(row.last_seen_at).getTime() - Date.now())).toBeLessThan(5000);
  expect(Math.abs(new Date(row.registered_at).getTime() - Date.now())).toBeLessThan(5000);
});

test('utc() turns every Date into UTC wall time, leaves everything else alone', () => {
  const d = new Date(Date.UTC(2025, 0, 2, 3, 4, 5, 6));
  expect(utcString(d)).toBe('2025-01-02 03:04:05.006');
  const buf = Buffer.from('x');
  expect(utc([d, 1, 'a', null, buf, [d]])).toEqual(['2025-01-02 03:04:05.006', 1, 'a', null, buf, ['2025-01-02 03:04:05.006']]);
  expect(utc(new Date('invalid'))).toBeNull();
});
