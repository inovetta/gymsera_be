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
};
