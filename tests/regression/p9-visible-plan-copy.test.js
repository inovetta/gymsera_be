/**
 * Phase 7 P9: visible_plan_required answers Add Branch (gym.service.js), New Organization
 * (host.controller.js createListing), submit (tenant.service.js) and approval (admin.service.js). The
 * shared copy said "before you submit", which is wrong in three of the four; it now names the
 * "Show to Travellers" switch, as the app, the CMS and the website do.
 */
const { ERROR_COPY } = require('../../src/constants/error-copy');

describe('visible_plan_required copy', () => {
  test('fits every place the code is sent', () => {
    expect(ERROR_COPY.visible_plan_required.en).toBe('Turn on "Show to Travellers" for at least one plan, then try again.');
    for (const locale of ['en', 'ur', 'ar']) expect(ERROR_COPY.visible_plan_required[locale]).toBeTruthy();
    expect(ERROR_COPY.visible_plan_required.en).not.toMatch(/submit/i);
  });
});
