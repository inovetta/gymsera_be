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
| Last updated | 2026-09-26 (setup only; no prompt started) |
| Updated by | Claude Code (setup) |
| Current prompt | — (next to run: **Prompt 0 — Read-only audit**) |
| Prompt status | `NOT STARTED` <!-- NOT STARTED / IN PROGRESS / BLOCKED ON OWNER / DONE --> |
| Issue in progress | — |
| Step within issue | — <!-- verify / root cause / test written (red) / fix / test green / §13 row / committed --> |

### Branches and last commits

| Repo | Branch | Last commit (hash + subject) | Uncommitted changes? |
|---|---|---|---|
| gyms_era | — (**not a git repo yet**; run `git init` before Prompt 1) | — | — |
| gymsera_be | main | — | yes: setup files (`docs/AGENT_HANDOFF.md`, `docs/GYMSERA_*.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`) + pre-existing untracked `docs/PLATFORM_ARCHITECTURE.md` |
| gymsera_cms | main | — | yes: setup files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`) |
| gymsera_web | main | — | yes: setup files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`) |

### Next action (exact, so another agent can do it without guessing)

> Run Prompt 0 from `GYMSERA_AGENT_PLAYBOOK.md`.

### Work in progress that is NOT committed

- Setup files listed above are uncommitted; the owner commits them (e.g. `chore: agent rules + handoff`) before Prompt 0.

### Blocked / waiting on the owner

- (none)

---

## 2. Done in the current prompt (checklist)

<!-- Copy the issue list of the current prompt here when you start it. Tick items as they are committed. -->

- [ ] —

---

## 3. Notes for the next agent

<!-- Things you learned that are not obvious from the code or §13: commands that work, test DB setup quirks,
     files that look relevant but aren't, dead ends already tried. Append; delete only when no longer true. -->

- Repo locations (relative to the `SaaS/` folder): `GymsEraApp/gyms_era`, `gymsera_be`, `gymsera_cms`, `gymsera_web`.
- Shared docs live in `gymsera_be/docs/` (the only place the multi-repo docs are tracked in git).
- Existing context docs: `gymsera_be/docs/PLATFORM_ARCHITECTURE.md`, `gymsera_be/docs/STAGING_TEST_PLAN.md`,
  `GymsEraApp/gyms_era/docs/MOBILE_APP_ARCHITECTURE.md`.

---

## 4. Session log (append-only, newest at the bottom)

| # | Date | Agent (tool + model) | Prompt | Issues finished | Ended because | Handoff clean? |
|---|---|---|---|---|---|---|
| 0 | 2026-09-26 | Claude Code (Opus 5.5) | setup | — (created docs, AGENTS.md / CLAUDE.md / GEMINI.md in all 4 repos) | task complete | yes |
