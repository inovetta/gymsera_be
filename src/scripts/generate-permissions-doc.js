#!/usr/bin/env node
/**
 * Auto-generate docs/PERMISSIONS.md from src/constants/permissions.js and src/constants/roles.js.
 *
 * Ensures that permission documentation never drifts from backend authority code.
 *
 * Usage:
 *   node src/scripts/generate-permissions-doc.js
 */

const fs = require('fs');
const path = require('path');
const { CATALOGUE, ROLE_ORDER, TIER } = require('../constants/permissions');
const { ROLE_META } = require('../constants/roles');

const TIER_SYMBOLS = {
  [TIER.FULL]: '✅ Full',
  [TIER.DIRECT]: '✅ Direct',
  [TIER.APPROVE]: '⚖️ Approve',
  [TIER.REQUEST]: '📝 Request',
  [TIER.VIEW]: '👁️ View',
  [TIER.NONE]: '❌ None',
};

const TIER_SHORT = {
  [TIER.FULL]: 'Full',
  [TIER.DIRECT]: 'Direct',
  [TIER.APPROVE]: 'Approve',
  [TIER.REQUEST]: 'Request',
  [TIER.VIEW]: 'View',
  [TIER.NONE]: '—',
};

function generateMarkdown() {
  const lines = [];

  lines.push('# GymsEra — Permission Catalogue & Persona Matrix');
  lines.push('');
  lines.push('> **AUTOMATICALLY GENERATED — DO NOT EDIT DIRECTLY**');
  lines.push('> Source of truth: `src/constants/permissions.js` and `src/constants/roles.js`.');
  lines.push('> Generated on: ' + new Date().toISOString().split('T')[0]);
  lines.push('');
  lines.push('This document describes the unified Role-Based Access Control (RBAC) model implemented in GymsEra, specifying exactly what each staff persona, gym member, and platform admin can do across all functional modules.');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 1. Roles & Hierarchy');
  lines.push('');
  lines.push('Staff roles are assigned per organization or per branch via `RoleAssignment`. Privilege escalation is strictly prevented by role levels: a user may only invite or assign roles strictly below their own level.');
  lines.push('');
  lines.push('| Role Key | Display Name | Level | Default Scope | Assignable | Charter |');
  lines.push('|---|---|---|---|---|---|');

  for (const roleKey of ROLE_ORDER) {
    const meta = ROLE_META[roleKey] || {};
    lines.push(
      `| \`${roleKey}\` | **${meta.displayName || meta.name}** | ${meta.level} | \`${meta.defaultScope}\` | ${meta.assignable ? 'Yes' : 'No (Host creation)'} | ${meta.charter} |`
    );
  }

  lines.push('');
  lines.push('### Non-Staff Personas');
  lines.push('- **MEMBER**: Gym member or traveler. Has zero staff access to tenant operations; operates exclusively on their own profile, QR check-ins, personal subscriptions, and invoices.');
  lines.push('- **PLATFORM_ADMIN**: System administrator across the platform. Holds superuser access to platform-level tenant management and diagnostic routes; accesses tenant DBs strictly through audited platform-admin doors without bypasses.');
  lines.push('- **ANONYMOUS**: Unauthenticated public caller. Access limited to public discovery, health checks, and auth endpoints.');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 2. Permission Tiers');
  lines.push('');
  lines.push('Every permission follows a 3-choice or 5-tier evaluation model:');
  lines.push('');
  lines.push('| Tier Code | Tier Name | Meaning | API Behavior |');
  lines.push('|---|---|---|---|');
  lines.push('| `F` | **FULL** | Full administrative control | Direct mutation + viewing + sub-configuration |');
  lines.push('| `D` | **DIRECT** | Direct action execution | Mutation executes immediately; holds `.direct` twin |');
  lines.push('| `A` | **APPROVE** | Decision maker | Can approve or reject requests in inbox |');
  lines.push('| `R` | **REQUEST** | Gated / Approvable action | Mutation writes `approval_request` for manager review |');
  lines.push('| `V` | **VIEW** | Read-only | Can query and view records within scope |');
  lines.push('| `x` | **NONE** | No access | Endpoint returns 403 Forbidden; UI element hidden |');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 3. Persona Matrix by Module');
  lines.push('');

  for (const group of CATALOGUE) {
    lines.push(`### 3.${CATALOGUE.indexOf(group) + 1} Module: ${group.label} (\`${group.module}\`)`);
    lines.push('');
    lines.push('| Permission | Key | Owner | Org Admin | Manager | Branch Admin | Front Desk | Trainer | Support | Approvable |');
    lines.push('|---|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|');

    for (const perm of group.permissions) {
      const tiersFormatted = perm.tiers.map((t) => TIER_SHORT[t] || t);
      const approvableStr = perm.approvable ? 'Yes' : 'No';
      lines.push(
        `| **${perm.label}** | \`${perm.key}\` | ${tiersFormatted.join(' | ')} | ${approvableStr} |`
      );
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## 4. Endpoint Protection Architecture');
  lines.push('');
  lines.push('Endpoints enforce permissions using two complementary mechanisms:');
  lines.push('');
  lines.push('1. **Direct Route Middleware (`can(permissionKey, opts)`):**');
  lines.push('   Resolves effective grants for `(tenantId, userId, branchId)` against active `RoleAssignment`s.');
  lines.push('   - `can(\'ledger.today.view\')`');
  lines.push('   - `can(\'team.invite\', { orgWide: true })`');
  lines.push('   - `can.any([\'approvals.view\', \'approvals.decide\'])`');
  lines.push('');
  lines.push('2. **Unified Approvable Actions Door (`POST /api/v1/actions/:actionKey`):**');
  lines.push('   Evaluates `req.grants.tierFor(actionKey)`:');
  lines.push('   - If `DIRECT`: runs action command immediately via `actions.controller`.');
  lines.push('   - If `REQUEST`: creates an `approval_request` row in tenant DB.');
  lines.push('   - If `OFF`: returns 403 Forbidden.');
  lines.push('');
  lines.push('3. **IDOR & Cross-Tenant Defense-in-Depth:**');
  lines.push('   - Out-of-scope resources (by `:id`) return 404 Not Found (never 403) to prevent existence leakage.');
  lines.push('   - Branch-scoped users (Manager, Desk, Trainer, Cleaner) cannot read or mutate data outside their assigned branch(es).');
  lines.push('   - Non-platform admins cannot read or mutate resources across different tenant boundaries.');

  return lines.join('\n') + '\n';
}

const outputPath = path.resolve(__dirname, '../../docs/PERMISSIONS.md');
const content = generateMarkdown();
fs.writeFileSync(outputPath, content, 'utf8');
console.log(`[generate-permissions-doc] Successfully generated ${outputPath} (${content.length} bytes)`);
