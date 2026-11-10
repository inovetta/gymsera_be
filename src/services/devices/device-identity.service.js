/**
 * Member identity on devices (spec docs/ZKTECO_PUSH_DEVICE_SYNC.md §6.3).
 *
 * A member gets a numeric PIN from the tenant's sequence (device_pin_sequence, from 1001), the
 * first time any device of the tenant should hold them. Digits only (some firmware has no string
 * PINs). The PIN never changes and is never handed to anyone else: the sequence only moves up,
 * and a deleted member's row is kept, retired, for DEVICE_PIN_RETIRE_DAYS (180) so an old
 * template on an offline device can never match a new person. The same person coming back inside
 * that hold (an account deletion undone) gets the same PIN again; after it the row is purged.
 *
 * `db` is a tenant connection: { sequelize, models }.
 */
const { utc } = require('./sql-time');
const { QueryTypes } = require('sequelize');

const select = (db, sql, replacements, transaction) =>
  db.sequelize.query(sql, { replacements: utc(replacements), type: QueryTypes.SELECT, transaction });

async function identityOf(db, memberId) {
  const [row] = await select(db, 'SELECT member_id, pin, card_no, retired_at FROM member_device_identity WHERE member_id = ?', [memberId]);
  return row || null;
}

async function identitiesOf(db, memberIds) {
  if (!memberIds.length) return new Map();
  const rows = await select(db, 'SELECT member_id, pin, card_no, retired_at FROM member_device_identity WHERE member_id IN (?)', [memberIds]);
  return new Map(rows.map((r) => [r.member_id, r]));
}

/** The member's PIN, allocated on first use; a retired one is taken back (same person, same PIN). */
async function ensurePin(db, memberId) {
  const existing = await identityOf(db, memberId);
  if (existing) {
    if (existing.retired_at) {
      await db.sequelize.query('UPDATE member_device_identity SET retired_at = NULL, updated_at = ? WHERE member_id = ?', {
        replacements: utc([new Date(), memberId]),
      });
    }
    return Number(existing.pin);
  }
  // One locked read-modify-write on the single sequence row: two processes never get the same PIN.
  const pin = await db.sequelize.transaction(async (transaction) => {
    const [seq] = await select(db, 'SELECT next_pin FROM device_pin_sequence WHERE id = 1 FOR UPDATE', [], transaction);
    let next = seq ? Number(seq.next_pin) : 1001;
    if (!seq) await db.sequelize.query('INSERT INTO device_pin_sequence (id, next_pin) VALUES (1, 1001)', { transaction });
    // A PIN already in use (a hand-edited row) is skipped, never shared.
    for (;;) {
      const [taken] = await select(db, 'SELECT 1 AS x FROM member_device_identity WHERE pin = ?', [next], transaction);
      if (!taken) break;
      next += 1;
    }
    await db.sequelize.query('UPDATE device_pin_sequence SET next_pin = ? WHERE id = 1', { replacements: utc([next + 1]), transaction });
    return next;
  });
  const now = new Date();
  try {
    await db.sequelize.query(
      'INSERT INTO member_device_identity (member_id, pin, card_no, retired_at, created_at, updated_at) VALUES (?, ?, NULL, NULL, ?, ?)',
      { replacements: utc([memberId, pin, now, now]) }
    );
    return pin;
  } catch (err) {
    // Another process gave this member a PIN first: use that one (this one stays unused).
    const again = await identityOf(db, memberId);
    if (again) return Number(again.pin);
    throw err;
  }
}

/** → { memberId, retired } for a PIN, or null when no member of this tenant ever had it. */
async function ownerOfPin(db, pin) {
  if (!/^\d{1,9}$/.test(String(pin ?? ''))) return null;
  const [row] = await select(db, 'SELECT member_id, retired_at FROM member_device_identity WHERE pin = ?', [Number(pin)]);
  return row ? { memberId: row.member_id, retired: Boolean(row.retired_at) } : null;
}

async function retire(db, memberId, now = new Date()) {
  await db.sequelize.query('UPDATE member_device_identity SET retired_at = COALESCE(retired_at, ?), updated_at = ? WHERE member_id = ?', {
    replacements: utc([now, now, memberId]),
  });
}

/** Card number reported by a device, kept only when GymsEra has none (§7.5). → true when it changed. */
async function adoptCardFromDevice(db, memberId, cardNo) {
  const card = String(cardNo || '').replace(/\s+/g, '').slice(0, 32);
  if (!card || card === '0') return false;
  const [, meta] = await db.sequelize.query(
    'UPDATE member_device_identity SET card_no = ?, updated_at = ? WHERE member_id = ? AND (card_no IS NULL OR card_no = \'\')',
    { replacements: utc([card, new Date(), memberId]) }
  );
  return (typeof meta === 'number' ? meta : meta?.affectedRows) === 1;
}

/** Retired rows past the hold are removed (their PIN still never returns: the sequence only moves up). */
async function purgeRetired(db, days, now = new Date()) {
  const [, meta] = await db.sequelize.query('DELETE FROM member_device_identity WHERE retired_at IS NOT NULL AND retired_at < ?', {
    replacements: utc([new Date(now.getTime() - days * 86400000)]),
  });
  return typeof meta === 'number' ? meta : meta?.affectedRows || 0;
}

module.exports = { identityOf, identitiesOf, ensurePin, ownerOfPin, retire, adoptCardFromDevice, purgeRetired };
