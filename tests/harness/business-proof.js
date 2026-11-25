/** NEW-303 M2 (D10): approving a business needs a proof-of-premises document. Tests that are not about the
 *  document record one on the listing row (no file); the real upload path is tested in new-303-m2-business-kyc. */
const { GymListing } = require('../../src/models/platform');

const addProof = async (businessId) => {
  const listing = await GymListing.findByPk(businessId);
  const docs = Array.isArray(listing.kycDocumentsJson) ? listing.kycDocumentsJson : [];
  await listing.update({
    kycDocumentsJson: [...docs, { documentId: 'doc_test_proof', key: 'test/none', documentType: 'PROOF_OF_PREMISES', status: 'PENDING', uploadedAt: new Date().toISOString() }],
  });
};

module.exports = { addProof };
