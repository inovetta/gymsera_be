#!/usr/bin/env node
/**
 * Token enforce: moving devices from `log` to `enforce` (spec docs/ZKTECO_PUSH_DEVICE_SYNC.md §2, §6.1,
 * §14 point 4; Phase 4). DEVICE_TOKEN_MODE only sets the mode of devices added after the change. Existing
 * devices are moved with this script, and only when they have proved the formula: the device sent a
 * token that matched (`last_token_state = 'match'`) and was seen within DEVICE_TOKEN_SEEN_HOURS (24).
 * A device that sends no token, or a wrong one, would be locked out by enforce: it is listed and skipped.
 *
 *   node src/scripts/device-token-mode.js --to enforce                 dry run: what would change
 *   node src/scripts/device-token-mode.js --to enforce --apply         switch the devices that qualify
 *   node src/scripts/device-token-mode.js --to log --device <id> --apply   the way back (one device)
 *   [--tenant <tenant id>] [--device <device id>]  (repeatable)
 *
 * Enforce keeps cdata GET, registry and push free of the token (the device learns its SessionID from the
 * push answer, Phase 1 correction 2); every other call without the right token gets 401.
 * Runbook: docs/runbooks/devices.md "Token enforce".
 */
const { QueryTypes } = require('sequelize');
const { sequelize: platformDb } = require('../database/platform');
const { getDeviceConfig } = require('../config/devices.config');
const { utc } = require('../services/devices/sql-time');

const REASON_OF_STATE = { absent: 'token_absent', mismatch: 'token_mismatch' };

/**
 * → { apply, to, switch: [{ id, tenantId }], skip: [{ id, reason }] }
 * deviceIds / tenantId narrow the devices looked at (default: every device that is not removed).
 */
async function planTokenMode({ to, apply = false, tenantId = null, deviceIds = null, now = new Date() } = {}) {
  if (!['enforce', 'log'].includes(to)) throw new Error('--to must be enforce or log');
  const where = ['status <> \'removed\''];
  const rep = [];
  if (tenantId) { where.push('tenant_id = ?'); rep.push(tenantId); }
  if (deviceIds && deviceIds.length) { where.push('id IN (?)'); rep.push(deviceIds); }
  const rows = await platformDb.query(
    `SELECT id, tenant_id, status, token_mode, last_token_state, last_seen_at FROM access_devices WHERE ${where.join(' AND ')} ORDER BY created_at`,
    { replacements: utc(rep), type: QueryTypes.SELECT }
  );
  const seenSince = now.getTime() - getDeviceConfig().tokenSeenHours * 3600000;
  const out = { apply, to, switch: [], skip: [] };
  for (const r of rows) {
    if (r.token_mode === to) { out.skip.push({ id: r.id, reason: 'already' }); continue; }
    if (to === 'enforce') {
      if (r.status !== 'active') { out.skip.push({ id: r.id, reason: 'not_active' }); continue; }
      if (r.last_token_state !== 'match') { out.skip.push({ id: r.id, reason: REASON_OF_STATE[r.last_token_state] || 'token_unknown' }); continue; }
      if (!r.last_seen_at || new Date(r.last_seen_at).getTime() < seenSince) { out.skip.push({ id: r.id, reason: 'not_seen_recently' }); continue; }
    }
    out.switch.push({ id: r.id, tenantId: r.tenant_id });
  }
  if (apply && out.switch.length) {
    // Only rows still in the state that qualified them (a device that sent a bad token since is left alone).
    const guard = to === 'enforce' ? ' AND last_token_state = \'match\' AND status = \'active\'' : '';
    await platformDb.query(`UPDATE access_devices SET token_mode = ?, updated_at = ? WHERE id IN (?)${guard}`, {
      replacements: utc([to, now, out.switch.map((s) => s.id)]),
    });
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const valueOf = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  const many = (flag) => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []));
  const to = valueOf('--to');
  const apply = args.includes('--apply');
  const plan = await planTokenMode({ to, apply, tenantId: valueOf('--tenant'), deviceIds: many('--device') });
  console.log(`[device-token-mode] ${apply ? 'APPLY' : 'dry run'}: to ${to}; ${plan.switch.length} device(s) ${apply ? 'switched' : 'would switch'}, ${plan.skip.length} skipped`);
  for (const s of plan.switch) console.log(`  switch  ${s.id} (tenant ${s.tenantId})`);
  for (const s of plan.skip) console.log(`  skip    ${s.id}: ${s.reason}`);
  if (!apply && plan.switch.length) console.log('Run again with --apply to switch them.');
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(`[device-token-mode] failed: ${err.message}`);
      process.exitCode = 1;
    })
    .finally(() => platformDb.close().catch(() => {}));
}

module.exports = { planTokenMode };
