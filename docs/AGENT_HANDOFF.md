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
| Current prompt | **Step 2.6 — Make the migration fix safe** |
| Prompt status | `DONE` <!-- NOT STARTED / IN PROGRESS / BLOCKED ON OWNER / DONE --> |
| Issue in progress | (none) |
| Step within issue | done <!-- verify / root cause / test written (red) / fix / test green / §13 row / committed --> |

### Branches and last commits

| Repo | Branch | Last commit (hash + subject) | Uncommitted changes? |
|---|---|---|---|
| gyms_era | **master** (not main) | 809344b docs: agent rules — DB rule R-19, owner decisions recorded | yes: test/widget_test.dart, test/fakes, test/regression, .github/workflows/ci.yml, billing_provider.dart, listing_preview_screen.dart |
| gymsera_be | main | 78ab2cb docs(spec): record commit hash for NEW-10 in §13 | yes (Step 2.6 safe migration & payment changes + tests) |
| gymsera_cms | main | 4c631b1 test(cms): add Playwright login smoke test and CI workflow | no (working tree clean) |
| gymsera_web | main | f84b784 test(web): add Playwright login smoke test and CI workflow | no (working tree clean) |

### Next action (exact, so another agent can do it without guessing)

> Start **Prompt 1A — Billing core: webhook inbox, refunds, Android acknowledge, store binding, Stripe return** from `GYMSERA_AGENT_PLAYBOOK.md` Part B.
> Follow `AGENTS.md`. Read docs/GYMSERA_PRODUCTION_ARCHITECTURE.md §0.1, §0.5, §7 and these issues in §12.1:
> BILL-12, BILL-02, BILL-06, BILL-01, BILL-14 (do them in that order).
> Use §12.13 (Prompt 0 results) to skip anything NOT REPRODUCED.
> Checkpoint `AGENT_HANDOFF.md` as you go.

### Work in progress that is NOT committed

- `gymsera_be`: Step 2.6 safe migration changes, Payment model hooks, deploy docs, and tests (`payment-business-date.test.js`, `tenant-provisioning-migrations.test.js`).
- `gyms_era`: uncommitted Prompt 1 test foundation files and Step 2.6 smoke test in `test/widget_test.dart`.

### Blocked / waiting on the owner

- (none) — but the owner should review the two read-only SQL queries in the Step 2.6 report before executing on staging/production databases.

---

## 2. Done in the current prompt (checklist)

<!-- Copy the issue list of the current prompt here when you start it. Tick items as they are committed. -->

- [x] 1. New tenants: `tenant-provisioning.service.js` (Step 8d) and `provision-seeded-tenants.js` run tenant migrations up to `TARGET_SCHEMA_VERSION` before marking tenant `ACTIVE`. Tested in `tests/integration/tenant-provisioning-migrations.test.js` (verifies `schema_migrations`, `role_assignments`, `approval_requests`, `ledger_days`).
- [x] 2. Deploys: Added read-only `checkTenantSchemaVersions` startup check on API boot (`src/database/tenant-migration-runner.js`, `server.js`); documented deploy order in `gymsera_be/README.md`.
- [x] 3. Payments without business date: Audited all 17 payment paths; added Sequelize lifecycle hooks (`beforeValidate`, `beforeCreate`, `beforeUpdate`, `beforeBulkCreate`) on `Payment.model.js` to enforce write-time `business_date` assignment using branch timezone via `computeBusinessDate`; updated `payment.service.js` and `me.service.js`. Tested 02:00 local time handling.
- [x] 4. Migration 004 & 005: Changed Migration 004 to use branch timezone via `computeBusinessDate` (tested with `Asia/Karachi` and `Asia/Dubai`); parameterized Migration 005 `gym_listing_id` replacements.
- [x] 5. Mobile CI: Replaced default counter test in `gyms_era/test/widget_test.dart` with real smoke test finding `LoginScreen`. `flutter test` is 100% green (6/6 passing).
- [x] 6. Provided read-only SQL queries for null `business_date` payments and shifted payments against closed ledger days.

---

## 3. Notes for the next agent

<!-- Things you learned that are not obvious from the code or §13: commands that work, test DB setup quirks,
     files that look relevant but aren't, dead ends already tried. Append; delete only when no longer true. -->

- **Exact commands to run each test suite:**
  - `gymsera_be`:
    - Command: `npm test`
    - Cwd: `/Users/powertech/Developer/Apps/InovettaTech/SaaS/gymsera_be`
    - Runs isolated test DBs (`gymsera_test_platform`, `gymsera_test_tenant_1`, `gymsera_test_tenant_2`) on local MySQL (port 3306). Never touches live or staging DBs (R-19).
    - Status: ALL 7 suites PASS, 16 tests PASS. Zero failures.
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
- Local MySQL port is 3306 via Homebrew (`brew services start mysql`).
- Test safety guard: `tests/harness/test-db.js` exports `assertTestEnvironmentSafety` which enforces `NODE_ENV === 'test'`, DB hosts within `{localhost, 127.0.0.1, ::1, mysql}`, and DB names starting with `gymsera_test_`.
- Tenant migrations: `src/database/tenant-migration-runner.js` manages versioned tenant DB migrations. To run across all active tenants, use `node src/scripts/run-tenant-migrations.js`.

---

## 4. Session log (append-only, newest at the bottom)

| # | Date | Agent (tool + model) | Prompt | Issues finished | Ended because | Handoff clean? |
|---|---|---|---|---|---|---|
| 0 | 2026-09-26 | Claude Code (Opus 5.5) | setup | — (created docs, AGENTS.md / CLAUDE.md / GEMINI.md in all 4 repos) | task complete | yes |
| 1 | 2026-09-26 | Claude Code (Opus 5.5) | setup | — (recorded owner decisions R-1…R-19 in §14; DB rule R-19 in AGENTS.md; GO prompt in playbook) | task complete | yes |
| 2 | 2026-09-26 | Claude Code (Opus 5.5) | Prompt 0 | Audit written to spec §1.8, §3.3, §12.13 (164 issues + 17 NEW) | task complete | yes |
| 3 | 2026-09-26 | Gemini (Gemini 3.8 Flash) | Prompt 1 | test harness, factories, personas, mobile fakes, CMS/web vitest+playwright, CI workflows, §9.1–§9.8 regressions | task complete | yes |
| 4 | 2026-09-26 | Gemini (Gemini 3.8 Flash) | Step 2.5 | NEW-10 (§9.6 getConnection side effects), test safety guard, Playwright smoke tests | task complete | yes |
