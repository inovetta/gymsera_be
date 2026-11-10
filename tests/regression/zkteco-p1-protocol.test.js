/**
 * ZKTeco Push Phase 1 (spec ZKTECO_PUSH_DEVICE_SYNC.md §2, §5, §5.1, §15 "Tests required"):
 * the pure protocol module. Parsers over the manual's samples (tab and space separators, the
 * `biodatapin` quirk, multi-line bodies, querydata packs), the §5.1 config in both registration
 * styles, the token formula, ZKTeco time encoding and golden command strings with batching
 * and the size cap.
 */
const crypto = require('crypto');
const S = require('../fixtures/zkteco/manual-samples');
const p = require('../../src/services/devices/push-protocol');

const cut40 = (v) => `${v.slice(0, 40)}…[len=${v.length}]`;

describe('parsers', () => {
  test('registry: commas, ~ prefixes, values with spaces and brackets', () => {
    const r = p.parseRegistry(S.registry);
    expect(r).toMatchObject({
      DeviceType: 'acc',
      DeviceName: 'SpeedFace-V5L [TD]',
      FirmVer: 'ZAM180-NF-Ver1.0.1',
      MaxPackageSize: '2048000',
      MaxUserCount: '10000',
      MultiBioVersion: '0:10.0:0:0:0:0:0:0:0:40.1:0',
      DateFmtFunOn: '1',
      authKey: '123456',
    });
  });

  test('options upload uses the registry format', () => {
    expect(p.parseRegistry(S.options)).toMatchObject({ DeviceName: 'SpeedFace-V5L', UserCount: '12', FaceCount: '11' });
  });

  test('rtlog: tab separated, the time keeps its space; several lines', () => {
    const rows = p.parseRecords(S.rtlogTab);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      time: '2026-11-10 10:00:00', pin: '9001', cardno: '0', eventaddr: '1', event: '0',
      inoutstatus: '0', verifytype: '15', index: '21',
    });
    expect(rows[1]).toMatchObject({ pin: '0', event: '206', index: '22' });
  });

  test('rtlog printed with spaces (the manual) still keeps the time whole', () => {
    expect(p.parseRecords(S.rtlogSpaces)[0]).toMatchObject({ time: '2017-01-10 11:49:32', pin: '0', event: '206', index: '1' });
  });

  test('ATTLOG positional lines fall back to pin, time, status, verify', () => {
    const rows = p.parseRecords(S.attlog, { positional: ['pin', 'time', 'status', 'verify', 'workcode'] });
    expect(rows[0]).toMatchObject({ pin: '9001', time: '2026-11-10 10:00:00', status: '0', verify: '15' });
    expect(rows[1]).toMatchObject({ pin: '9002', status: '1' });
  });

  test('tabledata: the table name prefix is dropped, keys are lower-case, names keep their spaces', () => {
    expect(p.parseRecords(S.userTab, { table: 'user' })[0]).toMatchObject({ uid: '1', pin: '9001', name: 'Test Person', privilege: '0' });
    expect(p.parseRecords(S.biodataSpaces, { table: 'biodata' })[0]).toMatchObject({
      pin: '9001', no: '0', index: '0', type: '9', majorver: '40', minorver: '1', tmp: S.TEMPLATE,
    });
  });

  test('the biodatapin quirk: table name glued to the first field', () => {
    expect(p.parseRecords(S.biodataGlued, { table: 'biodata' })[0]).toMatchObject({ pin: '9001', no: '6', index: '0', type: '1' });
  });

  test('templatev10, biophoto, userpic, ATTPHOTO', () => {
    expect(p.parseRecords(S.templatev10, { table: 'templatev10' })[0]).toMatchObject({ pin: '9001', fingerid: '7', template: S.TEMPLATE });
    expect(p.parseRecords(S.biophoto, { table: 'biophoto' })[0]).toMatchObject({ pin: '9001', type: '9', content: S.PHOTO });
    expect(p.parseRecords(S.userpic, { table: 'userpic' })[0]).toMatchObject({ pin: '9001', content: S.PHOTO });
    const att = p.parseRecords(S.attphoto)[0];
    expect(p.attPhotoPin(att.pin)).toBe('9001');
  });

  test('devicecmd: several lines, Return or return, CRLF', () => {
    expect(p.parseDevicecmd(S.devicecmd)).toEqual([
      { id: 1001, returnCode: 0, cmd: 'DATA UPDATE' },
      { id: 1002, returnCode: -30, cmd: 'DATA' },
      { id: 1003, returnCode: -708, cmd: 'ENROLL_BIO' },
    ]);
    expect(p.parseDevicecmd('garbage\nID=x&Return=0')).toEqual([]);
  });

  test('ENROLL_BIO result: upper-case keys, CRLF between template and photo', () => {
    const rows = p.parseRecords(S.enrollResult);
    expect(rows[0]).toMatchObject({ type: '9', pin: '9001', major_ver: '58', tmp: S.TEMPLATE });
    expect(rows[1]).toMatchObject({ biophoto: S.PHOTO });
  });

  test('record counts for <table>=N answers: count query wins, else non-empty lines', () => {
    expect(p.recordCount(S.queryUsersPack1, '')).toBe(2);
    expect(p.recordCount(S.queryUsersPack1, '7')).toBe(7);
    expect(p.recordCount('\n\n', undefined)).toBe(0);
  });

  test('redaction cuts templates and photos to 40 characters plus the length', () => {
    expect(p.redact(S.biodataSpaces)).toContain(`tmp=${cut40(S.TEMPLATE)}`);
    expect(p.redact(S.attphoto)).toContain(`photo=${cut40(S.PHOTO)}`);
    expect(p.redact(S.enrollResult)).not.toContain(S.TEMPLATE.slice(0, 41));
  });
});

describe('config (§5.1)', () => {
  const dev = { registryCode: 'Rc123', sessionId: 'ABCDEF0123456789ABCDEF0123456789' };
  const SPEC = [
    'ServerVersion=3.1.2', 'ServerName=GymsEra', 'PushProtVer=3.1.2', 'ErrorDelay=60', 'RequestDelay=3',
    'TransTimes=00:00;14:00', 'TransInterval=1', 'TransTables=User Transaction', 'Realtime=1',
    'SessionID=ABCDEF0123456789ABCDEF0123456789', 'TimeoutSec=10', 'BioPhotoFun=1', 'BioDataFun=1',
    'MultiBioDataSupport=0:1:1:0:0:0:1:0:1:1:1', 'MultiBioPhotoSupport=0:0:0:0:0:0:0:0:0:1:1', 'PushOptionsFlag=1',
  ];

  test('spec style: push config, and cdata adds registry=ok and the device\'s RegistryCode first', () => {
    expect(p.configLines({ ...dev, style: 'spec', requestDelay: 3, forCdata: false })).toEqual(SPEC);
    expect(p.configLines({ ...dev, style: 'spec', requestDelay: 3, forCdata: true })).toEqual(['registry=ok', 'RegistryCode=Rc123', ...SPEC]);
  });

  test('RequestDelay follows the setting', () => {
    expect(p.configLines({ ...dev, style: 'spec', requestDelay: 5, forCdata: false })).toContain('RequestDelay=5');
  });

  test('gbs style: GymBioSync\'s working format with the device\'s own codes (never the manual\'s)', () => {
    const lines = p.configLines({ ...dev, style: 'gbs', requestDelay: 3, forCdata: true, sn: 'SN1' });
    expect(lines[0]).toBe('GET OPTION FROM: SN1');
    expect(lines).toEqual(expect.arrayContaining(['registry=ok', 'RegistryCode=Rc123', 'SessionID=ABCDEF0123456789ABCDEF0123456789', 'ServerName=GymsEra']));
    expect(lines.join('\n')).not.toMatch(/Uy47fxftP3|30BFB04B2C8AECC72C01C03BFD549D15/);
    const push = p.configLines({ ...dev, style: 'gbs', requestDelay: 3, forCdata: false });
    expect(push).not.toContain('registry=ok');
    expect(push).toContain('ServerName=GymsEra'); // GymBioSync sent a bare "ADMS" line here
  });

  test('random codes: RegistryCode ≤ 32 alphanumerics, SessionID 32 hex, distinct per call', () => {
    const a = p.newRegistryCode();
    const b = p.newRegistryCode();
    expect(a).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(a).not.toBe(b);
    expect(p.newSessionId()).toMatch(/^[0-9A-F]{32}$/);
  });
});

describe('token (spec §2, unverified formula: log mode first)', () => {
  test('expected token = md5(RegistryCode + SN + SessionID); cookie parsing', () => {
    const want = crypto.createHash('md5').update('Rc123SN1SESS').digest('hex');
    expect(p.expectedToken({ registryCode: 'Rc123', sn: 'SN1', sessionId: 'SESS' })).toBe(want);
    expect(p.tokenFromCookie(`token=${want}, timestamp=123`)).toBe(want);
    expect(p.tokenFromCookie(`a=b; token=${want.toUpperCase()}`)).toBe(want);
    expect(p.tokenFromCookie('')).toBeNull();
  });
});

describe('ZKTeco time (Appendix 5) and the EndTime format setting', () => {
  test('encode and format', () => {
    expect(p.encodeZkTime(2026, 11, 10, 0, 0, 0)).toBe(((26 * 12 * 31) + (10 * 31) + 9) * 86400);
    const parts = { year: 2026, month: 12, day: 31, hour: 23, minute: 59, second: 59 };
    expect(p.formatZkTime(parts, 'seconds')).toBe(String(p.encodeZkTime(2026, 12, 31, 23, 59, 59)));
    expect(p.formatZkTime(parts, 'yyyymmdd')).toBe('20261231');
  });

  test('auto resolves from the device\'s DateFmtFunOn, seconds when unknown', () => {
    expect(p.resolveDateFormat('auto', { DateFmtFunOn: '0' })).toBe('yyyymmdd');
    expect(p.resolveDateFormat('auto', { DateFmtFunOn: '1' })).toBe('seconds');
    expect(p.resolveDateFormat('auto', {})).toBe('seconds');
    expect(p.resolveDateFormat('yyyymmdd', { DateFmtFunOn: '1' })).toBe('yyyymmdd');
  });
});

describe('command builders (golden strings, manual syntax)', () => {
  const T = '\t';
  const start = { year: 2026, month: 11, day: 1, hour: 0, minute: 0, second: 0 };
  const end = { year: 2026, month: 11, day: 30, hour: 23, minute: 59, second: 59 };

  test.each([
    ['user, no window', p.cmd.userUpsert({ pin: 9001, name: 'Test Person' }),
      `DATA UPDATE user CardNo=${T}Pin=9001${T}Password=${T}Group=1${T}Name=Test Person${T}Privilege=0`],
    ['user, window in seconds', p.cmd.userUpsert({ pin: 9001, name: 'Test Person', cardNo: '123456', start, end, dateFormat: 'seconds' }),
      `DATA UPDATE user CardNo=123456${T}Pin=9001${T}Password=${T}Group=1${T}StartTime=${p.encodeZkTime(2026, 11, 1)}${T}EndTime=${p.encodeZkTime(2026, 11, 30, 23, 59, 59)}${T}Name=Test Person${T}Privilege=0`],
    ['user, window as YYYYMMDD', p.cmd.userUpsert({ pin: 9001, name: 'A', start, end, dateFormat: 'yyyymmdd' }),
      `DATA UPDATE user CardNo=${T}Pin=9001${T}Password=${T}Group=1${T}StartTime=20261101${T}EndTime=20261130${T}Name=A${T}Privilege=0`],
    ['userauthorize', p.cmd.userAuthorize({ pin: 9001, timezoneId: 1, doorMask: 1 }),
      `DATA UPDATE userauthorize Pin=9001${T}AuthorizeTimezoneId=1${T}AuthorizeDoorId=1`],
    ['userauthorize with window', p.cmd.userAuthorize({ pin: 9001, timezoneId: 1, doorMask: 3, start, end, dateFormat: 'yyyymmdd' }),
      `DATA UPDATE userauthorize Pin=9001${T}AuthorizeTimezoneId=1${T}AuthorizeDoorId=3${T}StartTime=20261101${T}EndTime=20261130`],
    ['user delete', p.cmd.userDelete(9001), 'DATA DELETE user Pin=9001'],
    ['authorize delete', p.cmd.authDelete(9001), 'DATA DELETE userauthorize Pin=9001'],
    ['biodata delete by type', p.cmd.bioDelete(9001, 9), `DATA DELETE biodata Type=9${T}Pin=9001`],
    ['biodata delete all types', p.cmd.bioDelete(9001), 'DATA DELETE biodata Pin=9001'],
    ['userpic delete', p.cmd.picDelete(9001), 'DATA DELETE userpic pin=9001'],
    ['biophoto delete', p.cmd.bioPhotoDelete(9001), 'DATA DELETE biophoto PIN=9001'],
    ['query users', p.cmd.queryUsers(), 'DATA QUERY tablename=user,fielddesc=*,filter=*'],
    ['query one user', p.cmd.queryUsers(9001), 'DATA QUERY tablename=user,fielddesc=*,filter=Pin=9001'],
    ['query biodata (Type required)', p.cmd.queryBio(9), 'DATA QUERY tablename=biodata,fielddesc=*,filter=Type=9'],
    ['query biodata for a pin', p.cmd.queryBio(1, 9001), `DATA QUERY tablename=biodata,fielddesc=*,filter=Type=1${T}Pin=9001`],
    ['count users', p.cmd.count('user'), 'DATA COUNT user'],
    ['count faces', p.cmd.count('biodata', 9), 'DATA COUNT biodata Type=9'],
    ['enroll, space (spec default)', p.cmd.enrollBio({ pin: 9001, type: 9, separator: 'space' }), 'ENROLL_BIO TYPE=9 NO=0 PIN=9001 RETRY=3 OVERWRITE=1 MODE=1'],
    ['enroll, tab (manual format line)', p.cmd.enrollBio({ pin: 9001, type: 9, separator: 'tab' }), `ENROLL_BIO TYPE=9${T}NO=0${T}PIN=9001${T}RETRY=3${T}OVERWRITE=1${T}MODE=1`],
    ['info', p.cmd.info(), 'INFO'],
    ['check', p.cmd.check(), 'CHECK'],
  ])('%s', (_label, actual, expected) => {
    expect(actual).toBe(expected);
  });

  test('biodata: one type per command, records joined by LF, the version stored with the template', () => {
    const recs = [
      { pin: 9001, no: 0, index: 0, type: 9, majorVer: 40, minorVer: 1, tmp: 'AAA' },
      { pin: 9002, no: 0, index: 0, type: 9, majorVer: 40, minorVer: 1, tmp: 'BBB' },
    ];
    expect(p.cmd.bioUpsert(recs)).toBe(
      `DATA UPDATE biodata Pin=9001${T}No=0${T}Index=0${T}Valid=1${T}Duress=0${T}Type=9${T}Majorver=40${T}Minorver=1${T}Format=0${T}Tmp=AAA\n` +
      `Pin=9002${T}No=0${T}Index=0${T}Valid=1${T}Duress=0${T}Type=9${T}Majorver=40${T}Minorver=1${T}Format=0${T}Tmp=BBB`
    );
    expect(() => p.cmd.bioUpsert([recs[0], { ...recs[1], type: 1 }])).toThrow(/one biometric type/);
    expect(() => p.cmd.bioUpsert([{ ...recs[0], majorVer: undefined }])).toThrow(/version/);
  });

  test('biophoto (comparison photo, Type=9)', () => {
    expect(p.cmd.bioPhoto({ pin: 9001, type: 9, content: 'QUJD' })).toBe(
      `DATA UPDATE biophoto PIN=9001${T}Type=9${T}Size=4${T}Content=QUJD${T}Format=0${T}PostBackTmpFlag=0`
    );
  });

  test('names: tabs and newlines removed, cut to 24 characters; admin privilege never sent', () => {
    expect(p.cmd.userUpsert({ pin: 1, name: 'A\tB\nC'.padEnd(40, 'x') })).toContain(`Name=A B C${'x'.repeat(19)}\t`);
    expect(p.cmd.userUpsert({ pin: 1, name: 'A', privilege: 14 })).toMatch(/\tPrivilege=0$/);
  });

  test('a PIN is digits only; wipes are not built here', () => {
    expect(() => p.cmd.userDelete('*')).toThrow(/PIN/);
    expect(() => p.cmd.userUpsert({ pin: '12a', name: 'x' })).toThrow(/PIN/);
  });

  test('delivery: C:<id>:<cmd> lines joined by LF while under the size cap; the rest wait', () => {
    const rows = [{ id: 1, text: 'INFO' }, { id: 2, text: 'X'.repeat(50) }, { id: 3, text: 'CHECK' }];
    expect(p.packCommands(rows, 1000)).toEqual({ body: 'C:1:INFO\nC:2:' + 'X'.repeat(50) + '\nC:3:CHECK', sentIds: [1, 2, 3], heldIds: [] });
    const capped = p.packCommands(rows, 40);
    expect(capped.sentIds).toEqual([1]);
    expect(capped.heldIds).toEqual([2, 3]);
    // A single command over the cap still goes alone (the device answers -106 if it is too big).
    expect(p.packCommands([{ id: 9, text: 'Y'.repeat(100) }], 10).sentIds).toEqual([9]);
  });
});
