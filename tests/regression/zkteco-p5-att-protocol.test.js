/**
 * ZKTeco Phase 5: T&A PUSH (DeviceType=att) devices, the pure parts (spec ZKTECO_PUSH_DEVICE_SYNC.md §15 Phase 5).
 * Fixture: tests/fixtures/zkteco/att-speedface-v5l.js (sanitized; the structure of the 2026-11-11 capture).
 *
 *   options    `~OEMVendor=ZKTECO CO., LTD.` keeps its comma; att units (~MaxUserCount=100 is 10,000 users)
 *   INFO       getrequest?INFO=<fw>,<users>,<fp>,<att>,<ip>,<fpver>,<facever>,…,<faces>,<funcs>,…
 *   OPERLOG    USER / FP / OPLOG lines; BIODATA lines; ATTLOG by position with the trailing tab
 *   answer     the att option lines: random codes, stamps, Delay (the field GymBioSync sends) per setting
 *   commands   per-device user form (user | userinfo), validity none | datetime | seconds, no userauthorize
 *   ATTLOG key a fingerprint and a face punch of one person in the same second are two rows
 */
const protocol = require('../../src/services/devices/push-protocol');
const rules = require('../../src/services/devices/sync-rules');
const fixture = require('../fixtures/zkteco/att-speedface-v5l');

const f = fixture.build({ now: new Date(), timezone: 'Asia/Karachi' });

describe('options body (table=options)', () => {
  test('a comma inside a value (~OEMVendor) does not split it', () => {
    const o = protocol.parseRegistry(f.optionsBody);
    expect(o.OEMVendor).toBe('ZKTECO CO., LTD.');
    expect(o.FWVersion).toBe('ZAM180-NF50VA-Ver3.4.9');
    expect(o.PushVersion).toBe('Ver 2.0.33S-20220623');
    expect(o.MultiBioDataSupport).toBe('0:1:0:0:0:0:0:0:1:1');
    expect(o.RegDeviceType).toBe('');
    expect(Object.keys(o)).toHaveLength(44);
  });

  test('a registry body (acc) is read as before', () => {
    const o = protocol.parseRegistry('DeviceType=acc,~DeviceName=SpeedFace V5L,FirmVer=1.0,MultiBioVersion=0:10.0:0:0:0:0:0:0:0:40.1:0');
    expect(o).toEqual({ DeviceType: 'acc', DeviceName: 'SpeedFace V5L', FirmVer: '1.0', MultiBioVersion: '0:10.0:0:0:0:0:0:0:0:40.1:0' });
  });

  test('att options become capabilities in the units the rest of the engine uses, and counts', () => {
    const { capabilities, counts } = protocol.normalizeAttOptions(protocol.parseRegistry(f.optionsBody));
    expect(capabilities.DeviceType).toBe('att');
    expect(capabilities.MaxUserCount).toBe('10000'); // ~MaxUserCount=100 is in hundreds
    expect(capabilities.MaxAttLogCount).toBe('200000'); // ~MaxAttLogCount=20 is in ten-thousands
    expect(capabilities.MultiBioDataSupport).toBe('0:1:0:0:0:0:0:0:1:1');
    // Versions by MultiBioDataSupport position: 1 fingerprint (FPVersion), 8 palm (PvVersion), 9 VL face (FaceVersion).
    expect(capabilities.MultiBioVersion).toBe('0:10:0:0:0:0:0:0:12:39');
    expect(capabilities.MaxMultiBioDataCount).toBe('0:6000:0:0:0:0:0:0:3000:6000');
    expect(capabilities.DeviceName).toBe('SpeedFace-V5L');
    expect(capabilities.FirmVer).toBe('ZAM180-NF50VA-Ver3.4.9');
    expect(capabilities.PushVersion).toBe('Ver 2.0.33S-20220623');
    expect(capabilities.MAC).toBe('00:00:5e:00:53:01');
    expect(counts).toMatchObject({ UserCount: '356', FPCount: '416', FaceCount: '15', PvCount: '0', TransactionCount: '14262' });
    expect(rules.bioSupport(capabilities).majorFor(9)).toBe('39');
    expect(rules.bioSupport(capabilities).majorFor(1)).toBe('10');
  });
});

describe('getrequest INFO', () => {
  test('positional counts and versions', () => {
    expect(protocol.parseInfo(f.info)).toEqual({
      firmware: 'ZAM180-NF50VA-Ver3.4.9', UserCount: '356', FPCount: '416', TransactionCount: '14262', IPAddress: '192.0.2.87',
      FPVersion: '10', FaceVersion: '39', FaceCount: '15', FunctionFlags: '11110', raw: f.info,
    });
  });
  test('short or empty INFO is not an error', () => {
    expect(protocol.parseInfo('Ver 8.0,1,0')).toMatchObject({ firmware: 'Ver 8.0', UserCount: '1', FPCount: '0' });
    expect(protocol.parseInfo('')).toBeNull();
  });
});

describe('OPERLOG and BIODATA uploads', () => {
  test('USER lines (tab separated, names with spaces and trailing spaces)', () => {
    const all = f.userPosts.flatMap((b) => protocol.parseOperlog(b).users);
    expect(all).toHaveLength(356);
    expect(all[0]).toEqual({ pin: '1', name: 'Test Member 001', privilege: 14, cardno: '', group: '1', start: '0', end: '0' });
    expect(all.find((u) => u.pin === f.users[5].pin).cardno).toBe('0012345678');
    expect(new Set(all.map((u) => u.pin)).size).toBe(356);
  });

  test('FP lines become fingerprint templates with the device FPVersion; bad ones are dropped', () => {
    const recs = f.fpPosts.flatMap((b) => protocol.parseOperlog(b).fingerprints);
    expect(recs).toHaveLength(416);
    const t = rules.templatesFromOperlog(recs, { fpVersion: '10' });
    expect(t).toHaveLength(416);
    expect(t[0]).toMatchObject({ pin: f.fingerprints[0].pin, type: 1, no: 0, index: 0, valid: 1, majorVer: '10', minorVer: '0' });
    expect(rules.templatesFromOperlog([{ pin: 'x1', fid: '0', valid: '1', tmp: f.fingerprints[0].tmp }], {})).toHaveLength(0);
    expect(rules.templatesFromOperlog([{ pin: '7', fid: '0', valid: '1', tmp: 'not base64!' }], {})).toHaveLength(0);
  });

  test('OPLOG lines are positional and kept apart; unknown record types are counted', () => {
    const p = protocol.parseOperlog(`${f.oplogPost}\nFACE PIN=7\tFID=0\nUSERPIC PIN=7`);
    expect(p.oplog).toHaveLength(5);
    expect(p.oplog[3]).toMatchObject({ op: '80', obj1: 'COMKey' });
    expect(p.other).toEqual({ FACE: 1, USERPIC: 1 });
    expect(p.users).toHaveLength(0);
  });

  test('BIODATA lines (Type=9 MajorVer=39) read by the biodata parser', () => {
    const t = rules.templatesFrom('biodata', f.biodataPost);
    expect(t).toHaveLength(15);
    expect(t[0]).toMatchObject({ type: 9, majorVer: '39', minorVer: '3', no: 0, index: 0 });
  });
});

describe('ATTLOG by position', () => {
  test('PIN, time, status, verify, workcode; the trailing tab is not a field', () => {
    const rows = protocol.parseAttlog(f.attlogPosts[0]);
    expect(rows).toHaveLength(128);
    expect(rows[0]).toEqual({ pin: f.history[0].pin, time: f.history[0].time, status: 255, verify: f.history[0].verify, workcode: '0' });
  });
  test('space separated and keyed forms are read too', () => {
    expect(protocol.parseAttlog('1001 2026-01-02 03:04:05 0 15 0')).toEqual([{ pin: '1001', time: '2026-01-02 03:04:05', status: 0, verify: 15, workcode: '0' }]);
    expect(protocol.parseAttlog('PIN=1001\tTIME=2026-01-02 03:04:05\tSTATUS=1\tVERIFY=4\tWORKCODE=0')[0]).toMatchObject({ pin: '1001', status: 1, verify: 4 });
    expect(protocol.parseAttlog('\n\n')).toEqual([]);
  });
  test('the duplicate key keeps a fingerprint and a face punch of the same person in the same second', () => {
    expect(rules.attlogIndex('1001', 1)).not.toBe(rules.attlogIndex('1001', 15));
    expect(rules.attlogIndex('1001', 1)).toBe(rules.attlogIndex('1001', 1));
    expect(rules.attlogIndex('1001', 1)).not.toBe(rules.attlogIndex('1002', 1));
    expect(rules.attlogIndex('99999999', 255)).toBeLessThan(0);
    expect(Number.isSafeInteger(rules.attlogIndex('999999999', 255))).toBe(true);
  });
});

describe('the att option answer (cdata?options=all)', () => {
  const codes = { registryCode: protocol.newRegistryCode(), sessionId: protocol.newSessionId() };

  test('GymBioSync lines with this device’s random codes, our ServerName and the poll delay', () => {
    const lines = protocol.attConfigLines({ ...codes, sn: f.sn, delay: 3, delayFields: ['Delay'], stamps: {} });
    expect(lines[0]).toBe(`GET OPTION FROM: ${f.sn}`);
    expect(lines).toContain('Delay=3');
    expect(lines).not.toContain('RequestDelay=3');
    expect(lines).toContain('registry=ok');
    expect(lines).toContain(`RegistryCode=${codes.registryCode}`);
    expect(lines).toContain(`SessionID=${codes.sessionId}`);
    expect(lines).toContain('ServerName=GymsEra');
    expect(lines).toContain('Realtime=1');
    expect(lines).toContain('PushOptionsFlag=1');
    expect(lines.join('\n')).not.toMatch(/Uy47fxftP3|30BFB04B2C8AECC72C01C03BFD549D15/); // the manual's example codes
    for (const t of ['ATTLOG', 'OPERLOG', 'BIODATA', 'ATTPHOTO']) expect(lines).toContain(`${t}Stamp=0`);
  });

  test('both delay fields when set, and the stamps the device reported last', () => {
    const lines = protocol.attConfigLines({ ...codes, sn: f.sn, delay: 2, delayFields: ['Delay', 'RequestDelay'], stamps: { ATTLOG: '9999', OPERLOG: '123' } });
    expect(lines).toEqual(expect.arrayContaining(['Delay=2', 'RequestDelay=2', 'ATTLOGStamp=9999', 'OPERLOGStamp=123', 'BIODATAStamp=0']));
  });
});

describe('att user commands', () => {
  const win = { start: { year: 2026, month: 1, day: 2 }, end: { year: 2026, month: 2, day: 3, hour: 23, minute: 59, second: 59 } };

  test('acc, no validity: no window fields (unchanged)', () => {
    expect(protocol.cmd.userUpsert({ pin: 1001, name: 'Ali', cardNo: '' }))
      .toBe('DATA UPDATE user CardNo=\tPin=1001\tPassword=\tGroup=1\tName=Ali\tPrivilege=0');
  });

  test('att, validity none: GymBioSync’s exact string (StartTime=0 EndTime=0 clears an old window), privilege 0', () => {
    expect(protocol.cmd.userUpsert({ pin: 1001, name: 'Ali', cardNo: '', clearWindow: true }))
      .toBe('DATA UPDATE user CardNo=\tPin=1001\tPassword=\tGroup=1\tStartTime=0\tEndTime=0\tName=Ali\tPrivilege=0');
  });

  test('userinfo form (the attendance protocol), with and without validity', () => {
    expect(protocol.cmd.userInfoUpsert({ pin: 1001, name: 'Ali', cardNo: '123', clearWindow: true }))
      .toBe('DATA UPDATE USERINFO PIN=1001\tName=Ali\tPri=0\tPasswd=\tCard=123\tGrp=1\tStartDatetime=0\tEndDatetime=0');
    expect(protocol.cmd.userInfoUpsert({ pin: 1001, name: 'Ali', cardNo: '123' }))
      .toBe('DATA UPDATE USERINFO PIN=1001\tName=Ali\tPri=0\tPasswd=\tCard=123\tGrp=1');
    expect(protocol.cmd.userInfoUpsert({ pin: 1001, name: 'Ali', ...win, dateFormat: 'datetime' }))
      .toBe('DATA UPDATE USERINFO PIN=1001\tName=Ali\tPri=0\tPasswd=\tCard=\tGrp=1\tStartDatetime=2026-01-02 00:00:00\tEndDatetime=2026-02-03 23:59:59');
    expect(protocol.cmd.userInfoUpsert({ pin: 1001, name: 'Ali', ...win, dateFormat: 'seconds' }))
      .toMatch(/\tStartDatetime=\d+\tEndDatetime=\d+$/);
    expect(protocol.cmd.userInfoDelete(1001)).toBe('DATA DELETE USERINFO PIN=1001');
  });

  test('the user form takes the datetime format too', () => {
    expect(protocol.cmd.userUpsert({ pin: 1001, name: 'Ali', ...win, dateFormat: 'datetime' }))
      .toContain('\tStartTime=2026-01-02 00:00:00\tEndTime=2026-02-03 23:59:59\t');
  });
});

describe('per-device options (safe defaults until the device test)', () => {
  const cfg = { sendUserAuthorize: true, sendValidity: true, endTimeFormat: 'auto', attUserAuthorize: false, attValidity: 'none', attUserForm: 'user' };

  test('acc devices keep the global settings', () => {
    expect(rules.deviceOptions({ device_type: 'acc' }, cfg)).toEqual({ att: false, sendUserAuthorize: true, validity: 'auto', userForm: 'user' });
    expect(rules.deviceOptions({ device_type: null }, { ...cfg, sendValidity: false })).toMatchObject({ validity: 'none' });
  });

  test('att devices: no userauthorize, no validity window, the user form, unless the device row says otherwise', () => {
    expect(rules.deviceOptions({ device_type: 'att' }, cfg)).toEqual({ att: true, sendUserAuthorize: false, validity: 'none', userForm: 'user' });
    expect(rules.deviceOptions({ device_type: 'att', send_userauthorize: 1, validity_mode: 'datetime', user_command_form: 'userinfo' }, cfg))
      .toEqual({ att: true, sendUserAuthorize: true, validity: 'datetime', userForm: 'userinfo' });
    expect(rules.deviceOptions({ device_type: 'att', validity_mode: 'bogus', user_command_form: 'x' }, cfg)).toMatchObject({ validity: 'none', userForm: 'user' });
  });

  test('a device without userauthorize never gets DATA DELETE userauthorize', () => {
    const plan = rules.planCommands({ desired: null, applied: null, pin: '1001', supportedTypes: [1, 9], photoTypes: [9], auth: false });
    expect(plan.map((p) => p.kind)).not.toContain('auth_delete');
    expect(plan.map((p) => p.kind)).toContain('user_delete');
    const acc = rules.planCommands({ desired: null, applied: null, pin: '1001', supportedTypes: [1], photoTypes: [] });
    expect(acc.map((p) => p.kind)).toContain('auth_delete');
  });

  test('an acc desired record has the same shape (and hash) as before Phase 5', () => {
    const r = rules.desiredRecord({ pin: 1001, name: 'Ali', cardNo: '', window: null, caps: {}, device: {}, settings: { sendUserAuthorize: true } });
    expect(Object.keys(r)).toEqual(['pin', 'name', 'cardNo', 'dateFormat', 'window', 'auth', 'bio', 'photos', 'userpic']);
    const att = rules.desiredRecord({ pin: 1001, name: 'Ali', cardNo: '', window: null, caps: {}, device: {}, settings: { sendUserAuthorize: false, userForm: 'userinfo' } });
    expect(att.form).toBe('userinfo');
    expect(att.auth).toBeNull();
  });
});
