/**
 * ZKTeco Phase 4: import from a device that GymBioSync managed, and the cut-over (spec §15 Phase 4, §3, §6.3, §7.5).
 *
 * The device arrives with GymBioSync's users: their PINs are the old system's CustomerIDs
 * (GymBiosyncService BioMetric.cs:246), so they can equal a GymsEra PIN (the tenant sequence starts at 1001).
 *
 *   hold          a device added "import first" (or put into an import) gets only DATA QUERY / COUNT / INFO /
 *                 CHECK; reconcile, the sweep, the audit and Push now leave it alone; what it uploads is
 *                 never stored as member data; nothing is ever deleted on it during the import
 *   query         users, then biodata of each type, Type in every biodata filter, packs, size caps
 *   match         CSV (pin + member_id / email / phone) or one by one; conflicts: a PIN another member owns,
 *                 a member who already has a PIN, device admins
 *   preview       what apply will store, what go-live will remove, capacity
 *   apply         identities keep the device PIN; templates stored with the consent rules and held until
 *                 go-live; idempotent; the PIN sequence moves past every device PIN
 *   rollback      before go-live only: what the import stored goes, nothing on the device changes
 *   go-live       hold released, only rows marked "remove" are deleted, members sent, audit requested;
 *                 pending templates get their 7 days from go-live
 *   cut-over      checklist with imported, matched, verified counts and the unmatched PINs
 */
const crypto = require('crypto');
const { createWorld, localNow } = require('../harness/zkteco-world');
const { asPersona } = require('../harness');
const biometrics = require('../../src/services/devices/biometric.service');
const identity = require('../../src/services/devices/device-identity.service');
const sync = require('../../src/services/devices/device-sync.service');
const jobs = require('../../src/jobs/device-jobs');

const REG = 'DeviceType=acc,~DeviceName=SpeedFace GBS,FirmVer=SIM,PushVersion=3.1.2,MaxPackageSize=2048000,~MaxUserCount=10000,' +
  'MultiBioDataSupport=0:1:0:0:0:0:0:0:0:1:0,MultiBioPhotoSupport=0:0:0:0:0:0:0:0:0:1:0,MultiBioVersion=0:10.0:0:0:0:0:0:0:0:40.1:0,' +
  'MaxMultiBioDataCount=0:5000:0:0:0:0:0:0:0:5000:0,DateFmtFunOn=1';
const tmp = () => `GBS${crypto.randomBytes(120).toString('base64').replace(/[^A-Za-z0-9]/g, 'Q')}`;
const owner = () => asPersona('owner');
const code = (res) => res.body.error?.code || res.body.code;
const data = (res) => res.body.data;

let w;
let branch; let other; let door; let otherDoor;
const m = {}; // members
const T = {}; // device templates by name

beforeAll(async () => {
  w = await createWorld();
  branch = await w.branch(w.db1, { gymId: (await w.gym(w.db1)).id, name: 'GBS Branch' });
  other = await w.branch(w.db1, { gymId: (await w.gym(w.db1)).id, name: 'Other Org Branch' });

  // GymsEra members. X already holds PIN 1001 from a door at another organization's branch.
  for (const [k, name] of [['x', 'Xavier GymsEra'], ['ali', 'Ali Import'], ['sara', 'Sara Import'], ['omar', 'Omar Import'], ['old', 'Old Import'], ['q', 'Qasim Import']]) {
    m[k] = await w.member(name, { email: `p4-${k}-${crypto.randomBytes(3).toString('hex')}@gymseratest.com` });
  }
  await w.subscribe(w.db1, { user: m.x, branch: other });
  otherDoor = await w.device(w.db1, { branch: other, registryBody: REG, name: 'Other Door' });
  await otherDoor.sim.drain();
  expect(await w.pinOf(w.db1, m.x.id)).toBe('1001');
  // Q is a member at both branches and already has PIN 1002.
  await w.subscribe(w.db1, { user: m.q, branch: other });
  await otherDoor.sim.drain();
  expect(await w.pinOf(w.db1, m.q.id)).toBe('1002');

  for (const k of ['ali', 'sara', 'omar', 'q']) await w.subscribe(w.db1, { user: m[k], branch });
  await w.subscribe(w.db1, { user: m.old, branch, start: -60, end: -30, status: 'EXPIRED' });
  for (const k of ['ali', 'sara', 'q', 'old']) await biometrics.recordConsent(w.db1, { memberId: m[k].id, method: 'in_person' });
  // Omar has no consent: his face stays device-only for 7 days after go-live.

  // The device as GymBioSync left it.
  door = await w.device(w.db1, { branch, registryBody: REG, name: 'GBS Door', importFirst: true });
  const s = door.sim;
  s.seedUser({ pin: 1001, name: 'Ali GBS' });
  s.seedUser({ pin: 501, name: 'Sara GBS', cardNo: '7788' });
  s.seedUser({ pin: 502, name: 'Omar GBS' });
  s.seedUser({ pin: 503, name: 'Old GBS' });
  s.seedUser({ pin: 504, name: 'Unknown GBS' });
  s.seedUser({ pin: 506, name: 'Qasim GBS' });
  s.seedUser({ pin: 9, name: 'Installer', privilege: 14 });
  for (const [name, pin, type] of [['ali9', 1001, 9], ['sara9', 501, 9], ['sara1', 501, 1], ['omar9', 502, 9], ['old9', 503, 9], ['unk9', 504, 9], ['q9', 506, 9]]) {
    T[name] = tmp();
    s.seedBio({ pin, type, majorVer: type === 9 ? '40' : '10', minorVer: type === 9 ? '1' : '0', tmp: T[name] });
  }
}, 120000);
afterAll(async () => { await w.settled(); await require('../harness').teardownTestDatabases(); });

const deviceUsers = () => new Set(door.sim.users.keys());
const ORIGINAL = ['1001', '501', '502', '503', '504', '506', '9'];
const deletesSent = () => door.sim.executed.filter((t) => /^DATA DELETE/.test(t));
let importId;

describe('hold: a device added "import first"', () => {
  test('registration sends nothing; the device page says import hold', async () => {
    await door.sim.drain();
    expect(door.sim.executed).toEqual([]);
    const res = await owner().get(`/host/devices/${door.id}`);
    expect(data(res).device.importHold).toBe(true);
  });

  test('reconcile, sweep, audit and Push now leave it alone', async () => {
    expect(await sync.reconcileMember(w.db1, m.sara.id, 'test')).not.toHaveProperty(door.id);
    await jobs.syncTenant({ tenantId: w.ctx.tenant1.id, db: w.db1 }, new Date());
    await jobs.auditTenant({ tenantId: w.ctx.tenant1.id, db: w.db1 }, new Date(Date.now() + 23 * 3600000));
    const push = await owner().post(`/host/members/${m.sara.id}/device-push`, { deviceIds: [door.id] });
    expect(push.status).toBe(409);
    expect(code(push)).toBe('device_in_import');
    await door.sim.drain();
    expect(door.sim.executed).toEqual([]);
    expect(await w.commands(w.db1, door.id)).toEqual([]);
  });

  test('a template the device uploads for PIN 1001 is NOT stored as member X (another person on that PIN)', async () => {
    await door.sim.upload('tabledata', `biodata pin=1001\tno=0\tindex=0\tvalid=1\tduress=0\ttype=9\tmajorver=40\tminorver=1\tformat=0\ttmp=${T.ali9}`, { tablename: 'biodata', count: 1 });
    await w.settled();
    expect((await w.q(w.db1, 'SELECT COUNT(*) AS n FROM member_biometrics WHERE member_id = ?', [m.x.id]))[0].n).toBe(0);
  });

  test('a scan by PIN 1001 during the hold is no check-in for X', async () => {
    await door.sim.scan(1001, localNow());
    const [ev] = await w.q(w.db1, 'SELECT member_id, attendance_id, attendance_note FROM device_access_events WHERE device_id = ? ORDER BY id DESC LIMIT 1', [door.id]);
    expect(ev.member_id).toBeNull();
    expect(ev.attendance_id).toBeNull();
    expect(ev.attendance_note).toBe('import_hold');
  });
});

describe('query the device', () => {
  test('start: only DATA QUERY commands, Type in every biodata filter, nothing deleted', async () => {
    const res = await owner().post(`/host/devices/${door.id}/imports`, {});
    expect(res.status).toBe(202);
    importId = data(res).import.id;
    expect(data(res).import.status).toBe('querying');
    await door.sim.drain();
    expect(door.sim.executed.length).toBeGreaterThanOrEqual(3);
    for (const t of door.sim.executed) expect(t).toMatch(/^DATA QUERY tablename=(user|biodata),fielddesc=\*,filter=/);
    for (const t of door.sim.executed.filter((x) => x.includes('tablename=biodata'))) expect(t).toMatch(/filter=Type=\d+/);
    expect(door.sim.executed.filter((x) => x.includes('tablename=biodata')).map((x) => /Type=(\d+)/.exec(x)[1]).sort()).toEqual(['1', '9']);
    expect(deletesSent()).toEqual([]);
    expect([...deviceUsers()].sort()).toEqual([...ORIGINAL].sort());
  });

  test('a second start while querying or ready gives the same import back', async () => {
    const res = await owner().post(`/host/devices/${door.id}/imports`, {});
    expect(res.status).toBe(200);
    expect(data(res).import.id).toBe(importId);
    expect(data(res).reused).toBe(true);
  });

  test('ready: counts; templates encrypted in staging, never in any JSON', async () => {
    const res = await owner().get(`/host/devices/${door.id}/imports/${importId}`);
    expect(res.status).toBe(200);
    const imp = data(res).import;
    expect(imp.status).toBe('ready');
    expect(imp.counts).toMatchObject({ users: 7, templates: 7, admins: 1, matched: 0, unmatched: 6 });
    const raw = JSON.stringify(res.body);
    for (const t of Object.values(T)) expect(raw).not.toContain(t.slice(0, 40));
    const rows = await w.q(w.db1, 'SELECT template_enc FROM device_import_templates WHERE import_id = ?', [importId]);
    expect(rows).toHaveLength(7);
    for (const r of rows) expect(Buffer.from(r.template_enc).toString('utf8')).not.toContain(T.ali9.slice(0, 40));
  });

  test('a replayed query pack is not stored twice', async () => {
    const [cmd] = await w.commands(w.db1, door.id, 'kind = \'query_users\'');
    await door.sim.querydata({ cmdid: cmd.id, tablename: 'user', count: 1, packcnt: 4, packidx: 1 }, 'user uid=501\tcardno=7788\tpin=501\tname=Sara GBS\tprivilege=0');
    const [n] = await w.q(w.db1, 'SELECT COUNT(*) AS n FROM device_import_users WHERE import_id = ?', [importId]);
    expect(Number(n.n)).toBe(7);
  });

  test('users list is paged; the admin is flagged and cannot be matched', async () => {
    const page = await owner().get(`/host/devices/${door.id}/imports/${importId}/users?limit=2&offset=2`);
    expect(data(page).users).toHaveLength(2);
    expect(data(page).total).toBe(7);
    const admins = await owner().get(`/host/devices/${door.id}/imports/${importId}/users?filter=admin`);
    expect(data(admins).users.map((u) => u.pin)).toEqual(['9']);
    const res = await owner().put(`/host/devices/${door.id}/imports/${importId}/users/9`, { memberId: m.sara.id });
    expect(res.status).toBe(422);
    expect(code(res)).toBe('device_admin');
  });
});

describe('match', () => {
  test('CSV: email and member id; unknown, ambiguous and duplicate lines are reported, not guessed', async () => {
    const csv = [
      'pin,email,member_id',
      `501,${m.sara.email},`,
      `502,${m.omar.email},`,
      `503,,${m.old.id}`,
      '504,nobody@gymseratest.com,',
      `777,${m.ali.email},`, // no such device user
      `506,,${m.q.id}`,
    ].join('\n');
    const res = await owner().post(`/host/devices/${door.id}/imports/${importId}/mapping`, { csv });
    expect(res.status).toBe(200);
    expect(data(res).matched).toBe(4);
    expect(data(res).errors.map((e) => [e.line, e.reason])).toEqual([[5, 'member_not_found'], [6, 'pin_not_on_device']]);
    const dup = await owner().post(`/host/devices/${door.id}/imports/${importId}/mapping`, { csv: `pin,email\n504,${m.sara.email}` });
    expect(data(dup).errors.map((e) => e.reason)).toEqual(['member_already_matched']);
  });

  test('CSV: a header without pin, or over the size cap, is refused', async () => {
    expect((await owner().post(`/host/devices/${door.id}/imports/${importId}/mapping`, { csv: 'email\nx@y.z' })).status).toBe(422);
  });

  test('one by one: Ali on PIN 1001 is a conflict (X owns 1001); Q is sent under his own PIN 1002', async () => {
    const res = await owner().put(`/host/devices/${door.id}/imports/${importId}/users/1001`, { memberId: m.ali.id });
    expect(res.status).toBe(200);
    expect(data(res).user.conflict).toBe('pin_taken');
    const q = (await owner().get(`/host/devices/${door.id}/imports/${importId}/users?filter=matched`));
    const qRow = data(q).users.find((u) => u.pin === '506');
    expect(qRow.conflict).toBe('member_has_pin');
    expect(qRow.memberPin).toBe('1002');
    expect(qRow.removeAtGoLive).toBe(true);
  });

  test('a member of another tenant cannot be matched', async () => {
    const stranger = await w.member('Stranger');
    const res = await owner().put(`/host/devices/${door.id}/imports/${importId}/users/504`, { memberId: stranger.id });
    expect(res.status).toBe(404);
    expect(code(res)).toBe('member_not_found');
  });
});

describe('preview and apply', () => {
  test('preview: a blocking conflict stops apply', async () => {
    const res = await owner().get(`/host/devices/${door.id}/imports/${importId}/preview`);
    expect(res.status).toBe(200);
    const p = data(res).preview;
    expect(p.blocking.map((b) => [b.pin, b.conflict])).toEqual([['1001', 'pin_taken']]);
    expect(p.atGoLive.removePins).toEqual(['506']);
    expect(p.skipped.unmatched).toBe(1);
    expect(p.skipped.admins).toBe(1);
    const apply = await owner().post(`/host/devices/${door.id}/imports/${importId}/apply`, {});
    expect(apply.status).toBe(409);
    expect(code(apply)).toBe('import_conflicts');
  });

  test('marking 1001 "remove at go-live" resolves it; Ali keeps his face and gets a new PIN', async () => {
    const res = await owner().put(`/host/devices/${door.id}/imports/${importId}/users/1001`, { memberId: m.ali.id, removeAtGoLive: true });
    expect(res.status).toBe(200);
    const p = data(await owner().get(`/host/devices/${door.id}/imports/${importId}/preview`)).preview;
    expect(p.blocking).toEqual([]);
    expect(p.atGoLive.removePins.sort()).toEqual(['1001', '506']);
    expect(p.willStore).toMatchObject({ identities: 3, templates: 5, templatesPending: 1 });
    expect(p.consentNeeded.map((c) => c.memberId)).toEqual([m.omar.id]);
    expect(p.atGoLive.notEntitled).toBe(1); // Old: matched, package over
  });

  test('apply: device PINs kept, templates held, PIN sequence past every device PIN, still nothing sent', async () => {
    const res = await owner().post(`/host/devices/${door.id}/imports/${importId}/apply`, {});
    expect(res.status).toBe(200);
    expect(data(res).import.status).toBe('applied');
    expect(await w.pinOf(w.db1, m.sara.id)).toBe('501');
    expect(await w.pinOf(w.db1, m.omar.id)).toBe('502');
    expect(await w.pinOf(w.db1, m.old.id)).toBe('503');
    expect(await w.pinOf(w.db1, m.ali.id)).toBeNull();
    expect(await w.pinOf(w.db1, m.q.id)).toBe('1002');
    const [card] = await w.q(w.db1, 'SELECT card_no FROM member_device_identity WHERE member_id = ?', [m.sara.id]);
    expect(card.card_no).toBe('7788');
    const rows = await w.q(w.db1, 'SELECT member_id, bio_type, consent_pending, pending_until, import_hold, import_id FROM member_biometrics WHERE import_id = ? ORDER BY member_id, bio_type', [importId]);
    expect(rows).toHaveLength(6); // sara 1 + 9, omar 9, ali 9, q 9, old 9
    for (const r of rows) {
      expect(Number(r.import_hold)).toBe(1);
      expect(r.pending_until).toBeNull();
    }
    expect(rows.filter((r) => Number(r.consent_pending) === 1).map((r) => r.member_id)).toEqual([m.omar.id]);
    const [seq] = await w.q(w.db1, 'SELECT next_pin FROM device_pin_sequence WHERE id = 1');
    expect(Number(seq.next_pin)).toBeGreaterThan(1002);
    // Held templates reach no device yet: X's other door does not get Q's imported face.
    await sync.reconcileMember(w.db1, m.q.id, 'test');
    await otherDoor.sim.drain();
    expect(otherDoor.sim.holds('1002').bioTypes).toEqual([]);
    await door.sim.drain();
    expect(deletesSent()).toEqual([]);
    expect(door.sim.executed.every((t) => t.startsWith('DATA QUERY'))).toBe(true);
    // The staging copies are gone once applied.
    const [left] = await w.q(w.db1, 'SELECT COUNT(*) AS n FROM device_import_templates WHERE import_id = ? AND template_enc IS NOT NULL', [importId]);
    expect(Number(left.n)).toBe(0);
  });

  test('apply again: the same answer, nothing new', async () => {
    const res = await owner().post(`/host/devices/${door.id}/imports/${importId}/apply`, {});
    expect(res.status).toBe(200);
    expect(data(res).alreadyApplied).toBe(true);
    const [n] = await w.q(w.db1, 'SELECT COUNT(*) AS n FROM member_biometrics WHERE import_id = ?', [importId]);
    expect(Number(n.n)).toBe(6);
  });

  test('a scan by an applied member during the hold is their check-in', async () => {
    await door.sim.scan(501, localNow());
    const [ev] = await w.q(w.db1, 'SELECT member_id, attendance_id FROM device_access_events WHERE device_id = ? ORDER BY id DESC LIMIT 1', [door.id]);
    expect(ev.member_id).toBe(m.sara.id);
    expect(ev.attendance_id).not.toBeNull();
  });
});

describe('rollback and re-run', () => {
  test('rollback: what the import stored is gone, the device is untouched, the hold stays', async () => {
    const res = await owner().post(`/host/devices/${door.id}/imports/${importId}/rollback`, {});
    expect(res.status).toBe(200);
    expect(data(res).import.status).toBe('rolled_back');
    const [n] = await w.q(w.db1, 'SELECT COUNT(*) AS n FROM member_biometrics WHERE import_id = ?', [importId]);
    expect(Number(n.n)).toBe(0);
    expect(await w.pinOf(w.db1, m.sara.id)).toBeNull();
    expect(await w.pinOf(w.db1, m.q.id)).toBe('1002'); // not the import's
    expect(await w.pinOf(w.db1, m.x.id)).toBe('1001');
    expect(data(await owner().get(`/host/devices/${door.id}`)).device.importHold).toBe(true);
    expect([...deviceUsers()].sort()).toEqual([...ORIGINAL].sort());
    expect(deletesSent()).toEqual([]);
  });

  test('re-run: a new import carries the matches over; apply gives the same result', async () => {
    const res = await owner().post(`/host/devices/${door.id}/imports`, {});
    expect(res.status).toBe(202);
    importId = data(res).import.id;
    await door.sim.drain();
    const users = data(await owner().get(`/host/devices/${door.id}/imports/${importId}/users?filter=matched`)).users;
    expect(users.map((u) => u.pin).sort()).toEqual(['1001', '501', '502', '503', '506']);
    expect(users.find((u) => u.pin === '1001').removeAtGoLive).toBe(true);
    const apply = await owner().post(`/host/devices/${door.id}/imports/${importId}/apply`, {});
    expect(apply.status).toBe(200);
    expect(await w.pinOf(w.db1, m.sara.id)).toBe('501');
    const [n] = await w.q(w.db1, 'SELECT COUNT(*) AS n FROM member_biometrics WHERE import_id = ?', [importId]);
    expect(Number(n.n)).toBe(6);
  });

  test('no new import while one is applied and not live', async () => {
    const res = await owner().post(`/host/devices/${door.id}/imports`, {});
    expect(res.status).toBe(409);
    expect(code(res)).toBe('import_applied_not_live');
  });
});

describe('cut-over', () => {
  test('checklist before go-live', async () => {
    const res = await owner().get(`/host/devices/${door.id}/cutover`);
    expect(res.status).toBe(200);
    const c = data(res).cutover;
    expect(c.canGoLive).toBe(true);
    expect(c.counts).toMatchObject({ deviceUsers: 7, imported: 7, matched: 5, unmatched: 1, admins: 1, conflicts: 0, verified: 0 });
    expect(c.unmatchedPins).toEqual(['504']);
    expect(c.steps.find((s) => s.key === 'applied').status).toBe('done');
    expect(c.steps.find((s) => s.key === 'live').status).toBe('todo');
    expect(c.steps.find((s) => s.key === 'consent').status).toBe('warning');
  });

  test('go-live: only the marked users are deleted; members sent; admin and unmatched untouched', async () => {
    const res = await owner().post(`/host/devices/${door.id}/cutover/go-live`, {});
    expect(res.status).toBe(200);
    expect(data(res).cutover.steps.find((s) => s.key === 'live').status).toBe('done');
    await door.sim.drain();
    const deleted = new Set(deletesSent().map((t) => /Pin=(\d+)/i.exec(t)?.[1]).filter(Boolean));
    expect(deleted.has('1001')).toBe(true);
    expect(deleted.has('506')).toBe(true);
    // Never the unmatched user, the device admin, or a member GymsEra keeps. (503, matched but expired,
    // is removed by the audit requested at go-live: GymsEra manages the device from now on.)
    for (const pin of ['504', '9', '501', '502', '1002']) expect(deleted.has(pin)).toBe(false);
    const users = deviceUsers();
    for (const pin of ['501', '502', '504', '9', '1002']) expect(users.has(pin)).toBe(true);
    expect(users.has('1001')).toBe(false);
    expect(users.has('506')).toBe(false);
    expect(door.sim.holds('9').user.privilege).toBe('14');
    expect(door.sim.holds('504').user.name).toBe('Unknown GBS');
    // GymsEra names and validity on the matched members; Sara's face and finger are back from GymsEra.
    expect(door.sim.holds('501').user.name).toBe('Sara Import');
    expect(door.sim.holds('501').user.endTime).not.toBe('0');
    expect(door.sim.holds('501').bioTypes).toEqual([1, 9]);
    // Ali: a new PIN, with the face that was on 1001.
    const aliPin = await w.pinOf(w.db1, m.ali.id);
    expect(Number(aliPin)).toBeGreaterThan(1002);
    expect(door.sim.holds(aliPin).bioTypes).toEqual([9]);
    expect([...door.sim.bio.values()].find((b) => b.pin === aliPin).tmp).toBe(T.ali9);
    // Omar's pending face got its 7 days from go-live.
    const [om] = await w.q(w.db1, 'SELECT pending_until FROM member_biometrics WHERE member_id = ?', [m.omar.id]);
    const days = (new Date(om.pending_until).getTime() - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    // Consented imported templates now reach the member's other devices (Q's face on the other door).
    await otherDoor.sim.drain();
    expect(otherDoor.sim.holds('1002').bioTypes).toEqual([9]);
  });

  test('verified counts and the post-go-live audit: Old is removed, 504 is listed as unlinked', async () => {
    const c = data(await owner().get(`/host/devices/${door.id}/cutover`)).cutover;
    expect(c.counts.verified).toBe(4); // sara, omar, ali, q in sync
    await door.sim.drain();
    expect(door.sim.users.has('503')).toBe(false); // the audit at go-live removed the expired member
    expect(door.sim.users.has('504')).toBe(true);
    expect(door.sim.users.has('9')).toBe(true);
    const unlinked = data(await owner().get(`/host/devices/${door.id}/unlinked-users`)).users.map((u) => u.pin).sort();
    expect(unlinked).toEqual(['504', '9']);
    const after = data(await owner().get(`/host/devices/${door.id}/cutover`)).cutover;
    expect(after.steps.find((s) => s.key === 'verified').status).toBe('done');
  });

  test('rollback after go-live is refused', async () => {
    const res = await owner().post(`/host/devices/${door.id}/imports/${importId}/rollback`, {});
    expect(res.status).toBe(409);
    expect(code(res)).toBe('import_live');
  });

  test('GymBioSync stopped: recorded on the checklist', async () => {
    const res = await owner().post(`/host/devices/${door.id}/cutover/gymbiosync-stopped`, {});
    expect(res.status).toBe(200);
    expect(data(res).cutover.steps.find((s) => s.key === 'gymbiosync_stopped').status).toBe('done');
  });
});

describe('size caps', () => {
  test('users and template size over the caps: truncated and counted, never stored', async () => {
    const b = await w.branch(w.db1, { gymId: (await w.gym(w.db1)).id });
    const d = await w.device(w.db1, { branch: b, registryBody: REG, name: 'Big', importFirst: true });
    for (let i = 1; i <= 5; i++) d.sim.seedUser({ pin: 600 + i, name: `U${i}` });
    d.sim.seedBio({ pin: 601, type: 9, majorVer: '40', minorVer: '1', tmp: 'A'.repeat(40000) });
    process.env.DEVICE_IMPORT_MAX_USERS = '3';
    try {
      const res = await owner().post(`/host/devices/${d.id}/imports`, {});
      await d.sim.drain();
      const imp = data(await owner().get(`/host/devices/${d.id}/imports/${data(res).import.id}`)).import;
      expect(imp.counts.users).toBe(3);
      expect(imp.truncated).toBe(true);
      expect(imp.counts.templates).toBe(0);
      expect(imp.counts.templatesTooLarge).toBe(1);
    } finally {
      delete process.env.DEVICE_IMPORT_MAX_USERS;
    }
  });
});

describe('cancel', () => {
  test('cancel releases the hold (refused once applied); identity checks stay', async () => {
    const b = await w.branch(w.db1, { gymId: (await w.gym(w.db1)).id });
    const d = await w.device(w.db1, { branch: b, registryBody: REG, name: 'Cancel', importFirst: true });
    const res = await owner().post(`/host/devices/${d.id}/imports`, {});
    await d.sim.drain();
    const cancel = await owner().post(`/host/devices/${d.id}/imports/${data(res).import.id}/cancel`, {});
    expect(cancel.status).toBe(200);
    expect(data(await owner().get(`/host/devices/${d.id}`)).device.importHold).toBe(false);
    expect(await identity.ownerOfPin(w.db1, '1001')).toEqual({ memberId: m.x.id, retired: false });
  });
});
