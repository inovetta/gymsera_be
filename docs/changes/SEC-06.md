# SEC-06: unknown request fields (stage 1 done, inventory of the rest)

Branch `fix/sec-06-unknown-fields`. Generated 2026-10-21 from the running router (214 mutating routes) and the client sources (CMS, web, mobile: 276 `post/put/patch/delete` calls).

## What changed in stage 1

- `validate.strict(chains, { allow })` in `src/middleware/validate.js`: `validate()` plus a check that every top-level key of `req.body` is named by a chain (or in `allow`). An unknown key gives **422 `validation_error`** with one `{ field, message: 'Unknown field', code: 'unknown_field' }` entry per key, together with any ordinary validation errors.
- `UNKNOWN_FIELDS_MODE` = `reject` (default) | `log` (accept, log `[unknown-fields] METHOD path would be rejected: a, b`) | `off`. **Old app builds may still send fields this source no longer sends: run `log` for a while first.**
- Applied to the 41 validated mutating routes of the routers below. Only top-level keys are checked (nested objects are not).
- Routers: `/auth` (register, login, otp verify / resend, social google, google staff, refresh), `/cities`, `/discovery`, `/subscriptions`, `/membership-plans`, `/attendance`, `/admin/billing-plans`, `/admin/devices`, `/devices`.
- Test `tests/regression/sec-06-unknown-fields.test.js` (red before). Fixture `tests/fixtures/sec-06-stage1-client-bodies.json` holds the keys the clients send to each stage-1 route; the test fails if a validator stops declaring one.

## Totals

| Stage | Routes |
|---|---|
| 1 (done) | 41 |
| 2 (declare, then strict) | 18 |
| 2 (router not clean) | 24 |
| 3 (multipart) | 23 |
| 3 (write allow-list) | 102 |
| never (signed / device) | 6 |
| **all mutating routes** | 214 |

Stage 2 = a validator exists; clients send a field it does not declare (or the client body could not be read), so the validator must be fixed first. Stage 3 = no validator at all: an allow-list has to be written from what the handler reads. Multipart routes need the multer field names. Webhooks and device routes are signed and never get this check.

## Problems the inventory found (not fixed here)

- **Clients send fields the server validator does not declare** (strict would break them; today the server ignores or reads them unvalidated): `POST /tenants/register` `areaId` (web, app); `POST /tenants/:id/gym-profile` `latitude`, `longitude`; `POST /platform-packages` `featureFlags` (the validator has `featureFlagsJson`); `PATCH /gyms/profile` `address, category, email, establishedYear, imagesJson, latitude, longitude, phone, tagline`; `POST /gyms/branches` `facilities` (validator: `facilitiesJson`); `PATCH /gyms/branches/:branchId` `facilities`, `status`; `POST /host/branches` `country`, `gymListingId`; `POST /payments` `branchId`, `shift`; `PATCH /trainers/:id` `branchId`; `POST /users` `role`; `POST /admin/tenants/:id/invoices` `description, notes, tenantSubscriptionId`; `PATCH /admin/tenants/:id/invoices/:invoiceId` `notes, paidAt`.
- **Client and server disagree on names today (a real bug, independent of SEC-06; the web reset, mobile admin reset and web profile ones are fixed below):** web `PATCH /me/profile` sends `height`, `weight`, `allergies`, `foodPreferences` but the validator knows `heightCm`, `weightKg`; mobile `POST /users/:id/password` sends `password`, the validator wants `newPassword`; the web password-reset confirm sends `{ email, otp, newPassword }` but `POST /auth/password-reset/confirm` wants `{ email, code, password }`; the CMS reset-confirm sends `{ token, newPassword }`.
- **Client calls with no server route** (they 404 today): CMS `POST /auth/forgot-password` and `POST /auth/reset-password`; CMS `/gyms/trainers*` (NEW-41); CMS `PATCH /users/:id`, `PATCH /users/:id/status`, `POST /users/:id/reset-password` (the server has `PUT /users/:id` and `POST /users/:id/status`); CMS `PATCH /membership-plans/:id/toggle-status` (the server has `POST /membership-plans/:id/status`).
- **Mobile Apple sign-in** sends `userIdentifier`, `email`, `fullName` that the server validator does not declare (NEW-02 made the server ignore them): stage 2 must declare them or the app must stop sending them.
- Unreadable client bodies (variables or multipart): mobile `updates`, `fields`, `expenseData`, `FormData` uploads, CMS `formData`.

## Mismatch fixes (2026-10-21, one branch per repo, each with a failing-first test)

| Mismatch | Fixed in | Branch / commit |
|---|---|---|
| Web password-reset confirm sent `{ email, otp, newPassword }`; API wants `{ email, code, password }` (a web reset could never finish) | web | `fix/web-password-reset-confirm-fields` `09b0223` |
| Mobile `adminResetPassword` sent `{ password }`; API wants `{ newPassword }` (no screen calls it yet) | app | `fix/app-user-password-field` `ac3519e` |
| Web fitness profile sent `height` / `weight`, API wants `heightCm` / `weightKg`; it also read the fields from the top level, but the API nests them under `profile`; `allergies` and `foodPreferences` have no column (removed from the form) | web | `fix/web-profile-height-weight` `894c1fa` |

Product question left open: allergies and food preferences. The web form offered them but they were never saved. They were removed rather than kept as a promise the API does not keep; if wanted, they need columns on the member profile first.

## CMS calls to routes the server does not have

| CMS call | Used by | Server has | Recommendation |
|---|---|---|---|
| `POST /auth/forgot-password` (`requestPasswordReset`) | live: `(auth)/forgot-password` page, so CMS password reset 404s today | `POST /auth/password-reset/request` and `/confirm` (same OTP flow as web and mobile) | **Remove the CMS call, point it at the existing route.** Do not build a second reset flow. The CMS page has only the request step, so it also needs the confirm step (code + new password) |
| `POST /auth/reset-password` (`confirmPasswordReset`) | nothing calls it | `POST /auth/password-reset/confirm` `{ email, code, password }` | **Delete the dead call**; add it again, correctly named, with the confirm step above |
| `GET/POST/PATCH /gyms/trainers*`, `PATCH /gyms/trainers/:id/toggle-status` | live: the whole `/gym/trainers` page (NEW-41); in the sidebar | `/trainers`: `GET /`, `POST /`, `PATCH /:id`, `POST /:id/assign`. **No toggle-status** (status is a field on `PATCH /:id`) | **Point the CMS at `/trainers`** (do not build `/gyms/trainers`). Toggle becomes `PATCH /trainers/:id { status }`. Check the `/trainers` permission gates match the CMS sidebar rule (`schedule.trainer.assign`): the router uses `authorize('GYM_HOST')` on writes, so branch managers would still be refused |
| `PATCH /membership-plans/:id/toggle-status` | live: `/gym/plans` page (activate / deactivate) | `POST /membership-plans/:id/status` | **Change the CMS call** to the existing route |
| `PATCH /users/:id/status` | live: `/gym/members/[id]` (suspend / activate a member) | `POST /users/:id/status` | **Change the CMS call** to POST |
| `PATCH /users/:id` (`updateUser`) | nothing calls it | `PUT /users/:id` | **Delete the dead call** (or switch to PUT when a screen needs it) |
| `POST /users/:id/reset-password` (`resetUserPassword`) | nothing calls it | `POST /users/:id/password` `{ newPassword }` | **Delete the dead call**; if an admin reset screen is wanted, call the existing route |

None of these needs a new server route. Each is a CMS change, to be done as its own failing-first commit; the four that are live today (forgot-password, trainers, plan toggle, member status) are broken for users now.

## Every mutating route

| Stage | Method | Path | Validator body fields | What clients send |
|---|---|---|---|---|
| 3 (write allow-list) | POST | `/actions/:actionKey` | (no validator) | cms: branchId,payload,idempotencyKey<br>app: branchId,payload,idempotencyKey |
| 2 (router not clean) | PATCH | `/admin/branches/:branchId/traveler-visibility` | status,reason | cms: status,reason |
| 2 (router not clean) | PATCH | `/admin/reviews/:id/moderate` | action,adminNote | cms: action |
| 2 (router not clean) | POST | `/admin/reviews/:id/moderate` | action,adminNote | app: action,adminNote |
| 3 (write allow-list) | POST | `/admin/subscriptions/sync` | (no validator) | cms: none |
| 2 (router not clean) | POST | `/admin/tenants` | ownerEmail,ownerFullName,ownerPhone,businessName,email,phone,cityId,packageId | cms: ownerEmail,ownerFullName,ownerPhone,businessName,email,phone,cityId,packageId |
| 3 (write allow-list) | DELETE | `/admin/tenants/:id` | (no validator) | cms: none |
| 3 (write allow-list) | POST | `/admin/tenants/:id/approve` | (no validator) | cms: none<br>app: none |
| 3 (write allow-list) | POST | `/admin/tenants/:id/branches` | (no validator) | cms: branchName,address,cityId,areaId,phone,openingTime,closingTime,facilities,latitude,longitude |
| 3 (write allow-list) | DELETE | `/admin/tenants/:id/branches/:branchId` | (no validator) | (no client) |
| 3 (write allow-list) | PATCH | `/admin/tenants/:id/branches/:branchId` | (no validator) | cms: branchName,address,cityId,areaId,phone,openingTime,closingTime,facilities,latitude,longitude,status |
| 3 (write allow-list) | DELETE | `/admin/tenants/:id/branches/:branchId/images` | (no validator) | cms: data |
| 3 (multipart) | POST | `/admin/tenants/:id/branches/:branchId/images` | (no validator) | multipart |
| 2 (router not clean) | PATCH | `/admin/tenants/:id/branches/:branchId/status` | status,reason | cms: status |
| 2 (router not clean) | POST | `/admin/tenants/:id/branches/:branchId/suspend` | reason | (no client) |
| 3 (write allow-list) | POST | `/admin/tenants/:id/branches/:branchId/unsuspend` | (no validator) | (no client) |
| 3 (multipart) | POST | `/admin/tenants/:id/cover` | (no validator) | multipart |
| 3 (write allow-list) | PATCH | `/admin/tenants/:id/gym-listing` | (no validator) | cms: title,shortDescription,genderType,contactPhone,website,facilitiesJson,isFeatured,status,latitude,longitude,cityId,areaId |
| 3 (write allow-list) | POST | `/admin/tenants/:id/gym-listing` | (no validator) | cms: title,shortDescription,genderType,contactPhone,website,cityId,areaId,latitude,longitude |
| 3 (multipart) | POST | `/admin/tenants/:id/gym-listing/cover` | (no validator) | multipart |
| 3 (write allow-list) | DELETE | `/admin/tenants/:id/gym-listing/images` | (no validator) | cms: data |
| 3 (multipart) | POST | `/admin/tenants/:id/gym-listing/images` | (no validator) | multipart |
| 3 (multipart) | POST | `/admin/tenants/:id/gym-listing/logo` | (no validator) | multipart |
| 2 (declare, then strict) | POST | `/admin/tenants/:id/invoices` | subtotal,dueDate,taxAmount,status | cms: tenantSubscriptionId,description,subtotal,taxAmount,dueDate,notes,status |
| 2 (declare, then strict) | PATCH | `/admin/tenants/:id/invoices/:invoiceId` | status,dueDate | cms: status,dueDate,notes,paidAt |
| 3 (write allow-list) | POST | `/admin/tenants/:id/invoices/:invoiceId/send-confirmation` | (no validator) | cms: none |
| 3 (write allow-list) | POST | `/admin/tenants/:id/invoices/:invoiceId/send-reminder` | (no validator) | cms: none |
| 3 (multipart) | POST | `/admin/tenants/:id/logo` | (no validator) | multipart |
| 3 (write allow-list) | POST | `/admin/tenants/:id/members/:userId/reveal` | (no validator) | cms: dynamic |
| 3 (write allow-list) | POST | `/admin/tenants/:id/reactivate` | (no validator) | cms: none |
| 2 (router not clean) | POST | `/admin/tenants/:id/reject` | reason | cms: reason<br>app: reason |
| 2 (router not clean) | POST | `/admin/tenants/:id/subscriptions` | packageId,startDate,billingCycle,amount,autoRenew,createInvoice | cms: packageId,startDate,billingCycle,amount,autoRenew,createInvoice |
| 3 (write allow-list) | PATCH | `/admin/tenants/:id/subscriptions/:subId/revoke` | (no validator) | cms: none |
| 2 (router not clean) | POST | `/admin/tenants/:id/subscriptions/:subId/verify-payment` | bankTransferRef | (no client) |
| 2 (router not clean) | POST | `/admin/tenants/:id/suspend` | reason | cms: reason |
| 1 (done) | POST | `/admin/billing-plans` | branchCount,monthlyPrice,annualPrice,currency,isActive,sortOrder,iosMonthlyProductId,iosAnnualProductId,androidProductId,androidMonthlyBasePlanId,androidAnnualBasePlanId | cms: branchCount,monthlyPrice,annualPrice,currency,isActive,sortOrder,iosMonthlyProductId,iosAnnualProductId,androidProductId,androidMonthlyBasePlanId,androidAnnualBasePlanId |
| 1 (done) | PATCH | `/admin/billing-plans/:id` | branchCount,monthlyPrice,annualPrice,currency,isActive,sortOrder,iosMonthlyProductId,iosAnnualProductId,androidProductId,androidMonthlyBasePlanId,androidAnnualBasePlanId | cms: dynamic |
| 1 (done) | POST | `/admin/billing-plans/:id/mark-synced` | provider | cms: provider |
| 1 (done) | DELETE | `/admin/billing-plans/:id/prices/:currency` |  | (no client) |
| 1 (done) | PUT | `/admin/billing-plans/:id/prices/:currency` | monthlyPrice,annualPrice,stripeMonthlyPriceId,stripeAnnualPriceId | (no client) |
| 1 (done) | POST | `/admin/billing-plans/:id/prices/:currency/sync-stripe` |  | (no client) |
| 3 (write allow-list) | POST | `/admin/billing-plans/:id/sync-stripe` | (no validator) | cms: none |
| 1 (done) | POST | `/admin/devices` | tenantId,branchId,serialNumber,name,model,ipAddress | (no client) |
| 1 (done) | DELETE | `/admin/devices/:id` |  | (no client) |
| 1 (done) | PUT | `/admin/devices/:id` | name,status,ipAddress | (no client) |
| 1 (done) | POST | `/admin/devices/:id/members` | userId,zkPin,label | (no client) |
| 1 (done) | DELETE | `/admin/devices/:id/members/:memberId` |  | (no client) |
| 3 (write allow-list) | POST | `/approvals/:id/approve` | (no validator) | cms: dynamic<br>app: reason |
| 3 (write allow-list) | POST | `/approvals/:id/cancel` | (no validator) | cms: none<br>app: none |
| 3 (write allow-list) | POST | `/approvals/:id/collect` | (no validator) | app: method,notes |
| 3 (write allow-list) | POST | `/approvals/:id/reject` | (no validator) | cms: reason<br>app: reason |
| 3 (write allow-list) | PUT | `/approvals/policies/:actionKey` | (no validator) | (no client) |
| 3 (write allow-list) | PATCH | `/attendance/:id/check-out` | (no validator) | cms: none |
| 1 (done) | POST | `/attendance/check-in` | userId,branchId,subscriptionId,notes | cms: userId,subscriptionId,branchId,notes |
| never (signed / device) | POST | `/attendance/device-notify` | (no validator) | (no client) |
| 1 (done) | POST | `/attendance/manual` | userId,branchId,subscriptionId,notes | app: userId,branchId,subscriptionId,notes |
| 1 (done) | POST | `/attendance/qr-scan` | qrCode,branchId,deviceId | app: qrCode,branchId,deviceId |
| 1 (done) | POST | `/auth/login` | email,password | cms: dynamic<br>web: dynamic<br>app: email,password |
| 3 (write allow-list) | POST | `/auth/logout` | (no validator) | cms: none<br>web: none |
| 1 (done) | POST | `/auth/otp/resend` | email | web: email<br>app: email |
| 1 (done) | POST | `/auth/otp/verify` | email,code | web: email,code<br>app: email,code |
| 2 (declare, then strict) | POST | `/auth/password-reset/confirm` | email,code,password | web: dynamic<br>app: email,code,password |
| 2 (declare, then strict) | POST | `/auth/password-reset/request` | email | web: dynamic<br>app: email |
| 1 (done) | POST | `/auth/refresh` | refreshToken | cms: refreshToken<br>web: refreshToken<br>app: refreshToken |
| 1 (done) | POST | `/auth/register` | fullName,email,password,phone | web: fullName,email,password,phone<br>app: fullName,email,password,phone |
| 3 (write allow-list) | DELETE | `/auth/sessions` | (no validator) | (no client) |
| 3 (write allow-list) | DELETE | `/auth/sessions/:id` | (no validator) | (no client) |
| 2 (declare, then strict) | POST | `/auth/social/apple` | identityToken,authorizationCode | app: dynamic |
| 1 (done) | POST | `/auth/social/google` | idToken | web: idToken<br>app: idToken |
| 1 (done) | POST | `/auth/social/google/staff` | idToken | cms: idToken |
| 3 (write allow-list) | POST | `/auth/tenant-invitations/accept` | (no validator) | (no client) |
| 3 (write allow-list) | POST | `/billing/android/sync` | (no validator) | app: purchaseToken,productId |
| 3 (write allow-list) | PUT | `/billing/downgrade-choice` | (no validator) | (no client) |
| 3 (write allow-list) | POST | `/billing/ios/sync` | (no validator) | app: transactionId |
| 3 (write allow-list) | POST | `/billing/purchase-intent` | (no validator) | (no client) |
| 3 (write allow-list) | POST | `/billing/stripe/change-plan` | (no validator) | web: billingPlanId,billingCycle |
| 3 (write allow-list) | POST | `/billing/stripe/checkout-session` | (no validator) | web: billingPlanId,billingCycle,successUrl,cancelUrl |
| 3 (write allow-list) | POST | `/billing/stripe/portal-session` | (no validator) | web: returnUrl |
| never (signed / device) | POST | `/billing/webhooks/apple` | (no validator) | (no client) |
| never (signed / device) | POST | `/billing/webhooks/google` | (no validator) | (no client) |
| never (signed / device) | POST | `/billing/webhooks/stripe` | (no validator) | (no client) |
| 1 (done) | POST | `/cities` | name,isActive,imageUrl | cms: name,imageUrl<br>app: name,isActive |
| 3 (write allow-list) | DELETE | `/cities/:id` | (no validator) | cms: none |
| 1 (done) | PATCH | `/cities/:id` | name,isActive,imageUrl | cms: name,isActive,imageUrl<br>app: name,isActive |
| 1 (done) | POST | `/cities/:id/areas` | name,imageUrl | cms: name,imageUrl<br>app: name |
| 3 (write allow-list) | DELETE | `/cities/:id/areas/:areaId` | (no validator) | cms: none |
| 1 (done) | PATCH | `/cities/:id/areas/:areaId` | name,imageUrl | cms: name,imageUrl<br>app: name |
| 3 (multipart) | POST | `/cities/:id/areas/:areaId/image` | (no validator) | multipart |
| 3 (multipart) | POST | `/cities/:id/image` | (no validator) | multipart |
| 1 (done) | POST | `/devices` | branchId,serialNumber,name,model,ipAddress | (no client) |
| 1 (done) | DELETE | `/devices/:id` |  | (no client) |
| 1 (done) | PUT | `/devices/:id` | name,status,ipAddress | (no client) |
| 1 (done) | POST | `/devices/:id/members` | userId,zkPin,label | (no client) |
| 1 (done) | DELETE | `/devices/:id/members/:memberId` |  | (no client) |
| 1 (done) | POST | `/discovery/branches/:branchId/inquiries` | message | app: message |
| 1 (done) | POST | `/discovery/branches/:branchId/reviews` | rating,text,title | app: rating,text,title |
| 1 (done) | POST | `/discovery/gyms/:id/reviews` | branchId,rating,title,body,text | web: rating,title,body |
| 2 (declare, then strict) | POST | `/gyms/branches` | branchName,timezone,currency,address,cityId,areaId,latitude,longitude,phone,openingTime,closingTime,facilitiesJson,imagesJson,tagline,category,description,establishedYear,floorArea,addressLine1,addressLine2,postalCode,packages | cms: branchName,address,cityId,areaId,phone,openingTime,closingTime,facilities,latitude,longitude,packages |
| 3 (write allow-list) | DELETE | `/gyms/branches/:branchId` | (no validator) | cms: data |
| 2 (declare, then strict) | PATCH | `/gyms/branches/:branchId` | branchName,timezone,currency,address,cityId,areaId,latitude,longitude,phone,openingTime,closingTime,facilitiesJson,imagesJson | cms: branchName,address,cityId,areaId,phone,openingTime,closingTime,facilities,latitude,longitude,status<br>app: branchName,address,cityId,areaId,latitude,longitude,phone,openingTime,closingTime,facilitiesJson,imagesJson |
| 3 (write allow-list) | DELETE | `/gyms/branches/:branchId/images` | (no validator) | cms: data |
| 3 (multipart) | POST | `/gyms/branches/:branchId/images` | (no validator) | multipart |
| 2 (router not clean) | POST | `/gyms/branches/:branchId/staff` | userId,designation | app: userId,designation |
| 2 (router not clean) | DELETE | `/gyms/branches/:branchId/staff/:staffId` |  | app: none |
| 3 (write allow-list) | POST | `/gyms/members/enroll` | (no validator) | cms: email,fullName,phone,planId,branchId,startDate<br>app: email,fullName,phone,planId,branchId,startDate,notes,paymentMethod |
| 2 (declare, then strict) | PATCH | `/gyms/profile` | name,description,contactPhone,contactEmail,website,genderType,logoUrl,coverImageUrl,socialLinksJson,paymentDetailsJson,password,provider,idToken | cms: paymentDetailsJson,name,description,genderType,phone,email,address,latitude,longitude<br>app: name,tagline,category,description,establishedYear,contactPhone,contactEmail,website,genderType,logoUrl,coverImageUrl,imagesJson,socialLinksJson |
| 3 (multipart) | POST | `/gyms/profile/cover` | (no validator) | multipart |
| 3 (write allow-list) | DELETE | `/gyms/profile/images` | (no validator) | cms: data |
| 3 (multipart) | POST | `/gyms/profile/images` | (no validator) | multipart |
| 3 (multipart) | POST | `/gyms/profile/logo` | (no validator) | multipart |
| 3 (write allow-list) | POST | `/gyms/staff` | (no validator) | app: fullName,email,phone,password,designation,assignToAllBranches,branchIds |
| 3 (write allow-list) | DELETE | `/gyms/staff/:userId` | (no validator) | app: none |
| 2 (declare, then strict) | POST | `/host/branches` | branchName,timezone,currency,address,cityId,areaId,latitude,longitude,phone,openingTime,closingTime,facilitiesJson,imagesJson,tagline,category,description,establishedYear,floorArea,addressLine1,addressLine2,postalCode,packages | cms: branchName,gymListingId,address,cityId,areaId,latitude,longitude,phone,openingTime,closingTime,facilitiesJson,packages<br>app: branchName,gymListingId,address,cityId,areaId,latitude,longitude,phone,openingTime,closingTime,facilitiesJson,imagesJson,tagline,category,description,establishedYear,floorArea,addressLine1,addressLine2,postalCode,country,packages |
| 3 (write allow-list) | DELETE | `/host/branches/:branchId` | (no validator) | cms: data<br>app: password,provider,idToken,confirmOrganizationDeletion |
| 3 (write allow-list) | POST | `/host/branches/:branchId/announcements` | (no validator) | app: title,message,tag,status |
| 3 (write allow-list) | DELETE | `/host/branches/:branchId/announcements/:announcementId` | (no validator) | app: none |
| 3 (write allow-list) | POST | `/host/branches/:branchId/expenses` | (no validator) | app: dynamic |
| 3 (write allow-list) | DELETE | `/host/branches/:branchId/expenses/:expenseId` | (no validator) | app: none |
| 3 (write allow-list) | PATCH | `/host/branches/:branchId/expenses/:expenseId` | (no validator) | app: dynamic |
| 3 (write allow-list) | PATCH | `/host/branches/:branchId/listing-content` | (no validator) | cms: dynamic<br>app: branchName,tagline,category,description,establishedYear,floorArea,addressLine1,addressLine2,postalCode,country,cityId,areaId,tagsJson,facilitiesJson,imagesJson,openingTime,closingTime,address,phone,latitude,longitude |
| 3 (write allow-list) | POST | `/host/branches/:branchId/members` | (no validator) | app: fullName,email,phone,planId,startDate,notes,paymentMethod |
| 3 (write allow-list) | POST | `/host/branches/:branchId/move` | (no validator) | cms: dynamic<br>app: targetListingId,confirmOrganizationDeletion |
| 3 (write allow-list) | POST | `/host/branches/:branchId/restore` | (no validator) | cms: none<br>app: none |
| 3 (write allow-list) | PATCH | `/host/branches/:branchId/resubmit-visibility` | (no validator) | cms: none<br>app: none |
| 3 (write allow-list) | POST | `/host/branches/:branchId/schedule` | (no validator) | app: name,instructor,time,day,maxCapacity |
| 3 (write allow-list) | POST | `/host/expense-categories` | (no validator) | app: name |
| 3 (write allow-list) | POST | `/host/inbox/conversations` | (no validator) | app: userId,branchId,initialMessage |
| 3 (write allow-list) | PATCH | `/host/inbox/inquiries/:inquiryId/read` | (no validator) | app: none |
| 3 (write allow-list) | POST | `/host/inbox/inquiries/:inquiryId/reply` | (no validator) | app: text,clientMessageId |
| 3 (write allow-list) | POST | `/host/listings` | (no validator) | cms: gymName,gymDescription,genderType,branchSource,packages,cityId,areaId,address<br>app: gymName,gymDescription,genderType,branchSource,packages,cityId,areaId,address,logoUrl,coverImageUrl,images,contactPhone,latitude,longitude |
| 3 (write allow-list) | DELETE | `/host/listings/:id` | (no validator) | cms: none<br>app: strategy,targetListingId,password,provider,idToken |
| 3 (write allow-list) | PATCH | `/host/listings/:id` | (no validator) | app: gymName,gymDescription,genderType,cityId,areaId,logoUrl,coverImageUrl,contactPhone,latitude,longitude |
| 3 (write allow-list) | PUT | `/host/listings/:id` | (no validator) | (no client) |
| 3 (write allow-list) | POST | `/host/listings/:id/reserved-slots/transfer` | (no validator) | app: toListingId,count |
| 3 (multipart) | POST | `/host/listings/staging-images` | (no validator) | app: dynamic |
| 3 (write allow-list) | POST | `/host/payouts` | (no validator) | cms: branchId,amount,notes |
| 3 (write allow-list) | POST | `/host/subscription/upgrade` | (no validator) | app: planId |
| never (signed / device) | POST | `/iclock/cdata` | (no validator) | (no client) |
| never (signed / device) | POST | `/iclock/devicecmd` | (no validator) | (no client) |
| 3 (write allow-list) | POST | `/ledger/:ledgerDayId/adjustments` | (no validator) | cms: branchId,type,reason,amount,relatedPaymentId<br>app: branchId,type,relatedPaymentId,amount,reason |
| 3 (write allow-list) | POST | `/me/cancel-deletion` | (no validator) | app: none |
| 2 (router not clean) | POST | `/me/change-password` | currentPassword,newPassword | web: currentPassword,newPassword |
| 3 (write allow-list) | PATCH | `/me/inbox/:conversationId/read` | (no validator) | app: none |
| 3 (write allow-list) | POST | `/me/inbox/:conversationId/reply` | (no validator) | app: text,clientMessageId |
| 2 (router not clean) | POST | `/me/password` | currentPassword,newPassword | app: currentPassword,newPassword |
| 2 (router not clean) | POST | `/me/payment-request` | subscriptionId,method,amount,notes | app: subscriptionId,method,amount,notes |
| 3 (multipart) | POST | `/me/payment-requests/:id/proof` |  | app: dynamic |
| 2 (router not clean) | POST | `/me/payments` | subscriptionId,method,amount,notes | web: subscriptionId,amount,method,notes |
| 3 (multipart) | POST | `/me/payments/:id/proof` |  | multipart |
| 2 (declare, then strict) | PATCH | `/me/profile` | fullName,phone,gender,dateOfBirth,heightCm,weightKg,fitnessGoal | web: fullName,phone,gender,dateOfBirth,height,weight,fitnessGoal,allergies,foodPreferences |
| 2 (router not clean) | PUT | `/me/profile` | fullName,phone,gender,dateOfBirth,heightCm,weightKg,fitnessGoal | app: fullName,phone,gender,dateOfBirth,heightCm,weightKg,fitnessGoal |
| 3 (multipart) | POST | `/me/profile-image` | (no validator) | app: dynamic |
| 3 (multipart) | POST | `/me/profile/image` | (no validator) | multipart |
| 3 (write allow-list) | POST | `/me/request-deletion` | (no validator) | app: password,provider,idToken |
| 3 (write allow-list) | DELETE | `/me/saved-gyms/:gymId` | (no validator) | app: none |
| 3 (write allow-list) | POST | `/me/saved-gyms/:gymId` | (no validator) | app: none |
| 3 (write allow-list) | POST | `/member/subscriptions/:id/upgrade` | (no validator) | app: newPlanId |
| 1 (done) | POST | `/membership-plans` | name,description,branchId,durationType,durationValue,price,joiningFee,securityFee,visitLimit,freezeLimitDays,isTrial,isPublic | cms: name,description,branchId,durationType,durationValue,price,joiningFee,securityFee,visitLimit,freezeLimitDays,isTrial<br>app: name,durationType,durationValue,price,description,branchId,joiningFee,securityFee,visitLimit,freezeLimitDays,isTrial,isPublic |
| 1 (done) | DELETE | `/membership-plans/:id` |  | cms: none<br>app: none |
| 1 (done) | PATCH | `/membership-plans/:id` | name,description,durationType,durationValue,price,joiningFee,securityFee,visitLimit,freezeLimitDays,isTrial,isPublic,status | cms: status<br>app: name,description,durationType,durationValue,price,joiningFee,securityFee,visitLimit,freezeLimitDays,isTrial,isPublic |
| 3 (write allow-list) | POST | `/membership-plans/:id/featured` | (no validator) | app: none |
| 3 (multipart) | POST | `/membership-plans/:id/poster` | (no validator) | multipart |
| 3 (write allow-list) | POST | `/membership-plans/:id/public` | (no validator) | app: none |
| 3 (write allow-list) | POST | `/membership-plans/:id/status` | (no validator) | app: none |
| 3 (write allow-list) | PATCH | `/notifications/:id/read` | (no validator) | cms: none<br>app: none |
| 3 (write allow-list) | PATCH | `/notifications/read-all` | (no validator) | cms: none |
| 3 (write allow-list) | POST | `/notifications/read-all` | (no validator) | app: none |
| 3 (write allow-list) | POST | `/notifications/test-push` | (no validator) | app: title,body |
| 3 (write allow-list) | DELETE | `/notifications/token` | (no validator) | app: token |
| 3 (write allow-list) | POST | `/notifications/token` | (no validator) | app: token,platform,deviceId,deviceName,appVersion,locale |
| 2 (declare, then strict) | POST | `/payments` | userId,paymentFor,referenceEntityId,method,gatewayName,gatewayTransactionId,amount,currency,notes | cms: userId,paymentFor,amount,currency,method,referenceEntityId,branchId,notes,shift<br>app: userId,method,amount,paymentFor,branchId,referenceEntityId,gatewayName,gatewayTransactionId,currency,notes<br>app: userId,paymentFor,referenceEntityId,method,amount,notes |
| 3 (write allow-list) | POST | `/payments/:id/action` | (no validator) | cms: action,notes,rejectedReason,shift<br>app: action,notes,rejectedReason<br>app: action,waiveJoiningFee<br>app: action,rejectedReason<br>app: action |
| 3 (write allow-list) | POST | `/payments/:id/printed` | (no validator) | app: none |
| 3 (multipart) | POST | `/payments/:id/proof` | (no validator) | multipart |
| 3 (write allow-list) | POST | `/payments/:id/refund` | (no validator) | cms: amount,reason |
| 2 (router not clean) | POST | `/payments/:id/verify` | notes | app: none<br>app: notes |
| 3 (write allow-list) | POST | `/payments/collection-action` | (no validator) | cms: paymentIds<br>app: paymentIds |
| 2 (declare, then strict) | POST | `/platform-packages` | name,description,price,billingCycle,maxOrganizations,maxBranches,maxTrainers,maxMembers,featureFlagsJson | cms: name,description,price,billingCycle,maxOrganizations,maxBranches,maxTrainers,maxMembers,featureFlags<br>app: name,price,description,billingCycle,maxBranches,maxTrainers,maxMembers,featureFlagsJson |
| 2 (router not clean) | PATCH | `/platform-packages/:id` | name,description,price,billingCycle,maxOrganizations,maxBranches,maxTrainers,maxMembers,featureFlagsJson,status | cms: status<br>app: name,description,price,billingCycle,maxBranches,maxTrainers,maxMembers,featureFlagsJson,status |
| 3 (write allow-list) | POST | `/staff/branches/:branchId/action-requests` | (no validator) | app: actionType,payload |
| 3 (write allow-list) | POST | `/staff/host/action-requests/:requestId/approve` | (no validator) | app: none |
| 3 (write allow-list) | POST | `/staff/host/action-requests/:requestId/reject` | (no validator) | app: dynamic |
| 3 (write allow-list) | POST | `/staff-invites/:staffId/accept` | (no validator) | app: tenantId |
| 3 (write allow-list) | POST | `/staff-invites/:staffId/decline` | (no validator) | app: tenantId |
| 1 (done) | POST | `/subscriptions` | planId,gymListingId,branchId,autoRenew,sourceChannel | web: planId,gymListingId,branchId,autoRenew<br>app: planId,gymListingId,branchId,autoRenew,sourceChannel |
| 1 (done) | POST | `/subscriptions/:id/cancel` |  | cms: none<br>web: none<br>app: none |
| 1 (done) | POST | `/subscriptions/:id/change-plan` | planId | app: planId |
| 1 (done) | POST | `/subscriptions/:id/freeze` | freezeFrom,freezeTo | cms: freezeFrom,freezeTo<br>web: freezeFrom,freezeTo<br>app: freezeFrom,freezeTo |
| 3 (multipart) | POST | `/subscriptions/:id/proof` | (no validator) | multipart |
| 1 (done) | POST | `/subscriptions/:id/renew` | planId,startDate | web: none<br>app: planId,startDate |
| 3 (write allow-list) | POST | `/subscriptions/preview` | (no validator) | cms: planId,startDate,autoRenew<br>app: planId,startDate,autoRenew |
| 3 (write allow-list) | POST | `/subscriptions/staff` | (no validator) | app: userId,planId,branchId,startDate |
| 3 (write allow-list) | POST | `/subscriptions/staff/:id/activate` | (no validator) | cms: none<br>app: none |
| 3 (write allow-list) | DELETE | `/team/:assignmentId` | (no validator) | cms: none<br>app: none |
| 3 (write allow-list) | PATCH | `/team/:assignmentId` | (no validator) | cms: roleKey,status,jobTitle,assignToAllBranches,branchIds,expectedVersion<br>app: roleKey,status,jobTitle,assignToAllBranches,branchIds,validUntil |
| 3 (write allow-list) | PUT | `/team/:assignmentId/permissions` | (no validator) | cms: overrides,expectedVersion<br>app: overrides |
| 3 (write allow-list) | POST | `/team/invites` | (no validator) | cms: dynamic<br>app: email,roleKey,fullName,phone,jobTitle,assignToAllBranches,branchIds,overrides,validUntil |
| 3 (write allow-list) | POST | `/tenants/:id/finalize` | (no validator) | web: paymentMethod,bankTransferRef<br>app: paymentMethod,bankTransferRef |
| 2 (declare, then strict) | POST | `/tenants/:id/gym-profile` | gymName,gymDescription,genderType,address,mainBranchData,kycDocumentsJson,logoUrl,coverImageUrl | web: gymName,gymDescription,genderType,address,latitude,longitude,logoUrl,coverImageUrl,mainBranchData<br>app: gymName,gymDescription,genderType,address,latitude,longitude,mainBranchData,kycDocumentsJson,logoUrl,coverImageUrl |
| 3 (multipart) | POST | `/tenants/:id/kyc-documents` | (no validator) | multipart |
| 3 (write allow-list) | DELETE | `/tenants/:id/kyc-documents/:documentId` | (no validator) | (no client) |
| 3 (multipart) | POST | `/tenants/:id/onboarding-images` | (no validator) | multipart |
| 3 (write allow-list) | PUT | `/tenants/:id/onboarding-images` | (no validator) | web: imagesJson<br>app: imagesJson |
| 2 (router not clean) | POST | `/tenants/:id/select-package` | packageId | cms: packageId<br>web: packageId<br>app: packageId |
| 2 (router not clean) | PATCH | `/tenants/me` | businessName,email,phone,cityId | cms: businessName,email,phone,cityId |
| 2 (declare, then strict) | POST | `/tenants/register` | businessName,email,phone,cityId | web: businessName,email,phone,cityId<br>app: businessName,email,phone,cityId,areaId |
| 2 (router not clean) | POST | `/trainers` | userId,branchId,specialization,bio,yearsExperience,certificationsJson,availabilityJson | app: userId,branchId,specialization,bio,yearsExperience,certificationsJson,availabilityJson |
| 2 (declare, then strict) | PATCH | `/trainers/:id` | specialization,bio,yearsExperience,certificationsJson,availabilityJson,status | app: branchId,specialization,bio,yearsExperience,certificationsJson,availabilityJson,status |
| 2 (router not clean) | POST | `/trainers/:id/assign` | branchId | app: branchId |
| 2 (declare, then strict) | POST | `/users` | fullName,email,phone,password,gender,dateOfBirth | cms: fullName,email,phone,role,password<br>app: fullName,email,phone,password,gender,dateOfBirth |
| 2 (declare, then strict) | PUT | `/users/:id` | fullName,email,phone,gender,dateOfBirth,emergencyContactName,emergencyContactPhone,fitnessGoal,medicalNotes,heightCm,weightKg | app: dynamic |
| 2 (declare, then strict) | POST | `/users/:id/password` | newPassword | app: password |
| 3 (multipart) | POST | `/users/:id/profile-image` | (no validator) | multipart |
| 2 (router not clean) | POST | `/users/:id/status` | status,reason | app: status,reason |
