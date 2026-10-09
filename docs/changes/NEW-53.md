# NEW-53: Root-level tests brought into the suite, failures triaged

- **Issue ID**: NEW-53
- **Status**: PARTLY DONE. 7 of 13 files now run in `npm test`. 6 are left out, owner decision needed (see below).
- **Root cause**: `jest.config.js` `testMatch` covers only `tests/integration/**` and `tests/regression/**`. The 13 `tests/*.test.js` files were never run by `npm test`, so three of them went stale unnoticed.

## Step 1 and 2: inventory and run

Runs were done with the CI env (root, empty password, Docker MySQL `gymsera-test-mysql57` on 127.0.0.1:3308, harness guard `gymsera_test_*`). Nothing was run against a live database. Nothing was listening on :3000 during the run.

| File | Covers | Route/service still exists? | Before | First error line |
|---|---|---|---|---|
| `tests/access.test.js` | `access.service` precedence, guardrails, permission catalogue (mocked) | yes | PASS 32 | |
| `tests/approval-collect.test.js` | `approval.service.markCollected`, `members.create` command | yes | PASS 9 | |
| `tests/commands.test.js` | command registry (`members.*`, `expenses.create`, `plans.create`, ...) | yes | PASS 27 | |
| `tests/ledger.test.js` | `ledger.service` date math, close day, adjustments | yes | PASS 22 | |
| `tests/expenses-access.test.js` | `expenses.controller.listExpenses` gate | yes | FAIL 1 of 4 | `expect(next).not.toHaveBeenCalledWith({statusCode: 403})`, got `Access denied: Expense list and financial data are host and admin only.` (`expenses-access.test.js:85`) |
| `tests/payments-access.test.js` | `payments.controller.verifyPayment` gate | yes | FAIL 1 of 4 | `Expected statusCode 403, Received: Payment not found` (`payments-access.test.js:74`) |
| `tests/verify-payment-invoice.test.js` | `payment.service.verifyPayment` invoice backfill | yes | FAIL 3 of 3 | `TypeError: Cannot read properties of undefined (reading 'findByPk')` at `ledger.service.js:117` |
| `tests/admin.test.js` | `/admin/*`, `/platform-packages`, `/users` against a live server | yes (all routes found in `src/routes`) | FAIL 14 of 14 | `AxiosError` connection refused to `localhost:3000` at `helpers.js:28`, then `loginAs(...) failed` |
| `tests/auth.test.js` | register, OTP, login, refresh (live server) | yes | FAIL 14 of 14 | same |
| `tests/discovery.test.js` | `/discovery/*` (live server) | yes | FAIL 11, 4 pass (the 4 are `if (!x) return` guards that assert nothing) | same |
| `tests/host.test.js` | host gym/branch/plan/reports routes (live server) | yes | FAIL 22 of 22 | same |
| `tests/me.test.js` | `/me/*` (live server) | yes | FAIL 5 of 5 | same |
| `tests/member.test.js` | member subscribe/discovery/reviews (live server) | yes | FAIL 7 of 7 | same |

`tests/helpers.js` is the axios client for the six live-server files (`BASE = http://localhost:3000/api/v1`). It stays because they use it.

## Step 3: triage

| File | Verdict | Cause |
|---|---|---|
| `expenses-access` | STALE TEST | RBAC-07 (`d296268`, 2026-09-29) removed the legacy `GymStaff` "Admin" fallback from `hasExpenseAccess` (`expenses.controller.js:73-90`). Test now asserts the new behaviour: no grant means 403 and `GymStaff` is never read. |
| `payments-access` | STALE TEST | SEC-01 (`4de6020`) turned "no branch access" into a scoped 404 (`payments.controller.js:109-112`), so existence is not revealed. Test now expects 404. |
| `verify-payment-invoice` | STALE TEST | Three later changes: the ledger business-date stamp reads `Branch.timezone` (`ledger.service.js:115-120`), PAY-05 `12fa125` takes invoice numbers from `invoice-sequence.service`, PAY-01 `a5f26da` makes `_createInvoice` call `Invoice.create(payload, {})` (`payment.service.js:33-52`). Test mock gained `Branch`, stubs the sequence service, and expects the `{}` second argument. The behaviour asserted (backfill creates a PAID invoice once, never throws) is unchanged. |
| 4 passing files | none needed | |
| 6 live-server files | NOT TRIAGEABLE, left in `tests/`, owner decision | Not REAL BUG: there is no code to blame, they never reach the app. Not DEAD: every route they call exists. They are May 2026 smoke scripts that need a server on :3000, dev seed users (`admin@gymsera.com`, `ahmed@ironpeak.com`, `ali.hassan@example.com`), seeded Karachi gyms and a dev-only `debugCode`. The harness has none of these, and running them against a live server would break R-19. Fixing them means rewriting about 800 lines onto the harness personas/factories, which is bigger than "move and fix", so I stopped (AGENTS.md). Recorded as NEW-54. |

No assertion was weakened. `payments-access` and `expenses-access` still prove a user without the grant is refused; only the status code or mechanism changed.

## Step 4: moved into the suite

`git mv` into `tests/regression/`, with `../src/` changed to `../../src/`: `access`, `approval-collect`, `commands`, `expenses-access`, `ledger`, `payments-access`, `verify-payment-invoice`. `jest.config.js` is unchanged.

## New issues found

| ID | Severity | Issue |
|---|---|---|
| NEW-54 | P3 (test debt) | Six live-server smoke tests (`admin`, `auth`, `discovery`, `host`, `me`, `member`) are never run. Choose: A) rewrite onto the harness (about 800 lines, using `tests/harness/personas.js`) or B) delete them, since the regression suite covers most of these routes. No product bug was found. |

No REAL BUG was found among the runnable files.

## Test results (full suite, `npm test`)

Before this change: 141 suites / 1276 tests. After: **148 suites / 1377 tests** (+7 suites, +101 tests). Result: see the run table in the spec §13 row.
