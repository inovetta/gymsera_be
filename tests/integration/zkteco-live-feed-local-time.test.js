/**
 * Live feed times (2026-11-12, SpeedFace-V5L on a Pakistan branch): the CMS feed showed a punch at PKT 17:22:50
 * as "2026-11-12T17:22:50.000Z" while the real instant was 12:22:50 UTC.
 *
 * Root cause: device-screens.service#accessEvents returned `localTime: r.device_time`. device_time holds the
 * device's wall clock (branch local), but the connection reads every DATETIME as UTC, so the value came back
 * as a Date and was serialised with a 'Z'. Storage was right (utc_time is the converted instant); only the
 * response was wrong.
 *
 * The feed must return:
 *   localTime  the device wall time exactly as the device sent it, 'YYYY-MM-DD HH:mm:ss', no 'T', no 'Z'
 *   time       the instant, ISO 8601 UTC with 'Z' (Asia/Karachi has no DST: always wall time minus 5 hours)
 * for live punches, history punches, and on the branch feed too. Run under any machine zone (TZ=UTC,
 * TZ=America/Chicago): the answer must not depend on it.
 */
const crypto = require('crypto');
const { createWorld, localNow } = require('../harness/zkteco-world');
const { asPersona } = require('../harness');
const { ZkDeviceSimulator } = require('../../scripts/zk-device-simulator');
const registry = require('../../src/services/devices/device-registry.service');

const owner = () => asPersona('owner');
const WALL = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const PKT_OFFSET_MS = 5 * 3600000;
/** The instant of a PKT wall time: read the text as if it were UTC, then take 5 hours off. */
const pktInstant = (wall) => new Date(new Date(`${wall.replace(' ', 'T')}Z`).getTime() - PKT_OFFSET_MS).toISOString();

let w;
let branch;
let dev;
let sim;
let pin;
let member;
const RUN = crypto.randomBytes(2).toString('hex').toUpperCase();

beforeAll(async () => {
  w = await createWorld();
  branch = await w.branch(w.db1, { gymId: (await w.gym(w.db1)).id, name: 'Feed Time Branch', timezone: 'Asia/Karachi' });
  member = await w.member('Feed Time Member', { email: `feed-time-${crypto.randomBytes(3).toString('hex')}@gymseratest.com` });
  const { device } = await registry.createDevice({
    tenantId: w.db1.tenantId, tenantDb: w.db1, branchId: branch.id, organizationId: branch.gymId, name: 'Feed Door', direction: 'in',
    importFirst: false, createdBy: w.owner.user.id,
  });
  dev = device;
  sim = new ZkDeviceSimulator({ baseUrl: w.baseUrl, sn: `FT${RUN}0001`, key: device.deviceKey, mode: 'host', att: true });
  await sim.connectAtt();
  await w.settled();
  await w.subscribe(w.db1, { user: member, branch });
  await sim.drain();
  pin = await w.pinOf(w.db1, member.id);
  expect(pin).toMatch(/^\d+$/);
});

const feed = async () => {
  const res = await owner().get(`/api/v1/host/devices/${dev.id}/access-events`);
  expect(res.status).toBe(200);
  return res.body.data.events;
};

describe('live feed: localTime is the device wall time, time is the UTC instant', () => {
  test('a live ATTLOG punch at a known PKT time: localTime = the text sent, time = sent minus 5 hours with a Z', async () => {
    const sent = localNow(0, 'Asia/Karachi');
    await sim.punch(pin, sent, 15);
    const [e] = (await feed()).filter((x) => x.pin === pin && x.localTime === sent);
    expect(e).toBeDefined();
    expect(e.localTime).toMatch(WALL);
    expect(e.localTime).toBe(sent);
    expect(e.localTime).not.toMatch(/[TZ]/);
    expect(e.time).toBe(pktInstant(sent));
    expect(e.time).toMatch(/Z$/);
    expect(e.attendanceNote).toBe('check_in');

    // Storage (was already right): utc_time is the instant, the check-in uses it.
    const [row] = await w.q(w.db1, 'SELECT `utc_time`, attendance_id FROM device_access_events WHERE id = ?', [e.id]);
    expect(new Date(row.utc_time).toISOString()).toBe(pktInstant(sent));
    const [log] = await w.q(w.db1, 'SELECT check_in_at FROM attendance_logs WHERE id = ?', [row.attendance_id]);
    expect(new Date(log.check_in_at).toISOString()).toBe(pktInstant(sent));
  });

  test('a history punch (before activation) is shown the same way', async () => {
    const sent = localNow(-3 * 24 * 60, 'Asia/Karachi');
    await sim.punch(pin, sent, 1);
    const [e] = (await feed()).filter((x) => x.pin === pin && x.attendanceNote === 'history');
    expect(e).toBeDefined();
    expect(e.localTime).toBe(sent);
    expect(e.time).toBe(pktInstant(sent));
  });

  test('the branch feed returns the same shape', async () => {
    const res = await owner().get(`/api/v1/host/branches/${branch.id}/access-events`);
    expect(res.status).toBe(200);
    const events = res.body.data.events;
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.localTime).toMatch(WALL);
      expect(e.time).toBe(pktInstant(e.localTime));
    }
  });
});
