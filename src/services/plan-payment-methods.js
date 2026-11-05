'use strict';

/**
 * Payment methods a host can use to pay for a GymsEra plan outside the stores (P9c item D, R-95).
 *
 * The host flow is the same for every method: choose plan and cycle → see how to pay → pay →
 * the request shows PENDING / APPROVED / REJECTED. A method only says how the "pay" step works:
 *
 *   key             the value stored in plan_payment_requests.method
 *   label           shown to the host
 *   requiresProof   the host must upload a receipt (manual methods)
 *   approval        'ADMIN' = a platform admin approves after checking the money;
 *                   'PROVIDER' = the provider's verified callback approves (card providers)
 *   instructions()  what the host is shown (bank details for a transfer); null = not configured
 *
 * BANK_TRANSFER is the only method. A card provider (none approved in §14; R-7, R-73) adds an entry
 * with approval 'PROVIDER' and a start/confirm pair that creates the provider's hosted checkout
 * and, on its verified webhook, calls plan-payment.service.js#approve with the provider as actor.
 * Card details are only ever entered on the provider's hosted page (SEC-09).
 */
const billingConfig = require('../config/billing.config');

const METHODS = Object.freeze({
  BANK_TRANSFER: Object.freeze({
    key: 'BANK_TRANSFER',
    label: 'Bank transfer',
    requiresProof: true,
    approval: 'ADMIN',
    instructions: (currency) => {
      const i = billingConfig.getBankTransferInstructions(currency);
      // R-86: the platform account comes from the API's environment; none set = not offered yet.
      return i.accountNumber || i.iban ? i : null;
    },
  }),
});

const getMethod = (key) => METHODS[key] || null;
const listMethods = () => Object.values(METHODS);

module.exports = { getMethod, listMethods, METHODS };
