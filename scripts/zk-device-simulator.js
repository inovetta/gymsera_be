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
        { host: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
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

module.exports = { ZkDeviceSimulator, parseCommands, parseConfig, DEFAULT_REGISTRY };
