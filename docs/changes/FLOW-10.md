# FLOW-10: Review Moderation Queue, Subscription Enforcement, and Controller Parameter Alignment

- **Issue ID**: FLOW-10
- **Title**: Reviews: moderation state, require an active or past subscription, fix the controller passing req.body as branchId.
- **Status**: RESOLVED
- **Root Cause**:
  - `src/controllers/discovery.controller.js:144`: `submitReview` invoked `discoveryService.submitReview(req.user.sub, req.params.id, req.body)`. `req.body` was passed as the 3rd parameter (`branchId`), causing the service to attempt destructuring `{ rating, title, body }` from `undefined`, throwing a 500 `TypeError: Cannot destructure property 'rating' of 'undefined'`.
  - `src/services/discovery.service.js:918-924`: Checked `MemberSubscription.findOne({ where: { userId, branchId } })` with no status filter, allowing users with unpaid `PENDING` or `CANCELLED` subscriptions to submit reviews.
  - `src/services/discovery.service.js:933,946`: Newly submitted reviews and edits to existing reviews were auto-assigned `status: 'APPROVED'`, bypassing the admin review moderation queue entirely. Editing a previously rejected review also automatically re-approved it.
  - `src/services/discovery.service.js:938`: `review` was assigned without being declared with `let review`, creating an implicit global.
  - `src/validators/discovery.validator.js:67-80`: Did not validate optional `branchId` and `text` in `submitReview` body schema.
- **Pattern Reused**:
  - Reused `SubscriptionStatus` enum constants (`ACTIVE`, `EXPIRED`, `FROZEN`) to ensure only members with active or past memberships can submit reviews.
  - Reused existing moderation queue (`GymReview.status = 'PENDING'` with admin moderation via `adminListReviews` and `moderateReview`).
  - Reused `_recalculateAverageRating` helper to recalculate branch & listing rating averages only on approved reviews.
- **Files Modified / Created**:
  - `src/controllers/discovery.controller.js`:
    - Updated `submitReview` to extract `{ branchId, rating, title, body, text }` from `req.body`, resolving `branchId` from `branchId || req.params.id` and body from `body || text`, correctly passing 4 arguments.
    - Updated `submitBranchReview` to accept either `text` or `body` and return standard success message `'Review submitted and pending approval'`.
  - `src/services/discovery.service.js`:
    - Fixed `MemberSubscription` verification to require `status: { [Op.in]: [ACTIVE, EXPIRED, FROZEN] }`.
    - Declared `let review = null` to resolve undeclared variable.
    - Set review `status: 'PENDING'` for all new submissions and edits to existing reviews.
    - Recomputed listing average rating if an existing review is edited back into pending moderation.
  - `src/validators/discovery.validator.js`:
    - Added optional `branchId` and `text` to `submitReview` validator schema.
  - `tests/regression/flow-10-reviews.test.js`:
    - Verified:
      1. Unpaid `PENDING` subscription is rejected with 403 `active or past membership`.
      2. `POST /discovery/gyms/:id/reviews` succeeds without crashing on `branchId` parameter.
      3. New reviews are created with `status: 'PENDING'`.
      4. Editing an existing review resets status to `PENDING` for re-moderation.
      5. Admin moderation approves review and updates average rating.
- **Client Impact**:
  - No breaking contract changes: released mobile app uses `POST /discovery/branches/:branchId/reviews` with `{ rating, text, title }`, which now succeeds with 201 and places review in moderation queue.
  - Web & Swagger clients calling `POST /discovery/gyms/:id/reviews` now work without crashing.
  - Public review listings only display `APPROVED` reviews, ensuring brand safety.
- **Migration & Deploy Order**:
  - No schema migrations required (status enum already supported 'PENDING', 'APPROVED', 'REJECTED' on `gym_reviews`).
  - Code can be deployed independently.
