/**
 * R-99 (P11d): payouts are off by default (PAYOUTS_ENABLED unset). The existing payout suites test the
 * feature itself, so the test process turns it on unless a run sets it explicitly. Tests of the switch
 * (tests/regression/p11d-r99-payouts-flag.test.js) set and unset it themselves.
 */
if (process.env.PAYOUTS_ENABLED === undefined) process.env.PAYOUTS_ENABLED = 'true';
