/**
 * NEW-115 (P0 ledger) — "traveller bank details and host payout bank details are two
 * stores". NOT REPRODUCED: the host's Payout & Banking screen saves through
 * PATCH /gyms/profile { paymentDetailsJson } (app payouts_repository.dart), which
 * gym.service.js writes to tenant.paymentDetailsJson; GET /discovery/gyms/:id/payment-details
 * (discovery.service.js getPaymentDetails) reads that same column, and the app reads the
 * same keys (bankName, accountTitle, accountNumber, iban, jazzCashNumber, easyPaisaNumber).
 * payout.service.js only reads paymentDetailsUpdatedAt for the cooling period. This test
 * locks the single store: the end-to-end write is the real route, the read the traveller's.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { stopTestServer } = require('../harness/test-server');

let personas;

beforeAll(async () => {
  const h = await setupTestDatabases();
  personas = await setupPersonas(h);
  // Phase 7 P7a (NEW-159): payment details are shown only for a live gym (R-77).
  const { personaManager } = require('../harness/personas');
  await require('../harness/factories').makeBranchLive(personaManager.context.tenant1Db, personaManager.context.branch1.id);
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

describe('NEW-115: one store for bank details (NOT REPRODUCED, locked here)', () => {
  test('what the host saves under Payout & Banking is what travellers are shown', async () => {
    const { GymListing } = require('../../src/models/platform');
    const details = { bankName: 'Test Bank', accountTitle: 'Alpha Fitness', accountNumber: '0001234567', iban: 'PK00TEST0001234567' };
    // Exactly what payout_setup_screen.dart sends (with the SEC-13 re-auth).
    const save = await asPersona('owner').patch('/gyms/profile', { paymentDetailsJson: details, password: 'Test@12345' });
    expect(save.status).toBe(200);

    const listing = await GymListing.findOne({ where: { tenantId: personas.owner.tenantId } });
    const res = await asPersona('member').get(`/discovery/gyms/${listing.id}/payment-details`);
    expect(res.status).toBe(200);
    expect(res.body.data.paymentDetails).toEqual(details);
  });
});
