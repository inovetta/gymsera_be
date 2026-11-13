/**
 * NEW-244: the plan status a host sees for a member, one rule for every screen.
 *
 * The mobile app's branch member list (members_list_screen.dart `_buildStatusBadge`) is the product
 * reference (AGENTS rule 9). It shows the subscription, not the platform account:
 *   ACTIVE, end date before today      → EXPIRED   (the daily expiry job may not have run yet)
 *   ACTIVE, end date within 3 days     → EXPIRING  (same window as the expiry-warning job)
 *   ACTIVE                             → ACTIVE
 *   FROZEN                             → FROZEN    ("On hold")
 *   PENDING                            → PENDING
 *   EXPIRED, CANCELLED, anything else  → EXPIRED
 * "Today" is the branch's calendar day (GLB-01), not the server's.
 */
const { SubscriptionStatus } = require('../constants/subscription-status');

/** Days before the end date that count as "expiring soon"; also the expiry-warning job's window. */
const EXPIRING_SOON_DAYS = 3;

const MembershipDisplayStatus = Object.freeze({
  ACTIVE: 'ACTIVE',
  EXPIRING: 'EXPIRING',
  EXPIRED: 'EXPIRED',
  FROZEN: 'FROZEN',
  PENDING: 'PENDING',
});

/** Best first: which subscription speaks for a member who has several. */
const DISPLAY_RANK = ['ACTIVE', 'EXPIRING', 'FROZEN', 'PENDING', 'EXPIRED'];

const DAY_MS = 86400000;
const toDay = (value) => (value ? String(value instanceof Date ? value.toISOString() : value).slice(0, 10) : null);
const daysBetween = (fromDay, toDayStr) =>
  Math.round((Date.parse(`${toDayStr}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS);

/**
 * @param {{ status: string, endDate?: string|Date|null }} sub
 * @param {string} today  'YYYY-MM-DD' in the branch's time zone
 * @returns {'ACTIVE'|'EXPIRING'|'EXPIRED'|'FROZEN'|'PENDING'}
 */
const membershipDisplayStatus = (sub, today) => {
  const status = String(sub?.status || '').toUpperCase();
  if (status === SubscriptionStatus.ACTIVE) {
    const end = toDay(sub.endDate);
    if (end && today) {
      if (end < today) return MembershipDisplayStatus.EXPIRED;
      if (daysBetween(today, end) <= EXPIRING_SOON_DAYS) return MembershipDisplayStatus.EXPIRING;
    }
    return MembershipDisplayStatus.ACTIVE;
  }
  if (status === SubscriptionStatus.FROZEN) return MembershipDisplayStatus.FROZEN;
  if (status === SubscriptionStatus.PENDING) return MembershipDisplayStatus.PENDING;
  return MembershipDisplayStatus.EXPIRED;
};

/** True when `a` should be shown instead of `b` (better status, then the later end date). */
const isBetterMembership = (a, b) => {
  const ra = DISPLAY_RANK.indexOf(a.displayStatus);
  const rb = DISPLAY_RANK.indexOf(b.displayStatus);
  if (ra !== rb) return ra < rb;
  return (toDay(a.endDate) || '') > (toDay(b.endDate) || '');
};

module.exports = {
  EXPIRING_SOON_DAYS,
  MembershipDisplayStatus,
  membershipDisplayStatus,
  isBetterMembership,
};
