/** A complete contract-v2 FirstBranch body for endpoint tests (A2 H2, A3 J10). */
const { Area } = require('../../src/models/platform');

const firstBranchInput = async (overrides = {}) => {
  const cityId = overrides.cityId ?? 1;
  const hasArea = Object.prototype.hasOwnProperty.call(overrides, 'areaId') ||
    Object.prototype.hasOwnProperty.call(overrides, 'areaRequestId');
  const area = hasArea ? {} : {
    areaId: (await Area.findOrCreate({
      where: { cityId, name: 'Contract Test Area' },
      defaults: { cityId, name: 'Contract Test Area' },
    }))[0].id,
  };
  return {
    branchName: 'Main Branch', cityId, ...area,
    address: 'Main Street', latitude: 24.86, longitude: 67.01, phone: '+923001234567',
    imagesJson: ['https://example.test/branch-1.png', 'https://example.test/branch-2.png', 'https://example.test/branch-3.png'],
    packages: [{ name: 'Monthly', price: 100, durationType: 'MONTHLY', durationValue: 1, isPublic: true }],
    ...overrides,
  };
};

module.exports = { firstBranchInput };
