const { DataTypes } = require('sequelize');

/**
 * UserOrgIndex — which tenants a user holds any role assignment in.
 *
 * Exists to answer one question in a single indexed read: "which tenant databases
 * do I need to open for this user?" Before this table, four call sites answered it
 * by looping every active tenant and opening a live MySQL connection to each until
 * a row matched — O(tenants) handshakes on a single request, getting slower with
 * every customer won.
 *
 * ── The invariant, and it matters ────────────────────────────────────────────
 * This is a routing index, never an authorization source. It tells you which door
 * to open; the tenant database tells you what is behind it. Authorization always
 * resolves against role_assignments in the tenant DB. If this table and the tenant
 * DB disagree, the tenant DB wins and the row here is repaired.
 *
 * Written inside the same request that writes the assignment, not by a background
 * job. Because it is derived data, it can be rebuilt from scratch at any time by
 * scripts/backfill-rbac.js.
 */
module.exports = (sequelize) => {
  return sequelize.define(
    'UserOrgIndex',
    {
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
        primaryKey: true,
        field: 'user_id',
      },
      tenantId: {
        type: DataTypes.UUID,
        allowNull: false,
        primaryKey: true,
        field: 'tenant_id',
      },
      // Highest role the user holds in this tenant, denormalized so the app shell
      // can render a context switcher without opening any tenant database.
      roleKey: {
        type: DataTypes.STRING(40),
        allowNull: false,
        field: 'role_key',
      },
      roleLevel: {
        type: DataTypes.SMALLINT,
        allowNull: false,
        defaultValue: 0,
        field: 'role_level',
      },
      scopeType: {
        type: DataTypes.ENUM('ORG', 'BRANCH'),
        allowNull: false,
        defaultValue: 'BRANCH',
        field: 'scope_type',
      },
      branchCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'branch_count',
      },
      // Aggregate of the user's assignments in this tenant. ACTIVE if any
      // assignment is active; otherwise the most advanced state present.
      status: {
        type: DataTypes.ENUM('INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED'),
        allowNull: false,
        defaultValue: 'INVITED',
      },
    },
    {
      tableName: 'user_org_index',
      underscored: true,
      timestamps: true,
      indexes: [
        { fields: ['user_id', 'status'] },
        { fields: ['tenant_id', 'status'] },
      ],
    }
  );
};
