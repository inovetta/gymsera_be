# GymsEra — Agent Playbook

**How to run `GYMSERA_PRODUCTION_ARCHITECTURE.md` with AI coding agents (Claude Code, Gemini, or others), one step at a time, and switch agents at any point without losing work.**

Don't paste the spec into the chat section by section. The files are already **inside the workspace**, so give the agent short prompts that point to section numbers. That way:
- The agent can always re-open §0.1 rules, §8.3, or §12 while it works.
- It updates §13 and `AGENT_HANDOFF.md` in the files themselves, so progress survives a new chat **or a different agent**.
- Your prompts stay short, and the agent's memory isn't filled with pasted text.

---

## Part A — One-time setup (already done)

### A1. Where the files are

The four repos don't share a clean parent folder, so the shared docs live in `gymsera_be/docs/` (tracked in git):

```
SaaS/
  gymsera_be/docs/GYMSERA_PRODUCTION_ARCHITECTURE.md   ← the spec
  gymsera_be/docs/GYMSERA_AGENT_PLAYBOOK.md            ← this file
  gymsera_be/docs/AGENT_HANDOFF.md                     ← live "where are we" state shared by all agents
  GymsEraApp/gyms_era/   AGENTS.md  CLAUDE.md  GEMINI.md
  gymsera_be/            AGENTS.md  CLAUDE.md  GEMINI.md
  gymsera_cms/           AGENTS.md  CLAUDE.md  GEMINI.md
  gymsera_web/           AGENTS.md  CLAUDE.md  GEMINI.md
```

In the prompts below, `docs/…` means `gymsera_be/docs/…`. Each repo's `AGENTS.md` gives the exact relative path from that repo, so an agent opened in any one of the four folders can find the docs.

### A2. The rules files

`AGENTS.md` in each repo holds the permanent rules **and the handoff protocol**. Each agent reads it through its own file:

| Agent | Reads | How it gets the rules |
|---|---|---|
| Claude Code | `CLAUDE.md` | `@AGENTS.md` import |
| Gemini CLI / Gemini Code Assist (agent mode) | `GEMINI.md` | `@./AGENTS.md` import, plus a fallback line telling it to open `AGENTS.md` |
| Codex, Cursor, others | `AGENTS.md` | directly |

Edit rules **only in `AGENTS.md`**. If you change them, make the same change in all four repos.

**Check once per agent** that the rules were loaded: in Gemini CLI run `/memory show`; in Claude Code run `/memory`. Or ask the agent: "What does the handoff protocol in AGENTS.md say?"

### A3. Git hygiene

- ⚠️ **`gyms_era` is not a git repository yet.** Run `git init` there (and make a first commit) before Prompt 1. Otherwise "one issue per commit" and the handoff can't work for mobile.
- Commit or stash everything in all four repos so the agent starts from a clean state.
- Create a branch per phase in each repo you touch, for example `hardening/phase-1`.
- Review and merge each phase yourself before starting the next.

### A4. Decisions to make before Phase 1B

The agent will stop and ask about these (spec §14). Deciding early saves time. **Write your answers into spec §14** so every agent sees them.

| # | Decision | Default in the spec |
|---|---|---|
| R-2 | Days members can still check in at a locked branch | 7 |
| R-3 | Grace days before over-plan branches lock | 7 |
| R-4 | Card at web signup: save card and charge on approval, or charge now and refund on rejection | Save card, charge on approval |
| R-7 | Is Stripe available for your company's country? | Web card payments off until confirmed |
| BILL-18 | Is "Boost" paid? | Unknown — agent must ask |
| R-13 | Accept the mobile navigation proposals (drawer → More, label renames)? | No, keep mobile as is |

---

## Part B — The prompts, in order

### How to use them

1. Start a **new agent chat for each prompt**. Long chats make agents forget rules; the rules file, `AGENT_HANDOFF.md` and §13 carry the memory between chats and between agents.
2. Paste the prompt exactly. Wait for the report.
3. If the agent runs out of tokens or quota partway through, **switch agents with prompt C0** (Part C). Don't re-paste the original prompt into the new agent.
4. Review the diff and run the app yourself where it says so.
5. Then move to the next prompt.

Every prompt starts with the same **standard start** line and ends with the same **standard finish** block (B0). Both are written out in full in each prompt so you can copy one block at a time.

### B0. Standard start and finish (already included in every prompt below)

```text
Start: follow AGENTS.md. Read docs/AGENT_HANDOFF.md first; if this prompt is already IN PROGRESS there,
continue from its "Next action" instead of starting over. Checkpoint the handoff file as AGENTS.md says.
```

```text
Finish like this:
- Run the full test suites of every repo you changed and paste the pass/fail summary.
- Update docs/GYMSERA_PRODUCTION_ARCHITECTURE.md §13: one row per issue, with status
  (DONE / NOT REPRODUCED / DEFERRED / NEEDS OWNER DECISION), root cause file:line, pattern reused,
  test file names, commit hash.
- Update docs/AGENT_HANDOFF.md: prompt status DONE, next action = the next prompt, close your session-log row.
- Give me a short report: what you changed, what you could not verify, and any risk you noticed.
- Do not start the next group of issues. Stop after this report.
```

---

### Prompt 0 — Read-only audit (no code changes)

```text
Start: follow AGENTS.md. Read docs/AGENT_HANDOFF.md first; if this prompt is already IN PROGRESS there,
continue from its "Next action" instead of starting over. Checkpoint the handoff file as AGENTS.md says.

Read docs/GYMSERA_PRODUCTION_ARCHITECTURE.md fully, especially §0, §1, §3.3, §8.3 and §12.
This task is READ-ONLY: do not modify any source code, config, or database.

1. Map the four repos: stack, folder structure, test setup (or lack of it), how each app is started,
   which env files exist (names only, never print secret values).
2. Check every fact in §1 "Current architecture" against the code. Resolve the conflicts in §1.7
   (D-1 … D-4) from the code.
3. Fill in the §3.3 parity matrix with the real status of every row (✅ / ⚠️ / ❌), with file paths.
4. For EVERY issue in §12, record a verification result: CONFIRMED (file:line evidence),
   NOT REPRODUCED (file:line showing it's already correct), or NEEDS RUNTIME CHECK (explain).
   Put these results into a new section "§12.13 Verification results (Prompt 0)" as a table.
   Write results into the spec in batches (e.g. after each §12.x group) so another agent can
   resume if you stop; record the last finished group in the handoff file.
5. List anything in the code that looks like a serious defect but is NOT in §12. Add it to §12.13 with
   a new ID (NEW-01, NEW-02, …), severity and evidence.

Finish like this:
- Only the spec file and docs/AGENT_HANDOFF.md may change in this task. Commit them alone with message
  "docs: prompt-0 audit".
- Update docs/AGENT_HANDOFF.md: prompt status DONE, next action = Prompt 1, close your session-log row.
- Give me a short report: counts of CONFIRMED / NOT REPRODUCED / NEEDS RUNTIME CHECK / NEW, the ten
  most serious confirmed issues, and anything you could not inspect.
- Stop after this report.
```

**You:** read the report. If a P0 is "NOT REPRODUCED", open the file:line it gives and check it looks right.

---

### Prompt 1 — Test foundation (safety net before any fix)

```text
Start: follow AGENTS.md. Read docs/AGENT_HANDOFF.md first; if this prompt is already IN PROGRESS there,
continue from its "Next action" instead of starting over. Checkpoint the handoff file as AGENTS.md says.

Read docs/GYMSERA_PRODUCTION_ARCHITECTURE.md §0.1, §13 and §15. Reuse whatever test setup already exists.

Set up (only what is missing):
1. gymsera_be: an integration test harness against a REAL MySQL (Docker or Testcontainers) with one platform
   DB and two tenant DBs, factories for Tenant / GymListing / Branch / TenantSubscription / RoleAssignment /
   Payment, and a helper to call the API as any persona from §8.4. One command runs it (npm test).
2. gyms_era: flutter_test running with a fake API client and a fake store (for billing tests).
3. gymsera_cms and gymsera_web: component test runner + Playwright configured against local servers.
4. CI config (whatever CI the repos use, or GitHub Actions if none) running all of the above on every push.
5. Write the regression tests for the already-fixed defects listed in §13 ("§9.1 … §9.8" table).
   If one of them FAILS, do not fix it here — record it in §13 as a regression and report it.

Rules: never point tests at a production or shared database; use only test keys.
Write the exact commands to run each suite into docs/AGENT_HANDOFF.md §3 (Notes) so every later agent uses them.

Finish like this:
- Run the full test suites of every repo you changed and paste the pass/fail summary.
- Update §13 with the regression-test rows.
- Update docs/AGENT_HANDOFF.md: prompt status DONE, next action = Prompt 1A, close your session-log row.
- Give me a short report: how to run each suite, anything that failed, anything you could not set up.
- Stop after this report.
```

---

### Phase 1 — Money, entitlement and security leaks (P0)

Run these **in this order**; later prompts depend on earlier ones.

#### Prompt 1A — Billing core: webhook inbox, refunds, Android acknowledge, store binding, Stripe return

```text
Start: follow AGENTS.md. Read docs/AGENT_HANDOFF.md first; if this prompt is already IN PROGRESS there,
continue from its "Next action" instead of starting over. Checkpoint the handoff file as AGENTS.md says.

Read docs/GYMSERA_PRODUCTION_ARCHITECTURE.md §0.1, §0.5, §7 and these issues in §12.1:
BILL-12, BILL-02, BILL-06, BILL-01, BILL-14 (do them in that order).
Use §12.13 (Prompt 0 results) to skip anything NOT REPRODUCED.

For each issue: verify → root cause (file:line) → reuse the existing sync functions,
requestProviderChange, reconcileRenewalStatus and reconcileCapacity → fix → regression test → §13 row.
Do NOT create a second entitlement table or a second sync path: webhooks and the client /sync must end in
the SAME function (§7.6).

Finish like this:
- Run the full test suites of every repo you changed and paste the pass/fail summary.
- Update §13: one row per issue, with status, root cause file:line, pattern reused, test files, commit hash.
- Update docs/AGENT_HANDOFF.md: prompt status DONE, next action = the next prompt, close your session-log row.
- Give me a short report: what you changed, what you could not verify, and any risk you noticed.
- Do not start the next group of issues. Stop after this report.
```

#### Prompt 1B — Billing lifecycle: downgrade timing, grace/hold, real prices, pay-later, signup duplicate

```text
Start: follow AGENTS.md. Read docs/AGENT_HANDOFF.md first; if this prompt is already IN PROGRESS there,
continue from its "Next action" instead of starting over. Checkpoint the handoff file as AGENTS.md says.

Read docs/GYMSERA_PRODUCTION_ARCHITECTURE.md §0.1, §7.3–§7.5, §14 and these issues:
BILL-04, BILL-05, BILL-03, BILL-13, FLOW-03, BILL-08.

Before coding, check §14 decisions R-2, R-3, R-4. If the owner has not recorded a decision there, STOP and
ask me; do not pick defaults yourself. Record "BLOCKED ON OWNER" in the handoff file while you wait.
The one-ACTIVE-row invariant stays; only extend TenantSubscription additively (§7.3).
Mobile: the downgrade screen must follow the existing BranchPlanPickerScreen / billing notifier pattern.

Finish like this:
- Run the full test suites of every repo you changed and paste the pass/fail summary.
- Update §13: one row per issue, with status, root cause file:line, pattern reused, test files, commit hash.
- Update docs/AGENT_HANDOFF.md: prompt status DONE, next action = the next prompt, close your session-log row.
- Give me a short report: what you changed, what you could not verify, and any risk you noticed.
- Do not start the next group of issues. Stop after this report.
```

#### Prompt 1C — Capacity leaks

```text
Start: follow AGENTS.md. Read docs/AGENT_HANDOFF.md first; if this prompt is already IN PROGRESS there,
continue from its "Next action" instead of starting over. Checkpoint the handoff file as AGENTS.md says.

Read docs/GYMSERA_PRODUCTION_ARCHITECTURE.md §0.1 (rule 3: locked architecture), §6.2 and these issues:
CAP-03, CAP-04, CAP-02, CAP-01, CAP-05, CAP-06, CAP-07, CAP-08.

The invariant activeBranches + Σ reservedSlots ≤ maxBranches, reconcileCapacity,
subscription-quota.service.js and CapacityEvent stay. Fix defects INSIDE them. billingLock (CAP-01) must be
a separate field, never a change to Branch.status. The outbox (CAP-02) must reuse CapacityEvent.idempotencyKey.
Include the property-based test from CAP-07 and the concurrency tests from CAP-08.

Finish like this:
- Run the full test suites of every repo you changed and paste the pass/fail summary.
- Update §13: one row per issue, with status, root cause file:line, pattern reused, test files, commit hash.
- Update docs/AGENT_HANDOFF.md: prompt status DONE, next action = the next prompt, close your session-log row.
- Give me a short report: what you changed, what you could not verify, and any risk you noticed.
- Do not start the next group of issues. Stop after this report.
```

#### Prompt 1D — Access control: sessions, OTP, RBAC unification, IDOR

```text
Start: follow AGENTS.md. Read docs/AGENT_HANDOFF.md first; if this prompt is already IN PROGRESS there,
continue from its "Next action" instead of starting over. Checkpoint the handoff file as AGENTS.md says.

Read docs/GYMSERA_PRODUCTION_ARCHITECTURE.md §0.5, §8 (especially §8.3 Team & Access — the approved design
from the mobile app) and these issues: RBAC-07, AUTH-01, AUTH-04, AUTH-09, SEC-02, SEC-01, SEC-06, RBAC-03.

RBAC-07 first: every path that grants or removes staff access must go through the /team service and
RoleAssignment. Do NOT change the mobile Team & Access UX — it is the reference.
RBAC-03: generate the endpoint × persona permission test suite from the real route list and
constants/permissions.js, and commit docs/PERMISSIONS.md generated from the code.

Finish like this:
- Run the full test suites of every repo you changed and paste the pass/fail summary.
- Update §13: one row per issue, with status, root cause file:line, pattern reused, test files, commit hash.
- Update docs/AGENT_HANDOFF.md: prompt status DONE, next action = the next prompt, close your session-log row.
- Give me a short report: what you changed, what you could not verify, and any risk you noticed.
- Do not start the next group of issues. Stop after this report.
```

#### Prompt 1E — Member money: idempotency, ledger, refunds, payouts

```text
Start: follow AGENTS.md. Read docs/AGENT_HANDOFF.md first; if this prompt is already IN PROGRESS there,
continue from its "Next action" instead of starting over. Checkpoint the handoff file as AGENTS.md says.

Read docs/GYMSERA_PRODUCTION_ARCHITECTURE.md §6.3, §7.7, §11.2 and these issues:
REL-01 (idempotency middleware — do this first, the rest use it), PAY-01, PAY-02, PAY-03, PAY-04, PAY-07,
PAY-10, SEC-13.

Money must be atomic, auditable and idempotent. Ledger entries are never updated or deleted: corrections are
reversing entries. If changing the money column type is risky (PAY-02), stop and propose a migration plan
before doing it.

Finish like this:
- Run the full test suites of every repo you changed and paste the pass/fail summary.
- Update §13: one row per issue, with status, root cause file:line, pattern reused, test files, commit hash.
- Update docs/AGENT_HANDOFF.md: prompt status DONE, next action = the next prompt, close your session-log row.
- Give me a short report: what you changed, what you could not verify, and any risk you noticed.
- Do not start the next group of issues. Stop after this report.
```

#### Prompt 1F — Remaining P0 security and provisioning

```text
Start: follow AGENTS.md. Read docs/AGENT_HANDOFF.md first; if this prompt is already IN PROGRESS there,
continue from its "Next action" instead of starting over. Checkpoint the handoff file as AGENTS.md says.

Read docs/GYMSERA_PRODUCTION_ARCHITECTURE.md §0.1 and these issues:
SEC-03, SEC-07, SEC-09, SEC-10, RT-04, FLOW-02, AUTH-07, UX-12 (plan only — see below).

FLOW-02: make tenant provisioning resumable and idempotent without adding a background-job system.
AUTH-07: self-service account deletion; ask me before choosing retention periods.
UX-12: do NOT build it yet. Write a short implementation plan for porting the mobile Team & Access
screen to gymsera_cms (§8.3.7) and add it to §13 as "PLANNED".

Finish like this:
- Run the full test suites of every repo you changed and paste the pass/fail summary.
- Update §13: one row per issue, with status, root cause file:line, pattern reused, test files, commit hash.
- Update docs/AGENT_HANDOFF.md: prompt status DONE, next action = the next prompt, close your session-log row.
- Give me a short report: what you changed, what you could not verify, and any risk you noticed.
- Also list every P0 in §12 that is not yet DONE or NOT REPRODUCED.
- Stop after this report.
```

**You:** before Phase 2, test on a staging build:
- A real sandbox purchase, upgrade and downgrade on iOS and Android.
- Deleting and restoring a branch.
- Recording a cash payment twice quickly.

---

### Phase 2 — Reliability

#### Prompt 2A

```text
Start: follow AGENTS.md. Read docs/AGENT_HANDOFF.md first; if this prompt is already IN PROGRESS there,
continue from its "Next action" instead of starting over. Checkpoint the handoff file as AGENTS.md says.

Read docs/GYMSERA_PRODUCTION_ARCHITECTURE.md §4.1, §11 and these issues:
API-01, API-02, REL-02, REL-03, REL-04, REL-05, BILL-07, BILL-09, AUTH-02, AUTH-03, AUTH-08.

API-01 (one response/error envelope) must stay backward compatible: add it behind a version flag or
additive fields so the current mobile app keeps working. Update mobile, CMS and web clients to use
the shared error-copy table (§4.2).

Finish like this:
- Run the full test suites of every repo you changed and paste the pass/fail summary.
- Update §13: one row per issue, with status, root cause file:line, pattern reused, test files, commit hash.
- Update docs/AGENT_HANDOFF.md: prompt status DONE, next action = the next prompt, close your session-log row.
- Give me a short report: what you changed, what you could not verify, and any risk you noticed.
- Do not start the next group of issues. Stop after this report.
```

#### Prompt 2B

```text
Start: follow AGENTS.md. Read docs/AGENT_HANDOFF.md first; if this prompt is already IN PROGRESS there,
continue from its "Next action" instead of starting over. Checkpoint the handoff file as AGENTS.md says.

Read docs/GYMSERA_PRODUCTION_ARCHITECTURE.md §5.3 and these issues:
FLOW-05 (stale Listings tab — follow the four hypotheses in order, with debug logs, and fix the proven cause),
FLOW-06, FLOW-08, FLOW-09, FLOW-10, FLOW-12, FLOW-13, RBAC-04, RBAC-05, RBAC-08, RBAC-09, PAY-05…PAY-08, PAY-12.
For FLOW-05, record in the handoff file which hypotheses you already ruled out and how.

Finish like this:
- Run the full test suites of every repo you changed and paste the pass/fail summary.
- Update §13: one row per issue, with status, root cause file:line, pattern reused, test files, commit hash.
- Update docs/AGENT_HANDOFF.md: prompt status DONE, next action = the next prompt, close your session-log row.
- Give me a short report: what you changed, what you could not verify, and any risk you noticed.
- Do not start the next group of issues. Stop after this report.
```

---

### Phase 3 — CMS and website reach mobile parity

These follow the work order at the end of §3.3. For every prompt, the rule is the same: **open the mobile screen first and copy its flow, states, wording and API calls.**

#### Prompt 3A — Team & Access + Approvals in the CMS

```text
Start: follow AGENTS.md. Read docs/AGENT_HANDOFF.md first; if this prompt is already IN PROGRESS there,
continue from its "Next action" instead of starting over. Checkpoint the handoff file as AGENTS.md says.

Read docs/GYMSERA_PRODUCTION_ARCHITECTURE.md §0.5, §3.3, §8.3 (all of it) and issues UX-12, RBAC-01, RBAC-02,
UX-22. The mobile Team & Access and Approvals screens in gyms_era are the reference: find them and their
providers first, and list the endpoints they call (write that list into the handoff Notes).

Build /gym/team and /gym/approvals in gymsera_cms using the SAME endpoints, role chips with live counts
(empty roles hidden), the same 3-choice editor (Off / Needs approval / Direct), read-only labels for
role-preset tiers, the before/after diff before saving, and revoke-keeps-record. Retire /gym/staff
(redirect to /gym/team). Keep the Trainers screen, linked to the person's team record.
Acceptance test: the same person shows identical effective permissions in the app and the CMS.

Finish like this:
- Run the full test suites of every repo you changed and paste the pass/fail summary.
- Update §13 and the §3.3 parity matrix rows you completed.
- Update docs/AGENT_HANDOFF.md: prompt status DONE, next action = the next prompt, close your session-log row.
- Give me a short report with screenshots or a description of each new screen state.
- Stop after this report.
```

#### Prompt 3B — Organization switcher, capacity banner, branch flows, new organization

```text
Start: follow AGENTS.md. Read docs/AGENT_HANDOFF.md first; if this prompt is already IN PROGRESS there,
continue from its "Next action" instead of starting over. Checkpoint the handoff file as AGENTS.md says.

Read docs/GYMSERA_PRODUCTION_ARCHITECTURE.md §0.5, §2.5, §3.3 and issues UX-14, UX-13 (capacity banner part),
UX-19, UX-20. Copy the mobile behaviour: org selector strip, tenant-wide quota banner read from ONE place,
Add Branch attempt-first with the upsell only after 403, delete/restore with re-auth and the last-branch
409 confirmation, and new organization via "build new" or "move existing".
The web cannot sell App Store/Play plans: on 403 show the explanation and a "Continue in the GymsEra app"
action (Stripe option only if §14 R-7 says it is live).

Finish like this:
- Run the full test suites of every repo you changed and paste the pass/fail summary.
- Update §13 and the §3.3 parity matrix rows you completed.
- Update docs/AGENT_HANDOFF.md: prompt status DONE, next action = the next prompt, close your session-log row.
- Give me a short report: what you changed, what you could not verify, and any risk you noticed.
- Stop after this report.
```

#### Prompt 3C — Ledger, payouts, dashboard, reports, notifications in the CMS

```text
Start: follow AGENTS.md. Read docs/AGENT_HANDOFF.md first; if this prompt is already IN PROGRESS there,
continue from its "Next action" instead of starting over. Checkpoint the handoff file as AGENTS.md says.

Read docs/GYMSERA_PRODUCTION_ARCHITECTURE.md §0.5, §3.3, §9 and issues UX-13 (ledger, payouts), UX-18, UX-23.
Copy the mobile screens and endpoints. Notifications: bell + feed with server unread counts and the socket
(§9.2). Inbox for the CMS is out of scope unless I say otherwise.

Finish like this:
- Run the full test suites of every repo you changed and paste the pass/fail summary.
- Update §13 and the §3.3 parity matrix rows you completed.
- Update docs/AGENT_HANDOFF.md: prompt status DONE, next action = the next prompt, close your session-log row.
- Give me a short report: what you changed, what you could not verify, and any risk you noticed.
- Stop after this report.
```

#### Prompt 3D — Listing editor, signup unification, website cleanup

```text
Start: follow AGENTS.md. Read docs/AGENT_HANDOFF.md first; if this prompt is already IN PROGRESS there,
continue from its "Next action" instead of starting over. Checkpoint the handoff file as AGENTS.md says.

Read docs/GYMSERA_PRODUCTION_ARCHITECTURE.md §0.5, §2.3.5, §3.3 and issues UX-21, UX-24, UX-01, UX-02,
BILL-10, BILL-18.
- UX-21: CMS organization editor gets the same sections as the mobile one, on one listing-content API.
- UX-24: web /gym-owner/register and the mobile become-host wizard call the same /tenants/* steps with the
  same fields and validation; follow the mobile step order.
- UX-01: /onboarding → 301 to /gym-owner/register; delete its code.
- UX-02: /gymsera-billing becomes only a verified Stripe return that redirects to the CMS billing page.
- BILL-18: ask me whether Boost is paid before changing anything about it.

Finish like this:
- Run the full test suites of every repo you changed and paste the pass/fail summary.
- Update §13 and the §3.3 parity matrix rows you completed.
- Update docs/AGENT_HANDOFF.md: prompt status DONE, next action = the next prompt, close your session-log row.
- Give me a short report: what you changed, what you could not verify, and any risk you noticed.
- Stop after this report.
```

#### Prompt 3E — Screen-state and design-system pass

```text
Start: follow AGENTS.md. Read docs/AGENT_HANDOFF.md first; if this prompt is already IN PROGRESS there,
continue from its "Next action" instead of starting over. Checkpoint the handoff file as AGENTS.md says.

Read docs/GYMSERA_PRODUCTION_ARCHITECTURE.md §2.4–§2.12 and issues UX-08, UX-09, UX-10, UX-15, UX-16 (only if
§14 R-13 approves), UX-17. Find the existing theme/components in each app and extend them into the shared
token set (§2.4) — do not create a parallel theme. Then make every data screen implement all states in §2.5,
starting with the screens of Phase 3A–3D. Mobile screens that already do this are the reference.
Keep a checklist of screens in the handoff file (§2) and tick each one as it is committed.

Finish like this:
- Run the full test suites of every repo you changed and paste the pass/fail summary.
- Update §13: one row per issue, with status, root cause file:line, pattern reused, test files, commit hash.
- Update docs/AGENT_HANDOFF.md: prompt status DONE, next action = the next prompt, close your session-log row.
- Give me a short report: what you changed, what you could not verify, and any risk you noticed.
- Stop after this report.
```

---

### Phase 4 — Speed

#### Prompt 4A

```text
Start: follow AGENTS.md. Read docs/AGENT_HANDOFF.md first; if this prompt is already IN PROGRESS there,
continue from its "Next action" instead of starting over. Checkpoint the handoff file as AGENTS.md says.

Read docs/GYMSERA_PRODUCTION_ARCHITECTURE.md §10 and issues API-03…API-08, PERF-01…PERF-11.
First MEASURE (startup trace, API p95 per route, query counts per list endpoint, Lighthouse), write the
numbers into §13, then fix the worst offenders against the §10.1 budgets, then measure again.
PERF-07 (TenantDbManager pools): caps + LRU eviction + metrics only; no redesign.

Finish like this:
- Run the full test suites of every repo you changed and paste the pass/fail summary.
- Update §13 with before/after numbers for each change.
- Update docs/AGENT_HANDOFF.md: prompt status DONE, next action = the next prompt, close your session-log row.
- Give me a short report: what you changed, what you could not measure, and any risk you noticed.
- Stop after this report.
```

---

### Phase 5 — Global readiness, realtime and observability

#### Prompt 5A

```text
Start: follow AGENTS.md. Read docs/AGENT_HANDOFF.md first; if this prompt is already IN PROGRESS there,
continue from its "Next action" instead of starting over. Checkpoint the handoff file as AGENTS.md says.

Read docs/GYMSERA_PRODUCTION_ARCHITECTURE.md §9, §12.8, §12.11, §12.12 and issues RT-01…RT-09,
GLB-01…GLB-09, OBS-01…OBS-09, BILL-11, BILL-15, BILL-17 (ask me about Stripe/tax decisions),
SEC-04, SEC-05, SEC-08, SEC-14…SEC-18. Do timezones (GLB-01) and currency (GLB-02) before localization.

Finish like this:
- Run the full test suites of every repo you changed and paste the pass/fail summary.
- Update §13: one row per issue, with status, root cause file:line, pattern reused, test files, commit hash.
- Update docs/AGENT_HANDOFF.md: prompt status DONE, next action = the next prompt, close your session-log row.
- Give me a short report: what you changed, what you could not verify, and any risk you noticed.
- Stop after this report.
```

---

### Phase 6 — Final verification

#### Prompt 6A — Gap check

```text
Start: follow AGENTS.md. Read docs/AGENT_HANDOFF.md first; if this prompt is already IN PROGRESS there,
continue from its "Next action" instead of starting over. Checkpoint the handoff file as AGENTS.md says.

Read docs/GYMSERA_PRODUCTION_ARCHITECTURE.md §12, §13, §15, §16, §17.
1. List every issue in §12 and §12.13 that is not DONE or NOT REPRODUCED, grouped by severity.
2. Check every row of the §15 testing matrix: does a test exist, and does it pass? List the gaps.
3. Go through §17 criteria one by one: MET (with evidence link: test run, file, dashboard) or NOT MET.
Do not change code in this task. Do not mark anything MET without evidence.

Finish like this:
- Commit only the spec file and docs/AGENT_HANDOFF.md.
- Update docs/AGENT_HANDOFF.md: prompt status DONE, close your session-log row.
- Give me the three lists above.
- Stop after this report.
```

After this, fix the gaps with focused prompts, then do the §16 deployment checklist together with a human on staging.

---

## Part C — Switching agents and other useful prompts

### C0. Switch agents: continue another agent's work (Claude → Gemini, Gemini → Claude, …)

Use this when an agent ran out of tokens, context or quota, or you just want another agent to carry on. Open the new agent **in the repo the last agent was working in** (see "Branches" in the handoff file) and paste:

```text
You are taking over work that another AI agent started. Follow AGENTS.md.
1. Read docs/AGENT_HANDOFF.md, then docs/GYMSERA_PRODUCTION_ARCHITECTURE.md §0.1 and §13.
2. Run `git status` and `git log --oneline -15` in every repo listed in the handoff's Branches table.
   If git and the handoff file disagree, trust git, fix the handoff file, and tell me what differed.
3. If there is uncommitted work the handoff doesn't explain, stop and ask me before touching it.
4. Add your row to the Session log, then continue the current prompt from "Next action".
   Don't redo ticked items. Only do the remaining issues of that same prompt.
5. Use the same finish rules as the prompt in docs/GYMSERA_AGENT_PLAYBOOK.md (Part B) for that prompt name.
```

**Before switching, if the old agent can still respond,** send it:

```text
Stop now. Don't start anything new. Update docs/AGENT_HANDOFF.md per the handoff protocol in AGENTS.md:
current issue, exact step, exact next action, and every uncommitted file. Commit any finished issue.
Put a WIP commit on the phase branch only if the work is useful and clearly labelled. Then close your session-log row.
```

If the old agent died without checkpointing, C0 still works: the new agent rebuilds the state from git and §13 (step 2).

### C1. Resume the same agent in a new chat

```text
Read AGENTS.md and docs/AGENT_HANDOFF.md, then docs/GYMSERA_PRODUCTION_ARCHITECTURE.md §13.
Check git log and git status. Continue the current prompt from "Next action", using the same finish rules.
```

### C2. Independent review before you merge (use a new chat, ideally a *different* agent)

```text
Review the diff of branch [BRANCH] against main in [REPO]. Check it against docs/GYMSERA_PRODUCTION_ARCHITECTURE.md
§0.1 rules 1–9: any second system for an existing concern? any locked-architecture change without a listed
defect? any weakened guard or test? any client deciding capacity/permissions/prices? any secret or personal
data in code or logs? any issue marked DONE without a test? Report problems with file:line. Change nothing.
```

A different agent (for example Gemini reviewing Claude's branch, or the other way round) catches more, because it doesn't share the first agent's blind spots.

### C3. When the agent disagrees with the spec

```text
You think §[X] / issue [ID] is wrong for this codebase. Don't change code yet. Explain with file:line
evidence what the code does, why the spec's fix would be harmful, and what you propose instead.
Add it to §14 as a decision for me.
```

### C4. A new bug you found while using the app

```text
Bug: [describe what you did, what you expected, what happened, which app, which account role].
Follow AGENTS.md and docs/GYMSERA_PRODUCTION_ARCHITECTURE.md §0.1. Reproduce it with a failing test first, find the root
cause (file:line), fix it using existing patterns, and add it to §12 as NEW-xx and to §13. Mobile is the
reference unless the bug is in mobile.
```

---

## Part D — Tips that save you trouble

- **One prompt, one chat.** If the agent starts drifting (big refactors, touching unrelated files), stop it and start a new chat with C1 or C0.
- **Don't skip Prompt 0 and Prompt 1.** Without the audit, the agent "fixes" things that already work. Without tests, you can't tell whether a fix broke something.
- **Check the P0 "DONE" rows yourself.** Open two or three test files and confirm they test the real behaviour, not just that a function exists.
- **Real-device checks can't be skipped.** Store purchases, push notifications and thermal printing need a real phone on staging after Phases 1 and 5.
- **Keep the spec honest.** If the agent learns something that changes the plan, ask it to update the spec (§12, §14) in the same commit, so the next chat knows.

## Part E — Working with several agents

- **Only one agent at a time on the same repos.** Two agents editing the same branch at once will overwrite each other's work and the handoff file. If you want parallel work, give each agent a different repo *and* a different branch, and keep one handoff "Current position" per agent (add a second §1 block titled with the agent's name).
- **Files are the memory.** `AGENT_HANDOFF.md` (now), spec §13 (done), spec §14 (decisions) and git (truth). Nothing important may exist only in one agent's chat or in a tool's private memory.
- **Record your decisions in the spec, not in chat.** When you answer an owner question (R-2, BILL-18, …), have the agent write it into §14 right away. The next agent may be a different tool.
- **Ask for checkpoints if you're not sure.** At any time: "Checkpoint the handoff file now." It's cheap, and it's what makes a mid-task switch lossless.
- **Test commands live in the handoff Notes** (written in Prompt 1), so every agent runs the suites the same way.
- **Gemini specifics:** Gemini CLI loads `GEMINI.md` automatically, so run `/memory show` to confirm `AGENTS.md` was imported. In VS Code (Gemini Code Assist agent mode), if the rules don't seem to be applied, start the chat with "Read AGENTS.md first."
- **Claude Code specifics:** `CLAUDE.md` imports `AGENTS.md`. Run `/memory` to confirm.
