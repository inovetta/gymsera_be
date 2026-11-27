/** NEW-303 M2 (D10): approving a business needs a proof-of-premises document. Tests that are not about the
 *  document record one on the listing row (no file); the real upload path is tested in new-303-m2-business-kyc. */
const { GymListing } = require('../../src/models/platform');

const addProof = async (businessId, { photos = false } = {}) => {
  const listing = await GymListing.findByPk(businessId);
  const docs = Array.isArray(listing.kycDocumentsJson) ? listing.kycDocumentsJson : [];
  await listing.update({
    ...(photos && { imagesJson: ['https://example.test/p1.png', 'https://example.test/p2.png', 'https://example.test/p3.png'] }),
    kycDocumentsJson: [...docs, { documentId: 'doc_test_proof', key: 'test/none', documentType: 'PROOF_OF_PREMISES', status: 'PENDING', uploadedAt: new Date().toISOString() }],
  });
};

module.exports = { addProof };

/** The business approval that builds an organization's held first branch (M2d): proof + photos recorded, then approved. */
const approveFirstBusiness = async (organizationId, adminUserId) => {
  const { GymListing: Listing } = require('../../src/models/platform');
  const listing = await Listing.findOne({ where: { organizationId }, order: [['createdAt', 'ASC']] });
  await addProof(listing.id, { photos: true });
  return require('../../src/services/admin.service').approveBusiness(listing.id, adminUserId);
};

module.exports.approveFirstBusiness = approveFirstBusiness;
