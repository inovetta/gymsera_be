const cleanStr = (val) => (val || '').replace(/^["']|["']$/g, '').trim();

// Ensure Gmail SMTP is explicitly used when user is Gmail
const user = cleanStr(process.env.SMTP_USER) || 'techinovetta@gmail.com';
const pass = cleanStr(process.env.SMTP_PASS) || 'emzdovflooxhxoly';
let host = cleanStr(process.env.SMTP_HOST);

if (!host || host.includes('mailtrap') || host.includes('zoho') || user.includes('@gmail.com')) {
  host = 'smtp.gmail.com';
}

const port = (host === 'smtp.gmail.com') ? 465 : parseInt(process.env.SMTP_PORT || '587');
const secure = (host === 'smtp.gmail.com') ? true : (process.env.SMTP_SECURE === 'true' || port === 465);
const from = cleanStr(process.env.SMTP_FROM) || 'GymsEra <techinovetta@gmail.com>';

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
