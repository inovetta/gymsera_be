/**
 * Tells the host when what their plan covers changes (P7c item 7, NEW-176, owner decision
 * R-82; spec §7.6 "notify host if entitlement changed"): one in-app notification (push) and
 * one email to the tenant owner when an entitling plan goes on hold, is refunded, applies a
 * downgrade, or expires.
 *
 * Called once per transition, after the plan write committed: by
 * subscription-migration.service.js#applyVerifiedSubscription (every provider sync and
 * webhook) and by the daily expiry of a MANUAL plan (subscription-expiry.cron.js). A replay
 * of the same provider state finds the row already in that state, so nothing is sent twice.
 * Never throws: a failed notice must not fail a billing write.
 */
const { Tenant, User } = require('../models/platform');
const { ENTITLING_STATUSES } = require('./subscription-quota.service');
const { overquotaGraceDays } = require('../config/billing.config');

const STORE_NAME = { IOS: 'The App Store', ANDROID: 'Google Play', STRIPE: 'Your card provider' };

/**
 * The notice a plan write calls for, or null.
 * @returns {'on_hold'|'refunded'|'expired'|'downgraded'|null}
 */
const noticeKind = ({ previousStatus, previousBranchCount, status, branchCount }) => {
  if (!ENTITLING_STATUSES.includes(previousStatus)) return null;
  if (status === 'ON_HOLD') return 'on_hold';
  if (status === 'REVOKED') return 'refunded';
  if (status === 'EXPIRED') return 'expired';
  if (ENTITLING_STATUSES.includes(status) && previousBranchCount != null && branchCount != null && branchCount < previousBranchCount) {
    return 'downgraded';
  }
  return null;
};

const _push = (kind, { storeName, branchCount }) =>
  ({
    on_hold: {
      title: 'Plan on hold',
      message: `${storeName || 'Your store'} couldn't take your renewal payment. Update it to keep your branches open.`,
    },
    refunded: { title: 'Plan refunded', message: 'Your plan no longer covers your branches. Choose a plan to keep them open.' },
    expired: { title: 'Plan ended', message: 'Your plan has ended. Choose a plan to keep your branches open.' },
    downgraded: {
      title: 'Plan changed',
      message: `Your plan now covers ${branchCount} ${branchCount === 1 ? 'branch' : 'branches'}.`,
    },
  })[kind];

/**
 * @param {string} tenantId
 * @param {'on_hold'|'refunded'|'expired'|'downgraded'} kind
 * @param {object} subscription - the TenantSubscription just written.
 */
const notifyHostOfPlanChange = async (tenantId, kind, subscription) => {
  try {
    const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'ownerUserId', 'businessName', 'gymName'] });
    const owner = tenant?.ownerUserId ? await User.findByPk(tenant.ownerUserId, { attributes: ['id', 'email', 'fullName'] }) : null;
    if (!owner) return;
    const storeName = STORE_NAME[subscription.platform] || null;
    const branchCount = subscription.branchCount;
    const endedAt = subscription.entitlementEndedAt ? new Date(subscription.entitlementEndedAt) : null;
    const branchesLockAt =
      kind !== 'downgraded' && endedAt ? new Date(endedAt.getTime() + overquotaGraceDays() * 24 * 60 * 60 * 1000) : null;
    const businessName = tenant.businessName || tenant.gymName || 'your business';

    const notificationsService = require('./notifications.service');
    await notificationsService
      .createNotification({
        userId: owner.id,
        role: 'host',
        type: 'subscription',
        ..._push(kind, { storeName, branchCount }),
        priority: kind === 'downgraded' ? 'normal' : 'high',
        deepLink: '/host/subscriptions',
        metadataJson: { event: `host_plan_${kind}`, subscriptionId: subscription.id, status: subscription.status },
      })
      .catch((err) => console.warn(`[HostPlanNotice] ${kind} notification failed for tenant ${tenantId}:`, err.message));

    const emailService = require('./email.service');
    const send =
      kind === 'expired'
        ? emailService.sendTenantSubscriptionExpiredEmail(owner.email, owner.fullName, {
            businessName,
            endDate: subscription.endDate,
            branchesLockAt,
          })
        : emailService.sendTenantPlanChangedEmail(owner.email, owner.fullName, {
            kind,
            businessName,
            storeName,
            branchCount,
            branchesLockAt,
          });
    await Promise.resolve(send).catch((err) => console.warn(`[HostPlanNotice] ${kind} email failed for tenant ${tenantId}:`, err.message));
  } catch (err) {
    console.warn(`[HostPlanNotice] ${kind} notice failed for tenant ${tenantId}:`, err.message);
  }
};

module.exports = { noticeKind, notifyHostOfPlanChange };
