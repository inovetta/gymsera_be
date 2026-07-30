/**
 * iclock.service.js
 *
 * Handles the ZKTeco ADMS (Attendance Data Management System) protocol.
 *
 * ZKTeco ADMS flow:
 *   1. Device boots → sends GET /iclock/getrequest?SN=<serial>
 *      Server responds: "OK"  (device knows it's registered)
 *
 *   2. Every 30 s → device sends GET /iclock/getrequest?SN=<serial>&options=all
 *      Server responds with any pending commands (or just "OK" if none)
 *
 *   3. On each attendance scan → device sends:
 *      POST /iclock/cdata?SN=<serial>&table=ATTLOG&Stamp=<last_stamp>
 *      Body (plain text, one record per line, tab-separated):
 *        {pin}\t{datetime}\t{verify}\t{type}\t{workcode}\n
 *      Server responds: "OK: {count}\n"
 *
 *   4. GET /iclock/cdata?SN=<serial>&table=ATTLOG&Stamp=9999999999
 *      Initial sync request — server returns "OK: 0\n"
 */

const { Device, DeviceMember, User } = require('../models/platform');
const TenantDbManager = require('../database/TenantDbManager');
const { safeRedisGet, safeRedisSetex } = require('../config/redis.config');
const { SubscriptionStatus } = require('../constants/subscription-status');

// ── Resolve tenant DB from device ─────────────────────────────────────────────
const _getTenantDb = async (device) => {
  const cacheKey = `tenant:${device.tenantId}:connStr`;
  let encryptedConnStr = await safeRedisGet(cacheKey);

  if (!encryptedConnStr) {
    const { Tenant } = require('../models/platform');
    const tenant = await Tenant.findOne({
      where: { id: device.tenantId, status: 'ACTIVE' },
      attributes: ['id', 'connectionStringEncrypted'],
    });
    if (!tenant || !tenant.connectionStringEncrypted) return null;
    encryptedConnStr = tenant.connectionStringEncrypted;
    await safeRedisSetex(cacheKey, 3600, encryptedConnStr);
  }

  return TenantDbManager.getConnection(device.tenantId, encryptedConnStr);
};

// ── Parse ATTLOG plain-text body ──────────────────────────────────────────────
/**
 * ZKTeco ATTLOG line format (tab-separated):
 *   pin \t datetime \t verify \t type \t workcode \n
 *
 * verify: 1=fingerprint, 4=password, 15=face, 200=employee card
 * type:   0=check-in, 1=check-out, 4=OT-in, 5=OT-out (we treat all as CHECK_IN for now)
 */
const _parseAttlog = (body) => {
  if (!body || !body.trim()) return [];
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      if (parts.length < 2) return null;
      const [pin, datetimeStr, verifyRaw, typeRaw] = parts;
      const verify = parseInt(verifyRaw ?? '1', 10);
      const attendType = parseInt(typeRaw ?? '0', 10);
      const parsedDate = new Date(datetimeStr.replace(' ', 'T'));
      if (isNaN(parsedDate.getTime())) return null;
      return { pin: pin.trim(), datetime: parsedDate, verify, attendType };
    })
    .filter(Boolean);
};

// ── Heartbeat ─────────────────────────────────────────────────────────────────
/**
 * Called on GET /iclock/getrequest
 * Looks up device by serial, marks lastSeenAt, returns "OK".
 * Returns null if the device serial is not registered (caller should return 403).
 */
const handleHeartbeat = async (serialNumber) => {
  const device = await Device.findOne({ where: { serialNumber, status: 'ACTIVE' } });
  if (!device) return null;
  await device.update({ lastSeenAt: new Date() });
  return device;
};

// ── Attendance push ───────────────────────────────────────────────────────────
/**
 * Called on POST /iclock/cdata?table=ATTLOG
 * Parses the ATTLOG body, maps PINs → userIds via DeviceMember,
 * finds active subscriptions, and writes AttendanceLogs to the tenant DB.
 *
 * Returns { accepted, skipped } counts.
 */
const handleAttlog = async (serialNumber, rawBody) => {
  const device = await Device.findOne({ where: { serialNumber, status: 'ACTIVE' } });
  if (!device) return null;

  // Update heartbeat
  await device.update({ lastSeenAt: new Date() });

  const records = _parseAttlog(rawBody);
  if (!records.length) return { accepted: 0, skipped: 0 };

  // Load PIN → userId map for this device
  const deviceMembers = await DeviceMember.findAll({
    where: { deviceId: device.id },
    include: [{ model: User, as: 'user', attributes: ['id'] }],
  });
  const pinMap = {}; // pin (string) → userId
  for (const dm of deviceMembers) {
    pinMap[String(dm.zkPin)] = dm.userId;
  }

  // Get tenant DB connection
  const tenantDb = await _getTenantDb(device);
  if (!tenantDb) return { accepted: 0, skipped: records.length };

  const { AttendanceLog, MemberSubscription } = tenantDb.models;

  let accepted = 0;
  let skipped = 0;

  for (const rec of records) {
    const userId = pinMap[rec.pin];
    if (!userId) {
      skipped++;
      continue;
    }

    // Find the member's active subscription for this branch
    const subscription = await MemberSubscription.findOne({
      where: { userId, branchId: device.branchId, status: SubscriptionStatus.ACTIVE },
      order: [['subscribedAt', 'DESC']],
    });

    // Determine attendance type (ZKTeco type 0 = check-in, 1 = check-out)
    const attendanceType = rec.attendType === 1 ? 'CHECK_OUT' : 'CHECK_IN';
    const timeField = attendanceType === 'CHECK_IN' ? 'checkInAt' : 'checkOutAt';

    try {
      await AttendanceLog.create({
        branchId: device.branchId,
        userId,
        memberSubscriptionId: subscription ? subscription.id : null,
        attendanceType,
        checkInAt: rec.datetime,
        [timeField]: rec.datetime,
        entryMethod: 'DEVICE',
        deviceId: device.serialNumber,
      });
      accepted++;
    } catch (err) {
      console.error(`[iClock] Failed to write AttendanceLog for pin=${rec.pin}:`, err.message);
      skipped++;
    }
  }

  // Update the last sync stamp to now (Unix seconds) so device can use it next time
  await device.update({ lastSyncStamp: Math.floor(Date.now() / 1000) });

  return { accepted, skipped };
};

module.exports = { handleHeartbeat, handleAttlog };
