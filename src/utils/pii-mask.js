/**
 * Masking for personal contact details shown to platform admins (SEC-17).
 * Enough left to recognise a record ("a***@gmail.com", "*******67"), not enough to contact the person.
 */

/** 'ahmed.khan@gmail.com' -> 'a***@gmail.com'. Not an e-mail address: '***'. */
const maskEmail = (email) => {
  if (typeof email !== 'string' || !email.includes('@')) return email ? '***' : null;
  const [local, ...rest] = email.split('@');
  const domain = rest.join('@');
  if (!local || !domain) return '***';
  return `${local[0]}***@${domain}`;
};

/** '+923001234567' -> '**********67' (one star per digit, last two digits kept). */
const maskPhone = (phone) => {
  if (typeof phone !== 'string' || !phone.trim()) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 2) return '***';
  return `${'*'.repeat(Math.max(digits.length - 2, 3))}${digits.slice(-2)}`;
};

module.exports = { maskEmail, maskPhone };
