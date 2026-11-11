/**
 * ZKTeco Phase 4 hardening (spec §5 "rate limits", §13, §14 points 3 and 4):
 *
 *   token enforce   DEVICE_TOKEN_MODE=enforce: cdata GET, registry and push are exempt (the device learns the
 *                   SessionID from push); every other call needs the token; the migration script moves a
 *                   device from log to enforce only after it has sent a matching token
 *   rate limits     per device (DEVICE_RATE_PER_SECOND / DEVICE_RATE_BURST) → 429, nothing stored; an unknown
 *                   caller is answered from memory for DEVICE_UNCLAIMED_RATE_SECONDS (no database work)
 *   body size       heartbeat, push, registry and devicecmd take at most DEVICE_MAX_SMALL_BODY; uploads 10 MB
 *   replay          a result, a scan or a query pack sent twice changes nothing the second time
 *   wrong serial    406, recorded, and one owner alert per incident
 *   log redaction   no template, photo, RegistryCode, SessionID or biometric key in any log line
 */
const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const { createWorld, localNow } = require('../harness/zkteco-world');
const { ZkDeviceSimulator } = require('../../scripts/zk-device-simulator');
const { sequelize: platformDb } = require('../../src/database/platform');
const { Notification } = require('../../src/models/platform');
const registry = require('../../src/services/devices/device-registry.service');
const ingest = require('../../src/services/devices/device-ingest.service');
const jobs = require('../../src/jobs/device-jobs');
const tokenMode = require('../../src/scripts/device-token-mode');
const logRedaction = require('../../src/utils/log-redaction');

let w; let branch;
beforeAll(async () => {
  w = await createWorld();
  branch = await w.branch(w.db1, { gymId: (await w.gym(w.db1)).id, name: 'Hardening Branch' });
}, 120000);
afterAll(async () => { await w.settled(); await require('../harness').teardownTestDatabases(); });
afterEach(() => {
  for (const k of ['DEVICE_TOKEN_MODE', 'DEVICE_RATE_PER_SECOND', 'DEVICE_RATE_BURST', 'DEVICE_UNCLAIMED_RATE_SECONDS', 'LOG_DEVICES']) delete process.env[k];
  process.env.DEVICE_RATE_LIMIT = 'false'; // back to the test default (tests/harness/device-rate-limit.js)
  jest.restoreAllMocks();
});

const platformRow = async (id) => (await platformDb.query('SELECT * FROM access_devices WHERE id = ?', { replacements: [id], type: QueryTypes.SELECT }))[0];
const BAD = { Cookie: 'token=00000000000000000000000000000000' };

describe('token enforce', () => {
  test('enforce: cdata GET, registry and push need no token; getrequest, devicecmd, uploads and ping do', async () => {
    process.env.DEVICE_TOKEN_MODE = 'enforce';
    const d = await w.device(w.db1, { branch, name: 'Enforce Door' });
    expect((await platformRow(d.id)).token_mode).toBe('enforce');
    const bare = new ZkDeviceSimulator({ baseUrl: w.baseUrl, sn: d.sim.sn, key: d.device.deviceKey, sendToken: false });
    expect((await bare.request('GET', `/iclock/cdata?SN=${d.sim.sn}&options=all`)).status).toBe(200);
    expect((await bare.request('POST', `/iclock/push?SN=${d.sim.sn}`)).status).toBe(200); // the device learns the SessionID here
    expect((await bare.registry()).status).toBe(200);
    for (const [method, path, body] of [
      ['GET', '/iclock/getrequest', ''], ['POST', '/iclock/devicecmd', 'ID=1&Return=0&CMD=DATA'], ['GET', '/iclock/ping', ''],
      ['POST', '/iclock/cdata?table=rtlog', `time=${localNow()}\tpin=1\tevent=0\tindex=1`],
    ]) {
      const url = `${path}${path.includes('?') ? '&' : '?'}SN=${d.sim.sn}`;
      expect((await bare.request(method, url, body)).status).toBe(401);
      expect((await bare.request(method, url, body, BAD)).status).toBe(401);
    }
    expect((await d.sim.poll()).status).toBe(200);
    // The refused scan was never stored.
    const [n] = await w.q(w.db1, 'SELECT COUNT(*) AS n FROM device_access_events WHERE device_id = ?', [d.id]);
    expect(Number(n.n)).toBe(0);
  });

  test('migration from log: dry run changes nothing; apply moves only devices that sent a matching token', async () => {
    const good = await w.device(w.db1, { branch, name: 'Token Good' });
    await good.sim.poll();
    const silent = await w.device(w.db1, { branch, name: 'Token Silent', sendToken: false });
    await silent.sim.poll();
    const wrong = await w.device(w.db1, { branch, name: 'Token Wrong' });
    await wrong.sim.request('GET', `/iclock/getrequest?SN=${wrong.sim.sn}`, '', BAD);
    const ids = [good.id, silent.id, wrong.id];

    const dry = await tokenMode.planTokenMode({ to: 'enforce', deviceIds: ids });
    expect(dry.apply).toBe(false);
    expect(dry.switch.map((r) => r.id)).toEqual([good.id]);
    expect(Object.fromEntries(dry.skip.map((r) => [r.id, r.reason]))).toEqual({ [silent.id]: 'token_absent', [wrong.id]: 'token_mismatch' });
    expect((await platformRow(good.id)).token_mode).toBe('log');

    const done = await tokenMode.planTokenMode({ to: 'enforce', deviceIds: ids, apply: true });
    expect(done.switch.map((r) => r.id)).toEqual([good.id]);
    expect((await platformRow(good.id)).token_mode).toBe('enforce');
    expect((await platformRow(silent.id)).token_mode).toBe('log');
    expect((await good.sim.poll()).status).toBe(200);
    // Back to log (the way out if a firmware update changes the formula).
    await tokenMode.planTokenMode({ to: 'log', deviceIds: [good.id], apply: true });
    expect((await platformRow(good.id)).token_mode).toBe('log');
  });

  test('a device not seen for a day is not switched (its token is unproven since)', async () => {
    const d = await w.device(w.db1, { branch, name: 'Token Old' });
    await d.sim.poll();
    await platformDb.query('UPDATE access_devices SET last_seen_at = ? WHERE id = ?', { replacements: [new Date(Date.now() - 2 * 86400000), d.id] });
    const plan = await tokenMode.planTokenMode({ to: 'enforce', deviceIds: [d.id] });
    expect(plan.skip).toEqual([{ id: d.id, reason: 'not_seen_recently' }]);
  });
});

describe('rate limits', () => {
  test('per device: over the burst → 429 and nothing stored; another device is not affected', async () => {
    const a = await w.device(w.db1, { branch, name: 'Rate A' });
    const b = await w.device(w.db1, { branch, name: 'Rate B' });
    process.env.DEVICE_RATE_LIMIT = 'true';
    process.env.DEVICE_RATE_PER_SECOND = '0.1';
    process.env.DEVICE_RATE_BURST = '5';
    const statuses = [];
    for (let i = 0; i < 8; i++) statuses.push((await a.sim.scan(1, localNow(), { index: 900 + i })).res.status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses.slice(5)).toEqual([429, 429, 429]);
    const [n] = await w.q(w.db1, 'SELECT COUNT(*) AS n FROM device_access_events WHERE device_id = ?', [a.id]);
    expect(Number(n.n)).toBe(5);
    expect((await b.sim.poll()).status).toBe(200);
  });

  test('an unknown caller is answered from memory: the same answers, no lookup, for DEVICE_UNCLAIMED_RATE_SECONDS', async () => {
    process.env.DEVICE_UNCLAIMED_RATE_SECONDS = '10';
    const spy = jest.spyOn(registry, 'findByKey');
    const u = new ZkDeviceSimulator({ baseUrl: w.baseUrl, sn: `UNK${crypto.randomBytes(3).toString('hex')}`, key: 'ZZZZ3333', mode: 'host' });
    expect((await u.request('GET', `/iclock/cdata?SN=${u.sn}&options=all`)).text).toBe('OK\n');
    expect((await u.registry()).status).toBe(406);
    const looked = spy.mock.calls.length;
    for (let i = 0; i < 5; i++) {
      expect((await u.poll()).text).toBe('OK\n');
      expect((await u.registry()).status).toBe(406);
    }
    expect(spy.mock.calls.length).toBe(looked);
  });
});

describe('body size', () => {
  test('heartbeat, push, registry and devicecmd: over DEVICE_MAX_SMALL_BODY → 413; an upload of 1 MB is fine', async () => {
    const d = await w.device(w.db1, { branch, name: 'Size Door' });
    const big = 'A'.repeat(200 * 1024);
    for (const [method, path] of [['POST', '/iclock/registry'], ['POST', '/iclock/push'], ['POST', '/iclock/devicecmd'], ['POST', '/iclock/ping']]) {
      expect((await d.sim.request(method, `${path}?SN=${d.sim.sn}`, big)).status).toBe(413);
    }
    const upload = await d.sim.upload('tabledata', `user uid=1\tpin=1\tname=${'B'.repeat(1024 * 1024)}`, { tablename: 'user', count: 1 });
    expect(upload.status).toBe(200);
  });
});

describe('replay', () => {
  test('a command result, a scan and an audit pack sent twice change nothing the second time', async () => {
    const d = await w.device(w.db1, { branch, name: 'Replay Door' });
    const user = await w.member('Replay Member');
    await w.subscribe(w.db1, { user, branch });
    const ran = await d.sim.drain();
    const ackedFirst = await w.commands(w.db1, d.id, 'status = \'acked\'');
    // The same results again, and a forged failure for an acked command: ignored.
    await d.sim.ack(ran.map((r) => ({ id: r.id, returnCode: r.returnCode })));
    await d.sim.ack(ran.map((r) => ({ id: r.id, returnCode: -1001 })));
    expect((await w.commands(w.db1, d.id, 'status = \'acked\'')).map((c) => c.id)).toEqual(ackedFirst.map((c) => c.id));
    expect((await w.syncRow(w.db1, d.id, user.id)).state).toBe('in_sync');

    const pin = await w.pinOf(w.db1, user.id);
    const scan = await d.sim.scan(pin, localNow());
    await d.sim.upload('rtlog', scan.line);
    const events = await w.q(w.db1, 'SELECT attendance_id FROM device_access_events WHERE device_id = ? AND pin = ?', [d.id, pin]);
    expect(events).toHaveLength(1);
    const [att] = await w.q(w.db1, 'SELECT COUNT(*) AS n FROM attendance_logs WHERE user_id = ?', [user.id]);
    expect(Number(att.n)).toBe(1);
  });
});

describe('wrong serial', () => {
  test('406, recorded, one owner alert per incident', async () => {
    const d = await w.device(w.db1, { branch, name: 'Serial Door' });
    await Notification.destroy({ where: { userId: w.owner.user.id, type: 'device_serial_mismatch' } });
    const thief = new ZkDeviceSimulator({ baseUrl: w.baseUrl, sn: `THIEF${crypto.randomBytes(3).toString('hex')}`, key: d.device.deviceKey });
    expect((await thief.poll()).status).toBe(406);
    await jobs.deviceAlerts({ tenantId: w.db1.tenantId, db: w.db1 });
    await jobs.deviceAlerts({ tenantId: w.db1.tenantId, db: w.db1 });
    const sent = await Notification.findAll({ where: { userId: w.owner.user.id, type: 'device_serial_mismatch' }, raw: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toMatch(/Serial Door/);
    expect(sent[0].message).not.toContain(thief.sn); // the other serial is on the device page, not in a push notification
  });
});

describe('log redaction', () => {
  const TEMPLATE = `TAlTUzIxAAAFSksECAUHCc7Q${'Qk'.repeat(400)}`;

  test('the app-wide console redaction removes templates, photos, device secrets and the biometric key', () => {
    const line = `DATA UPDATE biodata Pin=1\tType=9\tMajorver=40\tTmp=${TEMPLATE} RegistryCode=AbCdEf0123456789XyZ0 SessionID=${'A1'.repeat(16)} ` +
      `content=${TEMPLATE} key ${process.env.BIOMETRIC_DATA_KEY}`;
    const out = logRedaction.redactString(line);
    expect(out).not.toContain(TEMPLATE.slice(0, 60));
    expect(out).not.toContain('AbCdEf0123456789XyZ0');
    expect(out).not.toContain('A1'.repeat(16));
    expect(out).not.toContain(process.env.BIOMETRIC_DATA_KEY.split(':')[1]);
    expect(out).toContain('Pin=1'); // what support needs stays
  });

  test('a device flow with LOG_DEVICES on, and a failure carrying a template, logs no template or secret', async () => {
    process.env.LOG_DEVICES = 'true';
    const lines = [];
    // What the app-wide console redaction would print (app.js installs it; tests read its sink).
    require('../../app');
    expect(logRedaction.isConsoleRedactionInstalled()).toBe(true);
    jest.spyOn(logRedaction.sink, 'write').mockImplementation((_t, _m, _o, args) => lines.push(args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')));
    const d = await w.device(w.db1, { branch, name: 'Log Door' });
    const user = await w.member('Log Member');
    await w.subscribe(w.db1, { user, branch });
    await d.sim.drain();
    const pin = await w.pinOf(w.db1, user.id);
    await d.sim.upload('tabledata', `biodata pin=${pin}\tno=0\tindex=0\tvalid=1\tduress=0\ttype=9\tmajorver=40\tminorver=1\tformat=0\ttmp=${TEMPLATE}`, { tablename: 'biodata', count: 1 });
    jest.spyOn(ingest, 'ingestTemplates').mockRejectedValueOnce(new Error(`Incorrect string value: 'tmp=${TEMPLATE}' for column`));
    await d.sim.upload('tabledata', `biodata pin=${pin}\tno=1\tindex=0\ttype=9\tmajorver=40\ttmp=${TEMPLATE}`, { tablename: 'biodata', count: 1 });
    await w.settled();
    const row = await platformRow(d.id);
    const all = lines.join('\n');
    expect(all).toMatch(/\[device-push\]/);
    expect(all).not.toContain(TEMPLATE.slice(0, 60));
    expect(all).not.toContain(row.registry_code);
    expect(all).not.toContain(row.session_id);
    expect(all).not.toContain(process.env.BIOMETRIC_DATA_KEY.split(':')[1]);
  });
});
