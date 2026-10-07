# NEW-45: permission enforcement on the /gyms routes (follow-up to NEW-44 item 3)

- **Issue ID**: NEW-45
- **Title**: member enrolment, member search, the gym profile, image uploads and branch detail did not follow the permission catalogue
- **Status**: backend items (a)–(e) and CMS items (f), (g) below
- **Root cause (shared)**: `src/routes/gyms.routes.js:13` guards the whole router with `authorize('GYM_HOST','BRANCH_MANAGER')`. The legacy role shim (`src/middleware/tenantContext.js:41-82`, called at `:298`) gives every team member `BRANCH_MANAGER`, so every handler below ran for any team member with at most an ad-hoc check.

## (a) POST /gyms/members/enroll → `members.create` through `approvalService.perform`

- **Root cause**: `gyms.controller.js#enrollMember` called `gymService.enrollMember` directly: no permission, no approval tier. A Trainer or Support account could enrol members (and create platform accounts).
- **Fix**: the handler builds the same context the other approvable routes use (`payments.controller.js` refund, `actions.controller.js`) and calls `approvalService.perform(ctx, 'members.create', body)`; the existing `members.create` command (`services/commands/member.commands.js`) validates and executes, so there is one enrolment path. Tiers (catalogue): Owner, Org Admin, Manager, Branch Admin = DIRECT → `201`, same body as before (`user`, `subscription`, `payment`, `userCreated`, plus an `id`); Front Desk = REQUEST → `202 { approvalRequestId, status: 'PENDING', summary }`; Trainer, Support, or a branch they are not assigned to → `403`. A body with no `branchId` or `planId` is `400` (it was a 500).
- **Owner path**: a host account (`role GYM_HOST` or `isHost`) keeps owner grants (`accessService.ownerGrants()`), exactly as the other branch checks treat it.
- **Behaviour change to know**: a team member who holds `members.create.direct` now enrols as host-level (payment auto-completed), the same as `POST /actions/members.create`; before, the shim's `BRANCH_MANAGER` role left the payment pending.
- **Test**: `tests/regression/new-45-enroll-members-create.test.js`.
- **Clients**: CMS `members/page.tsx:79` and mobile `host_members_tab.dart:544` (`gyms_repository.dart:875-896`) send `{email, fullName?, phone?, planId, branchId, startDate?, notes?, paymentMethod?}`: both already send `branchId` and `planId`, so no request change. Owners get the same 201 body. Neither client handles `202`: the mobile screen would say "Member enrolled successfully" for a Front Desk user, and the CMS toast likewise reads `res.data.userCreated`. Today only owners reach these screens in normal use; a follow-up should show the pending notice (the CMS has `SubmittedForApprovalNotice` / `readApprovalOutcome` from Prompt 3A).

## (b) GET /gyms/profile hides `paymentDetailsJson` unless the caller has `payouts.bank.manage`

- **Root cause**: `gym.service.js:159-168` adds the tenant's `paymentDetailsJson` (bank details) to the profile; `gyms.controller.js#getProfile` returned it to every team member. Only the write side (`updateProfile`, SEC-13) checked `payouts.bank.manage`.
- **Fix**: `getProfile` resolves the caller's organization-wide grants (same as `updateProfile`) and removes the field unless the caller is the owner or holds `payouts.bank.manage` (owner-only in the catalogue). The rest of the profile is unchanged.
- **Test**: `tests/regression/new-45-profile-bank-details.test.js` (Front Desk, Branch Manager, Org Admin: field absent; owner: present).
- **Clients**: the CMS profile page reads `getGymProfile` (`gym.ts:67`, `gym/profile/page.tsx:47`) and does not use `paymentDetailsJson`; the mobile app's host payment details come from other routes (`host_payment_details`, `me_repository.dart`), not from `/gyms/profile`. Owners see no change.

## (c) GET /gyms/members/search requires `members.create`

- **Root cause**: `gyms.routes.js` (`/members/search`) had no check beyond the role guard, and `gymService.searchMember` looks up any platform user by e-mail (id, name, phone, status, photo). Any team member, a Trainer or Support account included, could use it as a user directory.
- **Fix**: the route uses `can.atAnyBranch('members.create')` (NEW-44): held at one branch or more, or organization-wide; owner and host unchanged. Front Desk (needs-approval tier) can search because they can start an enrolment.
- **Not changed**: what a permitted caller sees about the found user (phone, status). Narrowing it is a separate decision.
- **Test**: `tests/regression/new-45-member-search.test.js`.
- **Clients**: CMS `members/page.tsx:117` and mobile `host_members_tab.dart:455` (`gyms_repository.dart:866`), both the enrol dialog's e-mail lookup. Owners see no change.

## (d) Profile writes and image routes need `listing.manage` / `branch.settings`

- **Root cause**: the routes below had only the role guard (`gyms.routes.js:13`): any team member could change the gym's public profile and logo, cover and gallery, and add or delete any branch's photos. (Bank details already needed `payouts.bank.manage` plus re-auth, SEC-13.)
- **Fix** (`src/routes/gyms.routes.js`, using the existing `can()` middleware, placed before the upload middleware so a refused request never reaches storage):
  - `POST /gyms/profile/logo`, `/profile/cover`, `/profile/images`, `DELETE /gyms/profile/images`, `PATCH /gyms/profile` → `can('listing.manage', { orgWide: true })` (Owner and Org Admin; Branch Manager and below are refused).
  - `POST` and `DELETE /gyms/branches/:branchId/images` → `can('branch.settings')`, the branch taken from the URL, so it applies at that branch only.
- **Test**: `tests/regression/new-45-listing-image-permissions.test.js` (Front Desk and Branch Manager refused on every profile write; Org Admin and owner pass; branch images refused at a branch the Manager is not assigned to). Image routes are called without a file, so nothing is stored.
- **Clients**: mobile `edit_organization_screen.dart` (`gyms_repository.dart:392-416`, `:647-690`) and CMS `gym/profile/page.tsx` / `branches/[id]/page.tsx:117,127` — owner screens; owners and Org Admins are unchanged. A Branch Manager can no longer change the organization's profile or logo (they never should have been able to) but keeps their own branch's photos.
- **Edge**: the check resolves grants for the account; a host account that is not the tenant's `ownerUserId` and has no assignment has no `listing.manage` here. The tenant owner always does.

## (e) GET and PATCH /gyms/branches/:branchId use `branch.settings` at the branch

- **Root cause**: `gyms.controller.js:72` asked `hasBranchAccess(req, branchId, 'branches.view')` and `:84` asked `'branches.manage'`. Neither key exists in `src/constants/permissions.js` (the catalogue has `branch.create` and `branch.settings`), so for everyone but the owner/host the answer was always "no" and the handler answered 404: an Org Admin and a Branch Manager could not open or edit a branch they run.
- **Fix**: both checks use `branch.settings` (Owner, Org Admin, Manager = DIRECT; Branch Admin and below = none), at the branch in the URL. A denied caller still gets 404 ("Branch not found"), not 403, because the SEC-01 IDOR matrix requires ids not to be probeable.
- **Test**: `tests/regression/new-45-branch-detail-permissions.test.js` (Manager of A reads and edits A, gets 404 for B; Front Desk gets 404 even at their own branch; Org Admin reads any branch; owner unchanged).
- **Clients**: CMS `branches/[id]/page.tsx:80` (`getBranch`) and `branches/page.tsx:167` (`updateBranch`); mobile `gyms_repository.dart:689`, `:709`. Owners are unchanged. Org Admins and Managers gain access they should have had; nothing that worked stops working.
