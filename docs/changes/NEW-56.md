# NEW-56: Member lookup returns the member's active subscriptions

## Issue
A team member with `checkins.manual.create` but not `subscriptions.view` gets 403 from `GET /subscriptions/staff`, so the CMS Manual Check-in dialog cannot find a subscription id to send to `POST /attendance/manual`.

## Root cause
- `src/routes/subscriptions.routes.js:213`: `GET /subscriptions/staff` is guarded by `can.atAnyBranch('subscriptions.view')`.
- `src/routes/attendance.routes.js:85-93`: `POST /attendance/manual` is guarded by `can('checkins.manual.create')` and needs `subscriptionId`.
- The only call that gave a check-in clerk a subscription id was the one they may not make. The default Front Desk preset holds both keys, but a role with `subscriptions.view` denied (or a custom role) does not.

## Pattern reused
`GET /host/branches/:branchId/members/lookup` (`src/routes/host.routes.js:100`, `host.controller.js:1430`), guarded by `authorize('GYM_HOST','BRANCH_MANAGER')` + `can('members.view')` at the path's branch (NEW-52). The guard is unchanged.

## Validity rules (the ones check-in uses)
`attendance.service.js:6-25` `_validateSubscription`, which `manual()` calls (`:170`):
1. `status === ACTIVE`;
2. `today <= endDate` (today is the UTC date `new Date().toISOString().split('T')[0]`);
3. `remainingVisits === null` (unlimited) or `> 0`.

`attendance.service.js:30` `isCheckinValid(subscription, today)` is the same three rules as a read-only predicate (the existing function throws and decrements, so it cannot be reused for listing). The lookup filters with it. Keep the two in step.

Not included: the branch billing lock (`assertBranchCheckinAllowed`, `manual()`), which is a property of the branch, not of a subscription. Check-in still enforces it and answers with its own error.

## Fix
`host.controller.js` `lookupBranchMember` adds `subscriptions` to every 200 response:

```json
{ "exists": true, "user": { ... }, "subscriptions": [
  { "id": "…", "planName": "Monthly", "endDate": "2026-11-01", "remainingVisits": null }
] }
```

- ACTIVE subscriptions of that user at that branch, filtered by `isCheckinValid`, ordered by `endDate`.
- Only `id`, `planName`, `endDate`, `remainingVisits`. No price, payment, invoice, QR code or other branch's data.
- Unknown email, or a user with no valid subscription: `[]`. The existing `exists` / `user` fields keep their meaning (`exists` is still true for ACTIVE, PENDING or FROZEN at the branch).
- Not changed: `GET /subscriptions/staff`, `POST /attendance/manual`, `/attendance/check-in`, and the lookup guard.

## Tests
`tests/regression/new-56-member-lookup-subscriptions.test.js` (12 tests). Written first; with the source change stashed 11 failed and 1 passed (the cross-branch 403 control).

| Case | Expected |
|---|---|
| Manager of branches A, B, C, each branch | 200, that branch's subscription id and plan name |
| Manager of A only | 200 at A (positive control); 403 at B |
| Front Desk with `subscriptions.view` DENIED | `GET /subscriptions/staff` 403; lookup 200 with the ids; lookup at B 403 |
| Owner | 200 at all three |
| Member with valid, unlimited, expired, zero-visit, frozen and other-branch subscriptions | only the valid and the unlimited one, with `remainingVisits` 3 and null |
| Item keys | exactly `id, planName, endDate, remainingVisits` |
| Known user, no subscription | `exists: false`, `user` present, `subscriptions: []` |
| Unknown email | `exists: false`, `subscriptions: []` |
| Id from the lookup sent to `POST /attendance/manual` | 201 |

Neighbouring suites `new-51` and `new-52` (which call this route) still pass.

## Result
Full suite (`npm test`, Docker MySQL on :3308, local Redis) three times: 149 suites, 1389 tests, all pass on each run. Run 3 used `DISABLE_REDIS=true`. No live database was touched.
