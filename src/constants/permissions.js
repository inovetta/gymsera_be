/**
 * Permission catalogue — the single source of truth for what can be done in a gym.
 *
 * Deliberately code-owned, not a database table. GymsEra runs one MySQL database
 * per tenant; seeding ~70 identical reference rows into every tenant DB guarantees
 * drift the first time a tenant misses a migration. The catalogue ships with the
 * deploy, so every tenant is on the same version by construction.
 *
 * A permission key is `module.action`. Application code checks keys and nothing
 * else — never a role name.
 *
 * ── Approval tiers ───────────────────────────────────────────────────────────
 * An approvable permission is really two keys:
 *
 *   holds nothing                     → OFF      (403, button hidden)
 *   holds `members.create`            → REQUEST  (writes an approval_request)
 *   holds `members.create` + `.direct`→ DIRECT   (writes immediately)
 *
 * The `.direct` twins are derived here, never hand-listed, so they cannot drift
 * from their parents.
 *
 * ── Data scopes ──────────────────────────────────────────────────────────────
 *   ALL       every record in the assigned branch
 *   ASSIGNED  only records linked to the holder (a trainer's own clients)
 *   OWN       only records the holder created (a front-desk shift's collections)
 */

/** Column order for the `tiers` arrays below. Must match ROLE_ORDER in roles.js. */
const ROLE_ORDER = ['OWNER', 'ORG_ADMIN', 'MANAGER', 'BR_ADMIN', 'DESK', 'TRAINER', 'SUPPORT'];

/**
 * Tier codes used in the `tiers` arrays.
 *   x  no access        V  view only         R  may act, by request
 *   A  may approve      D  may act directly  F  full (implies direct)
 */
const TIER = {
  NONE: 'x',
  VIEW: 'V',
  REQUEST: 'R',
  APPROVE: 'A',
  DIRECT: 'D',
  FULL: 'F',
};

/** Tiers that grant the base permission key at all. */
const GRANTING_TIERS = new Set([TIER.VIEW, TIER.REQUEST, TIER.APPROVE, TIER.DIRECT, TIER.FULL]);

/** Tiers that additionally grant the `.direct` twin of an approvable permission. */
const DIRECT_TIERS = new Set([TIER.DIRECT, TIER.FULL]);

const SCOPE = { ALL: 'ALL', ASSIGNED: 'ASSIGNED', OWN: 'OWN' };

/** Relative breadth of a data scope — used when unioning grants from several roles. */
const SCOPE_RANK = { OWN: 1, ASSIGNED: 2, ALL: 3 };

/**
 * The catalogue.
 *
 * Per permission:
 *   key          `module.action`
 *   label        shown in the permission editor
 *   approvable   has a `.direct` twin and can be gated behind an approval
 *   dangerous    rendered in red, requires a second confirmation in the UI
 *   orgOnly      may only be granted to an ORG-scoped assignment
 *   scopes       data scopes this permission understands (omit = ALL only)
 *   tiers        default tier per role, in ROLE_ORDER
 *   roleScopes   optional per-role data scope override, keyed by role
 *   note         one-line rationale, surfaced in the editor
 */
const CATALOGUE = [
  {
    module: 'dashboard',
    label: 'Dashboard',
    permissions: [
      {
        key: 'dashboard.view',
        label: 'View dashboard',
        tiers: ['F', 'F', 'F', 'F', 'V', 'V', 'V'],
        note: 'Operational widgets: today\'s check-ins, classes, expiring memberships.',
      },
      {
        key: 'dashboard.revenue.view',
        label: 'See revenue figures',
        tiers: ['F', 'F', 'F', 'V', 'x', 'x', 'x'],
        note: 'Split from the dashboard itself so a trainer can see attendance without seeing takings.',
      },
      {
        key: 'dashboard.multibranch.view',
        label: 'Roll-up across branches',
        orgOnly: true,
        tiers: ['F', 'F', 'x', 'x', 'x', 'x', 'x'],
      },
    ],
  },

  {
    module: 'members',
    label: 'Members',
    permissions: [
      {
        key: 'members.view',
        label: 'View members',
        scopes: [SCOPE.ALL, SCOPE.ASSIGNED],
        tiers: ['F', 'F', 'F', 'F', 'V', 'V', 'x'],
        roleScopes: { TRAINER: SCOPE.ASSIGNED },
      },
      {
        key: 'members.pii.view',
        label: 'See contact details',
        tiers: ['F', 'F', 'F', 'F', 'V', 'x', 'x'],
        note: 'Phone, email, address, CNIC. Masked at the serializer, so it holds across exports too.',
      },
      { key: 'members.create', label: 'Add member', approvable: true, tiers: ['D', 'D', 'D', 'D', 'R', 'x', 'x'] },
      { key: 'members.update', label: 'Edit member', approvable: true, tiers: ['D', 'D', 'D', 'D', 'R', 'x', 'x'] },
      {
        key: 'members.delete',
        label: 'Delete member',
        approvable: true,
        dangerous: true,
        tiers: ['D', 'D', 'R', 'R', 'x', 'x', 'x'],
      },
      { key: 'members.freeze', label: 'Freeze membership', approvable: true, tiers: ['D', 'D', 'D', 'R', 'R', 'x', 'x'] },
      {
        key: 'members.transfer',
        label: 'Transfer between branches',
        approvable: true,
        tiers: ['D', 'D', 'R', 'x', 'x', 'x', 'x'],
        note: 'Requires the permission on both the source and destination branch.',
      },
      { key: 'members.notes.write', label: 'Write progress notes', tiers: ['F', 'F', 'F', 'F', 'x', 'D', 'x'] },
      {
        key: 'members.export',
        label: 'Export member list',
        dangerous: true,
        tiers: ['F', 'F', 'V', 'x', 'x', 'x', 'x'],
        note: 'Data-exfiltration risk. Default off below Manager.',
      },
    ],
  },

  {
    module: 'checkins',
    label: 'Check-ins',
    permissions: [
      {
        key: 'checkins.view',
        label: 'View check-ins',
        scopes: [SCOPE.ALL, SCOPE.ASSIGNED],
        tiers: ['F', 'F', 'F', 'F', 'V', 'V', 'x'],
        roleScopes: { TRAINER: SCOPE.ASSIGNED },
      },
      { key: 'checkins.qr.scan', label: 'Scan member QR', tiers: ['F', 'F', 'F', 'F', 'D', 'D', 'x'] },
      {
        key: 'checkins.manual.create',
        label: 'Manual check-in',
        approvable: true,
        tiers: ['D', 'D', 'D', 'D', 'R', 'x', 'x'],
        note: 'Bypasses the QR scan — an abuse vector, so it stays approvable.',
      },
      {
        key: 'checkins.backdate',
        label: 'Backdate a check-in',
        approvable: true,
        dangerous: true,
        tiers: ['D', 'D', 'R', 'x', 'x', 'x', 'x'],
      },
      { key: 'checkins.delete', label: 'Delete a check-in', approvable: true, tiers: ['D', 'D', 'R', 'x', 'x', 'x', 'x'] },
    ],
  },

  {
    module: 'announcements',
    label: 'Announcements',
    permissions: [
      { key: 'announcements.view', label: 'View announcements', tiers: ['F', 'F', 'F', 'F', 'V', 'V', 'V'] },
      { key: 'announcements.create', label: 'Draft an announcement', approvable: true, tiers: ['D', 'D', 'D', 'D', 'R', 'R', 'x'] },
      {
        key: 'announcements.publish',
        label: 'Publish to members',
        tiers: ['D', 'D', 'D', 'D', 'x', 'x', 'x'],
        note: 'Separating draft from publish is itself the approval gate for member comms.',
      },
      {
        key: 'announcements.broadcast.all_branches',
        label: 'Broadcast to all branches',
        orgOnly: true,
        dangerous: true,
        tiers: ['D', 'D', 'x', 'x', 'x', 'x', 'x'],
      },
      { key: 'announcements.delete', label: 'Delete an announcement', tiers: ['D', 'D', 'D', 'x', 'x', 'x', 'x'] },
    ],
  },

  {
    module: 'schedule',
    label: 'Schedule',
    permissions: [
      {
        key: 'schedule.view',
        label: 'View class schedule',
        scopes: [SCOPE.ALL, SCOPE.ASSIGNED],
        tiers: ['F', 'F', 'F', 'F', 'V', 'V', 'V'],
      },
      { key: 'schedule.class.create', label: 'Create a class', approvable: true, tiers: ['D', 'D', 'D', 'D', 'R', 'D', 'x'] },
      {
        key: 'schedule.class.update',
        label: 'Edit a class',
        approvable: true,
        scopes: [SCOPE.ALL, SCOPE.ASSIGNED],
        tiers: ['D', 'D', 'D', 'D', 'R', 'D', 'x'],
        roleScopes: { TRAINER: SCOPE.ASSIGNED },
        note: 'ASSIGNED scope means a trainer edits only their own classes.',
      },
      {
        key: 'schedule.class.cancel',
        label: 'Cancel a class',
        approvable: true,
        tiers: ['D', 'D', 'D', 'R', 'R', 'R', 'x'],
        note: 'Triggers member notifications, so it stays approvable below Manager.',
      },
      { key: 'schedule.trainer.assign', label: 'Assign a trainer', tiers: ['D', 'D', 'D', 'x', 'x', 'x', 'x'] },
      { key: 'schedule.booking.override', label: 'Force-add to a full class', tiers: ['D', 'D', 'D', 'D', 'x', 'x', 'x'] },
    ],
  },

  {
    module: 'expenses',
    label: 'Expenses',
    permissions: [
      {
        key: 'expenses.view',
        label: 'View expenses',
        scopes: [SCOPE.ALL, SCOPE.OWN],
        tiers: ['F', 'F', 'F', 'V', 'V', 'x', 'V'],
        roleScopes: { DESK: SCOPE.OWN, SUPPORT: SCOPE.OWN },
      },
      {
        key: 'expenses.create',
        label: 'Record an expense',
        approvable: true,
        tiers: ['D', 'D', 'D', 'R', 'R', 'x', 'R'],
        note: 'A max_amount constraint can downgrade DIRECT to REQUEST above a threshold.',
      },
      { key: 'expenses.approve', label: 'Approve expenses', tiers: ['A', 'A', 'A', 'x', 'x', 'x', 'x'] },
      { key: 'expenses.category.manage', label: 'Manage expense categories', tiers: ['F', 'F', 'D', 'x', 'x', 'x', 'x'] },
      { key: 'expenses.delete', label: 'Delete an expense', approvable: true, dangerous: true, tiers: ['D', 'D', 'R', 'x', 'x', 'x', 'x'] },
    ],
  },

  {
    module: 'subscriptions',
    label: 'Subscriptions',
    permissions: [
      { key: 'subscriptions.view', label: 'View subscriptions', tiers: ['F', 'F', 'F', 'F', 'V', 'x', 'x'] },
      { key: 'subscriptions.create', label: 'Assign a plan', approvable: true, tiers: ['D', 'D', 'D', 'D', 'R', 'x', 'x'] },
      {
        key: 'subscriptions.extend',
        label: 'Extend / add free days',
        approvable: true,
        dangerous: true,
        tiers: ['D', 'D', 'D', 'R', 'R', 'x', 'x'],
        note: 'Free days are a fraud vector — keep this gated.',
      },
      { key: 'subscriptions.pause', label: 'Pause a subscription', approvable: true, tiers: ['D', 'D', 'D', 'D', 'R', 'x', 'x'] },
      { key: 'subscriptions.cancel', label: 'Cancel a subscription', approvable: true, tiers: ['D', 'D', 'D', 'R', 'R', 'x', 'x'] },
      {
        key: 'subscriptions.discount.apply',
        label: 'Apply a discount',
        approvable: true,
        dangerous: true,
        tiers: ['D', 'D', 'D', 'R', 'R', 'x', 'x'],
        note: 'Bound by a max_discount_pct constraint where one is set.',
      },
      { key: 'subscriptions.plan.change', label: 'Change plan', approvable: true, tiers: ['D', 'D', 'D', 'D', 'R', 'x', 'x'] },
    ],
  },

  {
    module: 'payments',
    label: 'Payments',
    permissions: [
      {
        key: 'payments.view',
        label: 'View payments',
        scopes: [SCOPE.ALL, SCOPE.OWN],
        tiers: ['F', 'F', 'F', 'V', 'V', 'x', 'x'],
        roleScopes: { DESK: SCOPE.OWN },
      },
      {
        key: 'payments.record',
        label: 'Record a payment',
        approvable: true,
        tiers: ['D', 'D', 'D', 'D', 'R', 'x', 'x'],
        note: 'At REQUEST tier the cash lands in the collection box pending verification.',
      },
      { key: 'payments.verify', label: 'Verify a payment', tiers: ['A', 'A', 'A', 'x', 'x', 'x', 'x'] },
      { key: 'payments.refund', label: 'Issue a refund', approvable: true, dangerous: true, tiers: ['D', 'D', 'R', 'x', 'x', 'x', 'x'] },
      { key: 'payments.collection_box.view', label: 'View the collection box', tiers: ['F', 'F', 'F', 'V', 'V', 'x', 'x'] },
      {
        key: 'payments.collection_box.reconcile',
        label: 'Reconcile cash handover',
        tiers: ['D', 'D', 'D', 'x', 'x', 'x', 'x'],
        note: 'End-of-shift reconciliation. Manager and above.',
      },
    ],
  },

  {
    module: 'invoices',
    label: 'Invoices',
    permissions: [
      { key: 'invoices.view', label: 'View invoices', tiers: ['F', 'F', 'F', 'F', 'V', 'x', 'x'] },
      { key: 'invoices.generate', label: 'Generate an invoice', tiers: ['D', 'D', 'D', 'D', 'x', 'x', 'x'] },
      { key: 'invoices.send', label: 'Send an invoice', tiers: ['D', 'D', 'D', 'D', 'D', 'x', 'x'] },
      {
        key: 'invoices.void',
        label: 'Void an invoice',
        approvable: true,
        dangerous: true,
        tiers: ['D', 'R', 'R', 'x', 'x', 'x', 'x'],
        note: 'A financial record — stays at REQUEST tier even for an Org Admin.',
      },
      { key: 'invoices.download', label: 'Download an invoice', tiers: ['F', 'F', 'F', 'F', 'V', 'x', 'x'] },
    ],
  },

  {
    module: 'plans',
    label: 'Membership plans',
    permissions: [
      { key: 'plans.view', label: 'View plans', tiers: ['F', 'F', 'V', 'V', 'V', 'x', 'x'] },
      { key: 'plans.create', label: 'Create a plan', approvable: true, tiers: ['D', 'D', 'R', 'x', 'x', 'x', 'x'] },
      { key: 'plans.update', label: 'Edit a plan', approvable: true, tiers: ['D', 'D', 'R', 'x', 'x', 'x', 'x'] },
      {
        key: 'plans.price.update',
        label: 'Change plan pricing',
        approvable: true,
        dangerous: true,
        orgOnly: true,
        tiers: ['D', 'D', 'x', 'x', 'x', 'x', 'x'],
        note: 'Org-level by default. A branch admin changing prices is how revenue leaks.',
      },
      { key: 'plans.archive', label: 'Archive a plan', approvable: true, tiers: ['D', 'D', 'R', 'x', 'x', 'x', 'x'] },
    ],
  },

  {
    module: 'governance',
    label: 'Team & governance',
    permissions: [
      { key: 'team.view', label: 'View the team', tiers: ['F', 'F', 'F', 'V', 'x', 'x', 'x'] },
      {
        key: 'team.invite',
        label: 'Invite team members',
        tiers: ['D', 'D', 'D', 'x', 'x', 'x', 'x'],
        note: 'Always bounded by the inviter\'s own level — you cannot invite a peer or a superior.',
      },
      { key: 'team.role.assign', label: 'Change someone\'s role', tiers: ['D', 'D', 'D', 'x', 'x', 'x', 'x'] },
      { key: 'team.permission.override', label: 'Fine-tune individual permissions', tiers: ['D', 'D', 'x', 'x', 'x', 'x', 'x'] },
      { key: 'roles.manage', label: 'Manage custom roles', dangerous: true, tiers: ['D', 'D', 'x', 'x', 'x', 'x', 'x'] },
      { key: 'approvals.view', label: 'See the approval inbox', tiers: ['F', 'F', 'F', 'x', 'x', 'x', 'x'] },
      { key: 'approvals.decide', label: 'Approve or reject requests', tiers: ['A', 'A', 'A', 'x', 'x', 'x', 'x'] },
      {
        key: 'approvals.self_approve',
        label: 'Approve your own requests',
        dangerous: true,
        tiers: ['D', 'x', 'x', 'x', 'x', 'x', 'x'],
        note: 'Owner only, and every use is logged prominently.',
      },
      { key: 'branch.create', label: 'Create a branch', tiers: ['D', 'x', 'x', 'x', 'x', 'x', 'x'] },
      { key: 'branch.settings', label: 'Edit branch settings', tiers: ['D', 'D', 'D', 'x', 'x', 'x', 'x'] },
      { key: 'listing.manage', label: 'Manage the public listing', tiers: ['D', 'D', 'x', 'x', 'x', 'x', 'x'] },
      { key: 'audit.view', label: 'View the audit log', tiers: ['F', 'F', 'V', 'x', 'x', 'x', 'x'] },
      { key: 'payouts.view', label: 'View payouts', dangerous: true, orgOnly: true, tiers: ['F', 'x', 'x', 'x', 'x', 'x', 'x'] },
      {
        key: 'payouts.bank.manage',
        label: 'Manage bank details',
        dangerous: true,
        orgOnly: true,
        tiers: ['D', 'x', 'x', 'x', 'x', 'x', 'x'],
        note: 'Owner only. Never delegate bank details.',
      },
      { key: 'billing.manage', label: 'Manage the GymsEra subscription', dangerous: true, orgOnly: true, tiers: ['D', 'x', 'x', 'x', 'x', 'x', 'x'] },
    ],
  },

  {
    module: 'ledger',
    label: 'Collection ledger',
    permissions: [
      { key: 'ledger.today.view', label: "View Today's Ledger", tiers: ['F', 'F', 'F', 'F', 'V', 'x', 'x'] },
      {
        key: 'ledger.verify',
        label: 'Verify / reconcile ledger',
        tiers: ['A', 'A', 'A', 'x', 'x', 'x', 'x'],
        note: 'Marks collections reviewed and logs discrepancy/variance adjustments. Never edits a payment record.',
      },
      {
        key: 'ledger.close',
        label: "Close Today's Ledger",
        approvable: true,
        dangerous: true,
        tiers: ['D', 'D', 'R', 'x', 'x', 'x', 'x'],
        note: 'Finalizes the day. Closed days are immutable — corrections after close are reversal adjustments, never edits.',
      },
      { key: 'ledger.weekly.view', label: 'View Weekly Ledger', tiers: ['F', 'F', 'F', 'x', 'x', 'x', 'x'] },
      { key: 'ledger.monthly.view', label: 'View Monthly Ledger', tiers: ['F', 'F', 'F', 'x', 'x', 'x', 'x'] },
    ],
  },
];

// ── Derived indexes ──────────────────────────────────────────────────────────

/** Suffix appended to an approvable key to form its "act immediately" twin. */
const DIRECT_SUFFIX = '.direct';

/** @type {Map<string, object>} every base permission, keyed by permission key */
const PERMISSIONS = new Map();

/** @type {Map<string, string>} `.direct` twin → its parent key */
const DIRECT_TWINS = new Map();

for (const group of CATALOGUE) {
  for (const perm of group.permissions) {
    if (PERMISSIONS.has(perm.key)) {
      throw new Error(`[permissions] duplicate permission key: ${perm.key}`);
    }
    if (perm.tiers.length !== ROLE_ORDER.length) {
      throw new Error(`[permissions] ${perm.key} declares ${perm.tiers.length} tiers, expected ${ROLE_ORDER.length}`);
    }
    PERMISSIONS.set(perm.key, {
      ...perm,
      module: group.module,
      moduleLabel: group.label,
      approvable: perm.approvable === true,
      dangerous: perm.dangerous === true,
      orgOnly: perm.orgOnly === true,
      scopes: perm.scopes || [SCOPE.ALL],
    });
    if (perm.approvable) {
      DIRECT_TWINS.set(perm.key + DIRECT_SUFFIX, perm.key);
    }
  }
}

/** Every grantable key, base plus `.direct` twins. */
const ALL_PERMISSION_KEYS = [...PERMISSIONS.keys(), ...DIRECT_TWINS.keys()];

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Is this a key the system knows about (base or `.direct` twin)? */
const isKnownPermission = (key) => PERMISSIONS.has(key) || DIRECT_TWINS.has(key);

/** The catalogue entry for a key. `.direct` twins resolve to their parent. */
const getPermission = (key) => PERMISSIONS.get(DIRECT_TWINS.get(key) || key) || null;

/** `members.create` → `members.create.direct`. Returns null for non-approvable keys. */
const directKeyFor = (key) => {
  const perm = PERMISSIONS.get(key);
  return perm && perm.approvable ? key + DIRECT_SUFFIX : null;
};

/** `members.create.direct` → `members.create`. Returns the input for base keys. */
const baseKeyFor = (key) => DIRECT_TWINS.get(key) || key;

/** The wider of two data scopes, for unioning grants across several assignments. */
const widerScope = (a, b) => ((SCOPE_RANK[a] || 0) >= (SCOPE_RANK[b] || 0) ? a : b);

/**
 * The catalogue shaped for the permission-editor UI.
 * Flags travel with each permission so the client needs no hardcoded knowledge.
 */
const getCatalogueForClient = () =>
  CATALOGUE.map((group) => ({
    module: group.module,
    label: group.label,
    permissions: group.permissions.map((p) => ({
      key: p.key,
      label: p.label,
      approvable: p.approvable === true,
      dangerous: p.dangerous === true,
      orgOnly: p.orgOnly === true,
      scopes: p.scopes || [SCOPE.ALL],
      note: p.note || null,
    })),
  }));

module.exports = {
  CATALOGUE,
  PERMISSIONS,
  ALL_PERMISSION_KEYS,
  DIRECT_TWINS,
  DIRECT_SUFFIX,
  ROLE_ORDER,
  TIER,
  GRANTING_TIERS,
  DIRECT_TIERS,
  SCOPE,
  SCOPE_RANK,
  isKnownPermission,
  getPermission,
  directKeyFor,
  baseKeyFor,
  widerScope,
  getCatalogueForClient,
};
