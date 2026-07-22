const emailService = require('../services/email.service');
const pushService  = require('../services/push.service');
const notificationsService = require('../services/notifications.service');

/**
 * Notification job processor for the Bull `notifications` queue.
 *
 * Job payload shape:
 * {
 *   type: 'SUBSCRIPTION_ACTIVATED' | 'SUBSCRIPTION_RENEWED' | 'SUBSCRIPTION_EXPIRING_SOON'
 *       | 'SUBSCRIPTION_EXPIRED'   | 'PAYMENT_FAILED'
 *       | 'TENANT_APPROVED'        | 'TENANT_REJECTED',
 *   userId?: string,           // optional user ID for database notifications
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

  // Create in-app notification if userId is present
  if (d.userId) {
    try {
      let title = 'Notification';
      let body = '';
      let type = 'info';

      switch (d.type) {
        case 'SUBSCRIPTION_ACTIVATED':
          title = 'Subscription Confirmed';
          body = `Your ${d.planName || 'membership'} at ${d.gymName || 'your gym'} is now active.`;
          type = 'subscription';
          break;
        case 'SUBSCRIPTION_RENEWED':
          title = 'Subscription Renewed';
          body = `Your ${d.planName || 'membership'} at ${d.gymName || 'your gym'} has been renewed until ${d.endDate || ''}.`;
          type = 'subscription';
          break;
        case 'SUBSCRIPTION_EXPIRING_SOON':
          title = 'Plan Expiring Soon';
          body = `Your membership at ${d.gymName || 'your gym'} expires on ${d.endDate || ''}. Renew now!`;
          type = 'expiry';
          break;
        case 'SUBSCRIPTION_EXPIRED':
          title = 'Membership Expired';
          body = `Your membership at ${d.gymName || 'your gym'} has expired.`;
          type = 'expiry';
          break;
        case 'PAYMENT_FAILED':
          title = 'Payment Failed';
          body = `Your payment of ${d.currency || 'PKR'} ${d.amount || '0'} for ${d.gymName || 'your gym'} could not be processed.`;
          type = 'warning';
          break;
        case 'TENANT_APPROVED':
          title = 'Host Application Approved';
          body = `Congratulations! You are now verified as a Host for ${d.gymName || 'your gym'}.`;
          type = 'host_update';
          break;
        case 'TENANT_REJECTED':
          title = 'Host Application Rejected';
          body = `Your application for ${d.gymName || 'your gym'} was rejected. Reason: ${d.reason || 'None'}`;
          type = 'warning';
          break;
        default:
          body = `New update on your account: ${d.type}`;
          type = 'info';
      }

      await notificationsService.createNotification({
        userId: d.userId,
        type,
        title,
        body,
        metadata: d,
      });
      console.log(`[Notifications] Created in-app notification for user ${d.userId}`);
    } catch (err) {
      console.warn('[Notifications] Failed to save in-app notification:', err.message);
    }
  }

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
