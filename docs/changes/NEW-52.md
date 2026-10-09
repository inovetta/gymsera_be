# NEW-52: Branch scoping on the remaining /host/branches/:branchId/* routes and GET /reports/branch/:branchId

- **Issue ID**: NEW-52
- **Status**: RESOLVED on branch `fix/new-52` (from `origin/main` at c06d82e, which includes NEW-51; not pushed). Suite counts in §8.
- **Worktree**: built in its own checkout (`gymsera_be_new52`); no other folder's branch was switched. No database scan was run; the tests use the local Docker MySQL harness only.

## 1. Audit (unpatched `origin/main`)

Middleware order on every route below was already `authenticate, tenantContext, authorize('GYM_HOST', 'BRANCH_MANAGER')` (`tenantContext` before `authorize`), so team members whose account role is MEMBER reach the handler. The gap was what happens next: nothing asked whether the caller holds a permission at *this* `:branchId`.

| Route | Route line | Guards before | Branch/permission check in controller or service | Verdict |
|---|---|---|---|---|
| `GET /host/branches/:branchId/members/lookup` | `host.routes.js:100` | auth, tenant, authorize | none (`host.controller.js:1421` `lookupBranchMember` only reads `req.params.branchId` into a query) | **GAP** |
| `POST /host/branches/:branchId/members` | `:101` | same | none (`host.controller.js:1475` -> `gymService.enrollMember`, which checks branch exists/active and plan, not the caller) | **GAP** |
| `GET /host/branches/:branchId/members` | `:102` | same | none (`host.controller.js:1152`, only "branch exists and is ACTIVE") | **GAP** |
| `GET /host/branches/:branchId/announcements` | `:104` | same | none (`host.controller.js:1303`) | **GAP** |
| `POST /host/branches/:branchId/announcements` | `:105` | same | none (`:1324`; also publishes by default, `status: status \|\| 'sent'`) | **GAP** |
| `DELETE /host/branches/:branchId/announcements/:announcementId` | `:106` | same | none (`:1350`) | **GAP** |
| `GET /host/branches/:branchId/schedule` | `:107` | same | none (`:1373`) | **GAP** |
| `POST /host/branches/:branchId/schedule` | `:108` | same | none (`:1394`) | **GAP** |
| `PATCH /host/branches/:branchId/resubmit-visibility` | `:109` | same | none (`:1490`, `Branch.findByPk` then update) | **GAP** |
| `GET /reports/branch/:branchId` | `reports.routes.js:160` | same | none (`reports.controller.js:157` -> `reports.service.js:349`, which returns members, revenue, attendance, staff count, plan distribution for the URL's branch) | **GAP** |
| `GET /host/branches/:branchId/expenses` | `host.routes.js:27` | auth, tenant, authorize | `expenses.controller.js:174` `hasExpenseAccess(req, branchId, 'expenses.view')` (resolves grants at that branch, `:73-90`) | GUARDED |
| `POST .../expenses` | `:28` | same | `:285` `expenses.create.direct`, else `:323-324` `expenses.create.request`/`expenses.create` (request tier), else 403 | GUARDED |
| `GET .../expenses/summary` | `:29` | same | `:582` `expenses.view` | GUARDED |
| `GET .../expenses/:expenseId` | `:30` | same | `:404` `expenses.view` | GUARDED |
| `PATCH .../expenses/:expenseId` | `:31` | same | `:441` `expenses.delete` (there is no `expenses.update` key; existing choice, left alone) | GUARDED |
| `DELETE .../expenses/:expenseId` | `:32` | same | `:534` `expenses.delete` | GUARDED |
| `GET .../dashboard`, `GET .../checkins` | `:99`, `:103` | + `can('dashboard.view')`, `can('checkins.view')` | NEW-51 | GUARDED |
| `POST .../move`, `POST .../restore`, `GET/PATCH .../listing-content`, `DELETE /host/branches/:branchId` | `:51-52, 72-96` | `authenticate, authorize('GYM_HOST'), tenantContext` | owner-only by role, no team member can reach them (`DELETE` also re-asks credentials, `gyms.controller.js:111`) | GUARDED (owner-only) |

Routes taking a `branchId` from query/body and using it with no check, in the host surface I read:

| Route | Where | Verdict |
|---|---|---|
| `GET /gyms/members?branchId=` | `gyms.controller.js:283` `hasBranchAccess(... 'members.view')` | GUARDED (NEW-48) |
| `GET /reports/weekly-attendance?branchId=` and the other list routes | `resolveBranchScope` (NEW-49/50/51) | GUARDED |
| `POST /host/branches/:branchId/members` body `branchId` | the body field is overwritten by the URL's (`host.controller.js:1480` `{ ...req.body, branchId }`), so the URL is the only branch | covered by the fix below |
| `POST /staff/branches/:branchId/action-requests`, `GET /host/branches/:branchId/action-requests`, `GET /staff/branches/:branchId/my-expenses` | `staff-actions.routes.js:101, 175, 411` | Not in scope; they check the caller is active staff at `:branchId` (`_resolveActiveStaff`, `:15-50`). Not changed. |

## 2. Keys (from `docs/PERMISSIONS.md`)

| Route | Key | Citation |
|---|---|---|
| members list, lookup | `members.view` | `PERMISSIONS.md:61` |
| members POST | `members.create` | `:63` |
| announcements GET | `announcements.view` | `:85` |
| announcements POST | `announcements.create` (route), plus `announcements.publish` when the post is not a draft | `:86-87` |
| announcements DELETE | `announcements.delete` | `:89` |
| schedule GET | `schedule.view` | `:95` |
| schedule POST | `schedule.class.create` | `:96` |
| resubmit-visibility | `branch.settings` (Owner, Gym Admin, Manager) | `:168` (the "Edit branch settings" row) |
| `GET /reports/branch/:branchId` | `dashboard.revenue.view` | `:54`, same key NEW-44 put on `/reports/dashboard` and `/reports/yearly`: the report carries revenue |

No route lacked a key, so there was nothing to stop and ask about. Three choices to flag, all reversible by changing one string:

- **Announcement POST** is the only route where two keys fit. The catalogue says the draft/publish split "is itself the approval gate for member comms" (`src/constants/permissions.js:181`). The handler's default status is `sent` (it goes straight to members), so the route gate is `announcements.create` and the controller additionally requires `announcements.publish` at that branch unless `status` is `draft`. Front Desk and Trainer (create on Request tier, no publish) can draft but not publish. Before this change they could publish.
- **Branch report** uses `dashboard.revenue.view`, not `dashboard.view`, because it returns revenue. A role with `dashboard.view` only (Front Desk, Trainer) now gets 403 on it; their dashboard route (`GET /host/branches/:branchId/dashboard`) is unchanged and masks revenue itself.
- **POST members** uses `members.create`. A Front Desk holds it on the Request tier (`PERMISSIONS.md:63`), and `can()` checks holding the key, so a Front Desk can still enrol directly through this legacy route. Same caveat as NEW-51's manual check-in; moving it onto the approval engine (as `POST /gyms/members/enroll` does since NEW-45) is a separate decision.

## 3. Fix

- Routes: `authenticate, tenantContext, authorize('GYM_HOST', 'BRANCH_MANAGER'), can(<key>)`. `can()` takes the branch from `req.params.branchId` (its default lookup) and runs `hasAllBranches` first, so the owner, platform admin and `isHost`/`isOwner` callers pass everywhere; an org-scope role (Gym Admin) resolves the key at every branch. 403 "You do not have permission to ..." otherwise. `host.routes.js:100-102, 104-109`, `reports.routes.js:160`.
- `host.controller.js` `createBranchAnnouncement`: the `announcements.publish` check described above, via the existing `hasBranchAccess` (new import, `host.controller.js:13`).
- Nothing new built. These are the NEW-44/49/51 pieces (`can`, `hasBranchAccess`). No list spans branches on these routes (each has `:branchId` in the URL), so `resolveBranchScope` was not needed.
- Expenses: unchanged (already guarded, see the table).

## 4. Behaviour changes to know about

- A manager of branch A can no longer list/enrol members, read/post/delete announcements, read/create schedule entries, resubmit visibility, or read the branch report for branch B. 403.
- A role with the key off gets 403 at its own branch (for example a Trainer, who has no `members.create` or `announcements.delete`).
- Front Desk / Trainer can no longer publish an announcement (draft still works).
- Front Desk / Trainer / Branch Admin: `GET /reports/branch/:branchId` is 403 unless the key is on (Branch Admin has `dashboard.revenue.view` as View).
- `GET .../members/lookup` returns any platform user's name, email and phone by email, so it now needs `members.view` at the branch; Support has no `members.view` and is now 403.

## 5. Same gap, found and NOT changed

| Item | Where | Note |
|---|---|---|
| `GET /host/inbox/*`, `POST /host/inbox/*` | `host.routes.js:112-116` | `authorize('GYM_HOST')` only, owner-only; `branchId` is not a route param. Not read in depth. |
| `PATCH .../expenses/:id` uses `expenses.delete` as its key | `expenses.controller.js:441` | No `expenses.update` key exists; left as is. A role that can delete can edit. |
| `hasExpenseAccess` ignores `isOwner`/`PLATFORM_ADMIN` | `expenses.controller.js:73-76` | Falls through to `accessService.resolve`, which returns owner grants for the tenant owner (`access.service.js:190`), so owners work (locked by the owner tests). A platform admin without a role assignment would be 403; unchanged. |
| Root-level tests never run | `tests/access.test.js`, `admin.test.js`, `approval-collect.test.js`, `auth.test.js`, `commands.test.js`, `discovery.test.js`, `expenses-access.test.js`, `host.test.js`, `ledger.test.js`, `me.test.js`, `member.test.js`, `payments-access.test.js`, `verify-payment-invoice.test.js` | `jest.config.js` `testMatch` only covers `tests/integration` and `tests/regression`. I moved only `dashboard-access.test.js` (asked). The others are unrun; not checked whether they pass. |
| `gyms.routes.js` staff/branch routes (`/branches/:branchId/staff`, `/branches/:branchId/images`) | `gyms.routes.js:223-224, 244, 281, 309` | Outside the `/host/branches` list I was given; partly guarded (`can('branch.settings')`, `team.view` in controller). Not audited here. |
| Items listed in `NEW-49.md` §5 / `NEW-50.md` §5 / `NEW-51.md` §7 not in this issue | | Subscription, trainer and plan writes; `GET /subscriptions/staff/:id`; `tenantContext.js:81` legacy `user.branchId`; `GET /reports/dashboard` not re-read. |

## 6. Clients that might depend on the old behaviour

Read-only search, no client code changed.

- **Mobile (`gyms_era`)**: `lib/features/gym_host/data/repositories/gyms_repository.dart:62-195` calls members, lookup, announcements (GET/POST/DELETE), schedule (GET/POST); `:547` calls `resubmit-visibility`; `lib/features/me/data/repositories/workspace_repository.dart:65, 158` calls members and lookup. A staff user who opened another branch by id will now get 403; announcement compose for a Front Desk / Trainer with `status: sent` will now get 403 (send `draft` or hide the publish button on `announcements.publish`).
- **CMS (`gymsera_cms`)**: I did not find `reports/branch` or these host branch routes in a quick search; not confirmed either way. Worth a check by the CMS owner.
- **Web (`gymsera_web`)**: no calls found.

## 7. Tests

`tests/regression/new-52-host-branch-routes-scope.test.js`: 211 tests.

Per route (10 fixed routes plus 6 expenses routes locked): manager of three works at each of A/B/C; manager of one works at own branch (positive control) and gets 403 at B and C with no row written (member subscription, announcement, class, visibility history, expense counts compared before/after); a manager of A with the route's key DENIED gets 403 at A; org-wide Gym Admin works at all three; owner works at all three. Plus three tests for announcement publishing (manager publishes, manager-of-one blocked at B, Front Desk drafts 200 / publishes 403 with "publish" in the message).

**Before the fix (source untouched, test file new): 32 failed, 179 passed.** The 32 are exactly the 10 gap routes x 3 cross-branch/denied cases, plus 2 announcement-publish cases. All positive controls and all expenses tests passed unpatched (expenses were already guarded). **After the fix**: 211/211.

`tests/dashboard-access.test.js` was moved to `tests/regression/dashboard-access.test.js` (`git mv`; only its `../src` paths changed to `../../src`). It runs and passes (4 tests); it calls the controller directly with a mocked access service.

## 8. Full suite

`jest --runInBand`, local Docker MySQL:

| Run | Suites | Tests |
|---|---|---|
| 1 | 141 passed / 141 | 1276 passed / 1276 |
| 2 | 141 passed / 141 | 1276 passed / 1276 |
| 3 (`DISABLE_REDIS=true`) | 141 passed / 141 | 1276 passed / 1276 |

The NEW-51 baseline was 139 suites / 1061 tests; the difference is this issue's new file (211) and the moved `dashboard-access.test.js` (4) = 2 suites, 215 tests.

Not committed: `.env` (copied in so the harness reaches local Docker MySQL; gitignored) and a `node_modules` symlink to the main checkout.
