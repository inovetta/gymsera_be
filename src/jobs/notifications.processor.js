const emailService = require('../services/email.service');
const pushService  = require('../services/push.service');

/**
 * Notification job processor for the Bull `notifications` queue.
 *
 * Job payload shape:
 * {
 *   type: 'SUBSCRIPTION_ACTIVATED' | 'SUBSCRIPTION_RENEWED' | 'SUBSCRIPTION_EXPIRING_SOON'
 *       | 'SUBSCRIPTION_EXPIRED'   | 'PAYMENT_FAILED'
 *       | 'TENANT_APPROVED'        | 'TENANT_REJECTED',
 *   email: string,             // recipient email
 *   fullName: string,          // recipient display name
 *   fcmToken?: string,         // optional Firebase device token
 *   // event-specific fields:
 *   gymName?: string,
 *   planName?: string,
 *   endDate?: string,
 *   amount?: string,
 *   currency?: string,
 *   reason?: string,
 * }
 */
const processNotification = async (job) => {
  const d = job.data;

  console.log(`[Notifications] Processing job ${job.id}: type=${d.type} to=${d.email}`);

  switch (d.type) {

    case 'SUBSCRIPTION_ACTIVATED':
      await emailService.sendSubscriptionActivatedEmail(d.email, d.fullName, d.gymName, d.planName, d.endDate);
      if (d.fcmToken) {
        await pushService.send(d.fcmToken, 'Subscription Active!',
          `Your ${d.planName} membership at ${d.gymName} is now active.`);
      }
      break;

    case 'SUBSCRIPTION_RENEWED':
      await emailService.sendSubscriptionRenewedEmail(d.email, d.fullName, d.gymName, d.planName, d.endDate);
      if (d.fcmToken) {
        await pushService.send(d.fcmToken, 'Subscription Renewed',
          `Your ${d.planName} at ${d.gymName} has been renewed until ${d.endDate}.`);
      }
      break;

    case 'SUBSCRIPTION_EXPIRING_SOON':
      await emailService.sendSubscriptionExpiringSoonEmail(d.email, d.fullName, d.gymName, d.endDate);
      if (d.fcmToken) {
        await pushService.send(d.fcmToken, 'Membership Expiring Soon',
          `Your membership at ${d.gymName} expires on ${d.endDate}. Renew now!`);
      }
      break;

    case 'SUBSCRIPTION_EXPIRED':
      await emailService.sendSubscriptionExpiredEmail(d.email, d.fullName, d.gymName);
      if (d.fcmToken) {
        await pushService.send(d.fcmToken, 'Membership Expired',
          `Your membership at ${d.gymName} has expired.`);
      }
      break;

    case 'PAYMENT_FAILED':
      await emailService.sendPaymentFailedEmail(d.email, d.fullName, d.gymName, d.amount, d.currency);
      if (d.fcmToken) {
        await pushService.send(d.fcmToken, 'Payment Failed',
          `Your payment of ${d.currency} ${d.amount} for ${d.gymName} could not be processed.`);
      }
      break;

    case 'TENANT_APPROVED':
      await emailService.sendTenantApprovedEmail(d.email, d.fullName, d.gymName);
      break;

    case 'TENANT_REJECTED':
      await emailService.sendTenantRejectedEmail(d.email, d.fullName, d.gymName, d.reason);
      break;

    default:
      console.warn(`[Notifications] Unknown notification type: ${d.type}`);
  }
};

module.exports = { processNotification };
