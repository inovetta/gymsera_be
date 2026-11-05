'use strict';

/**
 * Payment proofs (bank-transfer receipts) — Phase 7 P9c item A.
 *
 * The bytes live in the one private store (decision R-27, kyc-storage.service.js), under
 * `tenants/<tenantId>/payment-proofs/`. The payment row keeps `private:<key>`; API answers never
 * show the key: Payment#proofUrl reads as the authenticated route `/api/v1/payments/<id>/proof`
 * (payments.controller.js#getProof), which only the receiving host's staff with `payments.view`
 * on the payment's branch and platform admins can open. There is no public URL.
 *
 * Rows written before P9c hold `/uploads/payment-proofs/...`: that file was never stored, so the
 * proof is reported missing (`proofMissing: true`, 404 `proof_missing`) instead of a dead link.
 */

const crypto = require('crypto');
const privateStore = require('./kyc-storage.service');

const PRIVATE_PREFIX = 'private:';
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const isPrivateProof = (value) => typeof value === 'string' && value.startsWith(PRIVATE_PREFIX);
const keyOf = (value) => (isPrivateProof(value) ? value.slice(PRIVATE_PREFIX.length) : null);
const proofRoute = (paymentId) => `/api/v1/payments/${paymentId}/proof`;

/**
 * Stores the uploaded proof for `payment` (a tenant Payment instance) and points the row at it.
 * The previous private file, if any, is removed after the row is saved.
 * @param {{ tenantId: string, payment: object, file: { buffer: Buffer, mimetype: string } }} params
 */
const storeProof = async ({ tenantId, payment, file }) => {
  if (!tenantId) throw new Error('storeProof: tenantId is required');
  const ext = EXT[file.mimetype] || 'jpg';
  const key = `tenants/${tenantId}/payment-proofs/${payment.id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  await privateStore.putPrivateObject({ buffer: file.buffer, mimetype: file.mimetype, key });

  const previousKey = keyOf(payment.getDataValue('proofUrl'));
  await payment.update({ proofUrl: `${PRIVATE_PREFIX}${key}` });
  if (previousKey) await privateStore.deleteKycFile(previousKey).catch(() => {});
  return payment;
};

/** Stream of a stored proof, or a 404-shaped error with a code. */
const openProof = async (rawProofValue) => {
  if (!rawProofValue) {
    const err = new Error('This payment has no proof');
    err.statusCode = 404;
    err.code = 'proof_not_found';
    throw err;
  }
  const key = keyOf(rawProofValue);
  if (!key) {
    const err = new Error('The proof for this payment was not saved. Ask the member to upload it again.');
    err.statusCode = 404;
    err.code = 'proof_missing';
    throw err;
  }
  const { stream } = await privateStore.getKycStream(key);
  const ext = key.split('.').pop();
  const contentType = Object.keys(EXT).find((m) => EXT[m] === ext) || 'application/octet-stream';
  return { stream, contentType };
};

/** Removes a stored proof (account deletion). Non-private values have no file. */
const deleteProof = async (rawProofValue) => {
  const key = keyOf(rawProofValue);
  if (key) await privateStore.deleteKycFile(key);
};

module.exports = { PRIVATE_PREFIX, isPrivateProof, proofRoute, storeProof, openProof, deleteProof };
