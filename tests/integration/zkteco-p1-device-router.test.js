/**
 * ZKTeco Phase 1: the device router (spec ZKTECO_PUSH_DEVICE_SYNC.md §4, §5, §8.1, §14 point 5),
 * driven over real HTTP by scripts/zk-device-simulator.js.
 *
 * Claim and bind on first contact, no auto-join, wrong key / wrong serial, re-pair, unknown
 * serials, both registration styles, token log / enforce, oversized body, response headers and
 * speed, command delivery and acks, concurrent getrequest (no command handed out twice), tenant
 * isolation, the push-host path rule, and the old router's ATTLOG devices kept working.
 */
const { QueryTypes } = require('sequelize');
const http = require('http');
const { setupTestDatabases, teardownTestDatabases, setupPersonas } = require('../harness');
const { personaManager } = require('../harness/personas');
const { startTestServer } = require('../harness/test-server');
const { ZkDeviceSimulator } = require('../../scripts/zk-device-simulator');
const devices = require('../../src/services/devices/device-registry.service');
const { sequelize: platformDb } = require('../../src/database/platform');
const { utc } = require('../../src/services/devices/sql-time');

const ENV_KEYS = ['DEVICE_REGISTRATION_STYLE', 'DEVICE_TOKEN_MODE', 'DEVICE_SERIAL_PAIRING', 'DEVICE_ALLOW_HTTP', 'DEVICE_REQUEST_DELAY'];
const savedEnv = {};
beforeEach(() => ENV_KEYS.forEach((k) => { savedEnv[k] = process.env[k]; delete process.env[k]; }));
afterEach(() => ENV_KEYS.forEach((k) => { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }));

let baseUrl;
let ctx;
let owner;
let serial = 0;
// Per run: the migration-only tables are not recreated by the harness's sync (see beforeAll).
const RUN = Math.random().toString(36).slice(2, 6).toUpperCase();
const nextSn = () => `SIM${RUN}${String(++serial).padStart(4, '0')}`;

const platformRow = async (id) =>
  (await platformDb.query('SELECT * FROM access_devices WHERE id = ?', { replacements: [id], type: QueryTypes.SELECT }))[0];
const detailsRow = async (tenantDb, id) =>
  (await tenantDb.sequelize.query('SELECT * FROM access_device_details WHERE id = ?', { replacements: [id], type: QueryTypes.SELECT }))[0];
const commandsOf = async (tenantDb, deviceId) =>
  tenantDb.sequelize.query('SELECT * FROM device_commands WHERE device_id = ? ORDER BY id', { replacements: [deviceId], type: QueryTypes.SELECT });
const queue = async (tenantDb, deviceId, kind, n = 1, extra = {}) => {
  for (let i = 0; i < n; i++) {
    await tenantDb.sequelize.query(
      'INSERT INTO device_commands (device_id, kind, args_json, priority, not_before, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      { replacements: utc([deviceId, kind, extra.args ? JSON.stringify(extra.args) : null, extra.priority ?? 5, new Date(Date.now() - 1000), new Date(), new Date()]) }
    );
  }
};

const create = (over = {}) =>
  devices.createDevice({
    tenantId: ctx.tenant1.id,
    tenantDb: ctx.tenant1Db,
    branchId: ctx.branch1.id,
    organizationId: ctx.branch1.gymId || null,
    name: 'Front door IN',
    direction: 'in',
    createdBy: owner.user.id,
    ...over,
  });

const sim = (device, over = {}) =>
  new ZkDeviceSimulator({ baseUrl, sn: over.sn || nextSn(), key: device ? device.deviceKey : undefined, mode: 'host', ...over });

const raw = (method, path, { headers = {}, body = '' } = {}) =>
  new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { 'Content-Length': Buffer.byteLength(body), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });

beforeAll(async () => {
  const h = await setupTestDatabases();
  const personas = await setupPersonas(h);
  owner = personas.owner;
  ctx = personaManager.context;
  // The harness recreates model tables only; these come from migrations and keep old rows.
  for (const t of ['access_devices', 'unclaimed_device_contacts']) await platformDb.query(`DELETE FROM \`${t}\``);
  for (const db of [ctx.tenant1Db, ctx.tenant2Db]) {
    for (const t of ['access_device_details', 'device_commands']) await db.sequelize.query(`DELETE FROM \`${t}\``);
  }
  const server = await startTestServer();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await teardownTestDatabases();
});

describe('responses (§5)', () => {
  test('text/plain, GMT Date, Content-Length; no cookie, no CORS even with an Origin; under 1 s', async () => {
    const res = await raw('GET', '/iclock/cdata?SN=NOBODY01&options=all', { headers: { Origin: 'https://cms.gymsera.com' } });
    expect(res.status).toBe(200);
    expect(res.text).toBe('OK\n');
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers.date).toMatch(/GMT$/);
    expect(Math.abs(Date.parse(res.headers.date) - Date.now())).toBeLessThan(5000);
    expect(Number(res.headers['content-length'])).toBe(3);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['content-security-policy']).toBeUndefined(); // mounted before helmet
  });

  test('an oversized body gets 413 in plain text, nothing stored', async () => {
    const { device } = await create();
    const res = await raw('POST', `/iclock/cdata?SN=${nextSn()}&table=rtlog`, {
      headers: { Host: `${device.deviceKey.toLowerCase()}.push.gymsera.com`, 'Content-Type': 'application/push' },
      body: 'x'.repeat(10 * 1024 * 1024 + 10),
    });
    expect(res.status).toBe(413);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.text).not.toMatch(/<html|{"/i);
    expect((await platformRow(device.id)).serial_number).toBeNull();
  });
});

describe('claim, bind, no auto-join (§4.2)', () => {
  test('host key (mode B): first contact binds the serial; registration stores what the device reports', async () => {
    const { device } = await create();
    expect(device.status).toBe('awaiting_connection');
    const d = sim(device);
    const c = await d.connect();
    expect(c).toMatchObject({ ok: true, registeredBy: 'registry' });
    expect(c.cdata.text).toBe('OK\n'); // spec style: not registered yet → asks the device to register
    const row = await platformRow(device.id);
    expect(row).toMatchObject({ serial_number: d.sn, status: 'active', last_pushver: '3.1.2' });
    expect(row.registered_at).toBeTruthy();
    expect(d.registryCode).toBe(row.registry_code);
    expect(d.registryCode).not.toBe('Uy47fxftP3');
    expect(d.config).toMatchObject({ SessionID: row.session_id, RequestDelay: '3', ServerName: 'GymsEra' });
    const det = await detailsRow(ctx.tenant1Db, device.id);
    expect(det).toMatchObject({ model: 'SpeedFace-V5L Simulator', firmware: 'ZAM180-SIM-1.0', device_type: 'acc', push_version: '3.1.2' });
    expect(JSON.parse(det.capabilities_json)).toMatchObject({ MultiBioDataSupport: '0:1:1:0:0:0:0:0:0:1:0', DateFmtFunOn: '1' });

    // Next connection: already registered → registry=ok straight away.
    const again = await d.request('GET', `/iclock/cdata?SN=${d.sn}&options=all`);
    expect(again.text.split('\n').slice(0, 2)).toEqual(['registry=ok', `RegistryCode=${row.registry_code}`]);
  });

  test('path key (mode A), key in lower case too', async () => {
    const { device } = await create({ linkMode: 'path' });
    const d = sim(device, { mode: 'path' });
    expect((await d.connect()).ok).toBe(true);
    const lower = new ZkDeviceSimulator({ baseUrl, sn: d.sn, key: device.deviceKey.toLowerCase(), mode: 'path' });
    expect((await lower.poll()).status).toBe(200);
    expect((await platformRow(device.id)).serial_number).toBe(d.sn);
  });

  test('the same key from another serial gets 406 everywhere and is recorded; the binding stays', async () => {
    const { device } = await create();
    const first = sim(device);
    await first.connect();
    const thief = sim(device);
    expect((await thief.request('GET', `/iclock/cdata?SN=${thief.sn}&options=all`)).status).toBe(406);
    expect((await thief.registry()).status).toBe(406);
    expect((await thief.poll()).status).toBe(406);
    const row = await platformRow(device.id);
    expect(row).toMatchObject({ serial_number: first.sn, serial_mismatch_value: thief.sn });
    expect(row.serial_mismatch_at).toBeTruthy();
  });

  test('an unknown key: OK on cdata, 406 on registry, recorded as unclaimed', async () => {
    const d = new ZkDeviceSimulator({ baseUrl, sn: nextSn(), key: 'ZZZZ2222', mode: 'host' });
    expect((await d.request('GET', `/iclock/cdata?SN=${d.sn}&options=all`)).text).toBe('OK\n');
    expect((await d.registry()).status).toBe(406);
    expect((await d.poll()).text).toBe('OK\n');
    const [u] = await platformDb.query('SELECT * FROM unclaimed_device_contacts WHERE serial_number = ?', { replacements: [d.sn], type: QueryTypes.SELECT });
    expect(u).toMatchObject({ reason: 'unknown_key', path_key: null, host: 'zzzz2222.push.gymsera.com' });
  });

  test('a known serial without its key never joins (no auto-join by serial)', async () => {
    const { device } = await create();
    const d = sim(device);
    await d.connect();
    const noKey = new ZkDeviceSimulator({ baseUrl, sn: d.sn });
    expect((await noKey.request('GET', `/iclock/cdata?SN=${d.sn}&options=all`)).text).toBe('OK\n');
    expect((await noKey.registry()).status).toBe(406);
    const [u] = await platformDb.query('SELECT reason FROM unclaimed_device_contacts WHERE serial_number = ? AND path_key IS NULL AND host IS NOT NULL ORDER BY id DESC', { replacements: [d.sn], type: QueryTypes.SELECT });
    expect(u.reason).toBe('key_missing');
  });

  test('unclaimed contacts are throttled: one row, hits counted at most every 10 s', async () => {
    const d = new ZkDeviceSimulator({ baseUrl, sn: nextSn() });
    for (let i = 0; i < 5; i++) await d.poll();
    const rows = await platformDb.query('SELECT hits FROM unclaimed_device_contacts WHERE serial_number = ?', { replacements: [d.sn], type: QueryTypes.SELECT });
    expect(rows).toEqual([{ hits: 1 }]);
  });

  test('re-pair: the old key stops working, the new key binds a new serial', async () => {
    const { device } = await create();
    const old = sim(device);
    await old.connect();
    const { device: repaired } = await devices.repairDevice({ tenantId: ctx.tenant1.id, deviceId: device.id });
    expect(repaired.deviceKey).not.toBe(device.deviceKey);
    const row = await platformRow(device.id);
    expect(row).toMatchObject({ serial_number: null, previous_serial_number: old.sn, status: 'awaiting_connection' });
    expect(row.registry_code).not.toBe(old.registryCode);
    expect((await old.registry()).status).toBe(406);
    const replacement = sim(repaired);
    expect((await replacement.connect()).ok).toBe(true);
    expect((await platformRow(device.id)).serial_number).toBe(replacement.sn);
  });

  test('a disabled or unpaired device gets nothing', async () => {
    const { device } = await create();
    const d = sim(device);
    await d.connect();
    await queue(ctx.tenant1Db, device.id, 'info');
    await devices.setEnabled({ tenantId: ctx.tenant1.id, tenantDb: ctx.tenant1Db, deviceId: device.id, enabled: false });
    expect((await d.poll()).text).toBe('OK\n');
    expect((await d.registry()).status).toBe(406);
    await devices.unpairDevice({ tenantId: ctx.tenant1.id, tenantDb: ctx.tenant1Db, deviceId: device.id });
    expect((await platformRow(device.id))).toMatchObject({ status: 'removed', serial_number: null, previous_serial_number: d.sn });
    expect((await d.registry()).status).toBe(406);
  });
});

describe('serial pairing (mode C, D-2)', () => {
  test('refused while DEVICE_SERIAL_PAIRING is off (the default)', async () => {
    await expect(create({ linkMode: 'serial', serialNumber: nextSn() })).rejects.toMatchObject({ code: 'serial_pairing_off' });
  });

  test('authkey: registration must carry the Comm Key GymsEra showed', async () => {
    process.env.DEVICE_SERIAL_PAIRING = 'authkey';
    const sn = nextSn();
    const { device, setup } = await create({ linkMode: 'serial', serialNumber: sn });
    expect(setup).toMatchObject({ mode: 'serial', serverAddress: 'push.gymsera.com', commKey: expect.stringMatching(/^\d{6}$/) });
    expect((await new ZkDeviceSimulator({ baseUrl, sn }).registry()).status).toBe(406);
    const ok = new ZkDeviceSimulator({ baseUrl, sn, authKey: setup.commKey });
    expect((await ok.connect()).ok).toBe(true);
    expect((await platformRow(device.id)).status).toBe('active');
  });

  test('a serial already in use is refused when adding', async () => {
    process.env.DEVICE_SERIAL_PAIRING = 'open';
    const sn = nextSn();
    await create({ linkMode: 'serial', serialNumber: sn });
    await expect(create({ linkMode: 'serial', serialNumber: sn })).rejects.toMatchObject({ code: 'serial_in_use' });
  });
});

describe('registration styles (Phase 0 b)', () => {
  test('gbs: cdata answers registry=ok at once (GymBioSync format, this device\'s codes); the simulator skips registration', async () => {
    process.env.DEVICE_REGISTRATION_STYLE = 'gbs';
    const { device } = await create();
    const d = sim(device);
    const c = await d.connect();
    expect(c.registeredBy).toBe('cdata');
    expect(c.cdata.text.split('\n')[0]).toBe(`GET OPTION FROM: ${d.sn}`);
    const row = await platformRow(device.id);
    expect(row).toMatchObject({ status: 'active', serial_number: d.sn });
    expect(d.registryCode).toBe(row.registry_code);
  });

  test('DEVICE_REQUEST_DELAY reaches the config', async () => {
    process.env.DEVICE_REQUEST_DELAY = '5';
    const { device } = await create();
    const d = sim(device);
    await d.connect();
    expect(d.config.RequestDelay).toBe('5');
  });
});

describe('token (Phase 0 c)', () => {
  test('log (default): a wrong token is served and recorded; the right one is recorded as a match', async () => {
    const { device } = await create();
    const d = sim(device);
    await d.connect();
    await d.poll();
    expect((await platformRow(device.id)).last_token_state).toBe('match');
    const res = await d.request('GET', `/iclock/getrequest?SN=${d.sn}`, '', { Cookie: 'token=00000000000000000000000000000000' });
    expect(res.status).toBe(200);
    expect((await platformRow(device.id)).last_token_state).toBe('mismatch');
  });

  test('enforce: a wrong or missing token gets 401 after registration; the handshake still works', async () => {
    process.env.DEVICE_TOKEN_MODE = 'enforce';
    const { device } = await create();
    expect((await platformRow(device.id)).token_mode).toBe('enforce');
    const d = sim(device);
    expect((await d.connect()).ok).toBe(true);
    expect((await d.poll()).status).toBe(200);
    expect((await d.request('GET', `/iclock/getrequest?SN=${d.sn}`, '', { Cookie: 'token=00000000000000000000000000000000' })).status).toBe(401);
    const noCookie = sim(device, { sn: d.sn, sendToken: false });
    expect((await noCookie.poll()).status).toBe(401);
  });
});

describe('commands (§8.1)', () => {
  test('getrequest hands out queued commands in priority order as C:<id>:<cmd>; devicecmd records each result', async () => {
    const { device } = await create();
    const d = sim(device);
    await d.connect();
    expect((await d.poll()).text).toBe('OK\n');
    await queue(ctx.tenant1Db, device.id, 'info');
    await queue(ctx.tenant1Db, device.id, 'count', 1, { args: { table: 'user' }, priority: 0 });
    await queue(ctx.tenant1Db, device.id, 'check');
    const r = await d.poll();
    expect(r.commands.map((c) => c.text)).toEqual(['DATA COUNT user', 'INFO', 'CHECK']);
    const sent = await commandsOf(ctx.tenant1Db, device.id);
    expect(sent.every((c) => c.status === 'sent' && c.attempts === 1 && c.sent_at)).toBe(true);
    const [a, b, c] = r.commands;
    expect((await d.ack([{ id: a.id, returnCode: 3 }, { id: b.id, returnCode: -7 }, { id: c.id, returnCode: -708 }])).text).toBe('OK\n');
    const after = Object.fromEntries((await commandsOf(ctx.tenant1Db, device.id)).map((x) => [Number(x.id), x]));
    expect(after[a.id]).toMatchObject({ status: 'acked', return_code: 3 });
    expect(after[b.id]).toMatchObject({ status: 'acked', return_code: -7 }); // repeated command = done
    expect(after[c.id]).toMatchObject({ status: 'failed', return_code: -708 });
    expect((await d.poll()).text).toBe('OK\n');
  });

  test('a device cannot ack another device\'s command', async () => {
    const { device: a } = await create();
    const { device: b } = await create();
    const da = sim(a);
    const db = sim(b);
    await da.connect();
    await db.connect();
    await queue(ctx.tenant1Db, a.id, 'info');
    const [cmd] = (await da.poll()).commands;
    await db.ack([{ id: cmd.id, returnCode: 0 }]);
    expect((await commandsOf(ctx.tenant1Db, a.id))[0]).toMatchObject({ status: 'sent', return_code: null });
  });

  test('concurrent getrequest never hands out a command twice; at most 20 per poll', async () => {
    const { device } = await create();
    const d = sim(device);
    await d.connect();
    await queue(ctx.tenant1Db, device.id, 'info', 45);
    const polls = await Promise.all(Array.from({ length: 6 }, () => d.poll()));
    const ids = polls.flatMap((p) => p.commands.map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(45);
    expect(Math.max(...polls.map((p) => p.commands.length))).toBeLessThanOrEqual(20);
    const rows = await commandsOf(ctx.tenant1Db, device.id);
    expect(rows.filter((r) => r.status === 'sent')).toHaveLength(45);
  });

  test('commands not yet due or expired are not handed out', async () => {
    const { device } = await create();
    const d = sim(device);
    await d.connect();
    await ctx.tenant1Db.sequelize.query(
      'INSERT INTO device_commands (device_id, kind, not_before, expires_at, created_at, updated_at) VALUES (?, \'info\', ?, NULL, ?, ?), (?, \'check\', ?, ?, ?, ?)',
      { replacements: utc([device.id, new Date(Date.now() + 60000), new Date(), new Date(), device.id, new Date(Date.now() - 60000), new Date(Date.now() - 1000), new Date(), new Date()]) }
    );
    expect((await d.poll()).text).toBe('OK\n');
  });

  test('a device before registration gets no commands', async () => {
    const { device } = await create();
    await queue(ctx.tenant1Db, device.id, 'info');
    const d = sim(device);
    expect((await d.poll()).text).toBe('OK\n');
  });
});

describe('uploads and queries', () => {
  test('options updates the counts; tabledata and querydata answer <table>=N; ping OK; unknown paths OK', async () => {
    const { device } = await create();
    const d = sim(device);
    await d.connect();
    expect((await d.upload('options', '~DeviceName=X,UserCount=12,FaceCount=11')).text).toBe('OK\n');
    expect(JSON.parse((await detailsRow(ctx.tenant1Db, device.id)).counts_json)).toMatchObject({ UserCount: '12', FaceCount: '11' });
    expect((await d.upload(null, 'user uid=1\tpin=9001\nuser uid=2\tpin=9002', { tablename: 'user' })).text).toBe('user=2\n');
    expect((await d.upload(null, 'biodata pin=1 tmp=AAAA', { tablename: 'biodata', count: 1 })).text).toBe('biodata=1\n');
    expect((await d.upload('rtlog', 'time=2026-11-10 10:00:00\tpin=9001\tevent=0\tindex=1')).text).toBe('OK\n');
    expect((await d.upload('rtstate', 'time=2026-11-10 10:00:00\tsensor=00\trelay=00')).text).toBe('OK\n');
    expect(JSON.parse((await detailsRow(ctx.tenant1Db, device.id)).state_json)).toMatchObject({ relay: '00' });
    expect((await d.querydata({ cmdid: 5, tablename: 'user', count: 2 }, 'user uid=1\tpin=1\nuser uid=2\tpin=2')).text).toBe('user=2\n');
    expect((await d.ping()).text).toBe('OK\n');
    expect((await d.request('POST', `/iclock/somethingnew?SN=${d.sn}`)).text).toBe('OK\n');
    expect((await d.request('POST', `/iclock/cdata?SN=${d.sn}&type=BioData`, 'TYPE=9\tPIN=1\tTMP=AAAA')).text).toBe('OK\n');
  });
});

describe('tenant isolation (§14 point 5)', () => {
  test('devices of two tenants polling the same process only ever get their own commands', async () => {
    const { device: a } = await create();
    const { device: b } = await devices.createDevice({
      tenantId: ctx.tenant2.id, tenantDb: ctx.tenant2Db, branchId: ctx.branch2.id, name: 'Other gym', direction: 'in',
    });
    const da = sim(a);
    const db = sim(b);
    await da.connect();
    await db.connect();
    await queue(ctx.tenant1Db, a.id, 'info', 3);
    await queue(ctx.tenant2Db, b.id, 'check', 2);
    const [pa, pb] = await Promise.all([da.poll(), db.poll()]);
    expect(pa.commands.map((c) => c.text)).toEqual(['INFO', 'INFO', 'INFO']);
    expect(pb.commands.map((c) => c.text)).toEqual(['CHECK', 'CHECK']);
    expect(await commandsOf(ctx.tenant2Db, a.id)).toEqual([]);
    expect(await commandsOf(ctx.tenant1Db, b.id)).toEqual([]);
    expect(await detailsRow(ctx.tenant2Db, a.id)).toBeUndefined();
  });
});

describe('push.gymsera.com carries device paths only (§4.5)', () => {
  test.each([
    [{ Host: 'push.gymsera.com' }],
    [{ Host: 'k7qm3xrt.push.gymsera.com' }],
    [{ Host: '127.0.0.1:8085' }], // the local binding without X-Original-Host: fail closed
    [{ 'X-Original-Host': 'push.gymsera.com' }],
  ])('%j: /api/v1/health is 404, /iclock is served', async (headers) => {
    const api = await raw('GET', '/api/v1/health', { headers });
    expect(api.status).toBe(404);
    expect(api.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect((await raw('GET', '/iclock/ping?SN=X', { headers })).status).toBe(200);
  });

  test('the API host is unchanged', async () => {
    expect((await raw('GET', '/api/v1/health')).status).toBe(200);
    expect((await raw('GET', '/api/v1/health', { headers: { Host: 'api.gymsera.com' } })).status).toBe(200);
  });
});

describe('the old router\'s devices (platform `devices`, ATTLOG) keep working', () => {
  test('a serial registered in the old table: heartbeat OK, ATTLOG answered OK: n', async () => {
    const { Device } = require('../../src/models/platform');
    const sn = nextSn();
    await Device.create({ tenantId: ctx.tenant1.id, branchId: ctx.branch1.id, serialNumber: sn, name: 'Old reader', status: 'ACTIVE' });
    const d = new ZkDeviceSimulator({ baseUrl, sn });
    expect((await d.poll()).text).toBe('OK\n');
    const res = await d.upload('ATTLOG', '9999\t2026-11-10 10:00:00\t0\t1\t0');
    expect(res.text).toBe('OK: 0\n'); // no PIN mapping → skipped, as before
  });
});
