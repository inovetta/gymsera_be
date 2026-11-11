/**
 * ZKTeco Phase 0 spike: the throw-away capture server answers the Push handshake
 * the way docs/ZKTECO_PUSH_DEVICE_SYNC.md §5 / §5.1 says, builds the Phase 0 test
 * commands exactly (protocol manual syntax), and never writes a full template or
 * photo to a capture file.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const zk = require('../../scripts/zk-capture-server');

const SN = 'TESTSN0001';
const TEMPLATE = 'A'.repeat(1500);

function request(port, method, urlPath, { body = '', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath,
        headers: { 'Content-Length': Buffer.byteLength(body), ...headers } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

const SPEC_51_LINES = (sessionId) => [
  'ServerVersion=3.1.2',
  'ServerName=GymsEra',
  'PushProtVer=3.1.2',
  'ErrorDelay=60',
  'RequestDelay=3',
  'TransTimes=00:00;14:00',
  'TransInterval=1',
  'TransTables=User Transaction',
  'Realtime=1',
  `SessionID=${sessionId}`,
  'TimeoutSec=10',
  'BioPhotoFun=1',
  'BioDataFun=1',
  'MultiBioDataSupport=0:1:1:0:0:0:1:0:1:1:1',
  'MultiBioPhotoSupport=0:0:0:0:0:0:0:0:0:1:1',
  'PushOptionsFlag=1',
];

describe('zk-capture-server: per-run secrets', () => {
  it('RegistryCode and SessionID are random per run, never the manual example values', () => {
    const codes = new Set(Array.from({ length: 20 }, () => zk.generateRegistryCode()));
    expect(codes.size).toBe(20);
    for (const c of codes) {
      expect(c).toMatch(/^[A-Za-z0-9]{1,32}$/);
      expect(c).not.toBe(zk.MANUAL_EXAMPLE.registryCode);
    }
    const s1 = zk.generateSessionId();
    expect(s1).toMatch(/^[0-9A-F]{32}$/);
    expect(s1).not.toBe(zk.MANUAL_EXAMPLE.sessionId);
    expect(zk.generateSessionId()).not.toBe(s1);
  });
});

describe('zk-capture-server: handshake over HTTP (spec §5, §5.1)', () => {
  let cap;
  let port;
  let dir;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkcap-'));
    cap = zk.createCaptureServer({ capturesDir: dir, log: () => {} });
    port = await cap.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await cap.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('cdata options=all from an unregistered device answers OK (asks it to register), with GMT Date and text/plain', async () => {
    const before = Date.now();
    const r = await request(port, 'GET', `/iclock/cdata?SN=${SN}&options=all&pushver=3.1.2`);
    expect(r.status).toBe(200);
    expect(r.text).toBe('OK\n');
    expect(r.headers['content-type']).toMatch(/^text\/plain; charset=utf-8$/);
    expect(Number(r.headers['content-length'])).toBe(Buffer.byteLength(r.text));
    expect(r.headers.date).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
    expect(Math.abs(Date.parse(r.headers.date) - before)).toBeLessThan(5000);
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('registry stores the body and answers RegistryCode=<this run\'s code>', async () => {
    const body = 'DeviceType=acc,~DeviceName=SpeedFace V5L,FirmVer=ZAM180 Ver 1.0,DateFmtFunOn=1,MultiBioVersion=0:10:0:0:0:0:0:0:0:40:0';
    const r = await request(port, 'POST', `/iclock/registry?SN=${SN}`, { body });
    expect(r.status).toBe(200);
    expect(r.text).toBe(`RegistryCode=${cap.state.registryCode}\n`);
    const reg = cap.state.devices.get(SN).registry;
    expect(reg).toMatchObject({ DeviceType: 'acc', DeviceName: 'SpeedFace V5L', FirmVer: 'ZAM180 Ver 1.0', DateFmtFunOn: '1' });
  });

  it('cdata options=all from a registered device answers registry=ok, RegistryCode, then exactly the §5.1 config', async () => {
    const r = await request(port, 'GET', `/iclock/cdata?SN=${SN}&options=all`);
    expect(r.text.split('\n')).toEqual([
      'registry=ok',
      `RegistryCode=${cap.state.registryCode}`,
      ...SPEC_51_LINES(cap.state.sessionId),
      '',
    ]);
  });

  it('push answers the §5.1 config without registry lines', async () => {
    const r = await request(port, 'POST', `/iclock/push?SN=${SN}`);
    expect(r.text.split('\n')).toEqual([...SPEC_51_LINES(cap.state.sessionId), '']);
    expect(r.text).not.toMatch(/registry=ok|RegistryCode/);
  });

  it('getrequest answers OK when nothing is queued, then queued commands as C:<id>:<cmd> joined by \\n', async () => {
    expect((await request(port, 'GET', `/iclock/getrequest?SN=${SN}`)).text).toBe('OK\n');
    const a = cap.enqueue('count-user', {});
    const b = cap.enqueue('user', { pin: '9001', name: 'ZK Test' });
    const r = await request(port, 'GET', `/iclock/getrequest?SN=${SN}`);
    expect(r.text).toBe(
      `C:${a.id}:DATA COUNT user\nC:${b.id}:DATA UPDATE user CardNo=\tPin=9001\tPassword=\tGroup=1\tName=ZK Test\tPrivilege=0\n`
    );
    expect((await request(port, 'GET', `/iclock/getrequest?SN=${SN}`)).text).toBe('OK\n');
  });

  it('devicecmd accepts several result lines (Return or return) and records each code', async () => {
    const a = cap.enqueue('info', {});
    const b = cap.enqueue('check', {});
    await request(port, 'GET', `/iclock/getrequest?SN=${SN}`);
    const r = await request(port, 'POST', `/iclock/devicecmd?SN=${SN}`, {
      body: `ID=${a.id}&Return=0&CMD=INFO\nID=${b.id}&return=-708&CMD=CHECK\n`,
    });
    expect(r.text).toBe('OK\n');
    expect(cap.state.queue.find((c) => c.id === a.id)).toMatchObject({ status: 'acked', returnCode: 0 });
    expect(cap.state.queue.find((c) => c.id === b.id)).toMatchObject({ status: 'failed', returnCode: -708 });
  });

  it.each([
    ['user', 'pin=9001\tname=ZK Test\tprivilege=0\nuid=2\tpin=9002\tname=Two', 'user=2'],
    ['biodata', `biodata pin=9001 no=0 index=0 valid=1 duress=0 type=9 majorver=40 minorver=1 format=0 tmp=${TEMPLATE}`, 'biodata=1'],
    ['userpic', `userpic pin=9001 filename=9001.jpg size=2000 content=${TEMPLATE}`, 'userpic=1'],
    ['biophoto', `biophoto pin=9001 filename=9001.jpg type=9 size=2000 content=${TEMPLATE}`, 'biophoto=1'],
  ])('cdata tabledata tablename=%s answers <tablename>=<records>', async (table, body, expected) => {
    const r = await request(port, 'POST', `/iclock/cdata?SN=${SN}&table=tabledata&tablename=${table}`, { body });
    expect(r.text).toBe(`${expected}\n`);
  });

  it.each(['rtlog', 'rtstate', 'options', 'ATTLOG', 'errorlog'])('cdata table=%s answers OK', async (table) => {
    const body = table === 'rtlog'
      ? 'time=2026-11-10 10:00:00\tpin=9001\tcardno=0\teventaddr=1\tevent=29\tinoutstatus=0\tverifytype=15\tindex=7'
      : 'x=1';
    const r = await request(port, 'POST', `/iclock/cdata?SN=${SN}&table=${table}`, { body });
    expect(r.text).toBe('OK\n');
  });

  it('rtlog lines are parsed on tabs (the time keeps its space)', () => {
    expect(cap.state.scans.find((s) => s.pin === '9001')).toMatchObject({ time: '2026-11-10 10:00:00', pin: '9001', event: '29', index: '7' });
  });

  it('cdata type=BioData (ENROLL_BIO result) answers OK', async () => {
    const r = await request(port, 'POST', `/iclock/cdata?SN=${SN}&type=BioData`, {
      body: `TYPE=9 PIN=9001 NO=0 INDEX=0 MAJOR_VER=58 MINOR_VER=1 TMP=${TEMPLATE}`,
    });
    expect(r.text).toBe('OK\n');
  });

  it('querydata answers <tablename>=<count> for each pack', async () => {
    const r = await request(port, 'POST',
      `/iclock/querydata?SN=${SN}&type=tabledata&cmdid=99&tablename=user&count=2&packcnt=2&packidx=1`,
      { body: 'user uid=1\tpin=9001\nuser uid=2\tpin=9002' });
    expect(r.text).toBe('user=2\n');
    const c = await request(port, 'POST',
      `/iclock/querydata?SN=${SN}&type=count&cmdid=80&tablename=biodata&count=1&packcnt=1&packidx=1`,
      { body: 'biodata=2' });
    expect(c.text).toBe('biodata=1\n');
  });

  it('ping answers OK on GET and POST', async () => {
    expect((await request(port, 'GET', `/iclock/ping?SN=${SN}`)).text).toBe('OK\n');
    expect((await request(port, 'POST', `/iclock/ping?SN=${SN}`)).text).toBe('OK\n');
  });

  it('a path key prefix (mode A) is accepted and recorded', async () => {
    const r = await request(port, 'GET', `/d/K7QM3XRT/iclock/getrequest?SN=${SN}`);
    expect(r.text).toBe('OK\n');
    expect(cap.state.devices.get(SN).pathKey).toBe('K7QM3XRT');
  });

  it('an unknown /iclock path answers OK', async () => {
    expect((await request(port, 'POST', `/iclock/somethingnew?SN=${SN}`)).text).toBe('OK\n');
  });

  it('the capture file has method, path, query, headers and body, but never a full template or photo', () => {
    const text = fs.readFileSync(cap.captureFile, 'utf8');
    expect(text).toContain('POST /iclock/registry?SN=TESTSN0001');
    expect(text).toContain('query: {"SN":"TESTSN0001"');
    expect(text).toMatch(/headers:\n( {2}.*\n)* {2}host: 127\.0\.0\.1:\d+/);
    expect(text).toContain('DeviceType=acc');
    expect(text).toContain(`tmp=${'A'.repeat(40)}…[len=1500]`);
    expect(text).toContain(`content=${'A'.repeat(40)}…[len=1500]`);
    expect(text).toContain(`TMP=${'A'.repeat(40)}…[len=1500]`);
    expect(text).not.toContain('A'.repeat(41));
  });

  it('the control endpoints answer this Mac, and a queue request is validated', async () => {
    const ok = await request(port, 'POST', '/zkcap/queue', { body: JSON.stringify({ kind: 'count-user' }) });
    expect(JSON.parse(ok.text)).toMatchObject({ ok: true, text: 'DATA COUNT user' });
    const bad = await request(port, 'POST', '/zkcap/queue', { body: JSON.stringify({ kind: 'delete-user', pin: '*' }) });
    expect(bad.status).toBe(400);
  });
});

describe('zk-capture-server: registration refusal', () => {
  it('a serial outside --only-sn gets 406 on registry', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkcap-'));
    const cap = zk.createCaptureServer({ capturesDir: dir, onlySn: ['ALLOWED1'], log: () => {} });
    const port = await cap.listen(0, '127.0.0.1');
    try {
      const r = await request(port, 'POST', '/iclock/registry?SN=OTHER', { body: 'DeviceType=acc' });
      expect(r.status).toBe(406);
      const ok = await request(port, 'POST', '/iclock/registry?SN=ALLOWED1', { body: 'DeviceType=acc' });
      expect(ok.text).toBe(`RegistryCode=${cap.state.registryCode}\n`);
    } finally {
      await cap.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('zk-capture-server: command builders (golden strings)', () => {
  const now = () => new Date(2026, 10, 10, 9, 30, 0); // 2026-11-10 09:30:00 local

  it.each([
    ['user', { pin: '9001', name: 'ZK Test' }, 'DATA UPDATE user CardNo=\tPin=9001\tPassword=\tGroup=1\tName=ZK Test\tPrivilege=0'],
    ['user', { pin: '9001', name: 'ZK Test', card: '123456', window: 'zero' },
      'DATA UPDATE user CardNo=123456\tPin=9001\tPassword=\tGroup=1\tStartTime=0\tEndTime=0\tName=ZK Test\tPrivilege=0'],
    ['user', { pin: '9001', name: 'ZK Test', start: '2026-11-10', end: '2026-11-10 23:59:59', datefmt: 'seconds' },
      `DATA UPDATE user CardNo=\tPin=9001\tPassword=\tGroup=1\tStartTime=${zk.encodeZkTime(2026, 11, 10)}\tEndTime=${zk.encodeZkTime(2026, 11, 10, 23, 59, 59)}\tName=ZK Test\tPrivilege=0`],
    ['user', { pin: '9001', name: 'ZK Test', start: '2026-11-10', end: '2026-11-11', datefmt: 'yyyymmdd' },
      'DATA UPDATE user CardNo=\tPin=9001\tPassword=\tGroup=1\tStartTime=20261110\tEndTime=20261111\tName=ZK Test\tPrivilege=0'],
    ['userauthorize', { pin: '9001' }, 'DATA UPDATE userauthorize Pin=9001\tAuthorizeTimezoneId=1\tAuthorizeDoorId=1'],
    ['userauthorize', { pin: '9001', devid: '1', end: '+2m', datefmt: 'seconds' },
      `DATA UPDATE userauthorize Pin=9001\tAuthorizeTimezoneId=1\tAuthorizeDoorId=1\tDevID=1\tStartTime=${zk.encodeZkTime(2026, 11, 10, 9, 30)}\tEndTime=${zk.encodeZkTime(2026, 11, 10, 9, 32)}`],
    ['delete-user', { pin: '9001' }, 'DATA DELETE user Pin=9001'],
    ['delete-userauthorize', { pin: '9001' }, 'DATA DELETE userauthorize Pin=9001'],
    ['delete-biodata', { pin: '9001' }, 'DATA DELETE biodata Pin=9001'],
    ['delete-biodata', { pin: '9001', type: '9' }, 'DATA DELETE biodata Type=9\tPin=9001'],
    ['query-user', { pin: '9001' }, 'DATA QUERY tablename=user,fielddesc=*,filter=Pin=9001'],
    ['query-user', { all: '1' }, 'DATA QUERY tablename=user,fielddesc=*,filter=*'],
    ['query-biodata', { pin: '9001' }, 'DATA QUERY tablename=biodata,fielddesc=*,filter=Type=9\tPin=9001'],
    ['query-biodata', { type: '1', all: '1' }, 'DATA QUERY tablename=biodata,fielddesc=*,filter=Type=1'],
    ['count-user', {}, 'DATA COUNT user'],
    ['count-biodata', { type: '9' }, 'DATA COUNT biodata Type=9'],
    ['enroll-bio', { pin: '9001' }, 'ENROLL_BIO TYPE=9\tNO=0\tPIN=9001\tRETRY=3\tOVERWRITE=1\tMODE=1'],
    ['enroll-bio', { pin: '9001', sep: 'space' }, 'ENROLL_BIO TYPE=9 NO=0 PIN=9001 RETRY=3 OVERWRITE=1 MODE=1'],
    ['info', {}, 'INFO'],
    ['raw', { text: 'DATA COUNT biodata Type=1' }, 'DATA COUNT biodata Type=1'],
  ])('%s %j', (kind, params, expected) => {
    expect(zk.buildCommand(kind, params, { now })).toBe(expected);
  });

  it('biophoto Type=9 sends base64 content with its size, or a URL', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    const b64 = jpeg.toString('base64');
    const ctx = { readFile: () => jpeg, photoUrl: () => 'http://192.168.1.20:8088/zkcap/photo/p1.jpg' };
    expect(zk.buildCommand('biophoto', { pin: '9001', file: 'face.jpg' }, ctx)).toBe(
      `DATA UPDATE biophoto PIN=9001\tType=9\tSize=${b64.length}\tContent=${b64}\tFormat=0\tPostBackTmpFlag=1`
    );
    expect(zk.buildCommand('biophoto', { pin: '9001', file: 'face.jpg', format: 'url' }, ctx)).toBe(
      `DATA UPDATE biophoto PIN=9001\tType=9\tSize=${b64.length}\tFormat=1\tUrl=http://192.168.1.20:8088/zkcap/photo/p1.jpg\tPostBackTmpFlag=1`
    );
  });

  it('never wipes a device and never sends an admin privilege', () => {
    expect(() => zk.buildCommand('delete-user', { pin: '*' })).toThrow(/refused/);
    expect(() => zk.buildCommand('raw', { text: 'DATA DELETE user *' })).toThrow(/refused/);
    expect(() => zk.buildCommand('raw', { text: 'CLEAR DATA' })).toThrow(/refused/);
    expect(() => zk.buildCommand('raw', { text: 'DATA QUERY tablename=user,fielddesc=*,filter=*' })).toThrow(/all=1/);
    expect(() => zk.buildCommand('query-user', {})).toThrow(/pin is required/);
    expect(zk.buildCommand('user', { pin: '1', privilege: '14' })).toMatch(/\tPrivilege=0$/);
  });

  it('names are cut to 24 characters', () => {
    expect(zk.buildCommand('user', { pin: '1', name: 'X'.repeat(30) })).toContain(`Name=${'X'.repeat(24)}\t`);
  });
});

describe('zk-capture-server: helpers', () => {
  it('encodes and decodes ZKTeco seconds (protocol Appendix 5 and 6)', () => {
    expect(zk.encodeZkTime(2000, 1, 1, 0, 0, 0)).toBe(0);
    expect(zk.encodeZkTime(2026, 11, 10, 0, 0, 0)).toBe(((26 * 12 * 31) + (10 * 31) + 9) * 86400);
    expect(zk.decodeZkTime(zk.encodeZkTime(2026, 12, 31, 23, 59, 59)))
      .toEqual({ year: 2026, mon: 12, day: 31, hour: 23, min: 59, sec: 59 });
    // The manual's example value decodes to a real date.
    const d = zk.decodeZkTime(583512660);
    expect(zk.encodeZkTime(d.year, d.mon, d.day, d.hour, d.min, d.sec)).toBe(583512660);
  });

  it('reads relative and absolute times', () => {
    const now = new Date(2026, 10, 10, 9, 30, 0);
    expect(zk.parseWhen('+2m', now).getMinutes()).toBe(32);
    expect(zk.parseWhen('-1d', now).getDate()).toBe(9);
    expect(zk.parseWhen('2026-11-11 08:15', now)).toEqual(new Date(2026, 10, 11, 8, 15, 0));
    expect(() => zk.parseWhen('tomorrow', now)).toThrow();
  });

  it('redaction keeps 40 characters plus the length and leaves short values alone', () => {
    expect(zk.redactText(`biodata pin=1 tmp=${TEMPLATE}`)).toBe(`biodata pin=1 tmp=${'A'.repeat(40)}…[len=1500]`);
    expect(zk.redactText('user=2\nbiophoto=1')).toBe('user=2\nbiophoto=1');
    const bare = 'Zm9v'.repeat(50);
    expect(zk.redactText(`x ${bare} y`)).toBe(`x ${bare.slice(0, 40)}…[len=200] y`);
  });

  it('registry bodies split on commas with ~ prefixes and keep spaces in values', () => {
    expect(zk.parseRegistry('DeviceType=acc,~DeviceName=SpeedFace-V5L [TD],FirmVer=ZAM180 Ver 1.0'))
      .toEqual({ DeviceType: 'acc', DeviceName: 'SpeedFace-V5L [TD]', FirmVer: 'ZAM180 Ver 1.0' });
  });

  it('token check reports which formula matches', () => {
    const ctx = { registryCode: 'Code123', sessionId: 'ABCDEF0123456789ABCDEF0123456789', sn: SN };
    const token = crypto.createHash('md5').update(`Code123${SN}ABCDEF0123456789ABCDEF0123456789`).digest('hex');
    expect(zk.checkToken(`token=${token}`, ctx)).toBe('MATCH md5(RegistryCode+SerialNumber+SessionID) with this run');
    expect(zk.checkToken('token=00000000000000000000000000000000', ctx)).toBe('no candidate formula matched');
    expect(zk.checkToken('', ctx)).toBeNull();
  });

  it('control pages are for this Mac only', () => {
    expect(zk.isLoopback('127.0.0.1')).toBe(true);
    expect(zk.isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(zk.isLoopback('192.168.1.50')).toBe(false);
  });
});

// ── T&A PUSH (attendance) devices: shapes from the first real capture, 2026-11-11 ──────────────
// SpeedFace-V5L ZAM180-NF50VA-Ver3.4.9, Push 2.0.33S, Device Type "T&A PUSH". Synthetic values only.
const ATT_SN = 'TESTATT001';
const ATT_QUERY = `SN=${ATT_SN}&options=all&language=69&pushver=2.4.1&DeviceType=att&PushOptionsFlag=1`;
const ATT_OPTIONS_BODY = '~DeviceName=SpeedFace-V5L,MAC=00:00:00:00:00:00,TransactionCount=3,UserCount=2,FPVersion=10,'
  + 'FaceVersion=39,~OEMVendor=ZKTECO CO., LTD.,FWVersion=ZAM180-NF50VA-Ver3.4.9,PushVersion=Ver 2.0.33S-20220623,'
  + 'RegDeviceType=,MultiBioDataSupport=0:1:0:0:0:0:0:0:1:1,MultiBioPhotoSupport=0:0:0:0:0:0:0:0:0:1,UserPicURLFunOn=1';
const ATT_USERS = [
  'USER PIN=9001\tName=ZK Test \tPri=0\tPasswd=\tCard=\tGrp=1\tTZ=0000000000000000\tVerify=0\tViceCard=\tStartDatetime=0\tEndDatetime=0',
  'USER PIN=9002\tName=Other Person \tPri=0\tPasswd=\tCard=\tGrp=1\tTZ=0000000000000000\tVerify=0\tViceCard=\tStartDatetime=0\tEndDatetime=0',
  `FP PIN=9001\tFID=6\tSize=1500\tValid=1\tTMP=${TEMPLATE}`,
].join('\n');
const ATT_BIODATA = `BIODATA Pin=9001\tNo=0\tIndex=0\tValid=1\tDuress=0\tType=9\tMajorVer=39\tMinorVer=3\tFormat=0\tTmp=${TEMPLATE}`;
// PIN, time, status, verify, workcode, then five more values and a trailing tab (11 columns).
const attlogLine = (pin, time, verify) => `${pin}\t${time}\t255\t${verify}\t0\t0\t0\t255\t0\t0\t`;

describe('zk-capture-server: T&A PUSH handshake (tests (h) to (l))', () => {
  it('answerStyleFor: auto answers att only when the cdata query says DeviceType=att', () => {
    expect(zk.answerStyleFor('auto', { DeviceType: 'att' })).toBe('att');
    expect(zk.answerStyleFor('auto', { DeviceType: 'ATT' })).toBe('att');
    expect(zk.answerStyleFor('auto', { DeviceType: 'acc' })).toBe('spec');
    expect(zk.answerStyleFor('auto', {})).toBe('spec');
    expect(zk.answerStyleFor('spec', { DeviceType: 'att' })).toBe('spec');
    expect(zk.answerStyleFor('gbs', {})).toBe('gbs');
    expect(zk.STYLES).toEqual(['auto', 'spec', 'gbs', 'att']);
  });

  it('the att option lines are GymBioSync\'s cdata lines with this run\'s random codes and the known stamps', () => {
    const lines = zk.buildAttOptionLines({ sessionId: 'S'.repeat(32), registryCode: 'RandomCode1', sn: ATT_SN, stamps: { ATTLOG: '120' } });
    const gbs = zk.buildConfigLines({ sessionId: 'S'.repeat(32), registryCode: 'RandomCode1', sn: ATT_SN, forCdata: true, style: 'gbs' });
    expect(lines[0]).toBe(`GET OPTION FROM: ${ATT_SN}`);
    expect(lines).toHaveLength(gbs.length);
    expect(lines).toContain('ATTLOGStamp=120');
    expect(lines).toContain('OPERLOGStamp=9999');
    expect(lines).toContain('BIODATAStamp=9999');
    expect(lines).toContain('ATTPHOTOStamp=9999');
    expect(lines).toContain('RegistryCode=RandomCode1');
    expect(lines).toContain(`SessionID=${'S'.repeat(32)}`);
    expect(lines.filter((l) => !/Stamp=/.test(l))).toEqual(gbs.filter((l) => !/Stamp=/.test(l)));
    expect(lines.join('\n')).not.toContain(zk.MANUAL_EXAMPLE.registryCode);
    expect(zk.buildAttOptionLines({ sessionId: 'x', registryCode: 'y', defaultStamp: '0' })).toContain('OPERLOGStamp=0');
  });

  it('ATTLOG lines are positional (pin, time, status, verify, workcode, ...) with a trailing tab', () => {
    const rows = zk.parseAttlog(`${attlogLine('9001', '2026-11-11 16:04:24', '15')}\n${attlogLine('9002', '2026-11-11 16:05:00', '1')}\n`);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ pin: '9001', time: '2026-11-11 16:04:24', status: '255', verify: '15', workcode: '0', columns: 11 });
    expect(rows[1]).toMatchObject({ pin: '9002', verify: '1' });
  });

  it('two punches by one PIN in the same second are reported with both verify codes', () => {
    const rows = zk.parseAttlog([
      attlogLine('9001', '2026-11-11 16:04:24', '1'), attlogLine('9001', '2026-11-11 16:04:24', '15'),
      attlogLine('9002', '2026-11-11 16:04:24', '4'),
    ].join('\n'));
    expect(zk.sameSecond(rows)).toEqual([{ pin: '9001', time: '2026-11-11 16:04:24', verify: ['1', '15'] }]);
  });

  it('OPERLOG / BIODATA records are typed by their first word; OPLOG stays positional', () => {
    const recs = zk.parseOperlog(`${ATT_USERS}\nOPLOG 4\t0\t2026-11-11 16:00:00\t0\t0\t0\t0\n${ATT_BIODATA}`);
    expect(zk.countTypes(recs)).toEqual({ USER: 2, FP: 1, OPLOG: 1, BIODATA: 1 });
    expect(recs[0]).toMatchObject({ type: 'USER', pin: '9001' });
    expect(recs[0].fields).toMatchObject({ Name: 'ZK Test', Pri: '0', StartDatetime: '0', EndDatetime: '0' });
    expect(recs[3]).toMatchObject({ type: 'OPLOG', pin: null });
    expect(recs[3].fields.cols).toHaveLength(7);
    expect(recs[4]).toMatchObject({ type: 'BIODATA', pin: '9001' });
    expect(recs[4].fields).toMatchObject({ Type: '9', MajorVer: '39', MinorVer: '3' });
  });
});

describe('zk-capture-server: T&A PUSH flow over HTTP, style auto (the default)', () => {
  let cap;
  let port;
  let dir;
  const logs = [];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkcap-att-'));
    cap = zk.createCaptureServer({ capturesDir: dir, log: (l) => logs.push(l) });
    port = await cap.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await cap.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the default style is auto with stamps 9999 and test PIN 9001', () => {
    expect(cap.state).toMatchObject({ style: 'auto', defaultStamp: '9999', testPin: '9001' });
  });

  it('cdata options=all with DeviceType=att gets the option lines at once (no registry) and logs the flow', async () => {
    const r = await request(port, 'GET', `/iclock/cdata?${ATT_QUERY}`);
    const lines = r.text.split('\n');
    expect(lines[0]).toBe(`GET OPTION FROM: ${ATT_SN}`);
    expect(lines).toContain('ATTLOGStamp=9999');
    expect(lines).toContain(`RegistryCode=${cap.state.registryCode}`);
    expect(lines).toContain(`SessionID=${cap.state.sessionId}`);
    expect(r.headers.date).toMatch(/ GMT$/);
    const dev = cap.state.devices.get(ATT_SN);
    expect(dev).toMatchObject({ deviceType: 'att', pushver: '2.4.1', answered: 'att', flow: 'att options (no registry expected)' });
    expect(logs.some((l) => l.startsWith(`FLOW ${ATT_SN}: att options`))).toBe(true);
  });

  it('table=options is stored (a comma inside a value does not break the other keys)', async () => {
    const r = await request(port, 'POST', `/iclock/cdata?SN=${ATT_SN}&table=options`, { body: ATT_OPTIONS_BODY });
    expect(r.text).toBe('OK\n');
    expect(cap.state.devices.get(ATT_SN).options).toMatchObject({
      DeviceName: 'SpeedFace-V5L', FWVersion: 'ZAM180-NF50VA-Ver3.4.9', PushVersion: 'Ver 2.0.33S-20220623',
      MultiBioDataSupport: '0:1:0:0:0:0:0:0:1:1', FaceVersion: '39', UserPicURLFunOn: '1',
    });
  });

  it('getrequest with INFO answers OK and logs the INFO once', async () => {
    const info = 'ZAM180-NF50VA-Ver3.4.9,2,1,3,192.168.1.50,10,39,12,1,11110,1,0,7';
    expect((await request(port, 'GET', `/iclock/getrequest?SN=${ATT_SN}&INFO=${encodeURIComponent(info)}`)).text).toBe('OK\n');
    await request(port, 'GET', `/iclock/getrequest?SN=${ATT_SN}&INFO=${encodeURIComponent(info)}`);
    expect(logs.filter((l) => l.startsWith(`DEVICE INFO ${ATT_SN}`))).toHaveLength(1);
    expect(cap.state.devices.get(ATT_SN)).toMatchObject({ info, polls: 2 });
  });

  it('OPERLOG and BIODATA uploads answer OK, are counted by record type, and log only the test PIN\'s lines', async () => {
    logs.length = 0;
    const r = await request(port, 'POST', `/iclock/cdata?SN=${ATT_SN}&table=OPERLOG&OpStamp=9999`, { body: ATT_USERS });
    expect(r.text).toBe('OK\n');
    const b = await request(port, 'POST', `/iclock/cdata?SN=${ATT_SN}&table=BIODATA&OpStamp=9999`, { body: ATT_BIODATA });
    expect(b.text).toBe('OK\n');
    const dev = cap.state.devices.get(ATT_SN);
    expect(dev.uploads).toMatchObject({ 'OPERLOG:USER': 2, 'OPERLOG:FP': 1, 'BIODATA:BIODATA': 1 });
    expect(dev.stamps).toMatchObject({ OPERLOG: '9999', BIODATA: '9999' });
    expect(logs).toContain('UPLOAD table=OPERLOG records=3 {"USER":2,"FP":1} bytes=' + Buffer.byteLength(ATT_USERS));
    expect(logs.filter((l) => l.includes('test PIN 9001'))).toHaveLength(3);
    expect(logs.join('\n')).not.toContain('Other Person');
    expect(logs.join('\n')).not.toContain('A'.repeat(41));
  });

  it('ATTLOG uploads answer OK, record the stamp, log the test PIN\'s punches and same-second pairs', async () => {
    logs.length = 0;
    const body = [
      attlogLine('9001', '2026-11-11 16:04:24', '1'), attlogLine('9001', '2026-11-11 16:04:24', '15'),
      attlogLine('9002', '2026-11-11 16:05:00', '4'), attlogLine('9002', '2026-11-11 16:06:00', '1'),
    ].join('\n');
    const r = await request(port, 'POST', `/iclock/cdata?SN=${ATT_SN}&table=ATTLOG&Stamp=120`, { body });
    expect(r.text).toBe('OK\n');
    expect(cap.state.devices.get(ATT_SN).stamps.ATTLOG).toBe('120');
    expect(cap.state.devices.get(ATT_SN).uploads.ATTLOG).toBe(4);
    expect(logs[0]).toMatch(/^UPLOAD table=ATTLOG Stamp=120 records=4 columns=11 verify .*"15=face":1.* from 2026-11-11 16:04:24 to 2026-11-11 16:06:00$/);
    expect(logs.filter((l) => l.startsWith('SCAN (ATTLOG) pin=9001'))).toHaveLength(2);
    expect(logs.filter((l) => l.startsWith('SCAN (ATTLOG) pin=9002'))).toHaveLength(0);
    expect(logs).toContain('SAME SECOND (ATTLOG) pin=9001 time=2026-11-11 16:04:24 verify=1,15 (2 rows)');
  });

  it('the next cdata options=all sends back the stamps the device reported', async () => {
    const r = await request(port, 'GET', `/iclock/cdata?${ATT_QUERY}`);
    expect(r.text.split('\n')).toEqual(expect.arrayContaining(['ATTLOGStamp=120', 'OPERLOGStamp=9999']));
  });

  it('the capture file keeps the OPERLOG and BIODATA bodies with templates cut to 40 characters', () => {
    const text = fs.readFileSync(cap.captureFile, 'utf8');
    expect(text).toContain('table=OPERLOG');
    expect(text).toContain(`TMP=${'A'.repeat(40)}…[len=1500]`);
    expect(text).toContain(`Tmp=${'A'.repeat(40)}…[len=1500]`);
    expect(text).not.toContain('A'.repeat(41));
  });
});

describe('zk-capture-server: style spec with a T&A PUSH device reproduces the first capture', () => {
  it('answers OK, logs "waiting for registry", then "polling without registry" on getrequest', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkcap-spec-'));
    const logs = [];
    const cap = zk.createCaptureServer({ capturesDir: dir, style: 'spec', log: (l) => logs.push(l) });
    const port = await cap.listen(0, '127.0.0.1');
    try {
      expect((await request(port, 'GET', `/iclock/cdata?${ATT_QUERY}`)).text).toBe('OK\n');
      expect(cap.state.devices.get(ATT_SN).flow).toBe('waiting for registry');
      expect((await request(port, 'GET', `/iclock/getrequest?SN=${ATT_SN}`)).text).toBe('OK\n');
      expect(cap.state.devices.get(ATT_SN).flow).toBe('polling without registry');
      expect(logs.filter((l) => l.startsWith('FLOW '))).toHaveLength(2);
      // A later registry still works and is logged as its own flow.
      const reg = await request(port, 'POST', `/iclock/registry?SN=${ATT_SN}`, { body: 'DeviceType=att' });
      expect(reg.text).toBe(`RegistryCode=${cap.state.registryCode}\n`);
      expect(cap.state.devices.get(ATT_SN).flow).toBe('registry');
    } finally {
      await cap.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('style gbs still answers cdata and push like GymBioSync for any device', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zkcap-gbs-'));
    const cap = zk.createCaptureServer({ capturesDir: dir, style: 'gbs', log: () => {} });
    const port = await cap.listen(0, '127.0.0.1');
    try {
      const c = await request(port, 'GET', `/iclock/cdata?SN=${SN}&options=all`);
      expect(c.text.split('\n')[0]).toBe(`GET OPTION FROM: ${SN}`);
      expect(c.text).toContain('ATTLOGStamp=0');
      const p = await request(port, 'POST', `/iclock/push?SN=${SN}`);
      expect(p.text.split('\n')[0]).toBe('ServerVersion=3.0.1');
    } finally {
      await cap.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('zk-capture-server: attendance-protocol commands (tests (i), (j))', () => {
  const now = () => new Date(2026, 10, 11, 16, 0, 0);

  it.each([
    ['userinfo', { pin: '9001', name: 'ZK Test' },
      'DATA UPDATE USERINFO PIN=9001\tName=ZK Test\tPri=0\tPasswd=\tCard=\tGrp=1\tTZ=0000000000000000\tVerify=0\tViceCard='],
    ['userinfo', { pin: '9001', name: 'ZK Test', window: 'zero' },
      'DATA UPDATE USERINFO PIN=9001\tName=ZK Test\tPri=0\tPasswd=\tCard=\tGrp=1\tTZ=0000000000000000\tVerify=0\tViceCard=\tStartDatetime=0\tEndDatetime=0'],
    ['userinfo', { pin: '9001', name: 'ZK Test', end: '+3m', datefmt: 'datetime' },
      'DATA UPDATE USERINFO PIN=9001\tName=ZK Test\tPri=0\tPasswd=\tCard=\tGrp=1\tTZ=0000000000000000\tVerify=0\tViceCard=\tStartDatetime=2026-11-11 16:00:00\tEndDatetime=2026-11-11 16:03:00'],
    ['userinfo', { pin: '9001', end: '-1d', datefmt: 'seconds' },
      `DATA UPDATE USERINFO PIN=9001\tName=ZK Test\tPri=0\tPasswd=\tCard=\tGrp=1\tTZ=0000000000000000\tVerify=0\tViceCard=\tStartDatetime=${zk.encodeZkTime(2026, 11, 11, 16)}\tEndDatetime=${zk.encodeZkTime(2026, 11, 10, 16)}`],
    ['delete-userinfo', { pin: '9001' }, 'DATA DELETE USERINFO PIN=9001'],
    ['query-userinfo', { pin: '9001' }, 'DATA QUERY USERINFO PIN=9001'],
    ['user', { pin: '9001', name: 'ZK Test', end: '+3m', datefmt: 'datetime' },
      'DATA UPDATE user CardNo=\tPin=9001\tPassword=\tGroup=1\tStartTime=2026-11-11 16:00:00\tEndTime=2026-11-11 16:03:00\tName=ZK Test\tPrivilege=0'],
  ])('%s %j', (kind, params, expected) => {
    expect(zk.buildCommand(kind, params, { now })).toBe(expected);
  });

  it('the attendance forms never wipe and never send an admin privilege', () => {
    expect(() => zk.buildCommand('delete-userinfo', { pin: '*' })).toThrow(/refused/);
    expect(() => zk.buildCommand('raw', { text: 'DATA DELETE USERINFO *' })).toThrow(/refused/);
    expect(zk.buildCommand('userinfo', { pin: '1', pri: '14' })).toContain('\tPri=0\t');
    expect(() => zk.buildCommand('userinfo', { pin: '1', end: '+1m', datefmt: 'iso' })).toThrow(/datefmt/);
  });
});
