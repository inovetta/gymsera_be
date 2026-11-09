/**
 * R-99 (P11d): while PAYOUTS_ENABLED is not "true" the payout routes do not exist for anyone: 404
 * `payouts_not_available`, before authentication, tenant context and body checks, so the answer is the
 * same for every caller and nothing is written. The payout account (GET / PUT /host/payout-account) is
 * not gated: travellers' bank-transfer details come from it.
 */
const { payoutsEnabled } = require('../config/features.config');
const { createError } = require('../utils/response.utils');

const MESSAGE = 'Payouts are not available yet.';

const requirePayoutsEnabled = (_req, _res, next) =>
  (payoutsEnabled() ? next() : next(createError(MESSAGE, 404, 'payouts_not_available')));

module.exports = requirePayoutsEnabled;
