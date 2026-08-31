const port = parseInt(process.env.SMTP_PORT || '587');
const secure = process.env.SMTP_SECURE === 'true' || port === 465;

const cleanStr = (val) => (val || '').replace(/^["']|["']$/g, '').trim();

module.exports = {
  host: cleanStr(process.env.SMTP_HOST) || 'smtp.zoho.com',
  port,
  secure,
  auth: {
    user: cleanStr(process.env.SMTP_USER),
    pass: cleanStr(process.env.SMTP_PASS),
  },
  from: cleanStr(process.env.SMTP_FROM) || 'GymsEra <info@inovetta.com>',
  tls: {
    rejectUnauthorized: false,
  },
};
