const port = parseInt(process.env.SMTP_PORT || '587');
const secure = process.env.SMTP_SECURE === 'true'; // true = port 465 SSL

module.exports = {
  host: process.env.SMTP_HOST || 'smtp.mailtrap.io',
  port,
  secure,
  // On port 587 (STARTTLS), require TLS upgrade; skip cert validation for self-signed certs
  ...(!secure && { requireTLS: true, tls: { rejectUnauthorized: false } }),
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },
  from: process.env.SMTP_FROM || 'GymsEra <noreply@gymsera.com>',
};
