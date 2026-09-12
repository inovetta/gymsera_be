/**
 * Idempotent schema migration for the access-control tables.
 *
 * `sequelize.sync({ alter: true })` only runs in development in this codebase, so
 * new tenant tables need an explicit path that is safe to run on every connection
 * in production. `CREATE TABLE IF NOT EXISTS` gives exactly that: additive, cheap
 * once the table exists, and impossible to get wrong twice.
 *
 * Step 0 of the migration plan — ship the tables, have nothing read them yet.
 */

/** DDL keyed by table name, in dependency order. */
const TABLES = {
  role_assignments: `
    CREATE TABLE IF NOT EXISTS role_assignments (
      id           CHAR(36)     NOT NULL,
      user_id      CHAR(36)     NULL,
      email        VARCHAR(255) NULL,
      role_key     VARCHAR(40)  NOT NULL,
      role_level   SMALLINT     NOT NULL DEFAULT 0,
      scope_type   ENUM('ORG','BRANCH') NOT NULL DEFAULT 'BRANCH',
      status       ENUM('INVITED','ACTIVE','SUSPENDED','REVOKED') NOT NULL DEFAULT 'INVITED',
      job_title    VARCHAR(100) NULL,
      valid_from   DATETIME     NULL,
      valid_until  DATETIME     NULL,
      invited_by   CHAR(36)     NULL,
      invited_at   DATETIME     NULL,
      accepted_at  DATETIME     NULL,
      revoked_at   DATETIME     NULL,
      revoked_by   CHAR(36)     NULL,
      created_at   DATETIME     NOT NULL,
      updated_at   DATETIME     NOT NULL,
      PRIMARY KEY (id),
      KEY ra_user_status (user_id, status),
      KEY ra_email (email),
      KEY ra_role_key (role_key),
      KEY ra_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  role_assignment_branches: `
    CREATE TABLE IF NOT EXISTS role_assignment_branches (
      id            CHAR(36) NOT NULL,
      assignment_id CHAR(36) NOT NULL,
      branch_id     CHAR(36) NOT NULL,
      created_at    DATETIME NOT NULL,
      updated_at    DATETIME NOT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY rab_assignment_branch_unique (assignment_id, branch_id),
      KEY rab_branch (branch_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  assignment_overrides: `
    CREATE TABLE IF NOT EXISTS assignment_overrides (
      id             CHAR(36)    NOT NULL,
      assignment_id  CHAR(36)    NOT NULL,
      branch_id      CHAR(36)    NULL,
      permission_key VARCHAR(64) NOT NULL,
      effect         ENUM('ALLOW','DENY') NOT NULL,
      data_scope     ENUM('ALL','ASSIGNED','OWN') NULL,
      constraints    JSON        NULL,
      created_by     CHAR(36)    NULL,
      created_at     DATETIME    NOT NULL,
      updated_at     DATETIME    NOT NULL,
      PRIMARY KEY (id),
      KEY ao_assignment (assignment_id),
      KEY ao_assignment_perm (assignment_id, permission_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  approval_requests: `
    CREATE TABLE IF NOT EXISTS approval_requests (
      id                         CHAR(36)     NOT NULL,
      branch_id                  CHAR(36)     NULL,
      action_key                 VARCHAR(64)  NOT NULL,
      payload                    JSON         NOT NULL,
      summary                    VARCHAR(255) NULL,
      requested_by               CHAR(36)     NOT NULL,
      requested_by_assignment_id CHAR(36)     NULL,
      status                     ENUM('PENDING','APPROVED','REJECTED','EXPIRED','CANCELLED') NOT NULL DEFAULT 'PENDING',
      decided_by                 CHAR(36)     NULL,
      decided_at                 DATETIME     NULL,
      decision_reason            TEXT         NULL,
      result_ref                 JSON         NULL,
      idempotency_key            VARCHAR(120) NULL,
      expires_at                 DATETIME     NULL,
      escalated_at               DATETIME     NULL,
      created_at                 DATETIME     NOT NULL,
      updated_at                 DATETIME     NOT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY approval_idempotency_unique (idempotency_key),
      KEY ar_status_branch (status, branch_id),
      KEY ar_requested_by (requested_by),
      KEY ar_action (action_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  approval_policies: `
    CREATE TABLE IF NOT EXISTS approval_policies (
      id                  CHAR(36)    NOT NULL,
      branch_id           CHAR(36)    NULL,
      action_key          VARCHAR(64) NOT NULL,
      approver_permission VARCHAR(64) NOT NULL DEFAULT 'approvals.decide',
      min_approver_level  SMALLINT    NOT NULL DEFAULT 40,
      quorum              SMALLINT    NOT NULL DEFAULT 1,
      sla_hours           INT         NULL,
      escalate_to_level   SMALLINT    NULL,
      auto_expire_hours   INT         NULL,
      created_at          DATETIME    NOT NULL,
      updated_at          DATETIME    NOT NULL,
      PRIMARY KEY (id),
      KEY ap_action (action_key),
      KEY ap_branch_action (branch_id, action_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  audit_logs: `
    CREATE TABLE IF NOT EXISTS audit_logs (
      id             BIGINT       NOT NULL AUTO_INCREMENT,
      branch_id      CHAR(36)     NULL,
      actor_user_id  CHAR(36)     NULL,
      actor_role_key VARCHAR(40)  NULL,
      action         VARCHAR(64)  NOT NULL,
      target_type    VARCHAR(40)  NULL,
      target_id      VARCHAR(64)  NULL,
      before_state   JSON         NULL,
      after_state    JSON         NULL,
      ip             VARCHAR(64)  NULL,
      user_agent     VARCHAR(255) NULL,
      created_at     DATETIME     NOT NULL,
      PRIMARY KEY (id),
      KEY al_actor (actor_user_id),
      KEY al_action (action),
      KEY al_branch (branch_id),
      KEY al_target (target_type, target_id),
      KEY al_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

/**
 * Create any access-control table that is missing from this tenant database.
 *
 * Never drops, never alters an existing column. Failures are logged and swallowed
 * per table: one tenant with a locked table must not take down connection setup
 * for every other tenant.
 *
 * @param {import('sequelize').Sequelize} sequelize
 * @param {string} tenantId  for log context
 * @returns {Promise<string[]>} tables that were created or already present
 */
const ensureAccessControlTables = async (sequelize, tenantId) => {
  const ready = [];
  for (const [table, ddl] of Object.entries(TABLES)) {
    try {
      await sequelize.query(ddl);
      ready.push(table);
    } catch (err) {
      console.warn(`[RBAC] tenant ${tenantId}: could not ensure ${table} — ${err.message}`);
    }
  }
  return ready;
};

module.exports = { ensureAccessControlTables, TABLES };
