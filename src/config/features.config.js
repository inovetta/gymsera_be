/**
 * Launch feature switches, read from the environment on every call (ops can change them without a
 * code change; a restart picks them up on IIS).
 *
 * PAYOUTS_ENABLED (R-99, P11d): on only when it is exactly "true". Off by default: the payout balance is
 *   a bookkeeping number from the gym's own records and a payout request only records a PENDING row; no
 *   provider moves money, so hosts are not offered payouts until online payments are connected.
 */
const payoutsEnabled = () => (process.env.PAYOUTS_ENABLED || '').trim() === 'true';

const features = () => ({ payouts: payoutsEnabled() });

module.exports = { payoutsEnabled, features };
