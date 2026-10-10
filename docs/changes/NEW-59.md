# NEW-59: payouts balance and list routes missing permission check

- **Issue ID**: NEW-59
- **Title**: `GET /host/payouts/balance` and `GET /host/payouts` have no permission check
- **Status**: RESOLVED

## Root cause

In `src/routes/host.routes.js:18-19`, the routes:
- `GET /host/payouts/balance`
- `GET /host/payouts`
were guarded only by `authenticate, tenantContext`. There was no permission check or role guard. Any authenticated team member in the tenant context (including Front Desk, Trainers, or Support) could view the tenant's payout balance and payout history.

In `docs/PERMISSIONS.md:171` and `src/constants/permissions.js:374`:
- Key: `payouts.view`
- Label: `View payouts`
- Flags: `dangerous: true, orgOnly: true`
- Tiers: `['F', 'x', 'x', 'x', 'x', 'x', 'x']` (Owner-only full access; OFF for all other standard roles).
Bank details (`payouts.bank.manage`, `PERMISSIONS.md:172`) remain guarded separately on bank details management.

## What changed

In `src/routes/host.routes.js:18-19`:
Added `can('payouts.view', { orgWide: true })` middleware to both:
- `GET /host/payouts/balance`
- `GET /host/payouts`

## Tests

`tests/regression/new-58-59-60-payouts-reports-collected.test.js`:
- Owner works on `/host/payouts/balance` and `/host/payouts` (positive control, 200).
- Manager without `payouts.view` gets 403.
- Front Desk without `payouts.view` gets 403.
- Org Admin without `payouts.view` gets 403.

## Clients that might depend on old behaviour

- **CMS**: Prompt 3C added the Payouts page and gated the sidebar menu entry by `payouts.view`. Non-owners accessing the direct URLs will now be rejected by the backend with 403 instead of 200.
- **Mobile**: Mobile `payoutsProvider` in `analytics_provider.dart` holds mock state only and does not call `/host/payouts`. No impact.
