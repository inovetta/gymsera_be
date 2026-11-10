/**
 * ZKTeco Security PUSH device endpoints (spec ZKTECO_PUSH_DEVICE_SYNC.md §4, §5).
 *
 * Replaces the old `app.use('/iclock', iclock.routes)` mount. Mounted in app.js BEFORE helmet,
 * CORS and the JSON / urlencoded parsers, so device bodies (`application/push`) are read as text
 * and answers carry no cookies, CORS or HTML. Serves `/iclock/*` and `/d/<key>/iclock/*` (mode A);
 * mode B finds the key in the host name (X-Original-Host behind the IIS proxy, else Host).
 *
 * Who is calling (§4.2):
 *   key presented (path or host) → that device; first contact binds the serial; another serial → 406.
 *   no key → only a serial-mode device (when DEVICE_SERIAL_PAIRING allows it); a key device's serial
 *     without its key never joins; a serial in the old platform `devices` table keeps the old ATTLOG
 *     handling (iclock.service.js) until it is moved over (Phase 4).
 *   anything else → unclaimed: OK on cdata, 406 on registry, recorded for support.
 *
 * Unexpected errors answer OK (a device retries an error at once) and are logged with the device id,
 * never the body. Phase 2 stores scans, uploads, error logs, state history and audit packs
 * (services/devices/device-ingest.service.js).
 */
const express = require('express');
const { getDeviceConfig } = require('../config/devices.config');
const protocol = require('../services/devices/push-protocol');
const registry = require('../services/devices/device-registry.service');
const ingest = require('../services/devices/device-ingest.service');
const triggers = require('../services/devices/device-triggers');

/** The device as the sync engine sees it (details + branch time zone), or null. */
const syncDeviceOf = async (tenantDb, id) => {
  const [d] = await require('../services/devices/device-sync.service').devicesOf(tenantDb, { deviceId: id });
  return d || null;
};

const DEVICE_PATH = /^\/(?:d\/([A-Za-z0-9]{8})\/)?iclock(?:\/|$)/;
const isDevicePath = (path) => DEVICE_PATH.test(path);

const router = express.Router();

// ── Request facts ─────────────────────────────────────────────────────────────
/** The host the device typed: X-Original-Host from the IIS push site (§4.5), else Host. Lower case. */
const effectiveHost = (req) => String(req.headers['x-original-host'] || req.headers.host || '').trim().toLowerCase();
const hostWithoutPort = (host) => host.replace(/:\d+$/, '');

/**
 * Client IP for logs, unclaimed rows and the device page: CF-Connecting-IP, then the first
 * X-Forwarded-For, then the socket. Under iisnode every request arrives through a named pipe, so a
 * "loopback only" trust test cannot tell the proxy from anyone else; these values are therefore used
 * for display and support only, never to decide access.
 */
const clientIp = (req) => {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).trim().slice(0, 45);
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim().slice(0, 45);
  return String(req.socket?.remoteAddress || '').slice(0, 45) || null;
};

const schemeOf = (req) => {
  try {
    const v = req.headers['cf-visitor'] && JSON.parse(req.headers['cf-visitor']);
    if (v?.scheme) return String(v.scheme).toLowerCase();
  } catch (_) { /* not JSON */ }
  const xfp = req.headers['x-forwarded-proto'];
  if (xfp) return String(xfp).split(',')[0].trim().toLowerCase();
  return req.socket?.encrypted ? 'https' : 'http';
};

/** Mode B: `k7qm3xrt.push.gymsera.com` → K7QM3XRT (any configured suffix). */
const hostKey = (host) => {
  const h = hostWithoutPort(host);
  for (const suffix of getDeviceConfig().hostKeySuffixes) {
    if (h.endsWith(suffix) && h.length > suffix.length) return h.slice(0, -suffix.length);
  }
  return null;
};

// ── Answers ───────────────────────────────────────────────────────────────────
function send(res, status, text) {
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    Date: new Date().toUTCString(),
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': buf.length,
  });
  res.end(buf);
}
const lines = (...l) => `${l.flat().join('\n')}\n`;
const OK = lines('OK');

// ── Resolve the caller ────────────────────────────────────────────────────────
const tenantCache = new Map(); // tenantId → { enc, at }  (connection string only; 60 s)

async function tenantDbFor(tenantId) {
  const cached = tenantCache.get(tenantId);
  let enc = cached && Date.now() - cached.at < 60000 ? cached.enc : null;
  if (!enc) {
    const { Tenant } = require('../models/platform');
    const tenant = await Tenant.findOne({ where: { id: tenantId, status: 'ACTIVE' }, attributes: ['id', 'connectionStringEncrypted'] });
    if (!tenant || !tenant.connectionStringEncrypted || tenant.connectionStringEncrypted === 'PENDING_PROVISIONING') {
      tenantCache.delete(tenantId);
      return null;
    }
    enc = tenant.connectionStringEncrypted;
    tenantCache.set(tenantId, { enc, at: Date.now() });
  }
  return require('../database/TenantDbManager').getConnection(tenantId, enc);
}

async function isLegacySerial(sn) {
  const { Device } = require('../models/platform');
  return Boolean(await Device.findOne({ where: { serialNumber: sn, status: 'ACTIVE' }, attributes: ['id'] }));
}

/**
 * → { kind: 'device', device, tenantDb } | { kind: 'mismatch', device } | { kind: 'disabled', device }
 *   | { kind: 'legacy' } | { kind: 'unknown', reason }
 */
async function resolveCaller(c) {
  const cfg = getDeviceConfig();
  const unknown = async (reason) => {
    await registry.recordUnclaimed({ sn: c.sn, host: c.host, pathKey: c.pathKey, ip: c.ip, reason });
    return { kind: 'unknown', reason };
  };

  const presented = c.pathKey || c.hostKey;
  if (presented) {
    const key = registry.normalizeKey(presented);
    const device = key ? await registry.findByKey(key) : null;
    if (!device || device.status === 'removed' || device.link_mode === 'serial') return unknown('unknown_key');
    if (!c.sn) return unknown('no_serial');
    const bound = await registry.bindSerial(device, c.sn);
    if (bound === 'mismatch' || bound === 'in_use') {
      await registry.recordSerialMismatch(device, c.sn);
      return { kind: 'mismatch', device };
    }
    return withTenant(device);
  }

  if (!c.sn) return unknown('no_serial');
  const bySerial = await registry.findBySerial(c.sn);
  if (bySerial && bySerial.link_mode === 'serial' && bySerial.status !== 'removed' && cfg.serialPairing !== 'off') {
    return withTenant(bySerial);
  }
  if (bySerial && bySerial.link_mode !== 'serial') return unknown('key_missing');
  if (await isLegacySerial(c.sn)) return { kind: 'legacy' };
  return unknown('unknown_serial');
}

async function withTenant(device) {
  if (device.status === 'disabled') return { kind: 'disabled', device };
  const tenantDb = await tenantDbFor(device.tenant_id);
  if (!tenantDb) return { kind: 'disabled', device };
  return { kind: 'device', device, tenantDb };
}

// ── Endpoint handlers: (c, caller) → [status, text] ───────────────────────────
const TOKEN_EXEMPT = new Set(['GET cdata', 'POST registry', 'POST push', 'GET push']);

async function handleLegacy(c) {
  const iclock = require('../services/iclock.service');
  if (c.endpoint === 'getrequest') {
    await iclock.handleHeartbeat(c.sn);
    return [200, OK];
  }
  if (c.endpoint === 'cdata' && c.method === 'POST' && String(c.query.table || c.query.Table || '').toUpperCase() === 'ATTLOG') {
    const result = await iclock.handleAttlog(c.sn, c.body);
    return [200, lines(`OK: ${result ? result.accepted : 0}`)];
  }
  if (c.endpoint === 'cdata') return [200, lines('OK: 0')];
  if (c.endpoint === 'registry') return [406, lines('Not Acceptable')];
  return [200, OK];
}

async function handleDevice(c, { device, tenantDb }) {
  const cfg = getDeviceConfig();
  const det = await registry.detailsOf(tenantDb, device.id);
  if (!det || !det.enabled) return [c.endpoint === 'registry' ? 406 : 200, c.endpoint === 'registry' ? lines('Not Acceptable') : OK];
  const caps = (() => {
    try { return det.capabilities_json ? JSON.parse(det.capabilities_json) : {}; } catch (_) { return {}; }
  })();

  switch (c.endpoint) {
    case 'cdata': {
      if (c.method === 'GET') {
        if (cfg.registrationStyle === 'gbs') {
          if (device.status !== 'active') await registry.markRegistered(device, { pushver: c.query.pushver });
          return [200, lines(protocol.configLines({ style: 'gbs', registryCode: device.registry_code, sessionId: device.session_id, requestDelay: cfg.requestDelay, forCdata: true, sn: c.sn }))];
        }
        if (device.status === 'active') {
          return [200, lines(protocol.configLines({ style: 'spec', registryCode: device.registry_code, sessionId: device.session_id, requestDelay: cfg.requestDelay, forCdata: true }))];
        }
        return [200, OK];
      }
      const table = String(c.query.table || '').toLowerCase();
      const sdev = await syncDeviceOf(tenantDb, device.id);
      if (String(c.query.type || '').toLowerCase() === 'biodata') {
        // ENROLL_BIO result (§7.6): the same as a template upload.
        c.logTable = 'BioData';
        c.logCount = sdev ? await ingest.ingestTemplates(tenantDb, device.tenant_id, sdev, 'BioData', c.body) : 0;
        return [200, OK];
      }
      if (table === 'tabledata' || table === 'errorlog') {
        const name = table === 'errorlog' ? 'errorlog' : String(c.query.tablename || '');
        const lower = name.toLowerCase();
        c.logTable = name;
        c.logCount = protocol.recordCount(c.body, c.query.count);
        if (sdev) {
          if (lower === 'user') await ingest.ingestUsers(tenantDb, sdev, c.body);
          else if (lower === 'biodata' || lower === 'templatev10') await ingest.ingestTemplates(tenantDb, device.tenant_id, sdev, lower, c.body);
          else if (lower === 'biophoto' || lower === 'userpic' || lower === 'attphoto') await ingest.ingestPhotos(tenantDb, device.tenant_id, sdev, lower, c.body);
          else if (lower === 'errorlog') await ingest.ingestErrorlog(tenantDb, sdev, c.body);
        }
        return [200, table === 'errorlog' ? OK : lines(`${name}=${c.logCount}`)];
      }
      c.logTable = table;
      if (table === 'options') await registry.applyOptions(tenantDb, device.id, protocol.parseRegistry(c.body));
      else if (table === 'rtstate') {
        const rows = sdev ? await ingest.ingestState(tenantDb, sdev, c.body) : protocol.parseRecords(c.body);
        if (rows.length) await registry.applyState(tenantDb, device.id, rows[rows.length - 1]);
      } else if (table === 'rtlog' || table === 'attlog') {
        const res = sdev ? await ingest.ingestScans(tenantDb, sdev, c.body, { attlog: table === 'attlog' }) : { received: protocol.recordCount(c.body) };
        c.logCount = res.received;
      } else c.logCount = protocol.recordCount(c.body);
      return [200, OK];
    }
    case 'registry': {
      const reg = protocol.parseRegistry(c.body);
      if (device.link_mode === 'serial' && cfg.serialPairing === 'authkey' && (!reg.authKey || reg.authKey !== device.comm_key)) {
        return [406, lines('Not Acceptable')];
      }
      await registry.applyRegistry(tenantDb, device.id, reg);
      await registry.markRegistered(device, { pushver: reg.PushVersion || c.query.pushver });
      // Capabilities are known now: who belongs on it, with which templates (§8.2 "device created").
      triggers.reconcileDeviceSoon(tenantDb, device.id, 'device_registered');
      return [200, lines(`RegistryCode=${device.registry_code}`)];
    }
    case 'push':
      return [200, lines(protocol.configLines({ style: cfg.registrationStyle, registryCode: device.registry_code, sessionId: device.session_id, requestDelay: cfg.requestDelay, forCdata: false }))];
    case 'getrequest': {
      if (device.status !== 'active') return [200, OK];
      const body = await registry.claimCommands(tenantDb, device, { maxPackageSize: caps.MaxPackageSize });
      return [200, body ? `${body}\n` : OK];
    }
    case 'devicecmd': {
      const results = protocol.parseDevicecmd(c.body);
      c.logCount = results.length;
      if (results.length) await registry.recordResults(tenantDb, device, results);
      return [200, OK];
    }
    case 'querydata': {
      const name = String(c.query.tablename || '');
      c.logTable = name;
      c.logCount = protocol.recordCount(c.body, c.query.count);
      const sdev = await syncDeviceOf(tenantDb, device.id);
      if (sdev) await ingest.ingestQuery(tenantDb, sdev, c.query, c.body);
      return [200, lines(`${name}=${c.logCount}`)];
    }
    default:
      return [200, OK];
  }
}

async function handle(req, res) {
  const started = Date.now();
  const cfg = getDeviceConfig();
  const m = /^\/iclock\/([^/?]*)/.exec(req.path);
  const c = {
    method: req.method,
    endpoint: (m && m[1] ? m[1] : '').toLowerCase(),
    query: req.query || {},
    body: typeof req.body === 'string' ? req.body : '',
    sn: String((req.query && (req.query.SN || req.query.sn)) || '').trim().slice(0, 64) || null,
    host: effectiveHost(req),
    pathKey: req.deviceKey || null,
    ip: clientIp(req),
    scheme: schemeOf(req),
  };
  c.hostKey = c.pathKey ? null : hostKey(c.host);
  let status = 200;
  let text = OK;
  let caller = null;
  try {
    caller = await resolveCaller(c);
    if (caller.kind === 'legacy') {
      [status, text] = await handleLegacy(c);
    } else if (caller.kind === 'mismatch') {
      [status, text] = [406, lines('Not Acceptable')];
    } else if (caller.kind === 'unknown' || caller.kind === 'disabled') {
      [status, text] = c.endpoint === 'registry' ? [406, lines('Not Acceptable')] : [200, OK];
    } else {
      const { device } = caller;
      let tokenState = null;
      if (device.status === 'active' && !TOKEN_EXEMPT.has(`${c.method} ${c.endpoint}`)) {
        const sent = protocol.tokenFromCookie(req.headers.cookie);
        const want = protocol.expectedToken({ registryCode: device.registry_code, sn: c.sn, sessionId: device.session_id });
        tokenState = !sent ? 'absent' : sent === want ? 'match' : 'mismatch';
      }
      await registry.markSeen(device, { ip: c.ip, pushver: c.query.pushver, host: c.host.slice(0, 255), scheme: c.scheme, tokenState });
      if (!cfg.allowHttp && c.scheme !== 'https') {
        [status, text] = [403, lines('HTTPS required')];
      } else if (tokenState && tokenState !== 'match' && device.token_mode === 'enforce') {
        [status, text] = [401, lines('Unauthorized')];
      } else {
        [status, text] = await handleDevice(c, caller);
      }
    }
  } catch (err) {
    console.error(`[device-push] ${caller?.device?.id || '-'} ${c.method} /iclock/${c.endpoint} failed: ${err.message}`);
    status = 200;
    text = OK;
  }
  send(res, status, text);
  if (process.env.NODE_ENV !== 'test' || process.env.LOG_DEVICES === 'true') {
    // One line per request; never the body (§13).
    console.log(
      `[device-push] ${caller?.device?.id || caller?.kind || '-'} ${c.method} /iclock/${c.endpoint}` +
        `${c.logTable ? ` table=${c.logTable}` : ''}${c.logCount !== undefined ? ` count=${c.logCount}` : ''} → ${status} ${Date.now() - started}ms`
    );
  }
}

// ── Wiring ────────────────────────────────────────────────────────────────────
// Leave the router for anything that is not a device path.
router.use((req, _res, next) => (isDevicePath(req.path) ? next() : next('router')));

// Mode A: /d/<key>/iclock/… → /iclock/… with the key kept aside.
router.use((req, _res, next) => {
  const m = /^\/d\/([A-Za-z0-9]{8})(\/iclock(?:\/.*)?)$/.exec(req.path);
  if (m) {
    req.deviceKey = m[1];
    const qs = req.url.indexOf('?');
    req.url = m[2] + (qs >= 0 ? req.url.slice(qs) : '');
  }
  next();
});

router.use('/iclock', (req, res, next) => express.text({ type: () => true, limit: getDeviceConfig().maxBody })(req, res, next));

router.get('/iclock/cdata', handle);
router.post('/iclock/cdata', handle);
router.post('/iclock/registry', handle);
router.get('/iclock/push', handle);
router.post('/iclock/push', handle);
router.get('/iclock/getrequest', handle);
router.post('/iclock/devicecmd', handle);
router.post('/iclock/querydata', handle);
router.get('/iclock/ping', handle);
router.post('/iclock/ping', handle);
router.all('/iclock/*', handle); // new firmware calls: OK, path logged

// Body errors: 413 for an oversized body, OK for anything else; never HTML or JSON.
router.use((err, req, res, _next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    console.warn(`[device-push] body over ${getDeviceConfig().maxBody} on ${req.method} ${req.path} (not stored)`);
    return send(res, 413, lines('Payload Too Large'));
  }
  console.error(`[device-push] ${req.method} ${req.path} failed before the handler: ${err?.message}`);
  return send(res, 200, OK);
});

module.exports = router;
module.exports.isDevicePath = isDevicePath;
module.exports.effectiveHost = effectiveHost;
module.exports.hostWithoutPort = hostWithoutPort;
module.exports.send = send;
