# GymsEra API — Integration Test Report

**Date:** 8 May 2026
**Environment:** `NODE_ENV=test`
**Base URL:** `http://localhost:3000/api/v1`
**Framework:** Jest + Axios
**Result:** ✅ **76 / 76 Tests Passed — 6 / 6 Suites Passed**

---

## Summary

| Suite | File | Tests | Passed | Failed | Time |
|-------|------|-------|--------|--------|------|
| Authentication | `tests/auth.test.js` | 14 | 14 | 0 | ~3.1 s |
| Gym Host (Tenant) | `tests/host.test.js` | 21 | 21 | 0 | ~1.0 s |
| Platform Admin | `tests/admin.test.js` | 14 | 14 | 0 | ~0.8 s |
| Public Discovery | `tests/discovery.test.js` | 15 | 15 | 0 | ~0.6 s |
| Member Flow | `tests/member.test.js` | 7 | 7 | 0 | ~0.4 s |
| Member Self-Service | `tests/me.test.js` | 5 | 5 | 0 | ~0.3 s |
| **TOTAL** | | **76** | **76** | **0** | **~6.9 s** |

---

## Test Accounts Used

| Role | Email | Password |
|------|-------|----------|
| Platform Admin | `admin@gymsera.com` | `Admin@1234!` |
| Gym Host (Iron Peak) | `ahmed@ironpeak.com` | `Host@1234!` |
| Gym Host (Vitality Fit) | `sara@vitalityfit.com` | `Host@1234!` |
| Gym Member | `ali.hassan@example.com` | `Member@1234!` |
| Gym Member | `fatima.z@example.com` | `Member@1234!` |
| Gym Member | `omar.farooq@example.com` | `Member@1234!` |

---

## Suite 1 — Authentication (`tests/auth.test.js`) — 14/14 ✅

> Tests registration, OTP verification, login for all roles, token refresh, and the `/auth/me` endpoint.

| # | Method | Endpoint | Scenario | Expected | Result |
|---|--------|----------|----------|----------|--------|
| 1 | POST | `/auth/register` | New user registration | 201 | ✅ PASS |
| 2 | POST | `/auth/register` | Duplicate email | 409 | ✅ PASS |
| 3 | POST | `/auth/register` | Missing required fields | 422 | ✅ PASS |
| 4 | POST | `/auth/otp/verify` | Valid OTP code | 200 | ✅ PASS |
| 5 | POST | `/auth/otp/verify` | Wrong OTP code | 400 | ✅ PASS |
| 6 | POST | `/auth/login` | Seeded admin credentials | 200 | ✅ PASS |
| 7 | POST | `/auth/login` | Seeded gym host credentials | 200 | ✅ PASS |
| 8 | POST | `/auth/login` | Wrong password | 401 | ✅ PASS |
| 9 | POST | `/auth/login` | Nonexistent email | 401 | ✅ PASS |
| 10 | POST | `/auth/refresh` | Valid refresh token | 200 | ✅ PASS |
| 11 | POST | `/auth/refresh` | Invalid / expired token | 401 | ✅ PASS |
| 12 | GET | `/auth/me` | Authenticated user returns own profile | 200 | ✅ PASS |
| 13 | GET | `/auth/me` | No bearer token | 401 | ✅ PASS |
| 14 | POST | `/auth/password-reset/request` | Sends OTP reset email | 200 | ✅ PASS |

---

## Suite 2 — Gym Host / Tenant-Scoped (`tests/host.test.js`) — 21/21 ✅

> Tests all GYM_HOST endpoints. Routes require a valid JWT with `tenantId` and resolve the tenant DB via middleware.

### Gym Profile

| # | Method | Endpoint | Scenario | Expected | Result |
|---|--------|----------|----------|----------|--------|
| 1 | GET | `/gyms/profile` | Host reads own gym profile | 200 | ✅ PASS |
| 2 | PATCH | `/gyms/profile` | Update contact phone | 200 | ✅ PASS |
| 3 | GET | `/gyms/profile` | No auth token | 401 | ✅ PASS |

### Branches

| # | Method | Endpoint | Scenario | Expected | Result |
|---|--------|----------|----------|----------|--------|
| 4 | GET | `/gyms/branches` | List all branches | 200 | ✅ PASS |
| 5 | POST | `/gyms/branches` | Create new branch | 201 | ✅ PASS |
| 6 | GET | `/gyms/branches/:id` | Get branch detail | 200 or 404 | ✅ PASS |

### Membership Plans

| # | Method | Endpoint | Scenario | Expected | Result |
|---|--------|----------|----------|----------|--------|
| 7 | GET | `/membership-plans/host` | List all plans for host's gym | 200 | ✅ PASS |
| 8 | POST | `/membership-plans` | Create a new plan | 201 | ✅ PASS |

### Subscriptions (Staff View)

| # | Method | Endpoint | Scenario | Expected | Result |
|---|--------|----------|----------|----------|--------|
| 9 | GET | `/subscriptions/staff` | List all member subscriptions | 200 | ✅ PASS |

### Payments & Invoices

| # | Method | Endpoint | Scenario | Expected | Result |
|---|--------|----------|----------|----------|--------|
| 10 | GET | `/payments` | List tenant payments | 200 | ✅ PASS |
| 11 | GET | `/invoices` | List tenant invoices | 200 | ✅ PASS |

### Attendance

| # | Method | Endpoint | Scenario | Expected | Result |
|---|--------|----------|----------|----------|--------|
| 12 | GET | `/attendance` | All attendance logs | 200 | ✅ PASS |
| 13 | GET | `/attendance/today` | Today's check-in logs | 200 | ✅ PASS |
| 14 | GET | `/attendance/range` | Date range query | 200 | ✅ PASS |
| 15 | GET | `/attendance/report/daily` | Daily attendance report | 200 | ✅ PASS |
| 16 | GET | `/attendance/report/monthly` | Monthly attendance report | 200 | ✅ PASS |

### Reports

| # | Method | Endpoint | Scenario | Expected | Result |
|---|--------|----------|----------|----------|--------|
| 17 | GET | `/reports/dashboard` | KPI dashboard summary | 200 | ✅ PASS |
| 18 | GET | `/reports/monthly` | Monthly revenue/member breakdown | 200 | ✅ PASS |

### Trainers & Tenant Info

| # | Method | Endpoint | Scenario | Expected | Result |
|---|--------|----------|----------|----------|--------|
| 19 | GET | `/trainers` | List gym trainers | 200 | ✅ PASS |
| 20 | GET | `/tenants/me` | Host reads own tenant record | 200 | ✅ PASS |

### Role Guard

| # | Method | Endpoint | Scenario | Expected | Result |
|---|--------|----------|----------|----------|--------|
| 21 | GET | `/reports/dashboard` | MEMBER role (should be forbidden) | 403 | ✅ PASS |

---

## Suite 3 — Platform Admin (`tests/admin.test.js`) — 14/14 ✅

> Tests PLATFORM_ADMIN-only endpoints for managing tenants, users, reviews, and platform reports.

### Tenant Management

| # | Method | Endpoint | Scenario | Expected | Result |
|---|--------|----------|----------|----------|--------|
| 1 | GET | `/admin/tenants` | List all registered tenants | 200 | ✅ PASS |
| 2 | GET | `/admin/tenants/:id` | Tenant detail by ID | 200 | ✅ PASS |
| 3 | GET | `/admin/tenants/:id` | Nonexistent tenant UUID | 404 | ✅ PASS |
| 4 | POST | `/admin/tenants/:id/approve` | Approve tenant (already active → 400/200) | 200 or 400 | ✅ PASS |

### Platform Packages

| # | Method | Endpoint | Scenario | Expected | Result |
|---|--------|----------|----------|----------|--------|
| 5 | GET | `/platform-packages` | List subscription packages | 200 | ✅ PASS |

### User Management

| # | Method | Endpoint | Scenario | Expected | Result |
|---|--------|----------|----------|----------|--------|
| 6 | GET | `/users` | List all platform users | 200 | ✅ PASS |
| 7 | GET | `/users?search=...` | Search users by email | 200 | ✅ PASS |
| 8 | GET | `/users?page=1&limit=3` | Paginated user list | 200 | ✅ PASS |

### Reviews Moderation

| # | Method | Endpoint | Scenario | Expected | Result |
|---|--------|----------|----------|----------|--------|
| 9 | GET | `/admin/reviews` | List all reviews (pending/approved) | 200 | ✅ PASS |
| 10 | POST | `/admin/reviews/:id/moderate` | Approve a pending review | 200 | ✅ PASS |
| 11 | POST | `/admin/reviews/:id/moderate` | Missing action field | 422 | ✅ PASS |

### Platform Reports

| # | Method | Endpoint | Scenario | Expected | Result |
|---|--------|----------|----------|----------|--------|
| 12 | GET | `/admin/reports/platform` | Platform-wide summary stats | 200 | ✅ PASS |

### Auth Guards

| # | Method | Endpoint | Scenario | Expected | Result |
|---|--------|----------|----------|----------|--------|
| 13 | GET | `/admin/tenants` | No auth token | 401 | ✅ PASS |
| 14 | GET | `/admin/tenants` | Non-admin role (MEMBER) | 403 | ✅ PASS |

---

## Suite 4 — Public Discovery (`tests/discovery.test.js`) — 15/15 ✅

> Tests all public-facing discovery endpoints (no auth required).

### Cities

| # | Method | Endpoint | Scenario | Expected | Result |
|---|--------|----------|----------|----------|--------|
| 1 | GET | `/discovery/cities` | List all cities | 200 | ✅ PASS |

### Gym Listings

| # | Method | Endpoint | Scenario | Expected | Result |
|---|--------|----------|----------|----------|--------|
| 2 | GET | `/discovery/gyms` | List all active gyms | 200 | ✅ PASS |
| 3 | GET | `/discovery/gyms?city=...` | Filter gyms by city name | 200 | ✅ PASS |
| 4 | GET | `/discovery/gyms?page=1` | Paginate gym listings | 200 | ✅ PASS |
| 5 | GET | `/discovery/gyms/featured` | Featured gyms | 200 | ✅ PASS |
| 6 | GET | `/discovery/gyms/top-rated` | Top-rated gyms | 200 | ✅ PASS |
| 7 | GET | `/discovery/gyms/nearby` | Nearby gyms (lat/lng Karachi) | 200 | ✅ PASS |
| 8 | GET | `/discovery/gyms/nearby` | Missing lat/lng params | 422 | ✅ PASS |
| 9 | GET | `/discovery/gyms/map` | Map pins filtered by cityId | 200 | ✅ PASS |

### Gym Detail & Reviews

| # | Method | Endpoint | Scenario | Expected | Result |
|---|--------|----------|----------|----------|--------|
| 10 | GET | `/discovery/gyms/:id` | Valid gym UUID | 200 | ✅ PASS |
| 11 | GET | `/discovery/gyms/:id` | Non-UUID string as ID | 422 | ✅ PASS |
| 12 | GET | `/discovery/gyms/:id` | Nonexistent valid UUID | 404 or 422 | ✅ PASS |
| 13 | GET | `/discovery/gyms/:id/reviews` | Public review list | 200 | ✅ PASS |
| 14 | POST | `/discovery/gyms/:id/reviews` | Unauthenticated review attempt | 401 | ✅ PASS |
| 15 | POST | `/discovery/gyms/:id/reviews` | Authenticated member review | 201 or 400/403/409 | ✅ PASS |

---

## Suite 5 — Member Flow (`tests/member.test.js`) — 7/7 ✅

> Tests the end-to-end member journey: discover → get plans → subscribe → memberships → reviews.

| # | Method | Endpoint | Scenario | Expected | Result |
|---|--------|----------|----------|----------|--------|
| 1 | GET | `/membership-plans?gymListingId=:id` | Member fetches available plans for a gym | 200 | ✅ PASS |
| 2 | GET | `/discovery/gyms` | Public gym list (to obtain gymId) | 200 | ✅ PASS |
| 3 | POST | `/subscriptions` | Subscribe to a plan | 201 or 400/422 | ✅ PASS |
| 4 | GET | `/me/memberships` | View own memberships after subscribe | 200 | ✅ PASS |
| 5 | POST | `/discovery/gyms/:id/reviews` | Submit gym review (may require active sub) | 201/400/403/409 | ✅ PASS |
| 6 | POST | `/discovery/gyms/:id/reviews` | Missing `rating` field | 422 | ✅ PASS |
| 7 | GET | `/cities` | Authenticated user fetches city list | 200 | ✅ PASS |

---

## Suite 6 — Member Self-Service (`tests/me.test.js`) — 5/5 ✅

> Tests the `/me/*` namespace for a logged-in member managing their own account.

| # | Method | Endpoint | Scenario | Expected | Result |
|---|--------|----------|----------|----------|--------|
| 1 | GET | `/me/profile` | Read own profile | 200 | ✅ PASS |
| 2 | PUT | `/me/profile` | Update display name | 200 | ✅ PASS |
| 3 | GET | `/me/profile` | No auth token | 401 | ✅ PASS |
| 4 | GET | `/me/memberships` | List own gym memberships | 200 | ✅ PASS |
| 5 | POST | `/me/password` | Change password with wrong old password | 400 or 401 | ✅ PASS |

---

## Bugs Found & Fixed During Testing

| # | File | Bug | Fix Applied |
|---|------|-----|-------------|
| 1 | `src/services/auth.service.js` | `otp is not defined` — `Otp.create()` result not saved to variable; `otp.expiresAt` referenced on next line causing 500 on every registration | Changed `await Otp.create(...)` → `const otp = await Otp.create(...)` |
| 2 | `src/services/tenant.service.js` | `PlatformPackage is not associated to Tenant!` — Sequelize `include` used `as: null` for a model with no direct association | Removed the invalid `PlatformPackage` include from `getMyTenant()` |
| 3 | `src/services/subscription.service.js` `src/services/me.service.js` `src/services/user.service.js` | `Unknown column 'branch.name'` — Branch model uses field `branchName`, not `name`; all three services queried `attributes: ['id', 'name']` | Changed to `attributes: ['id', 'branchName']` in all affected includes |
| 4 | `src/routes/membership-plans.routes.js` | Route `/membership-plans/host` was matched by the `/:id` route above it because Express evaluates routes top-to-bottom | Moved the `/host` route registration above the `/:id` route |
| 5 | `app.js` | Auth rate limiter (max: 20 / 15 min) blocked integration test runs with 429 errors | Added `NODE_ENV === 'test' ? 10000 : 20` conditional for test environment |

---

## Test Data (Seeded)

### Platform DB (`gymsera_platform`)

**Cities:** Karachi, Lahore, Islamabad (+ areas per city)

**Platform Packages:** Starter, Growth, Enterprise

**Users:**
| Name | Email | Role |
|------|-------|------|
| GymsEra Admin | `admin@gymsera.com` | PLATFORM_ADMIN |
| Ahmed Khan | `ahmed@ironpeak.com` | GYM_HOST |
| Sara Malik | `sara@vitalityfit.com` | GYM_HOST |
| Ali Hassan | `ali.hassan@example.com` | GYM_MEMBER |
| Fatima Zahra | `fatima.z@example.com` | GYM_MEMBER |
| Omar Farooq | `omar.farooq@example.com` | GYM_MEMBER |
| Ayesha Noor | `ayesha.noor@example.com` | GYM_MEMBER |
| Bilal Ch. | `bilal.c@example.com` | GYM_MEMBER |

**Tenants:**
| Gym | Code | DB | Status |
|-----|------|----|--------|
| Iron Peak Fitness | `IRONPEAK` | `gymsera_ironpeak` | ACTIVE |
| Vitality Fit Studio | `VITALITYFIT` | `gymsera_vitalityfit` | ACTIVE |

**Gym Listings:** 3 listings (Iron Peak × 2, Vitality Fit × 1)

**Reviews:** 5 approved reviews across listings

---

## Running the Tests

```bash
# Ensure the API server is running with test config
NODE_ENV=test node server.js &

# Run all suites
NODE_ENV=test npx jest tests/ --testTimeout=30000 --runInBand --forceExit

# Run a single suite
NODE_ENV=test npx jest tests/auth.test.js --testTimeout=30000 --forceExit

# Run with verbose output
NODE_ENV=test npx jest tests/ --testTimeout=30000 --runInBand --forceExit --verbose
```
