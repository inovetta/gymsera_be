const cleanStr = (val) => (val || '').replace(/^["']|["']$/g, '').trim();

const host = cleanStr(process.env.SMTP_HOST) || 'smtp.gmail.com';
const user = cleanStr(process.env.SMTP_USER) || 'techinovetta@gmail.com';
const pass = cleanStr(process.env.SMTP_PASS) || 'emzdovflooxhxoly';
const from = cleanStr(process.env.SMTP_FROM) || 'GymsEra <techinovetta@gmail.com>';
const port = parseInt(process.env.SMTP_PORT || (host === 'smtp.gmail.com' ? '465' : '587'));
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
