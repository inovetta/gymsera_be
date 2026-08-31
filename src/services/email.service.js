const nodemailer = require('nodemailer');
const smtpConfig = require('../config/smtp.config');

let _transporter = null;

const getTransporter = () => {
  if (_transporter) return _transporter;

  _transporter = nodemailer.createTransport({
    host: smtpConfig.host,
    port: smtpConfig.port,
    secure: smtpConfig.secure,
    auth: smtpConfig.auth.user ? smtpConfig.auth : undefined,
    tls: smtpConfig.tls,
  });

  return _transporter;
};

/**
 * Send an email using Nodemailer.
 * In development, if SMTP credentials are not set, logs to console instead.
 */
const sendMail = async ({ to, subject, html, text }) => {
  const isDev = process.env.NODE_ENV !== 'production';
  const hasSmtp = !!smtpConfig.auth.user;

  if (isDev && !hasSmtp) {
    console.log('\n╔═══════════════════════════════════════════════════╗');
    console.log('║              [DEV] EMAIL (not sent)              ║');
    console.log('╠═══════════════════════════════════════════════════╣');
    console.log(`  To      : ${to}`);
    console.log(`  Subject : ${subject}`);
    console.log(`  Body    : ${text}`);
    console.log('╚═══════════════════════════════════════════════════╝\n');
    return;
  }

  await getTransporter().sendMail({ from: smtpConfig.from, to, subject, html, text });
};

// ── Email templates ───────────────────────────────────────────────────────────

const sendOtpEmail = async (to, fullName, code) => {
  await sendMail({
    to,
    subject: 'GymsEra — Email Verification Code',
    text: `Hi ${fullName},\n\nYour GymsEra verification code is: ${code}\n\nThis code expires in 10 minutes.\n\nIf you did not request this, please ignore this email.`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="color:#1a1a2e">Email Verification</h2>
        <p>Hi <strong>${fullName}</strong>,</p>
        <p>Your GymsEra verification code is:</p>
        <div style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#e94560;
                    background:#f5f5f5;border-radius:8px;padding:16px;text-align:center;
                    margin:24px 0">${code}</div>
        <p style="color:#666">This code expires in <strong>10 minutes</strong>.</p>
        <p style="color:#999;font-size:12px">If you did not create a GymsEra account, please ignore this email.</p>
      </div>`,
  });
};

const sendPasswordResetEmail = async (to, fullName, code) => {
  await sendMail({
    to,
    subject: 'GymsEra — Password Reset Code',
    text: `Hi ${fullName},\n\nYour password reset code is: ${code}\n\nThis code expires in 10 minutes.\n\nIf you did not request this, please ignore this email.`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="color:#1a1a2e">Password Reset</h2>
        <p>Hi <strong>${fullName}</strong>,</p>
        <p>Your GymsEra password reset code is:</p>
        <div style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#e94560;
                    background:#f5f5f5;border-radius:8px;padding:16px;text-align:center;
                    margin:24px 0">${code}</div>
        <p style="color:#666">This code expires in <strong>10 minutes</strong>.</p>
        <p style="color:#999;font-size:12px">If you did not request this, please ignore this email and ensure your account is safe.</p>
      </div>`,
  });
};

const sendTenantApprovedEmail = async (to, fullName, gymName) => {
  await sendMail({
    to,
    subject: 'GymsEra — Your Gym Has Been Approved!',
    text: `Hi ${fullName},\n\nCongratulations! "${gymName}" has been approved on GymsEra. You can now log in and set up your gym profile.`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="color:#1a1a2e">🎉 Gym Approved!</h2>
        <p>Hi <strong>${fullName}</strong>,</p>
        <p>Congratulations! <strong>${gymName}</strong> has been approved on GymsEra.</p>
        <p>You can now log in to your host dashboard and start setting up your gym profile, branches, and membership plans.</p>
      </div>`,
  });
};

const sendTenantRejectedEmail = async (to, fullName, gymName, reason) => {
  await sendMail({
    to,
    subject: 'GymsEra — Application Update',
    text: `Hi ${fullName},\n\nUnfortunately, "${gymName}" was not approved at this time.\n\nReason: ${reason}\n\nYou may reapply after addressing the above.`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="color:#1a1a2e">Application Update</h2>
        <p>Hi <strong>${fullName}</strong>,</p>
        <p>Unfortunately, <strong>${gymName}</strong> was not approved at this time.</p>
        <p><strong>Reason:</strong> ${reason}</p>
        <p>Please address the above and contact our support team to reapply.</p>
      </div>`,
  });
};

const sendSubscriptionActivatedEmail = async (to, fullName, gymName, planName, endDate) => {
  await sendMail({
    to,
    subject: `GymsEra — Subscription Activated at ${gymName}`,
    text: `Hi ${fullName},\n\nYour ${planName} membership at ${gymName} is now active until ${endDate}. Welcome to the gym!`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="color:#1a1a2e">Subscription Activated!</h2>
        <p>Hi <strong>${fullName}</strong>,</p>
        <p>Your <strong>${planName}</strong> membership at <strong>${gymName}</strong> is now active.</p>
        <p>Valid until: <strong>${endDate}</strong></p>
        <p>Show your QR code at the reception for check-in.</p>
      </div>`,
  });
};

const sendSubscriptionRenewedEmail = async (to, fullName, gymName, planName, endDate) => {
  await sendMail({
    to,
    subject: `GymsEra — Subscription Renewed at ${gymName}`,
    text: `Hi ${fullName},\n\nYour ${planName} membership at ${gymName} has been renewed and is valid until ${endDate}.`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="color:#1a1a2e">Subscription Renewed</h2>
        <p>Hi <strong>${fullName}</strong>,</p>
        <p>Your <strong>${planName}</strong> at <strong>${gymName}</strong> has been renewed.</p>
        <p>New expiry: <strong>${endDate}</strong></p>
      </div>`,
  });
};

const sendSubscriptionExpiringSoonEmail = async (to, fullName, gymName, endDate) => {
  await sendMail({
    to,
    subject: `GymsEra — Your membership at ${gymName} expires soon`,
    text: `Hi ${fullName},\n\nYour membership at ${gymName} expires on ${endDate}. Renew now to keep your access.`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="color:#e94560">Membership Expiring Soon</h2>
        <p>Hi <strong>${fullName}</strong>,</p>
        <p>Your membership at <strong>${gymName}</strong> expires on <strong>${endDate}</strong>.</p>
        <p>Renew now to keep uninterrupted gym access.</p>
      </div>`,
  });
};

const sendSubscriptionExpiredEmail = async (to, fullName, gymName) => {
  await sendMail({
    to,
    subject: `GymsEra — Membership Expired at ${gymName}`,
    text: `Hi ${fullName},\n\nYour membership at ${gymName} has expired. Visit the gym or app to renew.`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="color:#e94560">Membership Expired</h2>
        <p>Hi <strong>${fullName}</strong>,</p>
        <p>Your membership at <strong>${gymName}</strong> has expired.</p>
        <p>Renew your membership to regain access.</p>
      </div>`,
  });
};

const sendPaymentFailedEmail = async (to, fullName, gymName, amount, currency) => {
  await sendMail({
    to,
    subject: 'GymsEra — Payment Failed',
    text: `Hi ${fullName},\n\nYour payment of ${currency} ${amount} for ${gymName} could not be processed. Please update your payment method.`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="color:#e94560">Payment Failed</h2>
        <p>Hi <strong>${fullName}</strong>,</p>
        <p>Your payment of <strong>${currency} ${amount}</strong> for <strong>${gymName}</strong> could not be processed.</p>
        <p>Please update your payment method to avoid service interruption.</p>
      </div>`,
  });
};

// ── Platform invoice emails ────────────────────────────────────────────────────

const _invoiceBase = ({ invoiceNo, businessName, description, totalAmount, dueDate, paidAt, bodyHtml, headerColor, headerLabel }) => `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:'Helvetica Neue',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:40px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
        <!-- Header -->
        <tr><td style="background:${headerColor};padding:32px 40px">
          <table width="100%"><tr>
            <td><span style="color:#fff;font-size:24px;font-weight:700;letter-spacing:-0.5px">GymsEra</span><br>
              <span style="color:rgba(255,255,255,0.8);font-size:13px">Platform Management</span></td>
            <td align="right"><span style="background:rgba(255,255,255,0.2);color:#fff;font-size:12px;font-weight:600;padding:6px 14px;border-radius:20px">${headerLabel}</span></td>
          </tr></table>
        </td></tr>
        <!-- Invoice details -->
        <tr><td style="padding:32px 40px">
          ${bodyHtml}
          <!-- Invoice summary box -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:8px;padding:24px;margin:24px 0">
            <tr>
              <td style="font-size:13px;color:#64748b">Invoice No.</td>
              <td align="right" style="font-size:13px;font-weight:600;color:#1e293b">${invoiceNo}</td>
            </tr>
            <tr><td colspan="2" style="border-top:1px solid #e2e8f0;padding-top:12px;margin-top:12px"></td></tr>
            ${description ? `<tr><td style="font-size:13px;color:#64748b;padding-top:8px">Description</td><td align="right" style="font-size:13px;color:#1e293b;padding-top:8px">${description}</td></tr>` : ''}
            ${dueDate ? `<tr><td style="font-size:13px;color:#64748b;padding-top:8px">Due Date</td><td align="right" style="font-size:13px;color:#1e293b;padding-top:8px">${dueDate}</td></tr>` : ''}
            ${paidAt ? `<tr><td style="font-size:13px;color:#64748b;padding-top:8px">Paid On</td><td align="right" style="font-size:13px;color:#16a34a;font-weight:600;padding-top:8px">${new Date(paidAt).toLocaleDateString('en-US', { year:'numeric',month:'long',day:'numeric' })}</td></tr>` : ''}
            <tr><td colspan="2" style="border-top:1px solid #e2e8f0;padding-top:12px;margin-top:12px"></td></tr>
            <tr>
              <td style="font-size:15px;font-weight:700;color:#1e293b">Total Amount</td>
              <td align="right" style="font-size:18px;font-weight:700;color:${headerColor}">PKR ${Number(totalAmount).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
            </tr>
          </table>
        </td></tr>
        <!-- Footer -->
        <tr><td style="background:#f8fafc;padding:24px 40px;border-top:1px solid #e2e8f0">
          <p style="font-size:12px;color:#94a3b8;margin:0;text-align:center">
            This is an automated email from GymsEra Platform. Please do not reply directly to this email.<br>
            For support, contact us at <a href="mailto:support@gymsera.com" style="color:#6366f1">support@gymsera.com</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

const sendPlatformInvoiceReminderEmail = async (to, fullName, { invoiceNo, description, totalAmount, dueDate, businessName }) => {
  const body = `
    <p style="font-size:15px;color:#334155;margin:0 0 8px">Hi <strong>${fullName}</strong>,</p>
    <p style="font-size:15px;color:#334155;margin:0 0 20px">
      This is a friendly reminder that you have an outstanding invoice for your GymsEra platform subscription for
      <strong>${businessName}</strong>. Please arrange payment before the due date to avoid any service interruption.
    </p>
    <div style="background:#fef3c7;border-left:4px solid #f59e0b;border-radius:4px;padding:14px 18px;margin-bottom:24px">
      <p style="margin:0;font-size:13px;color:#92400e;font-weight:600">⚠️ Payment Due</p>
      <p style="margin:4px 0 0;font-size:13px;color:#78350f">Please settle this invoice by <strong>${dueDate || 'as soon as possible'}</strong> to avoid service disruption.</p>
    </div>`;

  await sendMail({
    to,
    subject: `GymsEra — Invoice ${invoiceNo} Payment Reminder`,
    text: `Hi ${fullName},\n\nThis is a reminder that invoice ${invoiceNo} for ${businessName} amounting to PKR ${totalAmount} is due on ${dueDate || 'soon'}. Please arrange payment to avoid service interruption.`,
    html: _invoiceBase({ invoiceNo, businessName, description, totalAmount, dueDate, paidAt: null, bodyHtml: body, headerColor: '#f59e0b', headerLabel: 'Payment Due' }),
  });
};

const sendPlatformInvoicePaidEmail = async (to, fullName, { invoiceNo, description, totalAmount, paidAt, businessName }) => {
  const body = `
    <p style="font-size:15px;color:#334155;margin:0 0 8px">Hi <strong>${fullName}</strong>,</p>
    <p style="font-size:15px;color:#334155;margin:0 0 20px">
      We have received your payment for your GymsEra platform subscription for <strong>${businessName}</strong>.
      Thank you for your prompt payment — your subscription remains fully active.
    </p>
    <div style="background:#dcfce7;border-left:4px solid #16a34a;border-radius:4px;padding:14px 18px;margin-bottom:24px">
      <p style="margin:0;font-size:13px;color:#14532d;font-weight:600">✓ Payment Confirmed</p>
      <p style="margin:4px 0 0;font-size:13px;color:#166534">Your invoice has been marked as paid. This receipt confirms full settlement.</p>
    </div>`;

  await sendMail({
    to,
    subject: `GymsEra — Invoice ${invoiceNo} Payment Confirmed`,
    text: `Hi ${fullName},\n\nWe have received your payment for invoice ${invoiceNo} for ${businessName}. Amount: PKR ${totalAmount}. Thank you!`,
    html: _invoiceBase({ invoiceNo, businessName, description, totalAmount, dueDate: null, paidAt, bodyHtml: body, headerColor: '#16a34a', headerLabel: 'Payment Confirmed' }),
  });
};

// ── Tenant subscription warning (2 days before platform subscription expires) ─
const sendTenantSubscriptionWarningEmail = async (to, fullName, { businessName, packageName, endDate }) => {
  const formattedEnd = endDate ? new Date(endDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
<tr><td style="background:#f59e0b;padding:36px 40px;text-align:center;">
<h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:700;">⚠️ Subscription Expiring Soon</h1>
<p style="color:#fef3c7;margin:8px 0 0;font-size:14px;">Action required to keep your account active</p>
</td></tr>
<tr><td style="padding:36px 40px;">
<p style="color:#374151;font-size:15px;margin:0 0 20px;">Hi <strong>${fullName}</strong>,</p>
<p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 24px;">Your <strong>${packageName}</strong> platform subscription for <strong>${businessName}</strong> is expiring on <strong>${formattedEnd}</strong> — that's in 2 days.</p>
<div style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:20px;margin:0 0 24px;">
<p style="color:#92400e;margin:0;font-size:14px;font-weight:600;">⚠️ What happens if you don't renew?</p>
<ul style="color:#92400e;font-size:14px;margin:8px 0 0;padding-left:20px;line-height:1.8;">
<li>Your account will be automatically suspended</li>
<li>Your gym listings will be hidden from public search</li>
<li>Your members will not be affected immediately</li>
</ul>
</div>
<p style="color:#6b7280;font-size:13px;">To renew, contact your platform administrator or log in to your account to arrange payment.</p>
<p style="color:#374151;font-size:15px;margin:24px 0 0;">Best regards,<br><strong>GymsEra Platform Team</strong></p>
</td></tr>
<tr><td style="background:#f9fafb;padding:20px 40px;text-align:center;border-top:1px solid #e5e7eb;">
<p style="color:#9ca3af;font-size:12px;margin:0;">Need help? Contact us at <a href="mailto:support@gymsera.com" style="color:#f59e0b;">support@gymsera.com</a></p>
</td></tr>
</table></td></tr></table></body></html>`;

  await sendMail({
    to,
    subject: `⚠️ Action Required: Your ${packageName} subscription expires in 2 days`,
    html,
    text: `Hi ${fullName}, your ${packageName} subscription for ${businessName} expires on ${formattedEnd}. Please renew to keep your account active.`,
  });
};

// ── Tenant account auto-suspended (subscription expired) ──────────────────────
const sendTenantSubscriptionSuspendedEmail = async (to, fullName, { businessName, packageName, endDate }) => {
  const formattedEnd = endDate ? new Date(endDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
<tr><td style="background:#dc2626;padding:36px 40px;text-align:center;">
<h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:700;">🚫 Account Suspended</h1>
<p style="color:#fee2e2;margin:8px 0 0;font-size:14px;">Your platform subscription has expired</p>
</td></tr>
<tr><td style="padding:36px 40px;">
<p style="color:#374151;font-size:15px;margin:0 0 20px;">Hi <strong>${fullName}</strong>,</p>
<p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 24px;">Your <strong>${packageName}</strong> subscription for <strong>${businessName}</strong> expired on <strong>${formattedEnd}</strong>. Your account has been automatically suspended.</p>
<div style="background:#fee2e2;border:1px solid #fca5a5;border-radius:8px;padding:20px;margin:0 0 24px;">
<p style="color:#991b1b;margin:0;font-size:14px;font-weight:600;">What this means:</p>
<ul style="color:#991b1b;font-size:14px;margin:8px 0 0;padding-left:20px;line-height:1.8;">
<li>Your gym listings are now hidden from public search</li>
<li>Platform access has been restricted</li>
<li>Your data is safe and preserved</li>
</ul>
</div>
<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:20px;margin:0 0 24px;">
<p style="color:#166534;margin:0;font-size:14px;font-weight:600;">✅ Restore your account</p>
<p style="color:#166534;font-size:14px;margin:8px 0 0;">Contact your platform administrator to renew your subscription. Once renewed, your account and all listings will be automatically reactivated.</p>
</div>
<p style="color:#374151;font-size:15px;margin:24px 0 0;">Best regards,<br><strong>GymsEra Platform Team</strong></p>
</td></tr>
<tr><td style="background:#f9fafb;padding:20px 40px;text-align:center;border-top:1px solid #e5e7eb;">
<p style="color:#9ca3af;font-size:12px;margin:0;">Need help? Contact us at <a href="mailto:support@gymsera.com" style="color:#dc2626;">support@gymsera.com</a></p>
</td></tr>
</table></td></tr></table></body></html>`;

  await sendMail({
    to,
    subject: `🚫 Account Suspended: ${businessName} subscription expired`,
    html,
    text: `Hi ${fullName}, your ${packageName} subscription for ${businessName} expired on ${formattedEnd}. Your account has been suspended. Please contact your administrator to renew.`,
  });
};

// ── Tenant account reactivated (new subscription assigned) ────────────────────
const sendTenantAccountReactivatedEmail = async (to, fullName, { businessName, packageName, endDate }) => {
  const formattedEnd = endDate ? new Date(endDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
<tr><td style="background:#16a34a;padding:36px 40px;text-align:center;">
<h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:700;">✅ Account Reactivated</h1>
<p style="color:#bbf7d0;margin:8px 0 0;font-size:14px;">Your subscription has been renewed successfully</p>
</td></tr>
<tr><td style="padding:36px 40px;">
<p style="color:#374151;font-size:15px;margin:0 0 20px;">Hi <strong>${fullName}</strong>,</p>
<p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 24px;">Great news! Your <strong>${packageName}</strong> subscription for <strong>${businessName}</strong> has been renewed and your account is now fully active until <strong>${formattedEnd}</strong>.</p>
<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:20px;margin:0 0 24px;">
<p style="color:#166534;margin:0;font-size:14px;font-weight:600;">✅ Everything is restored:</p>
<ul style="color:#166534;font-size:14px;margin:8px 0 0;padding-left:20px;line-height:1.8;">
<li>Your gym listings are live and visible to members</li>
<li>Full platform access restored</li>
<li>All your data and settings preserved</li>
</ul>
</div>
<p style="color:#374151;font-size:15px;margin:24px 0 0;">Best regards,<br><strong>GymsEra Platform Team</strong></p>
</td></tr>
<tr><td style="background:#f9fafb;padding:20px 40px;text-align:center;border-top:1px solid #e5e7eb;">
<p style="color:#9ca3af;font-size:12px;margin:0;">Need help? Contact us at <a href="mailto:support@gymsera.com" style="color:#16a34a;">support@gymsera.com</a></p>
</td></tr>
</table></td></tr></table></body></html>`;

  await sendMail({
    to,
    subject: `✅ Account Reactivated: ${businessName} is back online`,
    html,
    text: `Hi ${fullName}, your ${packageName} subscription for ${businessName} has been renewed. Your account is active until ${formattedEnd}.`,
  });
};

module.exports = {
  sendOtpEmail,
  sendPasswordResetEmail,
  sendTenantApprovedEmail,
  sendTenantRejectedEmail,
  sendSubscriptionActivatedEmail,
  sendSubscriptionRenewedEmail,
  sendSubscriptionExpiringSoonEmail,
  sendSubscriptionExpiredEmail,
  sendPaymentFailedEmail,
  sendPlatformInvoiceReminderEmail,
  sendPlatformInvoicePaidEmail,
  sendTenantSubscriptionWarningEmail,
  sendTenantSubscriptionSuspendedEmail,
  sendTenantAccountReactivatedEmail,
};
