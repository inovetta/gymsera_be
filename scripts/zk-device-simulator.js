#!/usr/bin/env node
/**
 * zk-device-simulator.js: a ZKTeco Security PUSH device in a script (spec ZKTECO_PUSH_DEVICE_SYNC.md
 * §15 Phase 1). Speaks the device side of the protocol against any server: the GymsEra API, the
 * Phase 0 capture server, or a local dev API. Used by the integration tests as a library.
 *
 * Both registration styles: when the server answers `OK` to `cdata?options=all` the simulator
 * registers (POST /iclock/registry, the spec flow); when it answers `registry=ok` straight away
 * (the GymBioSync style) it skips registration. Commands are parsed like a device does: a line
 * starting `C:<id>:` begins a command, any other line continues the one before (multi-record
 * `DATA UPDATE biodata`).
 *
 * CLI (no dependencies):
 *   node scripts/zk-device-simulator.js --url http://127.0.0.1:3000 --sn SIM00001 --key K7QM3XRT --mode host
 *     --mode host  sends Host: k7qm3xrt.push.gymsera.com   (mode B; --host-suffix to change)
 *     --mode path  calls /d/K7QM3XRT/iclock/…              (mode A)
 *     (no --key)   serial only                             (mode C; --auth-key 123456)
 *   --once        connect, poll once, print, exit
 *   --return N    the Return code it answers for every command (default 0)
 * It polls every RequestDelay seconds and answers each command. Ctrl+C to stop.
 *
 * Phase 2: the simulator keeps a device's own tables (users, userauthorize, templates per type,
 * comparison photos, userpic) and runs commands on them with the firmware's return codes: -27 for
 * an unknown PIN, -30 when a template's major version differs from its MultiBioVersion, -708 for a
 * photo type it does not support or ENROLL_BIO when `enrollSupported: false`. DATA QUERY user
 * answers through querydata in packs; DATA COUNT returns the count; ENROLL_BIO posts a BioData
 * result. scan() decides like the device (offline too: unknown 27, past EndTime 29, else 0) and
 * posts the rtlog line. step() acks every command of a poll in ONE devicecmd body.
 *
 * Phase 3: `DATA DELETE <table> *` empties the table (remove with wipe), `DATA DELETE biodata Type=<t>`
 * deletes every template of that type.
 */
'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const DEFAULT_REGISTRY =
  'DeviceType=acc,~DeviceName=SpeedFace-V5L Simulator,FirmVer=ZAM180-SIM-1.0,PushVersion=3.1.2,' +
  'MAC=00:17:61:00:00:01,CommType=ethernet,MaxPackageSize=2048000,LockCount=1,~MaxUserCount=10000,' +
  'MultiBioDataSupport=0:1:1:0:0:0:0:0:0:1:0,MultiBioPhotoSupport=0:0:0:0:0:0:0:0:0:1:0,' +
  'MultiBioVersion=0:10.0:0:0:0:0:0:0:0:40.1:0,MaxMultiBioDataCount=0:5000:0:0:0:0:0:0:0:5000:0,DateFmtFunOn=1';

/** `C:<id>:<text>` lines; a line without the prefix continues the previous command. */
function parseCommands(body) {
  const out = [];
  for (const line of String(body || '').split('\n')) {
    const m = /^C:(\d+):(.*)$/.exec(line);
    if (m) out.push({ id: Number(m[1]), text: m[2] });
    else if (out.length && line !== '') out[out.length - 1].text += `\n${line}`;
  }
  return out;
}

function parseConfig(body) {
  const out = {};
  for (const line of String(body || '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

// ── The device's own data (Phase 2): users, authorizations, templates, photos ────────────────────
const fieldsOf = (text) => {
  const out = {};
  for (const part of String(text).split('\t')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1);
  }
  return out;
};
const zkSeconds = (y, mo, d, h = 0, mi = 0, s = 0) => ((y - 2000) * 12 * 31 + (mo - 1) * 31 + d - 1) * 86400 + (h * 60 + mi) * 60 + s;
/** 'YYYY-MM-DD HH:MM:SS' → ZK seconds (Appendix 5); monotonic, so it compares with EndTime. */
const zkOf = (local) => {
  const [date, time = '00:00:00'] = String(local).split(' ');
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi, s] = time.split(':').map(Number);
  return zkSeconds(y, mo, d, h, mi, s);
};
/** EndTime in either format → the last ZK second it allows. */
const endOf = (v) => {
  const t = String(v || '');
  if (!t || t === '0') return null;
  if (/^\d{8}$/.test(t)) return zkSeconds(Number(t.slice(0, 4)), Number(t.slice(4, 6)), Number(t.slice(6, 8)), 23, 59, 59);
  return Number(t);
};
const majorOf = (v) => String(Number(String(v).split('.')[0]));

class ZkDeviceSimulator {
  /**
   * @param {object} o
   * @param {string} o.baseUrl        http://127.0.0.1:3000
   * @param {string} o.sn             serial number
   * @param {string} [o.key]          device key (8 characters)
   * @param {'host'|'path'} [o.mode]  how the key is presented (default host when a key is given)
   * @param {string} [o.hostSuffix]   '.push.gymsera.com'
   * @param {string} [o.registryBody] registration body (default: a SpeedFace-like device)
   * @param {string} [o.authKey]      Comm Key sent at registration (mode C)
   * @param {boolean} [o.sendToken]   send Cookie: token=… after registration (default true)
   * @param {object} [o.headers]      extra headers on every request
   */
  constructor(o) {
    this.baseUrl = o.baseUrl.replace(/\/$/, '');
    this.sn = o.sn;
    this.key = o.key || null;
    this.mode = o.key ? o.mode || 'host' : null;
    this.hostSuffix = o.hostSuffix || '.push.gymsera.com';
    this.registryBody = (o.registryBody || DEFAULT_REGISTRY) + (o.authKey ? `,authKey=${o.authKey}` : '');
    this.sendToken = o.sendToken !== false;
    this.headers = o.headers || {};
    this.registryCode = null;
    this.sessionId = null;
    this.config = {};
    // Phase 2: a device with its own tables.
    const reg = Object.fromEntries(this.registryBody.split(',').map((p) => p.replace(/^~/, '').split('=')).filter((kv) => kv.length === 2));
    this.versions = String(reg.MultiBioVersion || '').split(':');
    this.photoSupport = String(reg.MultiBioPhotoSupport || '').split(':');
    this.users = new Map(); // pin → { pin, name, cardNo, startTime, endTime, privilege }
    this.auth = new Map(); // pin → fields
    this.bio = new Map(); // `${pin}:${type}:${no}:${index}` → { pin, type, no, index, majorVer, tmp }
    this.photos = new Map(); // `${pin}:${type}` → content
    this.userpics = new Map(); // pin → content
    this.executed = []; // every command text received, in order
    this.uploads = []; // { path, body } posted while executing (querydata, BioData)
    this.recordIndex = 0;
    this.queryPackSize = o.queryPackSize || 2;
    this.enrollSupported = o.enrollSupported !== false;
    this.forceReturn = o.forceReturn || null; // (text) → a return code to answer instead, or null
    this.lowerCaseReturn = Boolean(o.lowerCaseReturn);
  }

  /** Runs one command on the device's tables like the firmware would. → return code */
  execute(text) {
    this.executed.push(text);
    if (this.forceReturn) {
      const forced = this.forceReturn(text);
      if (forced !== null && forced !== undefined) return forced;
    }
    const [head, ...rest] = text.split('\n');
    const m = /^(DATA (UPDATE|DELETE|QUERY|COUNT) (\w+)|ENROLL_BIO|INFO|CHECK)\s?(.*)$/.exec(head);
    if (!m) return -1;
    if (head.startsWith('INFO') || head.startsWith('CHECK')) return 0;
    if (head.startsWith('ENROLL_BIO')) {
      if (!this.enrollSupported) return -708;
      const f = Object.fromEntries(head.slice(11).split(/[ \t]/).map((kv) => kv.split('=')));
      this.pendingEnroll = { pin: f.PIN, type: Number(f.TYPE), no: Number(f.NO || 0) };
      return 0;
    }
    const verb = m[2];
    const table = m[3].toLowerCase();
    const first = fieldsOf(m[4]);
    const pinOf = (f) => String(f.pin ?? '');
    if (verb === 'UPDATE' && table === 'user') {
      this.users.set(pinOf(first), { pin: pinOf(first), name: first.name, cardNo: first.cardno, startTime: first.starttime, endTime: first.endtime, privilege: first.privilege });
      return 0;
    }
    if (verb === 'UPDATE' && table === 'userauthorize') {
      if (!this.users.has(pinOf(first))) return -27;
      this.auth.set(pinOf(first), first);
      return 0;
    }
    if (verb === 'UPDATE' && table === 'biodata') {
      const records = [first, ...rest.map(fieldsOf)];
      for (const r of records) {
        if (!this.users.has(pinOf(r))) return -27;
        if (!r.tmp) return -26;
        const want = this.versions[Number(r.type)];
        if (want && want !== '0' && majorOf(want) !== majorOf(r.majorver)) return -30;
      }
      for (const r of records) this.bio.set(`${pinOf(r)}:${r.type}:${r.no}:${r.index}`, { pin: pinOf(r), type: Number(r.type), no: Number(r.no), index: Number(r.index), majorVer: r.majorver, tmp: r.tmp });
      return 0;
    }
    if (verb === 'UPDATE' && table === 'biophoto') {
      if (!this.users.has(pinOf(first))) return -27;
      if (this.photoSupport[Number(first.type)] !== '1') return -708;
      this.photos.set(`${pinOf(first)}:${first.type}`, first.content);
      return 0;
    }
    if (verb === 'UPDATE' && table === 'userpic') {
      if (!this.users.has(pinOf(first))) return -27;
      this.userpics.set(pinOf(first), first.content);
      return 0;
    }
    if (verb === 'DELETE') {
      // Phase 3 wipe: `DATA DELETE <table> *`, and biodata by type alone.
      if (m[4].trim() === '*' || (table === 'biodata' && first.pin === undefined)) {
        if (table === 'user') {
          this.users.clear(); this.auth.clear(); this.bio.clear(); this.photos.clear(); this.userpics.clear();
        } else if (table === 'userauthorize') this.auth.clear();
        else if (table === 'biodata') {
          for (const [k, v] of [...this.bio.entries()]) if (first.type === undefined || v.type === Number(first.type)) this.bio.delete(k);
        } else if (table === 'biophoto') this.photos.clear();
        else if (table === 'userpic') this.userpics.clear();
        return 0;
      }
      const pin = pinOf(first);
      if (table === 'user') {
        this.users.delete(pin);
        this.auth.delete(pin);
        for (const k of [...this.bio.keys()]) if (k.startsWith(`${pin}:`)) this.bio.delete(k);
        for (const k of [...this.photos.keys()]) if (k.startsWith(`${pin}:`)) this.photos.delete(k);
        this.userpics.delete(pin);
      } else if (table === 'userauthorize') this.auth.delete(pin);
      else if (table === 'biodata') {
        for (const [k, v] of [...this.bio.entries()]) if (v.pin === pin && (first.type === undefined || v.type === Number(first.type))) this.bio.delete(k);
      } else if (table === 'biophoto') {
        for (const k of [...this.photos.keys()]) if (k.startsWith(`${pin}:`)) this.photos.delete(k);
      } else if (table === 'userpic') this.userpics.delete(pin);
      return 0;
    }
    if (verb === 'COUNT') {
      if (table === 'user') return this.users.size;
      if (table === 'biodata') return [...this.bio.values()].filter((b) => first.type === undefined || b.type === Number(first.type)).length;
      return 0;
    }
    if (verb === 'QUERY') {
      // The manual (9.1.4): a biodata query condition must include Type. A device refuses one without it.
      if (/tablename=biodata/i.test(m[4]) && !/filter=[^,]*Type=\d+/i.test(m[4])) return -1;
      this.pendingQuery = m[4];
      return 0;
    }
    return -1;
  }

  /** One device poll cycle: get commands, run them, post query packs / enrol results, then ONE devicecmd body. */
  async step() {
    const r = await this.poll();
    if (!r.commands.length) return { commands: [], results: [], poll: r };
    const results = [];
    for (const cmd of r.commands) {
      this.pendingQuery = null;
      this.pendingEnroll = null;
      const code = this.execute(cmd.text);
      if (this.pendingQuery !== null && this.pendingQuery !== undefined && cmd.text.includes('tablename=user')) await this.sendUserQuery(cmd.id);
      if (this.pendingQuery !== null && this.pendingQuery !== undefined && cmd.text.includes('tablename=biodata')) await this.sendBioQuery(cmd.id, this.pendingQuery);
      if (this.pendingEnroll) await this.sendEnroll(this.pendingEnroll);
      results.push({ id: cmd.id, returnCode: code, cmd: cmd.text.split(' ').slice(0, 2).join(' ') });
    }
    const body = results.map((x) => `ID=${x.id}&${this.lowerCaseReturn ? 'return' : 'Return'}=${x.returnCode}&CMD=${x.cmd}`).join('\n');
    const ack = await this.request('POST', `/iclock/devicecmd?${this.q()}`, body);
    return { commands: r.commands, results, poll: r, ack };
  }

  /** Polls until the server has nothing more (or `max` cycles). → every command handled */
  async drain(max = 50) {
    const all = [];
    for (let i = 0; i < max; i++) {
      const s = await this.step();
      if (!s.commands.length) break;
      all.push(...s.results.map((x, j) => ({ ...x, text: s.commands[j].text })));
    }
    return all;
  }

  async sendUserQuery(cmdid) {
    const users = [...this.users.values()];
    const packs = [];
    for (let i = 0; i < users.length; i += this.queryPackSize) packs.push(users.slice(i, i + this.queryPackSize));
    if (!packs.length) packs.push([]);
    for (let i = 0; i < packs.length; i++) {
      const body = packs[i].map((u) => `user uid=${u.pin}\tcardno=${u.cardNo || ''}\tpin=${u.pin}\tname=${u.name || ''}\tprivilege=${u.privilege || 0}`).join('\n');
      const res = await this.querydata({ cmdid, tablename: 'user', count: packs[i].length, packcnt: packs.length, packidx: i + 1 }, body);
      this.uploads.push({ path: 'querydata', status: res.status, text: res.text });
    }
  }

  /** Phase 4: the answer to `DATA QUERY tablename=biodata,…,filter=Type=<t>[\tPin=<p>]`, in packs. */
  async sendBioQuery(cmdid, query) {
    const filter = fieldsOf(String(query).replace(/^.*filter=/i, ''));
    const type = Number(filter.type);
    const rows = [...this.bio.values()].filter((b) => b.type === type && (filter.pin === undefined || b.pin === String(filter.pin)));
    const packs = [];
    for (let i = 0; i < rows.length; i += this.queryPackSize) packs.push(rows.slice(i, i + this.queryPackSize));
    if (!packs.length) packs.push([]);
    for (let i = 0; i < packs.length; i++) {
      const body = packs[i].map((b) => `biodata pin=${b.pin}\tno=${b.no}\tindex=${b.index}\tvalid=1\tduress=0\ttype=${b.type}\tmajorver=${b.majorVer}\tminorver=${b.minorVer ?? 0}\tformat=0\ttmp=${b.tmp}`).join('\n');
      const res = await this.querydata({ cmdid, tablename: 'biodata', count: packs[i].length, packcnt: packs.length, packidx: i + 1 }, body);
      this.uploads.push({ path: 'querydata', table: 'biodata', status: res.status, text: res.text });
    }
  }

  /** Phase 4: a user put on the device by another system (GymBioSync), with no validity window. */
  seedUser({ pin, name = '', cardNo = '', privilege = 0 }) {
    this.users.set(String(pin), { pin: String(pin), name, cardNo, startTime: '0', endTime: '0', privilege: String(privilege) });
  }

  /** Phase 4: a template enrolled on the device before GymsEra. */
  seedBio({ pin, type, no = 0, index = 0, majorVer, minorVer = '0', tmp }) {
    this.bio.set(`${pin}:${type}:${no}:${index}`, { pin: String(pin), type: Number(type), no, index, majorVer: String(majorVer), minorVer: String(minorVer), tmp });
  }

  async sendEnroll({ pin, type, no }) {
    const tmp = `ENROLLED${crypto.randomBytes(30).toString('base64').replace(/[^A-Za-z0-9]/g, 'A')}`;
    const major = majorOf(this.versions[type] || '0');
    this.bio.set(`${pin}:${type}:${no}:0`, { pin, type, no, index: 0, majorVer: major, tmp });
    const body = `TYPE=${type}\tPIN=${pin}\tNO=${no}\tINDEX=0\tMAJOR_VER=${major}\tMINOR_VER=1\tTMP=${tmp}`;
    const res = await this.request('POST', `/iclock/cdata?${this.q('&type=BioData')}`, body);
    this.uploads.push({ path: 'BioData', status: res.status, text: res.text });
  }

  /**
   * Someone presents a face, finger or card. The device decides alone, from its own tables (works
   * offline): unknown PIN → 27, past EndTime → 29, else 0 (door opens). Then posts the rtlog line.
   * `at` is device local time 'YYYY-MM-DD HH:MM:SS'. → { event, res }
   */
  async scan(pin, at, { inoutstatus = 0, send = true, index } = {}) {
    const u = this.users.get(String(pin));
    let event = 0;
    if (!u) event = 27;
    else {
      const end = endOf(u.endTime);
      if (end !== null && zkOf(at) > end) event = 29;
    }
    const idx = index ?? ++this.recordIndex;
    const line = `time=${at}\tpin=${pin}\tcardno=0\teventaddr=1\tevent=${event}\tinoutstatus=${inoutstatus}\tverifytype=15\tindex=${idx}`;
    const res = send ? await this.upload('rtlog', line) : null;
    return { event, res, line, index: idx };
  }

  /** What this device holds for a PIN (tests). */
  holds(pin) {
    const p = String(pin);
    return {
      user: this.users.get(p) || null,
      auth: this.auth.get(p) || null,
      bioTypes: [...new Set([...this.bio.values()].filter((b) => b.pin === p).map((b) => b.type))].sort(),
      photoTypes: [...this.photos.keys()].filter((k) => k.startsWith(`${p}:`)).map((k) => Number(k.split(':')[1])),
    };
  }

  token() {
    if (!this.registryCode || !this.sessionId) return null;
    return crypto.createHash('md5').update(`${this.registryCode}${this.sn}${this.sessionId}`).digest('hex');
  }

  request(method, path, body = '', extraHeaders = {}) {
    const prefix = this.key && this.mode === 'path' ? `/d/${this.key}` : '';
    const url = new URL(`${this.baseUrl}${prefix}${path}`);
    const headers = {
      'User-Agent': 'iClock Proxy/1.09',
      Accept: 'application/push',
      'Content-Type': 'application/push;charset=UTF-8',
      'Content-Length': Buffer.byteLength(body),
      ...this.headers,
      ...extraHeaders,
    };
    if (this.key && this.mode === 'host') headers.Host = `${this.key.toLowerCase()}${this.hostSuffix}`;
    const tok = this.sendToken ? this.token() : null;
    if (tok && !headers.Cookie) headers.Cookie = `token=${tok}`;
    const lib = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const req = lib.request(
        // agent: false: a new connection per request, as a device does; reusing sockets is not what is tested.
        // (The push load test's 'read ECONNRESET' / 'socket hang up' was not a keep-alive race: it was NEW-240,
        // the harness closing the server under the poll loops after an earlier failure.)
        { host: url.hostname, port: url.port, path: url.pathname + url.search, method, headers, agent: false },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, ms: Date.now() - started }));
        }
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  q(extra = '') {
    return `SN=${encodeURIComponent(this.sn)}${extra}`;
  }

  /** cdata handshake, then registry when asked, then push. */
  async connect() {
    const cdata = await this.request('GET', `/iclock/cdata?${this.q('&options=all&pushver=3.1.2')}`);
    if (cdata.status !== 200) return { ok: false, step: 'cdata', res: cdata };
    let registeredBy = 'cdata';
    if (/^registry=ok$/m.test(cdata.text)) {
      Object.assign(this.config, parseConfig(cdata.text));
      this.registryCode = this.config.RegistryCode;
      this.sessionId = this.config.SessionID;
    } else {
      const reg = await this.registry();
      if (reg.status !== 200) return { ok: false, step: 'registry', res: reg };
      registeredBy = 'registry';
    }
    const push = await this.push();
    if (push.status !== 200) return { ok: false, step: 'push', res: push };
    return { ok: true, registeredBy, cdata, config: this.config };
  }

  async registry() {
    const res = await this.request('POST', `/iclock/registry?${this.q()}`, this.registryBody);
    const m = /^RegistryCode=(.+)$/m.exec(res.text);
    if (res.status === 200 && m) this.registryCode = m[1].trim();
    return res;
  }

  async push() {
    const res = await this.request('POST', `/iclock/push?${this.q()}`);
    if (res.status === 200) {
      Object.assign(this.config, parseConfig(res.text));
      if (this.config.SessionID) this.sessionId = this.config.SessionID;
    }
    return res;
  }

  async poll() {
    const res = await this.request('GET', `/iclock/getrequest?${this.q()}`);
    return { ...res, commands: res.status === 200 ? parseCommands(res.text) : [] };
  }

  /** results: [{ id, returnCode, cmd }] → one line each. */
  ack(results) {
    const body = results.map((r) => `ID=${r.id}&Return=${r.returnCode}&CMD=${r.cmd || 'DATA'}`).join('\n');
    return this.request('POST', `/iclock/devicecmd?${this.q()}`, body);
  }

  /** table=rtlog | rtstate | options | ATTLOG; or tablename=… for tabledata uploads. */
  upload(table, body, { tablename, count } = {}) {
    const query = tablename ? `&table=tabledata&tablename=${tablename}${count ? `&count=${count}` : ''}` : `&table=${table}`;
    return this.request('POST', `/iclock/cdata?${this.q(query)}`, body);
  }

  querydata({ cmdid, tablename, type = 'tabledata', count, packcnt = 1, packidx = 1 }, body) {
    return this.request(
      'POST',
      `/iclock/querydata?${this.q(`&type=${type}&cmdid=${cmdid}&tablename=${tablename}&count=${count}&packcnt=${packcnt}&packidx=${packidx}`)}`,
      body
    );
  }

  ping() {
    return this.request('GET', `/iclock/ping?${this.q()}`);
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i++; }
  }
  return flags;
}

async function main() {
  const f = parseArgs(process.argv.slice(2));
  if (!f.url || !f.sn) {
    console.log('Usage: node scripts/zk-device-simulator.js --url http://127.0.0.1:3000 --sn SIM00001 [--key K7QM3XRT --mode host|path] [--auth-key 123456] [--once] [--return 0]');
    process.exitCode = 1;
    return;
  }
  const dev = new ZkDeviceSimulator({
    baseUrl: f.url, sn: f.sn, key: f.key ? String(f.key).replace(/-/g, '') : undefined, mode: f.mode,
    hostSuffix: f['host-suffix'], authKey: f['auth-key'],
  });
  const c = await dev.connect();
  if (!c.ok) {
    console.log(`Not connected: ${c.step} answered ${c.res.status} ${c.res.text.trim()}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Connected (${c.registeredBy}); RequestDelay=${dev.config.RequestDelay}`);
  const delay = Math.max(1, Number(dev.config.RequestDelay) || 3) * 1000;
  const returnCode = Number(f.return ?? 0);
  for (;;) {
    const r = await dev.poll();
    for (const cmd of r.commands) console.log(`  C:${cmd.id}: ${cmd.text.slice(0, 120)}`);
    if (r.commands.length) await dev.ack(r.commands.map((cmd) => ({ id: cmd.id, returnCode, cmd: cmd.text.split(' ').slice(0, 2).join(' ') })));
    if (f.once) return;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(err.message); process.exitCode = 1; });
}

module.exports = { ZkDeviceSimulator, parseCommands, parseConfig, DEFAULT_REGISTRY, zkOf };
