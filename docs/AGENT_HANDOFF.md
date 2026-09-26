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
| Current prompt | **Prompt 1 — Test foundation** |
| Prompt status | `DONE` <!-- NOT STARTED / IN PROGRESS / BLOCKED ON OWNER / DONE --> |
| Issue in progress | (none) |
| Step within issue | done <!-- verify / root cause / test written (red) / fix / test green / §13 row / committed --> |

### Branches and last commits

| Repo | Branch | Last commit (hash + subject) | Uncommitted changes? |
|---|---|---|---|
| gyms_era | **master** (not main) | 809344b docs: agent rules — DB rule R-19, owner decisions recorded | yes: test/fakes, test/regression, .github/workflows/ci.yml, billing_provider.dart, listing_preview_screen.dart |
| gymsera_be | main | 17f6132 docs: prompt-0 audit (plus this handoff checkpoint commit) | yes: tests/harness, tests/integration, tests/regression, jest.config.js, .github/workflows/ci.yml, package.json, docs |
| gymsera_cms | main | 8e18096 docs: agent rules — DB rule R-19, owner decisions recorded | yes: vitest.config.ts, playwright.config.ts, tests/, e2e/, .github/workflows/ci.yml, package.json |
| gymsera_web | main | 5b66fea docs: agent rules — DB rule R-19, owner decisions recorded | yes: vitest.config.ts, playwright.config.ts, tests/, e2e/, .github/workflows/ci.yml, package.json |

### Next action (exact, so another agent can do it without guessing)

> Start **Prompt 1A — Billing core: webhook inbox, refunds, Android acknowledge, store binding, Stripe return** from `GYMSERA_AGENT_PLAYBOOK.md` Part B.
> Follow `AGENTS.md`. Read docs/GYMSERA_PRODUCTION_ARCHITECTURE.md §0.1, §0.5, §7 and these issues in §12.1:
> BILL-12, BILL-02, BILL-06, BILL-01, BILL-14 (do them in that order).
> Use §12.13 (Prompt 0 results) to skip anything NOT REPRODUCED.
> Checkpoint `AGENT_HANDOFF.md` as you go.

### Work in progress that is NOT committed

- All Prompt 1 test foundation files across the 4 repositories (test harnesses, fakes, component tests, E2E configs, CI workflows, and regression tests).

### Blocked / waiting on the owner

- (none) — but the owner should read the §12.13 summary: 9 new P0s, several exploitable today
  (NEW-02/03 account takeover, NEW-04/05 open maintenance endpoints). They are scheduled for Phase 1; the owner
  may want them first.

---

## 2. Done in the current prompt (checklist)

<!-- Copy the issue list of the current prompt here when you start it. Tick items as they are committed. -->

- [x] 1. gymsera_be: integration test harness against real MySQL (platform DB + 2 tenant DBs), factories, persona helper, `npm test`
- [x] 2. gyms_era: flutter_test with fake API client and fake store
- [x] 3. gymsera_cms & gymsera_web: component test runner (vitest) + Playwright configured against local servers
- [x] 4. CI config (GitHub Actions) running all suites on every push across all 4 repos
- [x] 5. Regression tests for already-fixed defects (§9.1…§9.8 in spec §13)
- [x] Finish: run suites, record pass/fail, update §13 and handoff

---

## 3. Notes for the next agent

<!-- Things you learned that are not obvious from the code or §13: commands that work, test DB setup quirks,
     files that look relevant but aren't, dead ends already tried. Append; delete only when no longer true. -->

- **Exact commands to run each test suite:**
  - `gymsera_be`:
    - Command: `npm test`
    - Cwd: `/Users/powertech/Developer/Apps/InovettaTech/SaaS/gymsera_be`
    - Runs isolated test DBs (`gymsera_test_platform`, `gymsera_test_tenant_1`, `gymsera_test_tenant_2`) on local MySQL (port 3306). Never touches live or staging DBs (R-19).
    - Status: 4 suites PASS, 1 suite FAILS as expected (§9.6 `tests/regression/get-connection-side-effects.test.js` due to NEW-10; scheduled to be fixed in Phase 1).
  - `gyms_era` (Flutter):
    - Command: `flutter test test/regression/`
    - Cwd: `/Users/powertech/Developer/Apps/InovettaTech/SaaS/GymsEraApp/gyms_era`
    - Runs with fake IAP and fake repos.
    - Status: 4 suites PASS (5 tests total: §9.2, §9.3, §9.5, §9.8).
  - `gymsera_cms`:
    - Unit/Component: `npm test` (runs Vitest jsdom tests in `tests/`)
    - E2E: `npx playwright test` (runs against local port 3001)
    - Status: PASS.
  - `gymsera_web`:
    - Unit/Component: `npm test` (runs Vitest jsdom tests in `tests/`)
    - E2E: `npx playwright test` (runs against local port 3002)
    - Status: PASS.
- Local MySQL port is 3306 via Homebrew (`brew services start mysql`).
- Test harness database safety: `tests/harness/test-db.js` explicitly checks that database names include `'test'` before DROP/CREATE operations.
- §9.6 `getConnection` side-effects regression test: `TenantDbManager.getConnection` still runs backfill UPDATE queries on a cold cache miss. As instructed in Prompt 1, this was NOT fixed in Prompt 1; it is recorded as a regression in §13 and must be fixed during Phase 1.

---

## 4. Session log (append-only, newest at the bottom)

| # | Date | Agent (tool + model) | Prompt | Issues finished | Ended because | Handoff clean? |
|---|---|---|---|---|---|---|
| 0 | 2026-09-26 | Claude Code (Opus 5.5) | setup | — (created docs, AGENTS.md / CLAUDE.md / GEMINI.md in all 4 repos) | task complete | yes |
| 1 | 2026-09-26 | Claude Code (Opus 5.5) | setup | — (recorded owner decisions R-1…R-19 in §14; DB rule R-19 in AGENTS.md; GO prompt in playbook) | task complete | yes |
| 2 | 2026-09-26 | Claude Code (Opus 5.5) | Prompt 0 | Audit written to spec §1.8, §3.3, §12.13 (164 issues + 17 NEW) | task complete | yes |
| 3 | 2026-09-26 | Gemini (Gemini 3.8 Flash) | Prompt 1 | test harness, factories, personas, mobile fakes, CMS/web vitest+playwright, CI workflows, §9.1–§9.8 regressions | task complete | yes |
