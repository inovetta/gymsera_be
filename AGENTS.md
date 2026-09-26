# GymsEra — permanent agent rules (all AI agents: Claude Code, Gemini, Codex, Cursor, …)

This repo (`gymsera_be`) is one of four: `gyms_era` (Flutter), `gymsera_be` (API), `gymsera_cms`, `gymsera_web`.
Shared docs live in **`docs`** (absolute: `/Users/powertech/Developer/Apps/InovettaTech/SaaS/gymsera_be/docs/`):

| File | What it is |
|---|---|
| `docs/AGENT_HANDOFF.md` | **Live state: where the last agent stopped and the exact next action. Read it first.** |
| `docs/GYMSERA_PRODUCTION_ARCHITECTURE.md` | Master spec. §13 = finished work, §14 = owner decisions. |
| `docs/GYMSERA_AGENT_PLAYBOOK.md` | The prompts, in order. |

Before any change, re-read spec §0.1 (ground rules) and §0.5 (source of truth). These rules apply to every task:

1. Verify before you fix. Prove an issue exists in the code (file:line) before changing anything.
   If it doesn't exist, mark it NOT REPRODUCED in spec §13 and move on.
2. Reuse before you build. Search for an existing table/service/provider/hook/component first.
   A second system for the same concern is a defect.
3. Locked architecture (spec §0.1 rule 3) changes only where a listed issue proves a real defect.
4. Every fix: Issue → Root cause (file:line) → Pattern reused → Fix → Regression test → Result.
   Record it in spec §13 in the same commit.
5. One issue (or one tightly coupled group) per commit, with its test. No drive-by refactors.
6. Backend first, then clients. Clients never decide capacity, permissions, prices or entitlement.
7. Never weaken a guard or a test to make something pass.
8. No secrets or personal data in code, logs, fixtures or commits.
9. Mobile (gyms_era) is the reference for product behaviour; backend is the authority for enforcement.
   CMS and website copy mobile.

Safety:
- Database (owner decision R-19 in spec §14): the "production" database holds TEST data only. You may connect to it
  to investigate and to apply migrations that already passed locally. Automated test suites run ONLY against a
  local/Docker MySQL (the harness creates and drops databases). Never drop or truncate the live databases.
- Use only sandbox/test keys for Apple, Google Play and Stripe.
- Never run destructive commands (drop database, force push, rm -rf outside build folders) without asking.
- Owner decisions are recorded in spec §14 (all DECIDED on 2026-09-26). Apply them; don't ask again.
  Stop and ask only for a NEW decision that §14 doesn't cover, then record the answer in §14.
- If a task is bigger than expected, stop and report instead of improvising.

## Handoff protocol (so any agent can continue another agent's work)

Several agents take turns on this work, and any of them can run out of tokens, context or quota mid-task.
All state must live in files and git, never only in a chat.

**At the start of every session**
1. Read `docs/AGENT_HANDOFF.md`, then spec §13, then `git log --oneline -15` and `git status` in each repo you will touch.
2. If "Current prompt" is `IN PROGRESS`, continue from **Next action**. Don't restart the prompt or redo ticked items.
   Trust git over the handoff file if they disagree, and fix the file.
3. If uncommitted changes exist that the handoff doesn't explain, stop and ask the owner before touching them.
4. Add a row to the Session log (§4) with your tool and model name.

**Checkpoint: update `AGENT_HANDOFF.md` §1–§3 each time you**
- finish an issue (right after its commit),
- are about to start something long (big test run, migration, multi-file change),
- notice your context is getting long, you get a rate-limit/quota warning, or you have been working ~30–45 min since the last checkpoint,
- get blocked on an owner decision.

A good "Next action" is concrete: *"BILL-06: test `test/billing/android-ack.test.js` written and failing (red). Next: add
server-side acknowledge in `services/billing/google-sync.service.js` after verify, then make the test green."*

**If you must stop mid-issue**
- Commit what you have on the phase branch as `wip(<ISSUE-ID>): <what is done>` (never on main, never mixed with another issue),
  or leave it uncommitted and describe every changed file under "Work in progress that is NOT committed".
- The next agent finishes the issue and folds the WIP commit into the final one (`git reset --soft HEAD~1` on the unpushed branch, then commit properly).

**At the end of a prompt**
- Set "Prompt status" to `DONE`, clear "Issue in progress", set "Next action" to the next prompt in the playbook.
- Close your Session log row ("Ended because": task complete / context limit / quota / blocked).

Write the handoff in plain language that doesn't depend on any one tool. No tool-specific memory, no references
to "earlier in this chat".
