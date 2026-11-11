/**
 * SANITIZED fixture: a T&A PUSH (DeviceType=att) SpeedFace-V5L, firmware ZAM180-NF50VA-Ver3.4.9, Push
 * Ver 2.0.33S, as seen in the first real-device capture (2026-11-11, `captures/20261111-155035.txt`,
 * gitignored). Only the STRUCTURE is copied: the request order, the query strings, the number of records
 * per post, the field names and order, the separators (tabs, the trailing tab of ATTLOG), the verify codes
 * and the option keys (with the comma inside `~OEMVendor`).
 *
 * Nothing here is real member data: PINs, names, cards, templates, MAC, IP and serial are made up, and
 * every time is relative to `now` (NEW-207: no calendar literals). The capture itself never held a
 * template (the capture server cuts them); the templates below are random base64.
 *
 * Shape of the capture (what `build()` reproduces):
 *   1  GET  cdata?SN=…&options=all&language=69&pushver=2.4.1&DeviceType=att&PushOptionsFlag=1
 *   2  POST cdata?table=options                 45 comma-separated options
 *   3  GET  getrequest?INFO=<fw>,<users>,<fp>,<att>,<ip>,<fpver>,<facever>,<pvver>,<faces>,<funcs>,1,0,7
 *   4… POST cdata?table=OPERLOG&OpStamp=9999     USER lines: posts of 128, 128, 100 (356 users)
 *      POST cdata?table=OPERLOG&OpStamp=9999     FP lines: posts of 128, 42, 128, 118 (416 templates)
 *      POST cdata?table=BIODATA&OpStamp=9999     15 BIODATA lines, Type=9 MajorVer=39 MinorVer=3 (faces)
 *      POST cdata?table=ATTLOG&Stamp=9999        history, up to 128 positional rows per post
 *      POST cdata?table=OPERLOG&OpStamp=9999     OPLOG lines (positional)
 *      GET  getrequest (polls), then live ATTLOG posts of 1 row
 */
const crypto = require('crypto');

const SN = 'SIMATT0001';
const CDATA_QUERY = 'options=all&language=69&pushver=2.4.1&DeviceType=att&PushOptionsFlag=1';
const COUNTS = { users: 356, fingerprints: 416, faces: 15, transactions: 14262 };

/** Same keys, order and units as the device sent; MAC and IP replaced (documentation ranges). */
const OPTIONS_BODY = [
  '~DeviceName=SpeedFace-V5L', 'MAC=00:00:5e:00:53:01', `TransactionCount=${COUNTS.transactions}`, '~MaxAttLogCount=20',
  `UserCount=${COUNTS.users}`, '~MaxUserCount=100', 'PhotoFunOn=1', '~MaxUserPhotoCount=2500', 'FingerFunOn=1', 'FPVersion=10',
  '~MaxFingerCount=60', `FPCount=${COUNTS.fingerprints}`, 'FaceFunOn=1', 'FaceVersion=39', '~MaxFaceCount=6000', `FaceCount=${COUNTS.faces}`,
  'FvFunOn=0', 'FvVersion=3', '~MaxFvCount=10', 'FvCount=0', 'PvFunOn=1', 'PvVersion=12', '~MaxPvCount=3000', 'PvCount=0',
  'Language=69', 'IPAddress=192.0.2.87', '~Platform=ZAM180_TFT', '~OEMVendor=ZKTECO CO., LTD.', 'FWVersion=ZAM180-NF50VA-Ver3.4.9',
  'PushVersion=Ver 2.0.33S-20220623', 'RegDeviceType=', 'VisilightFun=1', 'MultiBioDataSupport=0:1:0:0:0:0:0:0:1:1',
  'MultiBioPhotoSupport=0:0:0:0:0:0:0:0:0:1', 'IRTempDetectionFunOn=0', 'MaskDetectionFunOn=1', 'UserPicURLFunOn=1',
  'VisualIntercomFunOn=1', 'VideoTID=', 'QRCodeDecryptFunList=', 'VideoProtocol=4', 'IsSupportQRcode=0', 'QRCodeEnable=',
  'SubcontractingUpgradeFunOn=1',
].join(',');

const INFO = `ZAM180-NF50VA-Ver3.4.9,${COUNTS.users},${COUNTS.fingerprints},${COUNTS.transactions},192.0.2.87,10,39,12,${COUNTS.faces},11110,1,0,7`;

// ── Deterministic fake data ───────────────────────────────────────────────────
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const fakeTemplate = (rand, length = 96) => {
  const bytes = Buffer.alloc(Math.ceil((length * 3) / 4));
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(rand() * 256);
  return bytes.toString('base64').replace(/[^A-Za-z0-9]/g, 'A').slice(0, length);
};

/**
 * PINs of 1 to 8 digits like the device (GymBioSync used the old system's CustomerIDs). Never in the GymsEra
 * range 1001+ for the first ones, so collisions are a choice of the test, not an accident.
 */
function fakeUsers(count = COUNTS.users) {
  const out = [];
  for (let i = 0; i < count; i++) {
    let pin;
    if (i < 9) pin = String(i + 1); // 1 digit
    else if (i < 60) pin = String(10 + i); // 2 digits
    else if (i < 120) pin = String(200 + i); // 3 digits
    else if (i < 300) pin = String(5000 + i); // 4 digits
    else pin = String(300000 + i); // 6 digits
    const privilege = i === 0 ? 14 : i === 1 ? 14 : i === 2 ? 2 : 0; // two device admins, one "enroller"
    out.push({ pin, name: `Test Member ${String(i + 1).padStart(3, '0')}${i % 7 === 0 ? ' ' : ''}`, privilege, card: i === 5 ? '0012345678' : '' });
  }
  return out;
}

const userLine = (u) =>
  `USER PIN=${u.pin}\tName=${u.name}\tPri=${u.privilege}\tPasswd=\tCard=${u.card}\tGrp=1\tTZ=0000000000000000\tVerify=0\tViceCard=\tStartDatetime=0\tEndDatetime=0`;
const fpLine = (t) => `FP PIN=${t.pin}\tFID=${t.fid}\tSize=${t.tmp.length}\tValid=1\tTMP=${t.tmp}`;
const biodataLine = (t) =>
  `BIODATA Pin=${t.pin}\tNo=0\tIndex=0\tValid=1\tDuress=0\tType=9\tMajorVer=39\tMinorVer=3\tFormat=0\tTmp=${t.tmp}`;
/** ATTLOG: 10 positional values and a trailing tab: PIN, time, status, verify, workcode, 0, 0, 255, 0, 0. */
const attRow = ({ pin, time, verify = 1, status = 255, workcode = 0 }) => `${pin}\t${time}\t${status}\t${verify}\t${workcode}\t0\t0\t255\t0\t0\t`;
const oplogLine = ({ op, admin = 0, time, obj1 = 0 }) => `OPLOG ${op}\t${admin}\t${time}\t${obj1}\t0\t0\t0`;

const chunks = (list, sizes) => {
  const out = [];
  let at = 0;
  for (const n of sizes) {
    out.push(list.slice(at, at + n));
    at += n;
  }
  if (at < list.length) out.push(list.slice(at));
  return out.filter((c) => c.length);
};

/** Device-local wall time `minutes` from `now` in `timezone`, 'YYYY-MM-DD HH:MM:SS'. */
function localTime(now, minutes, timezone) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const { type, value } of f.formatToParts(new Date(now.getTime() + minutes * 60000))) p[type] = value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/**
 * @param {object} [o]
 * @param {Date}   [o.now]       history is before this; live punches after
 * @param {string} [o.timezone]  device (= branch) zone
 * @param {number} [o.historyRows] ATTLOG history rows (the capture had 7,172; 3 posts by default)
 * @param {number} [o.seed]
 */
function build({ now = new Date(), timezone = 'Asia/Karachi', historyRows = 300, seed = 20261111 } = {}) {
  const rand = rng(seed);
  const users = fakeUsers();
  const fps = [];
  for (const u of users) {
    if (fps.length >= COUNTS.fingerprints) break;
    const fingers = u.privilege === 0 ? (rand() < 0.6 ? 2 : 1) : 1;
    for (let fid = 0; fid < fingers && fps.length < COUNTS.fingerprints; fid++) fps.push({ pin: u.pin, fid, tmp: fakeTemplate(rand) });
  }
  const faces = users.slice(10, 10 + COUNTS.faces).map((u) => ({ pin: u.pin, tmp: fakeTemplate(rand, 120) }));

  // History: days ago, verify 1 (fingerprint), 15 (face), 4 (card); one same-second pair (finger + face).
  const verifies = [1, 1, 1, 15, 15, 4];
  const rows = [];
  for (let i = 0; i < historyRows; i++) {
    const u = users[3 + Math.floor(rand() * (users.length - 3))];
    const minutesAgo = (historyRows - i) * 30 + 2 * 24 * 60;
    rows.push({ pin: u.pin, time: localTime(now, -minutesAgo, timezone), verify: verifies[Math.floor(rand() * verifies.length)] });
  }
  const pair = rows[Math.floor(historyRows / 2)];
  rows.splice(Math.floor(historyRows / 2) + 1, 0, { pin: pair.pin, time: pair.time, verify: pair.verify === 15 ? 1 : 15 });
  const oplog = [
    oplogLine({ op: 0, time: localTime(now, -5000, timezone) }),
    oplogLine({ op: 3, time: localTime(now, -4000, timezone), obj1: 53 }),
    oplogLine({ op: 4, admin: users[0].pin, time: localTime(now, -3000, timezone) }),
    oplogLine({ op: 80, time: localTime(now, -2000, timezone), obj1: 'COMKey' }),
    oplogLine({ op: 6, admin: users[1].pin, time: localTime(now, -1000, timezone), obj1: users[20].pin }),
  ];

  return {
    sn: SN,
    cdataQuery: CDATA_QUERY,
    optionsBody: OPTIONS_BODY,
    info: INFO,
    counts: { ...COUNTS },
    users,
    fingerprints: fps,
    faces,
    history: rows,
    userPosts: chunks(users, [128, 128]).map((c) => c.map(userLine).join('\n')),
    fpPosts: chunks(fps, [128, 42, 128, 118]).map((c) => c.map(fpLine).join('\n')),
    biodataPost: faces.map(biodataLine).join('\n'),
    attlogPosts: chunks(rows, [128, 128, 128]).map((c) => c.map(attRow).join('\n')),
    oplogPost: oplog.join('\n'),
    attRow,
    localTime: (minutes) => localTime(now, minutes, timezone),
  };
}

module.exports = { build, attRow, userLine, fpLine, biodataLine, oplogLine, OPTIONS_BODY, INFO, CDATA_QUERY, COUNTS, SN };
