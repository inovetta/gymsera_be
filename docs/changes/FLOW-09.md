# FLOW-09: Attendance QR Rotating Signed Tokens, Raw ID Rejection, and Configurable Duplicate Window

- **Issue ID**: FLOW-09
- **Title**: Attendance QR: rotating signed token, reject raw subscriptionId/userId, duplicate window.
- **Status**: RESOLVED
- **Root Cause**:
  - `src/services/attendance.service.js:37-48`: In `qrScan`, the backend accepted raw `subscriptionId` or raw `userId` in place of a QR code:
    ```javascript
    let subscription = await MemberSubscription.findOne({ where: { qrCode } });
    if (!subscription) subscription = await MemberSubscription.findByPk(qrCode);
    if (!subscription) subscription = await MemberSubscription.findOne({ where: { userId: qrCode, status: SubscriptionStatus.ACTIVE } });
    ```
    This allowed members to check in using screenshotted static QR codes or knowing a UUID, completely circumventing physical presence verification.
  - `src/validators/attendance.validator.js:5-8`: Checked `qrCode` with max length 100 characters, rejecting cryptographically signed JWT QR tokens.
  - Static 5-minute duplicate check-in window was hardcoded (`Date.now() - 5 * 60 * 1000`) instead of allowing branch configuration or environment override.
- **Pattern Reused**:
  - Reused HMAC-SHA256 JWT signing (`jwtConfig.secret`) with 60s TTL for rotating tokens.
  - Reused `ensureRedisReady()` with fallback to in-memory `Map` (for `DISABLE_REDIS=true` and single-process Windows IIS environments) for nonce replay protection (120s TTL).
  - Reused standard `createError` response format and `AttendanceLog` check-in recording.
- **Files Modified / Created**:
  - `src/utils/qr.utils.js`:
    - Implemented `generateAttendanceQrToken({ subscriptionId, userId, tenantId, branchId }, ttlSeconds = 60)` with random 16-byte nonce.
    - Implemented `verifyAttendanceQrToken(token)` with signature verification, token expiration handling (401 `QR_EXPIRED`), and atomic nonce caching (409 `QR_ALREADY_USED`).
  - `src/validators/attendance.validator.js`:
    - Updated `qrCode` max length to 1000 to accommodate signed JWT tokens.
  - `src/services/attendance.service.js`:
    - Updated `qrScan` to strictly reject raw UUIDs and legacy static `GE-` tokens with 400 Bad Request.
    - Verified signed rotating token via `verifyAttendanceQrToken`.
    - Made duplicate check-in window configurable: checks `branch.duplicateCheckinWindowMinutes ?? process.env.DUPLICATE_CHECKIN_WINDOW_MINUTES ?? 5`.
  - `src/services/subscription.service.js`:
    - Attached dynamically generated rotating signed QR token in `getMySubscriptionDetail` when membership is `ACTIVE`.
    - Added and exported `getSubscriptionQrToken(userId, subscriptionId)`.
  - `src/controllers/subscriptions.controller.js`:
    - Added `getSubscriptionQrToken` handler.
  - `src/routes/me.routes.js` & `src/routes/subscriptions.routes.js`:
    - Added `GET /subscriptions/:id/qr-token` route.
  - `tests/regression/flow-09-attendance-qr.test.js`:
    - Verified all 7 regression scenarios (raw subscriptionId rejection 400, raw userId rejection 400, valid rotating token check-in 201, replayed nonce rejection 409, expired token rejection 401, duplicate check-in within window rejection 409, member self-serve endpoints 200).
- **Client Impact**:
  - Released mobile app (`qr_full_screen.dart`): queries `GET /api/v1/me/subscriptions/:id` and reads `sub.qrCode`. Because the backend dynamically attaches the rotating signed token, released mobile app displays the rotating QR token without client changes.
  - Released host scanner (`qr_scanner_screen.dart`): reads the displayed QR code string and sends `POST /api/v1/attendance/qr-scan` with `{ qrCode, branchId }`, which processes cleanly.
  - Old / offline app behavior: If an old app cached an offline subscription with raw `widget.subscriptionId` or a member attempts to scan a static screenshot or raw UUID, the backend responds with HTTP 400 (`Invalid QR code. Raw subscription or user IDs are not permitted for check-in. Please use the rotating QR code in the app.`). The member simply opens the app online to display the rotating QR.
- **Grace Mode (`ATTENDANCE_LEGACY_QR_UNTIL`)**:
  - `ATTENDANCE_LEGACY_QR_UNTIL` must be set **explicitly** in the environment to an ISO date string (e.g. `2026-12-05T00:00:00.000Z`).
  - If `ATTENDANCE_LEGACY_QR_UNTIL` is **unset** or **invalid**, grace mode is strictly **OFF**, and raw IDs / static QR codes are rejected with HTTP 400 immediately.
  - When explicitly configured and active (`Date.now() <= legacyUntil`):
    - Raw subscription ID, user ID, and static `GE-` formats are resolved using the legacy database lookup.
    - Each legacy scan is logged for auditability (`[Attendance] Legacy QR scan accepted under grace mode: branchId=..., subscriptionId=...`) with no personal data (no email, names, or phone numbers).
  - After the grace date has passed (`Date.now() > legacyUntil`):
    - Raw IDs and static codes are strictly rejected with HTTP 400 (`Invalid QR code. Raw subscription or user IDs are not permitted for check-in. Please use the rotating QR code in the app.`).
- **Migration & Deploy Order**:
  - No database migration required.
  - Backend can be deployed immediately.

