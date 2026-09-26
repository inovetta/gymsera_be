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
| Last updated | 2026-09-26 (Prompt 0 finished) |
| Updated by | Claude Code (Opus 5.5) |
| Current prompt | **Prompt 0 — Read-only audit** |
| Prompt status | `DONE` <!-- NOT STARTED / IN PROGRESS / BLOCKED ON OWNER / DONE --> |
| Issue in progress | — |
| Step within issue | — <!-- verify / root cause / test written (red) / fix / test green / §13 row / committed --> |

### Branches and last commits

| Repo | Branch | Last commit (hash + subject) | Uncommitted changes? |
|---|---|---|---|
| gyms_era | **master** (not main) | 809344b docs: agent rules — DB rule R-19, owner decisions recorded | no |
| gymsera_be | main | the "docs: prompt-0 audit" commit (see `git log -1`) | no |
| gymsera_cms | main | 8e18096 docs: agent rules — DB rule R-19, owner decisions recorded | no |
| gymsera_web | main | 5b66fea docs: agent rules — DB rule R-19, owner decisions recorded | no |

### Next action (exact, so another agent can do it without guessing)

> Run **Prompt 1 — Test foundation** from `GYMSERA_AGENT_PLAYBOOK.md` Part B. Read §3 below first
> (what test setup exists today and which regression test is expected to fail).

### Work in progress that is NOT committed

- (none)

### Blocked / waiting on the owner

- (none) — but the owner should read the §12.13 summary: 9 new P0s, several exploitable today
  (NEW-02/03 account takeover, NEW-04/05 open maintenance endpoints). They are scheduled for Phase 1; the owner
  may want them first.

---

## 2. Done in the current prompt (checklist)

<!-- Copy the issue list of the current prompt here when you start it. Tick items as they are committed. -->

- [x] 1. Repo map (stack, structure, tests, start commands, env file names) → spec §1.8
- [x] 2. §1 facts checked; D-1…D-4 resolved → spec §1.8
- [x] 3. §3.3 parity matrix filled
- [x] 4. §12.13 verification: BILL
- [x] 4. §12.13 verification: CAP
- [x] 4. §12.13 verification: FLOW
- [x] 4. §12.13 verification: PAY
- [x] 4. §12.13 verification: AUTH/RBAC
- [x] 4. §12.13 verification: SEC
- [x] 4. §12.13 verification: REL/API
- [x] 4. §12.13 verification: RT
- [x] 4. §12.13 verification: UX
- [x] 4. §12.13 verification: PERF/GLB/OBS
- [x] 5. NEW-xx findings (NEW-01…16 + NEW-BOOST in spec §12.13.11)
- [x] Commit "docs: prompt-0 audit"

---

## 3. Notes for the next agent

<!-- Things you learned that are not obvious from the code or §13: commands that work, test DB setup quirks,
     files that look relevant but aren't, dead ends already tried. Append; delete only when no longer true. -->

- Repo locations (relative to the `SaaS/` folder): `GymsEraApp/gyms_era`, `gymsera_be`, `gymsera_cms`, `gymsera_web`.
- Shared docs live in `gymsera_be/docs/` (the only place the multi-repo docs are tracked in git).
- Prompt 0 results live in spec §12.13 (per-issue table + NEW-01…16, NEW-BOOST), §3.3 "Verified status", and §1.8
  (repo map, fact check, D-1…D-4). Use those file:line references as the starting point for each fix.
- Test setup found by Prompt 0 (for Prompt 1):
  - `gymsera_be/tests/*.test.js` (Jest) call a **running server at http://localhost:3000** with seeded users
    (`tests/helpers.js`). There is no isolated DB harness. Never point them at the live DB (R-19).
  - `gymsera_be/docker-compose.yml` already defines platform MySQL (3306), tenant MySQL (3307) and Redis — reuse it.
  - `gyms_era/test/widget_test.dart` is the default Flutter counter test; it will fail against this app.
  - CMS and web have no test runner. No repo has CI.
  - Expected regression-test failure: §9.6 "`getConnection` on a cold cache performs zero UPDATEs" will FAIL —
    `TenantDbManager.getConnection` still runs ALTER/UPDATE backfills (NEW-10). Record it as a regression, don't fix in Prompt 1.
- The backend has two `node-cron`/Vercel cron entry points for the same job (REL-03); don't run both in tests.
- Shell note: in zsh an unquoted `echo =====` fails ("= not found"); quote separators.
- Existing context docs: `gymsera_be/docs/PLATFORM_ARCHITECTURE.md`, `gymsera_be/docs/STAGING_TEST_PLAN.md`,
  `GymsEraApp/gyms_era/docs/MOBILE_APP_ARCHITECTURE.md`.

---

## 4. Session log (append-only, newest at the bottom)

| # | Date | Agent (tool + model) | Prompt | Issues finished | Ended because | Handoff clean? |
|---|---|---|---|---|---|---|
| 0 | 2026-09-26 | Claude Code (Opus 5.5) | setup | — (created docs, AGENTS.md / CLAUDE.md / GEMINI.md in all 4 repos) | task complete | yes |
| 1 | 2026-09-26 | Claude Code (Opus 5.5) | setup | — (recorded owner decisions R-1…R-19 in §14; DB rule R-19 in AGENTS.md; GO prompt in playbook) | task complete | yes |
| 2 | 2026-09-26 | Claude Code (Opus 5.5) | Prompt 0 | Audit written to spec §1.8, §3.3, §12.13 (164 issues + 17 NEW) | task complete | yes |
