# GymsEra — Production Fix Prompt Pack (Phase 7)

Prepared 2026-10-24 from the owner's walkthrough of the four flows (Become a Host, Host area unpaid, Host area approved, Traveller area) plus the CMS and website. Use it with the coding agent open in your workspace (Claude Code), one prompt at a time.

---

## 0. How to use this file

1. Do **Section 1 (owner decisions)** and **Section 2 (owner setup)** first. Several prompts cannot be built correctly without them.
2. Paste **Prompt G (global rules)** once at the start of each new agent session.
3. Run the prompts **in order**. Each one ends with a report. Push, open the PR, wait for CI, merge, deploy, then move to the next.
4. After each prompt, tick the bugs it closed in the **Bug ledger (Section 4)**.
5. Mobile freeze is **2026-11-30**, store release **2026-12-05**. Wave A must land before the freeze. Wave B can follow the release.

| Wave | Prompts | Must be in the 12-05 app build? |
|---|---|---|
| A (blockers) | P0, P1, P2, P3, P4, P5, P6, P7a, P8, P9, P10 | Yes |
| B (new feature) | P7b Stripe for hosts | No — after release, once Decision D2 is made |

"No bugs remaining" can't be proven by any one prompt. What this pack gives you is: every reported bug verified, fixed with a test that failed first, checked on a real device and on staging, and a final gate (P10) that re-walks every flow end to end.

---

## 1. Owner decisions (answer before the prompts that need them)

| # | Decision | Recommendation | Needed by |
|---|---|---|---|
| D1 | **One brand name.** Screens today say "GymConnect", "Gymsera", "GymsEra" and the store name is "Gyms Era". | Pick one (for example **GymsEra**) and use it everywhere: app headers, store display name, emails, CMS, web. | P8 |
| D2 | **Card payments for travellers through the host's own Stripe.** Stripe does not support accounts based in Pakistan (check https://stripe.com/global before building). Pakistani hosts would not be able to connect a Stripe account. | Build a **payout-account abstraction**: Stripe Connect for hosts in supported countries; for Pakistan keep bank transfer + request now, and add a local gateway (Safepay, PayFast, JazzCash/Easypaisa merchant) later. Card entry must always be the provider's hosted sheet, never our own card fields (SEC-09). | P7b |
| D3 | **Remove the 5% platform fee** from the traveller order. | Remove it from the UI **and** the backend calculation, so the server never charges a fee the screen doesn't show. Record it in §14. | P7a |
| D4 | **Which price the host sees for the GymsEra subscription.** Onboarding shows Rs 2,000/mo (backend catalog), later screen shows $6.99/mo (App Store price from a US sandbox account). | On iOS/Android always show the **store's localized price** (Apple and Google require it). Only the CMS/web show the catalog price. Use a Pakistan-region sandbox tester when testing. | P2 |
| D5 | **Google Maps / Places billing.** Real maps, city/area search, address autocomplete and "use current location" need a Google Cloud project with billing on. | Approve it and set a budget alert (see Section 2). | P3 |
| D6 | **What counts as a "live" gym for traveller city lists.** | Tenant ACTIVE + subscription entitled (paid or in grace) + branch approved + branch visible + at least one plan visible to travellers. | P6 |
| D7 | **Marketing numbers on the Host intro** ("12k+ active users", "98% growth", "24/7"). | Remove them, or replace with real numbers from the API. Invented numbers are a store-review risk. | P8 |

---

## 2. Owner setup (only you can do these)

**Google Cloud (for P3)**
1. Create or pick a Google Cloud project, enable billing, set a budget alert (for example USD 50/month).
2. Enable: **Maps SDK for Android**, **Maps SDK for iOS**, **Places API (New)**, **Geocoding API**, **Maps JavaScript API**.
3. Create **four separate API keys**, each restricted:
   - Android key: restricted to package `com.inovettatech.gymsera` + your SHA-1 fingerprints (debug and release).
   - iOS key: restricted to bundle ID `com.inovettatech.gymsera`.
   - Web key: restricted to HTTP referrers `https://gymsera.com/*`, `https://cms.gymsera.com/*`, `https://cmsstaging.gymsera.com/*`.
   - Server key: restricted to your API server IP (`209.209.42.64`), used only by the backend for Place Details / Geocoding.
4. Give the agent the key **names** and where they go (`.env`, `--dart-define`, Xcode/Gradle config). Never paste keys into chat or commit them.

**Accounts and devices**
- A Pakistan-region App Store sandbox tester and a Play license tester (for P2 prices and P10 purchase checks).
- Two host test accounts in **different** tenants, plus one staff account in each (for P1 cross-tenant tests).
- Staging must be running the same code as production before P10.

---

## 3. Prompt G — global rules (paste once per agent session)

```text
You are continuing GymsEra production hardening (repos: gymsera_be, gymsera_cms, gymsera_web, gyms_era). Follow AGENTS.md. Rules for every prompt in this pack:

1. Verify before fixing. For every bug ID, reproduce it first (test, script or a precise code trace with file:line). If it does not reproduce, mark it NOT REPRODUCED with evidence and move on.
2. Failing-first. Every fix gets a test that fails on the old code and passes on the new code. Say how you proved it failed.
3. Never weaken an existing assertion to make a test pass. If an existing test is wrong, explain why before changing it.
4. Small PRs: one branch per repo per prompt (or per bug if large). Branch from the latest origin/main (origin/master for gyms_era). Never commit to main/master. Never push. Never remove a git worktree while anything is running.
5. No mock, placeholder or invented data in production code paths. Loading = skeleton/shimmer. Empty = real empty state. Error = ErrorStateView (mobile) / error state with retry (CMS/web). No fake counts, ratings, trends, names, stats or avatars.
6. No raw server messages shown to users (for example "send an X-Tenant-Id header"). Map every error code to user-facing copy; keep the request reference visible.
7. Backend: every tenant-scoped read/write must resolve the tenant from the caller's verified membership. Add a persona test for any route you touch (owner, manager, front desk, member, other-tenant owner).
8. Mobile: flutter test 3x, flutter analyze with no new findings. Release builds need --dart-define=APP_ENV=production (the guard enforces it). CMS/web: Vitest, tsc, next lint, npm run build, and Playwright for any page you change.
9. Test protocol: new tests + related suites locally; GitHub CI runs the full suite. Keep the Mac on power, lid open.
10. Migrations: platform/tenant migration with dry-run, idempotent re-run, rollback note. Tell me the deploy order (migration before code).
11. Every new env variable goes in .env.example with a comment. Never commit secrets.
12. Report at the end of each prompt in this format:
    - Bug ID → VERIFIED / NOT REPRODUCED → root cause (file:line) → fix → test name → red-before/green-after.
    - Per repo: branch, final commit hash, files changed, tests run with counts.
    - Push commands, merge order, deploy steps, migrations, new env vars.
    - What you could not test (device, staging, real Google/Stripe).
    - Anything new you found (as NEW-xxx, with severity), not fixed unless trivial and in scope.
13. Update docs/GYMSERA_PRODUCTION_ARCHITECTURE.md §13 rows and docs/AGENT_HANDOFF.md in a separate docs commit at the end of each prompt.
```

---

## 4. Bug ledger (from the owner walkthrough, 2026-10-24)

Severity: **P0** data leak or money/security; **P1** blocks a core flow or misleads users; **P2** wrong or confusing UI; **P3** polish.

### Become a Host flow (mobile; CMS/web where noted)
| ID | Bug | Sev | Prompt |
|---|---|---|---|
| BUG-01 | "Select City" and "Select Area" lists come from our backend, not Google. Must use Google Places (city first, then areas within it). | P1 | P3 |
| BUG-02 | Location & hours screen shows a static/fake map image, not a real map. | P1 | P3 |
| BUG-03 | "Use current location" does not fill the address/lat/lng fields. | P1 | P3 |
| BUG-04 | Gym address field has no Google autocomplete suggestions. | P1 | P3 |
| BUG-05 | "Show to Travellers" can be off on every plan, so travellers see a branch with no plans. At least one plan must stay visible. | P1 | P4 |
| BUG-06 | Headers say "GymConnect" (Host intro, Amenities, Photos, Plans list). | P2 | P8 |
| BUG-07 | Host intro shows invented stats (12k+, 98%, 24/7) and hardcoded "Peshawar". | P2 | P8 |
| BUG-08 | Step numbering is inconsistent: Location has no step, "Step 5" vs "Step 5 of 5", "80% Complete" on step 4 of 5. | P3 | P8 |
| BUG-09 | Plan price field is labelled PKR regardless of branch currency. | P2 | P4 |
| BUG-10 | Hosting subscription shows Rs 2,000/mo in onboarding and $6.99/mo later. | P1 | P2 |

### Host area, payment not done
| ID | Bug | Sev | Prompt |
|---|---|---|---|
| BUG-11 | Today tab sometimes shows an empty dashboard until the app is reloaded. | P1 | P2 |
| BUG-12 | Gyms tab says "Waiting for admin approval" when the real blocker is the unpaid subscription. | P1 | P2 |
| BUG-13 | Host Profile shows "Verified" and "Growth Plan" before payment. | P1 | P2 |
| BUG-14 | Analytics shows the raw error "This route requires a gym context … send an X-Tenant-Id header". | P1 | P1 |
| BUG-15 | Team & Access shows the same raw X-Tenant-Id error. | P1 | P1 |
| BUG-16 | **Team & Access sometimes shows another host's data.** | **P0** | P1 |
| BUG-17 | Same action worded "Switch to Traveler", "Switch to Traveling", "Traveller". | P3 | P8 |
| BUG-18 | Listings shows "Gym Companies 1/1 · Limit reached" to an unpaid host, which reads as an error. | P2 | P2 |

### Host area, after CMS approval
| ID | Bug | Sev | Prompt |
|---|---|---|---|
| BUG-19 | Today dashboard cards open a screen, but Back does not return to the dashboard (routing). | P1 | P5 |
| BUG-20 | "+12.4%" trend badge shows while every value is 0. | P2 | P5 |
| BUG-21 | Gyms & Operations shows no branch although onboarding created one; "1 of 1 branches used" next to "0 branches · Limit reached". | P1 | P5 |
| BUG-22 | Listings: header says "Host Dashboard"; New / Edit / Delete Organization flow has multiple bugs; "Move an existing branch" state unclear. | P1 | P5 |
| BUG-23 | Team & Access shows "A database error occurred". | P1 | P1 |
| BUG-24 | Host Profile plan shows "Growth" though onboarding picked 1 branch ("Starter"). | P2 | P2 |
| BUG-25 | Inbox header shows a stock photo while Profile shows the "A" initial. | P3 | P5 |

### Traveller area
| ID | Bug | Sev | Prompt |
|---|---|---|---|
| BUG-26 | City picker lists cities with no live gym. Show only cities with at least one live branch (Decision D6). | P1 | P6 |
| BUG-27 | Every gym rated 0.0; "(124)" review count is invented. | P1 | P6 |
| BUG-28 | Most gym cards have no photo although photos were uploaded. | P2 | P6 |
| BUG-29 | Names doubled ("heist - heist", "tkr - tkr"). | P2 | P6 |
| BUG-30 | "Near You" shows the host's own "Submitted! Your gym is under review" card. | P1 | P6 |
| BUG-31 | My Plans pending request already shows "Expires 2026-11-24" before host approval. | P2 | P7a |
| BUG-32 | Tab says "Inbox", screen title says "Messages". | P3 | P8 |
| BUG-33 | One plan named three ways ("standard Athlete Pass", "Full-Access standard Plan", "standard Pass"). | P2 | P4 |
| BUG-34 | Review your order shows a 5% platform fee (Rs 250) that should not exist (Decision D3). | P1 | P7a |
| BUG-35 | Payment stuck on "Loading host bank details…" while the text says "transfer to the above account". | P1 | P7a |
| BUG-36 | Payment options: show card payment via the host's connected Stripe account; otherwise show the request / bank-transfer path. Host needs a screen to connect Stripe. | Feature | P7b |

### Cross-cutting
| ID | Bug | Sev | Prompt |
|---|---|---|---|
| BUG-37 | The CMS and website have the same bugs as the app in the matching screens. | P1 | P9 |
| BUG-38 | Hidden mock/fake data may still exist in other screens (like NEW-104 wishlist). Needs a sweep and a guard. | P1 | P8 |

---

## 5. The prompts

### P0 — Intake and verification (no code)

```text
Read section 4 (Bug ledger) of GYMSERA_PRODUCTION_FIX_PROMPTS.md, which I am pasting below, plus the four flow images I attach. Do not change code.

For each BUG-01 … BUG-38:
1. Find the exact code path (screen, provider, repository, API route, service) with file:line in every repo it touches (mobile, backend, CMS, web).
2. Reproduce: write down the steps and whether you confirmed it by test, script or code trace. Mark VERIFIED, NOT REPRODUCED (with evidence) or NEEDS DEVICE.
3. Give the root cause in one or two sentences.
4. List the CMS and web screens that share the same root cause (for BUG-37).
5. Flag anything that is a security or data-isolation problem as P0, even if I rated it lower.

Also:
- BUG-16: trace both the server side (can any team/staff route return rows from a tenant the caller is not staff of?) and the client side (does any Riverpod provider, cache, ETag store or socket room survive logout, account switch or tenant switch?).
- BUG-11/14/15: explain what the app sends as the tenant selector for a host whose tenant is not ACTIVE yet, and what tenantContext does with it.
- BUG-10/24: list every place a plan tier name and a subscription price are computed or shown, and where each value comes from.
- Grep all four repos for hardcoded mock data in production code paths (fake gyms, names, ratings, review counts, trends, stats, avatars, "GymConnect", "Peshawar", "Lorem") and list them as BUG-38 findings.

Output: a table BUG-ID | status | root cause (file:line) | repos affected | proposed prompt (P1–P9) | risk. Commit it as docs/changes/PHASE7_BUG_LEDGER.md on a docs branch. Never push.
```

---

### P1 — Data isolation and raw errors (P0 first)

**Covers:** BUG-16, BUG-14, BUG-15, BUG-23.

```text
Use the P0 ledger. Fix data isolation and the Team & Access / Analytics errors.

BUG-16 (P0): a host sometimes sees another host's Team & Access data.
- Server: add persona tests with two tenants (owner A, owner B, staff in each) for every /team, /staff, /staff-invites, /host/analytics, /reports and approvals route. Each caller must only ever see their own tenant's rows. Fix any route that resolves the tenant from a client value without checking membership.
- Client (mobile, CMS, web): on logout, account switch and organization/tenant switch, reset every user- or tenant-scoped provider, cache, ETag/If-None-Match store, socket room and in-memory list. Add a test: log in as owner A, load Team & Access, log out, log in as owner B, and assert no A data is shown at any point (including while loading).
- Check the B3 ETag/304 path cannot serve one user's cached body to another on the client.

BUG-14/15: a host whose tenant is not ACTIVE gets "This route requires a gym context … X-Tenant-Id".
- Decide per screen what an unpaid/pending host should see (Team & Access: owner can still view and invite? Analytics: empty state "Analytics start after your gym is live"). Implement it on the server (clear error code, not a 400/500 text) and the client (friendly state).
- No screen may show a raw server message.

BUG-23: after approval, Team & Access shows "A database error occurred". Reproduce with an approved tenant, find the failing query, fix, add a regression test.

Report per Prompt G.
```

---

### P2 — One source of truth for host status and plan

**Covers:** BUG-10, BUG-11, BUG-12, BUG-13, BUG-18, BUG-24 (needs D4).

```text
The host app shows contradictory status: empty dashboard until reload, "waiting for admin approval" when payment is the blocker, "Verified" and "Growth Plan" before payment, "1/1 limit reached" to an unpaid host, and two different prices.

1. Backend: expose one host onboarding status in /me/bootstrap (and the host summary routes):
   DRAFT → AWAITING_PAYMENT → PENDING_REVIEW → APPROVED (or REJECTED with reason, SUSPENDED).
   Include: the next action the host must take, the plan tier name (from the branch-count tier: 1 = Starter, etc.; one naming table shared by all clients), verification status, and whether payment is done. Derive it from real subscription, payment and review data. Unit-test every transition.
2. Mobile: every host tab (Today, Gyms, Listings, Profile) reads this one status. Each state has its own screen copy:
   - AWAITING_PAYMENT: "Finish your subscription to submit your gym", button to Choose Your Plan.
   - PENDING_REVIEW: "Your gym is under review".
   - APPROVED: normal dashboard.
   "Verified" badge only when actually verified; plan label only when paid.
   Hide "Limit reached" wording until the host has a paid plan.
3. BUG-11: find the race that renders an empty Today dashboard on first open (bootstrap/tenant not ready, provider not refetched). Show a skeleton until status is known; refetch when the tenant becomes active. Add a test that simulates the slow bootstrap.
4. BUG-10 / D4: on iOS and Android show the store's localized price everywhere (onboarding Choose Your Plan and the later screen) from the same store-product source. Never mix catalog PKR and store USD on the device. CMS/web show the catalog price.
5. BUG-24: plan name must match the tier the host bought (1 branch = Starter, never "Growth").

Report per Prompt G, with screenshots-worth of state descriptions for each status.
```

---

### P3 — Real Google Maps, Places and location (needs D5 and Section 2 keys)

**Covers:** BUG-01, BUG-02, BUG-03, BUG-04 (and CMS/web branch forms).

```text
Replace our own city/area lists and the fake map with Google Maps Platform, in the mobile Become a Host flow, the mobile Add Branch wizard and branch location editor, and the CMS branch create/edit form.

Requirements:
1. City: Google Places Autocomplete (New) limited to cities (locality), optionally region-biased to Pakistan; the user types and picks. Area: autocomplete limited to areas inside the picked city (sublocality/neighborhood, location-biased to the city's viewport). If Google has no area match, allow free text.
2. Location & hours screen: a real interactive Google Map with a draggable pin. "Use current location" asks for permission, gets GPS, reverse-geocodes, and fills address, city, area, lat and lng immediately, moving the pin. Handle permission denied with a clear message.
3. Address field: Google address autocomplete; picking a suggestion fills address, lat/lng and moves the pin.
4. Use Places session tokens; debounce input; no API call per keystroke without debounce. Handle offline and quota errors with a friendly message.
5. Backend: store Google place_id, formatted address, lat/lng for the branch, and the city/area place_ids. Upsert the cities and areas tables from Google data (normalized names, no duplicates), so discovery filters and the CMS /admin/cities page keep working. Validate lat/lng ranges. Keep existing branches working (nullable new columns, no backfill; migration with dry-run + rollback note).
6. Keys: mobile keys via build config (never committed), CMS/web key via env, server key in API .env. Add each name to .env.example / build docs. No key in git.
7. Tests: widget tests with a fake Places client (city then area flow, current location fills fields, suggestion fills fields, denied permission); backend tests for upsert/dedupe and validation; Playwright for the CMS branch form with a mocked Places script.
8. Tell me what must be checked on a real device (map renders, GPS, autocomplete) and on staging.

Report per Prompt G.
```

---

### P4 — Membership plans: visibility, naming, currency

**Covers:** BUG-05, BUG-09, BUG-33.

```text
1. BUG-05: a branch must always have at least one plan visible to travellers.
   - Backend: reject (422 with a clear code) creating/updating/deleting/hiding a plan if it would leave an approved or submitted branch with zero traveller-visible active plans. Onboarding submit must require at least one visible plan. Persona + edge-case tests (hide last visible, delete last visible, deactivate last visible).
   - Mobile and CMS: disable the "Show to Travellers" toggle (with an explanation) on the last visible plan; show the server message if it still fails.
   - Existing data: a read-only report of branches that currently have no visible plan, so I can fix them.
2. BUG-09: the price field and plan cards use the branch currency (GLB-02 formatter), not a hardcoded "PKR".
3. BUG-33: one plan, one name. Define a single display rule (plan name exactly as the host typed it, plus the duration label) and use it on gym detail, plans & pricing, plan details, review order, payment, My Plans and the CMS. Remove invented suffixes like "Athlete Pass", "Full-Access … Plan", "Pass", and "BEST SELLER" unless it is real data.

Report per Prompt G.
```

---

### P5 — Host area after approval: navigation and data

**Covers:** BUG-19, BUG-20, BUG-21, BUG-22, BUG-25.

```text
1. BUG-19: every card/button on the Today dashboard that opens another screen must push onto the stack (context.push or a nested route), so Back returns to Today. Audit all host tabs for context.go used where push is meant. Add a navigation test: open each dashboard card, press back, assert Today is visible.
2. BUG-20: trend badges come only from real comparisons; hide the badge when there is no previous-period data or both values are 0.
3. BUG-21: ALREADY VERIFIED on a device 2026-10-28 (list and counts; spec §13 "Phase 7 production verification 2026-10-28"). Skip it unless it comes back. Original text: Gyms & Operations must list the branches the host created in onboarding. Find why the list is empty while the capacity banner says "1 of 1 used", and why it also shows "0 branches · Limit reached". Use one source for branch count and list. Test with an approved tenant created through the real onboarding path.
4. BUG-22: Listings tab. Fix the header title, and walk New Organization (build new branch / move existing branch), Edit Organization and Delete Organization end to end with tests: capacity checks, what happens to branches on delete, re-auth for delete, empty states, error states, and that the list refreshes after each action. List every defect you find before fixing.
5. BUG-25: one avatar rule app-wide (uploaded photo, otherwise initials). No stock photos.
6. NEW-147 (from P4; DONE in P5 2026-10-29, spec §13 "Phase 7 Prompt P5"): "Show to Travellers" ignored when a branch is built (New Organization and Add Branch share `_createBranchRecord`).

Report per Prompt G.
```

---

### P6 — Traveller discovery

**Covers:** BUG-26, BUG-27, BUG-28, BUG-29, BUG-30 (needs D6).

```text
1. BUG-26: the city picker and Home city chips show only cities with at least one live branch (D6: tenant ACTIVE, subscription entitled, branch approved and visible, at least one traveller-visible plan). Backend endpoint returns these with counts; cached with the existing discovery snapshot and invalidated by the existing hooks. Default city = nearest live city to the user, else the first live city.
   (Checked 2026-10-28, spec §13 "Phase 7 P3 device follow-ups": `/discovery/cities` lists every active city, 21 of 30 with no live gym; the snapshot does not check subscription entitlement yet. The website's owner registration form reads the same endpoint for its city list (`web/src/components/features/gym-owner-register.tsx:244-247`): move it to `/cities` or the Places search in the same change, or a first host in a new city cannot register on the web.)
2. BUG-27: ratings and review counts come only from approved reviews. No review = "New" (no stars, no count). Remove every invented count.
3. BUG-28: cards use the branch/listing cover photo, then the first gallery photo, then a neutral placeholder. Find why uploaded photos are not reaching discovery responses.
4. BUG-29: display name rule: if branch name equals organization name, show it once; otherwise "Organization · Branch". Same rule on web and CMS.
5. BUG-30: a host's own onboarding status card ("Submitted! Your gym is under review") must never appear in traveller discovery lists. Move it to the host's own surfaces only.
6. NEW-145 (from P4, P2): discovery listing cards print "Rs." in front of `minPrice` and the API sends no currency with a listing (`home_screen.dart`, `search_results_screen.dart`, `gym_detail_screen.dart`, `map_search_screen.dart`, `filters_bottom_sheet.dart`; spec §13 P4 "New"). Send the currency with each listing and format with GLB-02 `formatMoney`; remove the invented "Rs. 0/mo" / "Rs. 1,500 / session" fallbacks (with NEW-139).

Apply the same fixes to gymsera.com listing pages. Tests on backend (live-city filter, rating source), mobile (widgets), web (Vitest/Playwright).

Report per Prompt G.
```

---

### P7a — Booking and payment fixes (needs D3)

**Covers:** BUG-31, BUG-34, BUG-35.

```text
1. BUG-34 / D3: remove the platform fee from the traveller order: the backend price calculation, invoices, receipts, ledger lines and every UI that shows it. Existing orders keep their stored amounts. Tests that the total equals the plan price (plus real joining/security fees only).
2. BUG-35: the Bank Transfer option is stuck on "Loading host bank details…". Find why (missing route, permission, empty payout account, error swallowed). Show the host's real bank details, or a clear "This gym hasn't added bank details yet — send a request instead" state. Never show "transfer to the above account" when nothing is above.
3. BUG-31: a pending request shows no start or expiry date until the host approves; after approval show the real dates. Check My Plans, plan detail and the CMS subscription screens.
4. Remove or hide payment options that are "Not available for this gym" unless the host has them configured.
5. Confirm the old /home/checkout/add-card route is gone or unreachable after SEC-09.
6. NEW-144 (fixed 2026-10-28, spec §13): iOS purchase sync answered 500 on production because axios was a dev-only package. After its deploy, test an iOS sandbox purchase and Restore Purchases end to end, and recover purchases made while sync was failing.
7. NEW-150 (from P4, P1): review order and payment take 10% off when the hardcoded promo code `GYMSERA10` is typed (`order_review_screen.dart:193,594`, `payment_screen.dart:65`); the API has no promo logic, so the total shown is not what is owed. Remove it with BUG-34 (the total equals what the server charges).

Report per Prompt G.
```

---

### P7b — Host payout accounts and card payments (Wave B, after D2)

**Covers:** BUG-36.

```text
Plan first, no code until I approve.

Goal: travellers can pay a gym by card when that gym's host has connected a payout account; otherwise they use the request / bank-transfer path.

Constraints from me:
- Stripe does not support accounts based in Pakistan. Design a provider abstraction (host_payout_accounts: provider, account id, country, status, capabilities) with Stripe Connect as the first provider for supported countries, and bank transfer as the always-available fallback. Leave room for a Pakistani gateway later.
- Card entry is always the provider's hosted UI (Stripe PaymentSheet on mobile, Checkout on web). We never see or store card numbers (SEC-09).
- Host side: a "Payouts & Payments" screen (mobile and CMS) to connect, see status, and disconnect the account, using Stripe-hosted onboarding.
- Traveller side: payment options come from the server per branch: card (if a connected, charge-enabled account exists), bank transfer (if bank details exist), request (always).
- Webhooks: signed, idempotent, recorded in billing_events; payment success activates the membership; refunds and disputes handled.
- Store rules: gym memberships are real-world services; confirm the App Store / Play guideline that allows external payment for them and cite it.
- No platform fee (D3) unless I decide otherwise.

Give me: data model, routes, screens, webhook list, test plan, migration plan, risks, and the env variables. Ask me via AskUserQuestion where I must decide.
```

---

### P8 — Copy, brand and fake-data sweep

**Covers:** BUG-06, BUG-07, BUG-08, BUG-17, BUG-32, BUG-38 (needs D1, D7).

```text
1. Brand (D1): replace every product-name variant with the chosen name in app headers, store display name config, emails, push titles, CMS, web, and metadata. Add a guard test that fails if "GymConnect" or other banned variants appear in source.
2. Host intro (D7): remove invented stats and the hardcoded city, or load real numbers from an API.
3. Become a Host steps: one consistent stepper: "Step N of M" on every step, progress matches the step, Location is part of the count.
4. Wording: one label for switching modes (for example "Switch to Traveller" / "Switch to Host") everywhere; tab and screen titles match (Inbox = Inbox).
5. BUG-38: remove every mock/placeholder data source found in P0 from production code paths. Add a guard test that scans lib/ and src/ for known fake strings and mock providers used outside tests.
6. Run a copy pass with the UX-08 rules: every empty, loading and error state has real, specific copy.
7. NEW-146 (from P4, P2): provisioning invents a "Standard Membership" plan at 5,000 when onboarding has no usable plan (`tenant-provisioning.service.js`, fallback after the plan loop), and `_createBranchRecord`'s default package is "<branch> Membership" at 0. Refuse instead (visible_plan_required) or ask the host; no invented plan.
8. NEW-148 (from P4, P2): host screens invent plan names when the API sends none ("Daily Pass", "Gym Pass", "Pass", "Monthly Pro": `host_providers.dart`, `check_ins_screen.dart`, `host_today_screen.dart`, `gym_dashboard_screen.dart`, `members_list_screen.dart`, `member_subscriptions_history_screen.dart`, `staff_gyms_tab_screen.dart`, `change_plan_screen.dart`; spec §13 P4 "New").
9. NEW-149 (from P4, P2, GLB-02 client part): platform-billing and member-subscription screens still print "PKR" / "Rs." (`host_subscription_detail_dialog.dart`, `invoices_screen.dart`, `analytics_screen.dart` passes 'PKR'). Found in P5: Today's Net Profit / Gross Revenue / Total Expenses cards print a hardcoded "Rs" too (`host_today_screen.dart`, `_buildStatCard` callers).
10. NEW-153 (from P5, P2): stock Unsplash photos still used as decoration or fallback on host and member screens (`add_member_screen.dart`, `package_editor_screen.dart`, `host_gyms_overview_screen.dart` branch card fallback, `core/widgets/app_image_widget.dart` fallback, `my_subscriptions_screen.dart`, `subscription_history_screen.dart`). Traveller discovery photos are BUG-28 (P6). Person avatars were fixed in P5 (BUG-25, `PersonAvatar`).
11. NEW-154, NEW-155, NEW-157 (from P5, P3): invented values: staff names in the class form (`add_class_screen.dart:293`), "Pakistan" as a branch's city on the branch dashboard header (`gym_dashboard_screen.dart`), Add Branch prefilled with established year 2024 and floor area 5000 (`add_branch_screen.dart:70-71`).

Report per Prompt G.
```

---

### P9 — CMS and website parity

**Covers:** BUG-37 (and the CMS/web halves of P1–P8).

```text
Using the P0 ledger's "repos affected" column, make sure every fix in P1–P8 is also applied to gymsera_cms and gymsera_web where the same screen or logic exists:
- Team & Access / Staff isolation and errors (P1).
- Host status and plan naming on the CMS dashboard, Business Profile and Subscription & Billing (P2).
- Google Places branch forms and the /admin/cities page now fed by Google data (P3).
- Plan visibility rule and plan naming on /gym/plans and admin tenant Plans tab (P4). R-80: the whole CMS half of P4 is here: a "Show to Travellers" control (NEW-112; plans created in the CMS are hidden today), the API's `last_visible_plan` / `visible_plan_required` copy, the price label and plan amounts from the plan's `currency`, and the mobile naming rule (`planDisplayName` + `planDurationLabel`, QUARTERLY n = 3n months).
- Branch list consistency on /gym/branches and admin tenant Branches tab (P5). P5 also changed the API the CMS should use for an organization: `GET /host/listings/:id` and PUT/PATCH with category, establishedYear, contactEmail, website, imagesJson (BUG-22 L8). Check every CMS screen that edits an organization through `/gyms/profile` (it edits the tenant's first gym only) and NEW-151 (tagline, category, established year sent to `/gyms/profile` are never stored).
- Live-city rule, ratings, photos and names on gymsera.com listing pages (P6).
- Platform fee removal and bank-details state on web checkout or member pages (P7a).
- Brand, copy and fake-data guard (P8).
For each, add Vitest + Playwright coverage, then run tsc, lint, build and the security-header Playwright specs.

Report per Prompt G, as a table: fix → mobile | CMS | web → status.
```

---

### P10 — End-to-end release gate

```text
No new features. Prove the flows work end to end on staging with the real backend.

1. Write a QA script (docs/qa/PHASE7_E2E.md) with numbered steps and expected results for:
   A. Traveller → Become a Host → all steps → plan created → subscription purchased (sandbox) → submitted.
   B. Host before payment (every tab) and after payment before approval.
   C. CMS admin approves → host area after approval (every tab, every drawer item, back navigation).
   D. Traveller discovery → gym → plan → review order → payment (bank transfer/request; card if P7b is done) → host approves → My Plans active → check-in QR.
   E. Team: owner invites staff → staff signs in → staff sees only their branch → owner revokes → staff loses access live.
   F. Account switch: owner A → logout → owner B: no A data anywhere.
2. Automate what you can: Flutter integration tests for A, D and F against a seeded staging tenant; Playwright for C and the CMS/web halves.
3. Run the full backend suite 3x plus DISABLE_REDIS=true, CMS and web full Vitest + Playwright + build, Flutter test 3x + analyze.
4. Re-run the 6A gap check with this evidence and list what is still NOT MET.
5. Give me the device checklist (what I must do by hand on an iPhone and an Android phone) with pass/fail columns.

Report per Prompt G.
```

---

## 6. Device checklist for the owner (after P10)

Run on a real iPhone (TestFlight, `APP_ENV=production` build) and a real Android phone (internal track).

| # | Check | iOS | Android |
|---|---|---|---|
| 1 | City and area come from Google search; current location fills the address; map is real and the pin moves | | |
| 2 | Last visible plan cannot be hidden | | |
| 3 | Store price shown is the same on onboarding and later screens | | |
| 4 | Unpaid host: each tab shows the "finish your subscription" state, no raw errors | | |
| 5 | Approved host: every Today card opens and Back returns to Today | | |
| 6 | Gyms & Operations lists the branch created in onboarding | | |
| 7 | Team & Access: no errors; logout and login as another host shows no old data | | |
| 8 | Traveller city list shows only live cities; ratings/photos/names correct | | |
| 9 | Order total has no platform fee; bank details load or a clear request state shows | | |
| 10 | Pending plan shows no expiry until approved | | |
| 11 | Sandbox purchase, restore, upgrade/downgrade, expiry (from the earlier sandbox guide) | | |
| 12 | One brand name everywhere; no "GymConnect" | | |

---

## 7. Order of work and dates (suggested)

| Dates | Work |
|---|---|
| 10-25 → 10-26 | Decisions D1–D7, Google Cloud setup, P0 ledger |
| 10-27 → 10-31 | P1 (P0 data isolation first), P2 |
| 11-01 → 11-08 | P3 (Google), P4 |
| 11-09 → 11-15 | P5, P6, P7a |
| 11-16 → 11-22 | P8, P9 |
| 11-23 → 11-29 | P10, device checklist, sandbox purchases |
| 11-30 | Mobile freeze: build from master with a new build number and `APP_ENV=production` |
| 12-05 | Store release |
| After 12-05 | P7b Stripe for hosts, staging/production wipe, `MIN_APP_VERSION_*`, 12-20 SEC-06 reject flip |

If P3 or P5 slips, cut P7b and the stepper polish first; never cut P1.
