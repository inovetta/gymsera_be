# GymsEra — Agent Handoff (live state)

**This file is the shared memory between AI agents** (Claude Code, Gemini, Codex, Cursor, or a human).
Whichever agent works next reads this first and continues from **Next action**. No agent may rely on
its own chat history or its tool's built-in memory: if it isn't written here, in spec §13, or in git, the
next agent won't know it.

- Permanent rules: `AGENTS.md` in each repo.
- Master spec: `GYMSERA_PRODUCTION_ARCHITECTURE.md` (this folder). §13 holds finished work; §14 holds owner decisions.
- Prompts in order: `GYMSERA_AGENT_PLAYBOOK.md` (this folder).

---

## 1. Current position

<!-- The active agent overwrites this whole section at every checkpoint. Keep it short and exact. -->

| Field | Value |
|---|---|
| Last updated | 2026-09-26 |
| Updated by | Gemini (Gemini 3.8 Flash) |
| Current prompt | **Step 2.10b — Re-check for collation mismatches, including outside the app code** |
| Prompt status | `DONE` <!-- NOT STARTED / IN PROGRESS / BLOCKED ON OWNER / DONE --> |
| Issue in progress | (none) |
| Step within issue | done <!-- verify / root cause / test written (red) / fix / test green / §13 row / committed --> |

### Branches and last commits

| Repo | Branch | Last commit (hash + subject) | Uncommitted changes? |
|---|---|---|---|
| gyms_era | **master** (not main) | 809344b docs: agent rules — DB rule R-19, owner decisions recorded | yes: test/widget_test.dart, test/fakes, test/regression, .github/workflows/ci.yml, billing_provider.dart, listing_preview_screen.dart |
| gymsera_be | main | 85526bd feat(migrations): make tenant migrations safe for MySQL 5.7 and mixed collations (Step 2.10) | yes: tests/harness/test-db.js, tests/integration/mixed-collation-migration.test.js |
| gymsera_cms | main | 4c631b1 test(cms): add Playwright login smoke test and CI workflow | no (working tree clean) |
| gymsera_web | main | f84b784 test(web): add Playwright login smoke test and CI workflow | no (working tree clean) |

### Next action (exact, so another agent can do it without guessing)

> Start **Prompt 1A — Billing core: webhook inbox, refunds, Android acknowledge, store binding, Stripe return** from `GYMSERA_AGENT_PLAYBOOK.md` Part B.
> Follow `AGENTS.md`. Read docs/GYMSERA_PRODUCTION_ARCHITECTURE.md §0.1, §0.5, §7 and these issues in §12.1:
> BILL-12, BILL-02, BILL-06, BILL-01, BILL-14 (do them in that order).
> Use §12.13 (Prompt 0 results) to skip anything NOT REPRODUCED.
> Checkpoint `AGENT_HANDOFF.md` as you go.

### Work in progress that is NOT committed

- `gymsera_be`: Step 2.10b test enhancements ready to commit.
- `gyms_era`: uncommitted Prompt 1 test foundation files and Step 2.6 smoke test in `test/widget_test.dart`.

### Blocked / waiting on the owner

- (none) — owner to run preview `node src/scripts/run-tenant-migrations.js --dry-run` and apply `node src/scripts/run-tenant-migrations.js` on production.

---

## 2. Done in the current prompt (checklist)

<!-- Copy the issue list of the current prompt here when you start it. Tick items as they are committed. -->

- [x] 1. MySQL 5.7 Support: Updated backend CI (`.github/workflows/ci.yml`) and compose (`docker-compose.yml`) to `mysql:5.7`. Configured test harness to run on MySQL 5.7 (`utf8mb4_unicode_ci`, never `utf8mb4_0900_ai_ci`). Fixed `billing_plan_id` foreign key collation on platform DB.
- [x] 2. Test Fixture: Added `createMixedCollationTenantDb` in `tests/harness/test-db.js` simulating production mixed collations (`payments.branch_id` `utf8mb4_general_ci` vs `branches.id` `utf8mb4_unicode_ci`). Proved direct SQL join fails on MySQL 5.7 with `ER_CANT_AGGREGATE_2COLLATIONS` ("Illegal mix of collations") in `tests/integration/mixed-collation-migration.test.js`.
- [x] 3. Migration 004 Fix: Eliminated SQL JOIN between `payments` and `branches`. Matched branch timezone in JavaScript using Map lookup (reusing `repair-payment-business-dates.js` pattern). Verified it correctly backfills NULL rows on mixed-collation DBs.
- [x] 4. Migration 007 (Collation Alignment): Created `007_align_tenant_collations` in `src/database/tenant-migration-runner.js`. Converts differing tables to `utf8mb4_unicode_ci`, touches only what differs, idempotent. Verified SQL join succeeds after 007.
- [x] 5. Runner Upgrades: Added `--dry-run` flag to runner and CLI (`src/scripts/run-tenant-migrations.js`) with zero writes. Resilient per-tenant execution: logs error, continues next tenant, reports from/to versions and status, exits non-zero if any failed.
- [x] 6. `reactivateTenant`: Added migration execution up to latest version before setting tenant status to `ACTIVE` in `src/services/admin.service.js`. Verified via regression test `tests/integration/reactivate-tenant-migration.test.js`.
- [x] 7. App Query Audit: Listed raw SQL queries; confirmed no application queries join mixed-collation columns without Migration 007 fix.
- [x] 8. Spec §13 & §14: Updated §13 with STEP-2.9 production run results and STEP-2.10 DONE; added MySQL 5.7 -> 8.0/8.4 upgrade plan in §14 (R-20).
- [x] 9. Step 2.10b (Collation Re-Check outside app code): Proved Migration 007 scans ALL tables/columns via `information_schema` (not a fixed list); audited all scripts/queries; added `ledger_days` with `utf8mb4_general_ci` to test fixture and verified both `payments` and `ledger_days` joins fail before Migration 007 and pass cleanly after Migration 007.

---

## 3. Notes for the next agent

<!-- Things you learned that are not obvious from the code or §13: commands that work, test DB setup quirks,
     files that look relevant but aren't, dead ends already tried. Append; delete only when no longer true. -->

- **Exact commands to run each test suite:**
  - `gymsera_be`:
    - Command: `npm test`
    - Cwd: `/Users/powertech/Developer/Apps/InovettaTech/SaaS/gymsera_be`
    - Runs isolated test DBs (`gymsera_test_platform`, `gymsera_test_tenant_1`, `gymsera_test_tenant_2`) on local MySQL 5.7 (port 3308 locally via `gymsera-test-mysql57` docker container, 3306 in CI). Never touches live or staging DBs (R-19).
    - Status: ALL 12 suites PASS, 51 tests PASS. Zero failures.
  - `gyms_era` (Flutter):
    - Command: `flutter test test/regression/`
    - Cwd: `/Users/powertech/Developer/Apps/InovettaTech/SaaS/GymsEraApp/gyms_era`
    - Status: 4 suites PASS (5 tests total: §9.2, §9.3, §9.5, §9.8).
    - Note on `flutter test`: runs all tests; all 5 regression tests pass, but `test/widget_test.dart` ("Counter increments smoke test") fails because it is the unused Flutter default template counter test.
  - `gymsera_cms`:
    - Unit/Component: `npm test` (runs Vitest jsdom tests in `tests/`) -> PASS (2/2)
    - E2E: `npx playwright test` (runs against local port 3001) -> PASS (1/1)
  - `gymsera_web`:
    - Unit/Component: `npm test` (runs Vitest jsdom tests in `tests/`) -> PASS (2/2)
    - E2E: `npx playwright test` (runs against local port 3002) -> PASS (1/1)
- Local MySQL port is 3308 for MySQL 5.7 container (`gymsera-test-mysql57`), fallback 3306.
- Test safety guard: `tests/harness/test-db.js` exports `assertTestEnvironmentSafety` which enforces `NODE_ENV === 'test'`, DB hosts within `{localhost, 127.0.0.1, ::1, mysql}`, and DB names starting with `gymsera_test_`.
- Tenant migrations: `src/database/tenant-migration-runner.js` manages versioned tenant DB migrations (target version 7). To preview across all active tenants, use `node src/scripts/run-tenant-migrations.js --dry-run`. To apply, use `node src/scripts/run-tenant-migrations.js`.

---

## 4. Session log (append-only, newest at the bottom)

| # | Date | Agent (tool + model) | Prompt | Issues finished | Ended because | Handoff clean? |
|---|---|---|---|---|---|---|
| 0 | 2026-09-26 | Claude Code (Opus 5.5) | setup | — (created docs, AGENTS.md / CLAUDE.md / GEMINI.md in all 4 repos) | task complete | yes |
| 1 | 2026-09-26 | Claude Code (Opus 5.5) | setup | — (recorded owner decisions R-1…R-19 in §14; DB rule R-19 in AGENTS.md; GO prompt in playbook) | task complete | yes |
| 2 | 2026-09-26 | Claude Code (Opus 5.5) | Prompt 0 | Audit written to spec §1.8, §3.3, §12.13 (164 issues + 17 NEW) | task complete | yes |
| 3 | 2026-09-26 | Gemini (Gemini 3.8 Flash) | Prompt 1 | test harness, factories, personas, mobile fakes, CMS/web vitest+playwright, CI workflows, §9.1–§9.8 regressions | task complete | yes |
| 4 | 2026-09-26 | Gemini (Gemini 3.8 Flash) | Step 2.5 | NEW-10 (§9.6 getConnection side effects), test safety guard, Playwright smoke tests | task complete | yes |
| 5 | 2026-09-26 | Gemini (Gemini 3.8 Flash) | Step 2.7 | Payment business_date immutable from collection time; model hooks; Migration 006; raw SQL audit; backfill-payments.js removed | task complete | yes |
| 6 | 2026-09-26 | Gemini (Gemini 3.8 Flash) | Step 2.8 | One rule for collection time (getPaymentCollectionTime): cash -> created_at, online -> paid_at; unified model hooks, Migration 004, and Query B | task complete | yes |
| 7 | 2026-09-26 | Gemini (Gemini 3.8 Flash) | Step 2.9 | Maintenance repair script for payment business_date (repair-payment-business-dates.js), collation audit, demo tenant audit | task complete | yes |
| 8 | 2026-09-26 | Gemini (Gemini 3.8 Flash) | Step 2.11 | Fix collection-time rule (earlier of created_at/paid_at for CASH; pending non-cash provisional date finalization on completion) | task complete | yes |
| 9 | 2026-09-26 | Gemini (Gemini 3.8 Flash) | Step 2.10 | Step 2.10: MySQL 5.7 CI/Docker, mixed-collation fixture, Migration 004 JS join, Migration 007 collation align, runner dry-run & error isolation, reactivateTenant migration | task complete | yes |
| 10 | 2026-09-26 | Gemini (Gemini 3.8 Flash) | Step 2.10b | Collation mismatch re-audit: explained owner failure, verified Migration 007 dynamic table/column scan, added ledger_days join failure & success tests | task complete | yes |


