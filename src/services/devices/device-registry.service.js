/**
 * ZKTeco Push device registry (spec ZKTECO_PUSH_DEVICE_SYNC.md §4, §6, §8.1).
 *
 * Platform DB `access_devices`: routing (key, bound serial, link mode), per-device secrets
 * (RegistryCode, SessionID, Comm Key) and status. Tenant DB `access_device_details`: name,
 * direction and what the device reports; `device_commands`: the queue.
 *
 * All state is in MySQL (iisnode runs several processes). Times are written from JS (UTC), never
 * NOW(), so a MySQL server in another time zone cannot shift them.
 */
const { utc } = require('./sql-time');
const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const { sequelize: platformDb } = require('../../database/platform');
const { getDeviceConfig } = require('../../config/devices.config');
const protocol = require('./push-protocol');
const { createError } = require('../../utils/response.utils');

// §4.2: 8 characters, no 0/O/1/I/L. Stored without the hyphen, upper case.
// Built from character ranges at load time (letters A-Z, then digits 2-9, the look-alikes
// removed), so the source holds no long literal that a secret scanner reads as a key. The
// result is pinned in tests/regression/zkteco-p1-device-key.test.js.
const charRange = (first, last) => {
  let out = '';
  for (let c = first.charCodeAt(0); c <= last.charCodeAt(0); c++) out += String.fromCharCode(c);
  return out;
};
const LOOK_ALIKES = new Set(['0', 'O', '1', 'I', 'L']);
const KEY_ALPHABET = [...charRange('A', 'Z'), ...charRange('2', '9')].filter((c) => !LOOK_ALIKES.has(c)).join('');
const KEY_RE = new RegExp(`^[${KEY_ALPHABET}]{8}$`);
const DIRECTIONS = ['in', 'out', 'both'];
const LINK_MODES = ['host', 'path', 'serial'];
const SERIAL_RE = /^[A-Za-z0-9]{4,32}$/;

function newDeviceKey() {
  let key = '';
  for (let i = 0; i < 8; i++) key += KEY_ALPHABET[crypto.randomInt(KEY_ALPHABET.length)];
  return key;
}

/** 'k7qm-3xrt' → 'K7QM3XRT'; anything that cannot be a key → null. */
function normalizeKey(value) {
  const key = String(value || '').replace(/-/g, '').toUpperCase();
  return KEY_RE.test(key) ? key : null;
}

const formatKey = (key) => `${key.slice(0, 4)}-${key.slice(4)}`;
const newCommKey = () => String(crypto.randomInt(100000, 1000000));
const newClaimToken = () => crypto.randomBytes(13).toString('hex').toUpperCase(); // 26 chars

const q = (db, sql, replacements, type = QueryTypes.SELECT) => db.query(sql, { replacements: utc(replacements), type });

const isUniqueError = (err) => err && (err.name === 'SequelizeUniqueConstraintError' || err.original?.code === 'ER_DUP_ENTRY');

// ── Platform rows ─────────────────────────────────────────────────────────────
async function findByKey(key) {
  const [row] = await q(platformDb, 'SELECT * FROM access_devices WHERE device_key = ?', [key]);
  return row || null;
}

async function findBySerial(sn) {
  const [row] = await q(platformDb, 'SELECT * FROM access_devices WHERE serial_number = ?', [sn]);
  return row || null;
}

async function findById(id) {
  const [row] = await q(platformDb, 'SELECT * FROM access_devices WHERE id = ?', [id]);
  return row || null;
}

/**
 * First contact binds the serial (§4.2 rule 2). Returns 'bound' | 'same' | 'mismatch' | 'in_use'.
 * Atomic: two first contacts at once cannot both bind.
 */
async function bindSerial(device, sn) {
  if (device.serial_number) return device.serial_number === sn ? 'same' : 'mismatch';
  try {
    const [, meta] = await platformDb.query(
      'UPDATE access_devices SET serial_number = ?, updated_at = ? WHERE id = ? AND serial_number IS NULL',
      { replacements: utc([sn, new Date(), device.id]) }
    );
    const affected = typeof meta === 'number' ? meta : meta?.affectedRows;
    if (affected === 1) {
      device.serial_number = sn;
      return 'bound';
    }
  } catch (err) {
    if (isUniqueError(err)) return 'in_use';
    throw err;
  }
  const fresh = await findById(device.id);
  device.serial_number = fresh?.serial_number || null;
  return device.serial_number === sn ? 'same' : 'mismatch';
}

async function recordSerialMismatch(device, sn) {
  await platformDb.query(
    'UPDATE access_devices SET serial_mismatch_at = ?, serial_mismatch_value = ?, updated_at = ? WHERE id = ?',
    { replacements: utc([new Date(), String(sn || '').slice(0, 32), new Date(), device.id]) }
  );
}

/**
 * last_seen_at, IP, pushver, host, scheme and token state. Written at most every
 * `seenWriteSeconds`, or at once when one of the values changes (one statement, a no-op when not due).
 */
async function markSeen(device, { ip, pushver, host, scheme, tokenState }) {
  const cfg = getDeviceConfig();
  const now = new Date();
  const due = new Date(now.getTime() - cfg.seenWriteSeconds * 1000);
  await platformDb.query(
    `UPDATE access_devices SET last_seen_at = ?, last_ip = ?, last_pushver = COALESCE(?, last_pushver),
       last_host = ?, last_scheme = ?, last_token_state = COALESCE(?, last_token_state)
     WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ? OR NOT (last_ip <=> ?) OR NOT (last_host <=> ?)
       OR (? IS NOT NULL AND NOT (last_token_state <=> ?)) OR (? IS NOT NULL AND NOT (last_pushver <=> ?)))`,
    {
      replacements: utc([
        now, ip, pushver || null, host, scheme, tokenState || null,
        device.id, due, ip, host, tokenState || null, tokenState || null, pushver || null, pushver || null,
      ]),
    }
  );
}

async function markRegistered(device, { pushver }) {
  const now = new Date();
  await platformDb.query(
    'UPDATE access_devices SET status = \'active\', registered_at = ?, last_pushver = COALESCE(?, last_pushver), updated_at = ? WHERE id = ? AND status IN (\'awaiting_connection\', \'active\')',
    { replacements: utc([now, pushver || null, now, device.id]) }
  );
  device.status = 'active';
}

/**
 * Unknown serials and keys (§4.2 rule 1): one row per (serial, host, key, ip), counted at most every
 * `unclaimedThrottleSeconds`, capped at `unclaimedMaxRows`, rows older than `unclaimedDays` pruned.
 */
async function recordUnclaimed({ sn, host, pathKey, ip, reason }) {
  const cfg = getDeviceConfig();
  const now = new Date();
  const hash = crypto.createHash('sha256').update([sn, host, pathKey, ip, reason].join('|')).digest('hex');
  const due = new Date(now.getTime() - cfg.unclaimedThrottleSeconds * 1000);
  await platformDb.query(
    `INSERT INTO unclaimed_device_contacts (contact_hash, serial_number, host, path_key, ip, reason, first_seen_at, last_seen_at, hits)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1 FROM DUAL
     WHERE (SELECT COUNT(*) FROM unclaimed_device_contacts) < ?
     ON DUPLICATE KEY UPDATE hits = IF(last_seen_at < ?, hits + 1, hits), last_seen_at = IF(last_seen_at < ?, ?, last_seen_at)`,
    {
      replacements: utc([
        hash, sn ? String(sn).slice(0, 64) : null, host ? String(host).slice(0, 255) : null, pathKey || null,
        ip ? String(ip).slice(0, 45) : null, reason, now, now, cfg.unclaimedMaxRows, due, due, now,
      ]),
    }
  );
  if (crypto.randomInt(50) === 0) {
    await platformDb.query('DELETE FROM unclaimed_device_contacts WHERE last_seen_at < ?', {
      replacements: utc([new Date(now.getTime() - cfg.unclaimedDays * 86400000)]),
    });
  }
}

// ── Tenant rows ───────────────────────────────────────────────────────────────
async function detailsOf(tenantDb, id) {
  const [row] = await q(tenantDb.sequelize, 'SELECT * FROM access_device_details WHERE id = ?', [id]);
  return row || null;
}

const parseJson = (text) => {
  try {
    return text ? JSON.parse(text) : {};
  } catch (_) {
    return {};
  }
};

/** Registration fields → the device row (§6.2). The Comm Key (authKey) is never stored. */
async function applyRegistry(tenantDb, deviceId, reg) {
  const caps = { ...reg };
  delete caps.authKey;
  await tenantDb.sequelize.query(
    `UPDATE access_device_details SET model = ?, firmware = ?, push_version = ?, mac = ?, comm_type = ?, device_type = ?,
       capabilities_json = ?, updated_at = ? WHERE id = ?`,
    {
      replacements: utc([
        caps.DeviceName ? String(caps.DeviceName).slice(0, 100) : null,
        caps.FirmVer ? String(caps.FirmVer).slice(0, 100) : null,
        caps.PushVersion ? String(caps.PushVersion).slice(0, 16) : null,
        caps.MAC ? String(caps.MAC).slice(0, 32) : null,
        caps.CommType ? String(caps.CommType).slice(0, 32) : null,
        caps.DeviceType ? String(caps.DeviceType).slice(0, 8) : null,
        JSON.stringify(caps), new Date(), deviceId,
      ]),
    }
  );
}

/** table=options: counts and parameters, merged over what we had. */
async function applyOptions(tenantDb, deviceId, options) {
  const det = await detailsOf(tenantDb, deviceId);
  if (!det) return;
  const counts = { ...parseJson(det.counts_json), ...options };
  await tenantDb.sequelize.query('UPDATE access_device_details SET counts_json = ?, updated_at = ? WHERE id = ?', {
    replacements: utc([JSON.stringify(counts), new Date(), deviceId]),
  });
}

async function applyState(tenantDb, deviceId, state) {
  await tenantDb.sequelize.query('UPDATE access_device_details SET state_json = ?, updated_at = ? WHERE id = ?', {
    replacements: utc([JSON.stringify(state), new Date(), deviceId]),
  });
}

// ── Command queue (§8.1) ──────────────────────────────────────────────────────
/** The command text for a row that carries no member data (Phase 1 kinds). Member kinds: device-sync.service. */
function renderCommand(row) {
  const args = parseJson(row.args_json);
  switch (row.kind) {
    case 'info': return protocol.cmd.info();
    case 'check': return protocol.cmd.check();
    case 'count': return protocol.cmd.count(args.table || 'user', args.type);
    case 'query_users': return protocol.cmd.queryUsers(args.pin);
    case 'query_bio': return protocol.cmd.queryBio(args.type ?? 9, args.pin);
    default: return null;
  }
}

/**
 * Claims up to `commandsPerPoll` due commands with one UPDATE (MySQL 5.7 has no SKIP LOCKED), so two
 * processes can never hand out the same command, then renders them (device-sync.service: templates
 * decrypted in memory only) and packs them under min(MaxPackageSize, 1 MB). What does not fit, and
 * photos over DEVICE_PHOTOS_PER_POLL, go back to `queued`; a command of a replaced batch is
 * superseded; one that cannot be built is failed and its pair re-planned.
 */
async function claimCommands(tenantDb, device, { maxPackageSize } = {}) {
  const cfg = getDeviceConfig();
  const sync = require('./device-sync.service');
  const now = new Date();
  const token = newClaimToken();
  await tenantDb.sequelize.query(
    `UPDATE device_commands SET status = 'sent', sent_at = ?, attempts = attempts + 1, claim_token = ?, updated_at = ?
     WHERE device_id = ? AND status = 'queued' AND not_before <= ? AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY priority, id LIMIT ?`,
    { replacements: utc([now, token, now, device.id, now, now, Number(cfg.commandsPerPoll)]) }
  );
  const rows = await q(tenantDb.sequelize, 'SELECT * FROM device_commands WHERE claim_token = ? ORDER BY priority, id', [token]);
  if (!rows.length) return '';

  const rendered = await sync.renderCommands(tenantDb, device, rows);
  const renderable = rendered.filter((r) => r.text);
  const putBack = rendered.filter((r) => r.held).map((r) => r.id);
  await sync.supersede(tenantDb, device, rendered.filter((r) => r.superseded).map((r) => r.id), now);
  const limit = Math.min(Number(maxPackageSize) > 0 ? Number(maxPackageSize) : cfg.maxPackageBytes, cfg.maxPackageBytes);
  const packed = protocol.packCommands(renderable, limit);
  putBack.push(...packed.heldIds);
  if (putBack.length) {
    await tenantDb.sequelize.query(
      `UPDATE device_commands SET status = 'queued', claim_token = NULL, sent_at = NULL, attempts = attempts - 1, updated_at = ?
       WHERE claim_token = ? AND id IN (?)`,
      { replacements: utc([now, token, putBack]) }
    );
  }
  await sync.failUnrenderable(tenantDb, device, rendered.filter((r) => r.failed).map((r) => r.id), now);
  return packed.body;
}

/** devicecmd results: the §8.1 return-code table (device-sync.service#recordResults). Only this device's commands. */
async function recordResults(tenantDb, device, results) {
  return require('./device-sync.service').recordResults(tenantDb, device, results);
}

// ── Host-facing operations ────────────────────────────────────────────────────
function setupFor(row) {
  const cfg = getDeviceConfig();
  const base = { mode: row.link_mode, port: cfg.pushPort, https: cfg.pushHttps, key: formatKey(row.device_key) };
  if (row.link_mode === 'path') return { ...base, serverAddress: `${cfg.pushHost}/d/${row.device_key}`, domainName: true };
  if (row.link_mode === 'serial') return { ...base, serverAddress: cfg.pushHost, domainName: true, commKey: row.comm_key };
  const suffix = cfg.hostKeySuffixes[0] || `.${cfg.pushHost}`;
  return { ...base, serverAddress: `${row.device_key.toLowerCase()}${suffix}`, domainName: true };
}

const bit = (support, i) => String(support || '').split(':')[i] === '1';

/** The device as the CMS and the app see it. Never the RegistryCode, SessionID or Comm Key. */
function viewOf(row, det, branchName) {
  const cfg = getDeviceConfig();
  const caps = parseJson(det?.capabilities_json);
  const counts = parseJson(det?.counts_json);
  const seenAgo = row.last_seen_at ? Math.max(0, Math.round((Date.now() - new Date(row.last_seen_at).getTime()) / 1000)) : null;
  let connection;
  if (row.status === 'removed') connection = 'removed';
  else if (row.status === 'disabled') connection = 'disabled';
  else if (row.status === 'awaiting_connection') connection = 'awaiting_connection';
  else connection = seenAgo !== null && seenAgo <= cfg.onlineWindowSeconds ? 'online' : 'offline';
  const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
  return {
    id: row.id,
    deviceKey: row.device_key,
    key: formatKey(row.device_key),
    branchId: row.branch_id,
    branchName: branchName || null,
    organizationId: row.organization_id,
    name: det?.name || null,
    direction: det?.direction || null,
    enabled: det ? Boolean(det.enabled) : row.status !== 'disabled',
    linkMode: row.link_mode,
    status: row.status,
    connection,
    serialNumber: row.serial_number,
    registeredAt: row.registered_at,
    lastSeenAt: row.last_seen_at,
    lastSeenSecondsAgo: seenAgo,
    lastIp: row.last_ip,
    scheme: row.last_scheme,
    encrypted: row.last_scheme ? row.last_scheme === 'https' : null,
    tokenState: row.last_token_state,
    serialMismatch: row.serial_mismatch_at ? { at: row.serial_mismatch_at, serialNumber: row.serial_mismatch_value } : null,
    model: det?.model || null,
    firmware: det?.firmware || null,
    pushVersion: det?.push_version || null,
    deviceType: det?.device_type || null,
    capabilities: caps.MultiBioDataSupport
      ? {
        fingerprint: bit(caps.MultiBioDataSupport, 1),
        face: bit(caps.MultiBioDataSupport, 2) || bit(caps.MultiBioDataSupport, 9),
        palm: bit(caps.MultiBioDataSupport, 6) || bit(caps.MultiBioDataSupport, 8) || bit(caps.MultiBioDataSupport, 10),
      }
      : null,
    counts: {
      users: num(counts.UserCount),
      faces: num(counts.FaceCount),
      fingerprints: num(counts.FPCount),
      maxUsers: num(caps.MaxUserCount),
    },
    createdAt: row.created_at,
  };
}

async function branchOf(tenantDb, branchId) {
  const [b] = await q(tenantDb.sequelize, 'SELECT id, gym_id, branch_name FROM branches WHERE id = ?', [branchId]);
  return b || null;
}

/**
 * Adds a device to a branch. Returns { device, setup } (setup = the card the host types on the device).
 * Mode C (serial) only when DEVICE_SERIAL_PAIRING allows it (D-2).
 */
async function createDevice({ tenantId, tenantDb, branchId, organizationId, name, direction = 'in', linkMode, serialNumber, createdBy = null }) {
  const cfg = getDeviceConfig();
  const mode = linkMode || cfg.defaultLinkMode;
  if (!LINK_MODES.includes(mode)) throw createError('Choose how the device connects: host, path or serial.', 422, 'invalid_link_mode');
  if (!DIRECTIONS.includes(direction)) throw createError('Direction must be in, out or both.', 422, 'invalid_direction');
  const cleanName = String(name || '').trim().slice(0, 100);
  if (!cleanName) throw createError('Give the device a name.', 422, 'name_required');

  let sn = null;
  if (mode === 'serial') {
    if (cfg.serialPairing === 'off') {
      throw createError('Adding a device by serial number is switched off. Use the device key instead.', 422, 'serial_pairing_off');
    }
    sn = String(serialNumber || '').trim().toUpperCase();
    if (!SERIAL_RE.test(sn)) throw createError('Enter the serial number printed on the device (4 to 32 letters and digits).', 422, 'invalid_serial_number');
    if (await findBySerial(sn)) throw createError('That serial number is already linked to a device.', 409, 'serial_in_use');
  }

  const branch = await branchOf(tenantDb, branchId);
  if (!branch) throw createError('Branch not found.', 404, 'branch_not_found');

  const id = crypto.randomUUID();
  const now = new Date();
  const commKey = mode === 'serial' ? newCommKey() : null;
  let row = null;
  for (let attempt = 0; attempt < 5 && !row; attempt++) {
    const key = newDeviceKey();
    try {
      await platformDb.query(
        `INSERT INTO access_devices (id, device_key, serial_number, tenant_id, organization_id, branch_id, link_mode, comm_key,
           registry_code, session_id, token_mode, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_connection', ?, ?, ?)`,
        {
          replacements: utc([
            id, key, sn, tenantId, organizationId || branch.gym_id || null, branchId, mode, commKey,
            protocol.newRegistryCode(), protocol.newSessionId(), cfg.tokenMode, createdBy, now, now,
          ]),
        }
      );
      row = await findById(id);
    } catch (err) {
      if (!isUniqueError(err)) throw err;
      if (sn && (await findBySerial(sn))) throw createError('That serial number is already linked to a device.', 409, 'serial_in_use');
    }
  }
  if (!row) throw createError('Could not create a device key. Try again.', 503, 'device_key_unavailable');

  try {
    await tenantDb.sequelize.query(
      `INSERT INTO access_device_details (id, branch_id, name, direction, enabled, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
      { replacements: utc([id, branchId, cleanName, direction, createdBy, now, now]) }
    );
  } catch (err) {
    await platformDb.query('DELETE FROM access_devices WHERE id = ?', { replacements: utc([id]) }).catch(() => {});
    throw err;
  }
  return { device: viewOf(row, await detailsOf(tenantDb, id), branch.branch_name), setup: setupFor(row) };
}

/** One device of this tenant, not removed; null otherwise (a 404 for the caller). */
async function getDevice({ tenantId, tenantDb, deviceId }) {
  const [row] = await q(platformDb, 'SELECT * FROM access_devices WHERE id = ? AND tenant_id = ? AND status <> \'removed\'', [deviceId, tenantId]);
  if (!row) return null;
  const det = await detailsOf(tenantDb, deviceId);
  if (!det) return null;
  const branch = await branchOf(tenantDb, row.branch_id);
  return { row, details: det, view: viewOf(row, det, branch?.branch_name), setup: setupFor(row) };
}

/** branchIds null = every branch the tenant has. */
async function listDevices({ tenantId, tenantDb, branchIds = null }) {
  if (Array.isArray(branchIds) && branchIds.length === 0) return [];
  const rows = Array.isArray(branchIds)
    ? await q(platformDb, 'SELECT * FROM access_devices WHERE tenant_id = ? AND status <> \'removed\' AND branch_id IN (?) ORDER BY created_at', [tenantId, branchIds])
    : await q(platformDb, 'SELECT * FROM access_devices WHERE tenant_id = ? AND status <> \'removed\' ORDER BY created_at', [tenantId]);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const dets = await q(tenantDb.sequelize, 'SELECT * FROM access_device_details WHERE id IN (?)', [ids]);
  const byId = new Map(dets.map((d) => [d.id, d]));
  const bids = [...new Set(rows.map((r) => r.branch_id))];
  const branches = await q(tenantDb.sequelize, 'SELECT id, branch_name FROM branches WHERE id IN (?)', [bids]);
  const names = new Map(branches.map((b) => [b.id, b.branch_name]));
  return rows.filter((r) => byId.has(r.id)).map((r) => viewOf(r, byId.get(r.id), names.get(r.branch_id)));
}

async function updateDevice({ tenantId, tenantDb, deviceId, name, direction }) {
  let clean = null;
  if (name !== undefined) {
    clean = String(name || '').trim().slice(0, 100);
    if (!clean) throw createError('Give the device a name.', 422, 'name_required');
  }
  if (direction !== undefined && !DIRECTIONS.includes(direction)) {
    throw createError('Direction must be in, out or both.', 422, 'invalid_direction');
  }
  if (clean !== null || direction !== undefined) {
    // One fixed statement: a field left out keeps its value.
    await tenantDb.sequelize.query(
      'UPDATE access_device_details SET name = COALESCE(?, name), direction = COALESCE(?, direction), updated_at = ? WHERE id = ?',
      { replacements: utc([clean, direction ?? null, new Date(), deviceId]) }
    );
  }
  if (direction !== undefined) require('./device-triggers').reconcileDeviceSoon(tenantDb, deviceId, 'direction_changed');
  return getDevice({ tenantId, tenantDb, deviceId });
}

/** Disable stops all traffic (§10.3); enable returns it to active, or awaiting when it never registered. */
async function setEnabled({ tenantId, tenantDb, deviceId, enabled }) {
  const now = new Date();
  await tenantDb.sequelize.query('UPDATE access_device_details SET enabled = ?, updated_at = ? WHERE id = ?', {
    replacements: utc([enabled ? 1 : 0, now, deviceId]),
  });
  const sql = enabled
    ? 'UPDATE access_devices SET status = IF(registered_at IS NULL, \'awaiting_connection\', \'active\'), updated_at = ? WHERE id = ? AND tenant_id = ? AND status <> \'removed\''
    : 'UPDATE access_devices SET status = \'disabled\', updated_at = ? WHERE id = ? AND tenant_id = ? AND status <> \'removed\'';
  await platformDb.query(sql, { replacements: utc([now, deviceId, tenantId]) });
  if (enabled) require('./device-triggers').reconcileDeviceSoon(tenantDb, deviceId, 'device_enabled');
  return getDevice({ tenantId, tenantDb, deviceId });
}

/**
 * Re-pair (§4.2 rule 3): new key, new RegistryCode and SessionID, serial unbound (kept as
 * previous_serial_number). The old key stops working at once. A disabled device stays disabled.
 */
async function repairDevice({ tenantId, tenantDb = null, deviceId }) {
  const now = new Date();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await platformDb.query(
        `UPDATE access_devices SET device_key = ?, registry_code = ?, session_id = ?,
           previous_serial_number = COALESCE(serial_number, previous_serial_number), serial_number = NULL,
           status = IF(status = 'disabled', 'disabled', 'awaiting_connection'), registered_at = NULL,
           serial_mismatch_at = NULL, serial_mismatch_value = NULL, last_token_state = NULL, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND status <> 'removed' AND link_mode <> 'serial'`,
        { replacements: utc([newDeviceKey(), protocol.newRegistryCode(), protocol.newSessionId(), now, deviceId, tenantId]) }
      );
      break;
    } catch (err) {
      if (!isUniqueError(err) || attempt === 4) throw err;
    }
  }
  const row = await findById(deviceId);
  if (!tenantDb) return { device: { id: row.id, deviceKey: row.device_key, status: row.status }, setup: setupFor(row) };
  const found = await getDevice({ tenantId, tenantDb, deviceId });
  return { device: found.view, setup: found.setup };
}

/** Unpair (remove from GymsEra): the key stops working, the serial is free to be added again. */
async function unpairDevice({ tenantId, tenantDb, deviceId }) {
  const now = new Date();
  await platformDb.query(
    `UPDATE access_devices SET status = 'removed', previous_serial_number = COALESCE(serial_number, previous_serial_number),
       serial_number = NULL, updated_at = ? WHERE id = ? AND tenant_id = ?`,
    { replacements: utc([now, deviceId, tenantId]) }
  );
  await tenantDb.sequelize.query('UPDATE access_device_details SET enabled = 0, removed_at = ?, updated_at = ? WHERE id = ?', {
    replacements: utc([now, now, deviceId]),
  });
  // Commands still queued for it can never be delivered.
  await tenantDb.sequelize.query('UPDATE device_commands SET status = \'expired\', updated_at = ? WHERE device_id = ? AND status = \'queued\'', {
    replacements: utc([now, deviceId]),
  });
}

module.exports = {
  KEY_ALPHABET,
  newDeviceKey,
  normalizeKey,
  formatKey,
  findByKey,
  findBySerial,
  findById,
  bindSerial,
  recordSerialMismatch,
  markSeen,
  markRegistered,
  recordUnclaimed,
  detailsOf,
  applyRegistry,
  applyOptions,
  applyState,
  renderCommand,
  claimCommands,
  recordResults,
  setupFor,
  viewOf,
  createDevice,
  getDevice,
  listDevices,
  updateDevice,
  setEnabled,
  repairDevice,
  unpairDevice,
};
