/**
 * The one generator of organization codes (R-120 NEW-307, F8). Before it, tenant.service.js and auth.service.js each
 * built `GYM-XXXXXXXX` on their own. New codes start `ORG-` (owner decision D-5); existing codes are never rewritten.
 */
const crypto = require('crypto');

const ORGANIZATION_CODE_PREFIX = 'ORG-';

/** `ORG-` + 8 uppercase hex characters, e.g. ORG-1A2B3C4D. */
const generateOrganizationCode = () => `${ORGANIZATION_CODE_PREFIX}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

module.exports = { ORGANIZATION_CODE_PREFIX, generateOrganizationCode };
