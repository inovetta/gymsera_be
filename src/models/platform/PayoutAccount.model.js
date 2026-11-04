const { DataTypes } = require('sequelize');

/**
 * Where a host's money is paid out to (P7b, R-73, R-94). One store for the tenant's payout
 * details: what the traveller is shown at checkout and where a payout request is sent.
 *
 * Scope: a row belongs to a tenant (the business). `organizationId` (a gym_listings id) is
 * OPTIONAL: null = the tenant default; set = an override for that organization only.
 * Resolution for a branch: its organization's ACTIVE row if one exists, else the tenant
 * default (payout-account.service.js#resolveForBranch). There are no per-branch rows.
 *
 * `scopeKey` exists only so MySQL can enforce one row per (tenant, scope, provider): a UNIQUE
 * key treats NULLs as distinct, so organizationId alone could not. It is set by the hook below
 * and never written by callers.
 *
 * `provider` is the payout abstraction of R-73: BANK_TRANSFER (manual bank / wallet details)
 * is the only provider today. A card provider (Stripe Connect where supported, a Pakistani
 * gateway later) adds a provider value plus `externalAccountId`, `countryCode` and
 * `capabilitiesJson`; nothing here talks to a provider.
 */
const TENANT_SCOPE = 'TENANT';
const PROVIDERS = Object.freeze({ BANK_TRANSFER: 'BANK_TRANSFER' });
const STATUSES = Object.freeze({ ACTIVE: 'ACTIVE', DISABLED: 'DISABLED' });

const scopeKeyFor = (organizationId) => organizationId || TENANT_SCOPE;

module.exports = (sequelize) => {
  const PayoutAccount = sequelize.define(
    'PayoutAccount',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      tenantId: { type: DataTypes.UUID, allowNull: false },
      organizationId: { type: DataTypes.UUID, allowNull: true },
      scopeKey: { type: DataTypes.STRING(36), allowNull: false },
      provider: { type: DataTypes.STRING(32), allowNull: false, defaultValue: PROVIDERS.BANK_TRANSFER },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: STATUSES.ACTIVE },
      countryCode: { type: DataTypes.STRING(2), allowNull: true },
      externalAccountId: { type: DataTypes.STRING(255), allowNull: true },
      capabilitiesJson: { type: DataTypes.JSON, allowNull: true },
      detailsJson: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: 'BANK_TRANSFER: bankName, accountTitle, accountNumber, iban, branchCode, jazzCashNumber, easyPaisaNumber, additionalInstructions',
      },
      detailsUpdatedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'SEC-13: last change of the details; a payout is refused for 24 hours after it',
      },
    },
    {
      tableName: 'payout_accounts',
      underscored: true,
      timestamps: true,
      indexes: [
        { unique: true, name: 'payout_accounts_tenant_scope_provider', fields: ['tenant_id', 'scope_key', 'provider'] },
        { name: 'payout_accounts_organization_id', fields: ['organization_id'] },
      ],
      hooks: {
        beforeValidate: (row) => {
          row.scopeKey = scopeKeyFor(row.organizationId);
        },
      },
    }
  );
  PayoutAccount.TENANT_SCOPE = TENANT_SCOPE;
  PayoutAccount.PROVIDERS = PROVIDERS;
  PayoutAccount.STATUSES = STATUSES;
  PayoutAccount.scopeKeyFor = scopeKeyFor;
  return PayoutAccount;
};
