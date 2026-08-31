const cleanStr = (val) => (val || '').replace(/^["']|["']$/g, '').trim();

let host = cleanStr(process.env.SMTP_HOST);
let user = cleanStr(process.env.SMTP_USER);
let pass = cleanStr(process.env.SMTP_PASS);
let from = cleanStr(process.env.SMTP_FROM);

// If host/user is empty or contains blocked zoho/mailtrap, enforce official GymsEra domain SMTP
if (!host || host.includes('zoho') || host.includes('mailtrap') || !user || user.includes('zoho') || user === 'info@inovetta.com') {
  host = 'mail.gymsera.com';
  user = 'noreply@gymsera.com';
  pass = '!@#bU+Ue9320';
  from = 'GymsEra <noreply@gymsera.com>';
}

const port = (host === 'mail.gymsera.com') ? 587 : parseInt(process.env.SMTP_PORT || '587');
const secure = (host === 'mail.gymsera.com') ? false : (process.env.SMTP_SECURE === 'true' || port === 465);

module.exports = {
  host,
  port,
  secure,
  auth: {
    user,
    pass,
  },
  from: from || 'GymsEra <noreply@gymsera.com>',
  tls: {
    rejectUnauthorized: false,
  },
};
