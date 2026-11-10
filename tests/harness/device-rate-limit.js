/**
 * ZKTeco Phase 4: the per-device rate limit (DEVICE_RATE_LIMIT, spec §5: about 2 requests a second, bursts
 * of 20) is on in production. The device simulator answers in milliseconds, not every RequestDelay seconds,
 * so a test drain would hit it on every suite. Off for the test process unless a run sets it;
 * tests/integration/zkteco-p4-hardening.test.js turns it on and checks it.
 */
if (process.env.DEVICE_RATE_LIMIT === undefined) process.env.DEVICE_RATE_LIMIT = 'false';
