# P1 items still open: owner and date (to fill in)

Spec §17.2: every P1 issue is `DONE` or explicitly `DEFERRED` with an **owner and a date** in §14. This is the list of P1 items that are
not DONE as of 2026-10-21 (after the NEW-06, NEW-16, NEW-19, NEW-21/32, NEW-81, NEW-09/33, NEW-41, NEW-97 to NEW-100 fixes). Fill the last
three columns; copy the filled rows into §14 as R-39 onward. "Suggested" is my recommendation, not a decision.

How to fill: **Decision** = `BUILD` (schedule it), `DEFER` (not before the date, say why) or `DROP` (record it as won't do).
A `DEFER` or `BUILD` needs an owner (a person) and a date. Items marked **OWNER ACTION** are not code.

## A. Needs a decision from you

| # | Item | What is left | Suggested | Owner | Date | Decision |
|---|---|---|---|---|---|---|
| 1 | **BILL-17 / GLB-07** web sales entity | Which legal entity or merchant of record sells on the web (R-7). Web card stays OFF until decided | DEFER; web sells bank transfer and pay-later only | Amir | 2027-02-28 | DEFER |
| 2 | **FLOW-04** rejected applicants | A rejected tenant cannot edit or re-apply (`tenant.service.js:71`, `:38-39`) | BUILD: allow one re-application from the rejected application, keep the rejection reason visible | Amir + Claude Code | 2026-11-20 | BUILD |
| 3 | **FLOW-05** Listings tab | Not reproduced in normal use; a tenant-less token gives an empty list. Fix proposed in `docs/changes/FLOW-05.md` | DROP (not reproduced); keep the diagnostic | Amir | 2026-10-31 | DROP |
| 4 | **RBAC-06** admin sub-roles | Platform admin routes check `PLATFORM_ADMIN` only. Needs a role list (Support / Finance / Super?) | BUILD after you name the roles | Amir | 2027-01-31 | DEFER |
| 5 | **NEW-25** Stripe downgrade timing, card at signup | Blocked by R-7 | DEFER until #1 | Amir | 2027-02-28 | DEFER |
| 6 | **GLB-09** privacy: data export, consent, cookie banner | Deletion exists (AUTH-07); export and consent do not. Needs legal input on scope | BUILD: per-user export (JSON) first | Amir + Claude Code | 2026-12-01 | BUILD (per-user export first) |
| 7 | **GLB-03 / UX-09** localization | Nothing started. R-31 fixed the scope to English + string infrastructure | BUILD infrastructure now, translations later | Amir | 2027-01-31 | DEFER |
| 8 | **GLB-04** phone numbers | No libphonenumber on any platform; numbers are free text | BUILD with GLB-03 (same screens) | Amir | 2027-01-31 | DEFER |
| 9 | **API-05, PERF-03, PERF-04, PERF-05** speed items | Cursor pagination, image variants, list paging, web ISR. 4A deferred them | DEFER until the staging load test shows which one hurts | Amir | 2027-01-15 | DEFER |
| 10 | **UX-22** CMS staff requests / invite accept page | Not ported from mobile | BUILD if team onboarding happens in the CMS; otherwise DROP | Amir + Claude Code | 2026-12-15 | BUILD on gymsera.com (web); mobile already accepts invites; invite link points to the web app |
| 11 | **BILL-10** legacy `PlatformPackage` sales | Host self-grant is gone (NEW-06). Admin assign and approval grace still create legacy rows (R-6: migrate at next renewal) | DEFER; revisit with #1 | Amir | 2027-02-28 | DEFER |
| 12 | **PAY-08 / FLOW-08** gateway part | A member payment gateway does not exist | DEFER until a gateway is chosen | Amir | 2027-02-28 | DEFER |
| 13 | **NEW-20 / NEW-21 / NEW-32** CMS and web notices | Mobile shows payment due, failed renewal, over-capacity countdown. CMS admin "Verify payment" button and CMS/web banners are not built | BUILD the admin button first (pay-later tenants lapse after 14 days without it) | Amir + Claude Code | 2026-11-20 | BUILD |
| 14 | **UX-08 / UX-10** | About 40 mobile error handlers and the text-scale audit (NEW-74) | BUILD as one mobile sweep before the 2026-12-05 release if time allows | Amir + Claude Code | 2026-11-30 | BUILD UX-08 error handlers; UX-10 text-scale audit DEFER to 2027-01-31 |

## B. Owner actions (an agent cannot do these)

| # | Item | What is needed | Owner | Date |
|---|---|---|---|---|
| 15 | **OBS-02** client error tracking (PR9) and **OBS-08** client performance (PR12) | Sentry DSNs for CMS, web, Flutter and a `SENTRY_AUTH_TOKEN` CI secret | Amir | 2026-11-15 |
| 16 | **OBS-04** MySQL slow log | Enable on the servers (`docs/runbooks/slow-queries.md`) | Amir | 2026-11-15 |
| 17 | **SEC-05** secret manager / KMS | Move secrets, rotate any key that ever used the old committed values (`docs/runbooks/secrets-rotation.md`) | Amir | 2026-11-10 |
| 18 | **SEC-14** enforce the CSP | Read the `[csp-report]` log for a release cycle, then switch both Next.js apps to enforcing | Amir | 2026-12-15 |
| 19 | **SEC-08** presigned uploads and virus scan | Decide the scanner (ClamAV or a service); needs hosting | Amir | 2027-02-28 |
| 20 | **SEC-15** cookie sessions + CSRF | Own prompt (API, CMS, web, realtime, CORS change together). Accepted risk until then (R-37) | Amir | 2027-03-31 |
| 21 | **PERF-01** device startup measurement | Run the cold-start check on the reference device | Amir | 2026-11-25 |
| 22 | **BILL-03 / BILL-05 / BILL-08** store sandbox checks | Real-device sandbox purchases on Apple and Google (the four checks in §16) | Amir | 2026-11-25 |
| 23 | **SEC-06** unknown request fields | Stage 2 routes run in log mode: after one release cycle with no `[unknown-fields]` lines, set `UNKNOWN_FIELDS_STAGE2_MODE=reject` | Amir | 2026-12-20 |
| 24 | **NEW-81** force update | Set `MIN_APP_VERSION_IOS` / `_ANDROID` when a release must be forced | Amir | 2026-12-10 |

## C. For the record: closed since the 6A check

NEW-06 (host free plan), NEW-09/33 (fake payouts), NEW-16 (purchase listener), NEW-19 (keep branches), NEW-21/32 (mobile notices),
NEW-27 (restore message), NEW-41, NEW-97 (Next.js), NEW-98 to NEW-100 (trainer permissions), NEW-81 (force update), SEC-06 stage 1 and
the Apple route. The CMS BILL-15 badge is ready on `feat/bill-15-price-check-badge` (cms `8a7229e`).
