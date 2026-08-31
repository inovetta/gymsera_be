const cleanStr = (val) => (val || '').replace(/^["']|["']$/g, '').trim();

const host = cleanStr(process.env.SMTP_HOST) || 'mail.gymsera.com';
const user = cleanStr(process.env.SMTP_USER) || 'noreply@gymsera.com';
const pass = cleanStr(process.env.SMTP_PASS) || '!@#bU+Ue9320';
const from = cleanStr(process.env.SMTP_FROM) || 'GymsEra <noreply@gymsera.com>';
const port = parseInt(process.env.SMTP_PORT || '587');
const secure = process.env.SMTP_SECURE === 'true' || port === 465;

module.exports = {
  host,
  port,
  secure,
  auth: {
    user,
    pass,
  },
  from,
  tls: {
    rejectUnauthorized: false,
  },
};
