'use strict';

/**
 * R-120 NEW-309 (API contract v2 §2): in a host or admin response the nested `tenant` object is `organization` and the
 * list `tenants` is `organizations`. Applied to the top-level keys of the result a controller sends; the services keep
 * their own names. Models and arrays pass through unchanged.
 */
const KEYS = Object.freeze({ tenant: 'organization', tenants: 'organizations' });

const toOrganizationKeys = (data) => {
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.toJSON === 'function') return data;
  const out = {};
  for (const [k, v] of Object.entries(data)) out[KEYS[k] || k] = v;
  return out;
};

module.exports = { toOrganizationKeys };
