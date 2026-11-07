# Runbook: build 22 device checklist (release candidate)

Phase 7 P11, 2026-11-07. Build 22 = app `master` after the P11 app PR is merged, built with
`--dart-define=APP_ENV=production` (release builds refuse to compile without it). Run every step on
**one iPhone and one Android phone** unless the step says otherwise. Write the result (pass / fail,
with a screenshot for a fail) next to each step number.

Before you start:

- The API, CMS and website are deployed from the P11 branches (API first). The app talks to the
  production API, which holds **test data only** (R-19). Use test accounts only.
- **Sandbox accounts.** Steps marked **[Apple sandbox]** need an App Store Connect Sandbox tester signed
  in under Settings → App Store → Sandbox Account (TestFlight build). Steps marked **[Google test]** need a
  Google account listed as a licence tester in Play Console, with the build installed from an internal
  testing track. A real card is never charged. Never use a personal Apple ID or Google account for
  test purchases (R-93: one Apple ID buys for one host only).
- Accounts you need: **Host A** (owner of one approved gym, two organizations, each with at least one
  branch), **Host A's front desk** (a team member of Host A), **Traveller T** (no team role anywhere),
  **Host B** (owner of a gym with a PAID bank-transfer plan that ends at least 10 days from today,
  approved by an admin on CMS Plan payments).
- Sandbox subscriptions renew fast: in Apple Sandbox a monthly plan renews about every 5 minutes; in a
  Google test a monthly plan renews about every 5 minutes. Cancel test subscriptions when you are done.

## 1. Host Profile → My Subscription

| # | Step | Expected result |
|---|---|---|
| 1.1 | Sign in as Host A. Open the **Profile** tab. | A **My Subscription** row is shown. |
| 1.2 | Tap **My Subscription**. | The screen title is "My Subscription". It shows the plan name, "Billed through" (Apple App Store, Google Play or "Invoiced by GymsEra"), "Billing cycle", and the price you subscribed at ("This is the price locked in when you subscribed."). No invented plan name, no "PKR" fallback for another currency. |
| 1.3 | Go back to the **Gyms** tab and tap the subscription banner. | The same My Subscription screen opens. |
| 1.4 | Turn on airplane mode, pull to refresh / reopen the screen. | "Couldn't load your subscription" with a retry, not "No active subscription". Airplane mode off → retry loads the plan. |
| 1.5 | **[Apple sandbox]** on iPhone, **[Google test]** on Android: tap **Restore purchases** with the store account that bought the plan. | "Checking the store…", then "Subscription restored and verified." With a store account that never bought: "Nothing to restore" and the explanation. |

## 2. Verification Documents by type

| # | Step | Expected result |
|---|---|---|
| 2.1 | Host A: Profile → **Verification Documents**. | Title "Verification Docs". Three rows: **Owner ID** ("National ID card or passport"), **Business registration** ("Registration certificate or trade licence"), **Proof of premises** ("Lease or a utility bill for the gym"), and the KYC status (Verified / Under review / Not accepted / Not submitted). |
| 2.2 | On **Owner ID** tap **Upload**, pick a photo from the gallery. | Snackbar "Owner ID sent for review." The row says "Sent: <file name> · <today>" and the button becomes **Send another**. No error is shown after a successful upload (NEW-198 is fixed from build 21). |
| 2.3 | Repeat with the camera for **Proof of premises**. | Same as 2.2 for that row only; Owner ID is unchanged. |
| 2.4 | Close the app completely, reopen, go back to Verification Docs. | Both documents are still listed on their own rows; the count "N documents on file" matches. |
| 2.5 | CMS (admin) → the tenant's KYC documents. | Both files open (the viewer requests the stream once, NEW-222) and show their document type. |

## 3. Second organization: logo and cover

| # | Step | Expected result |
|---|---|---|
| 3.1 | Host A: Gyms tab → open the **second** organization → **Edit Organization**. | The editor shows that organization's name, logo and cover. |
| 3.2 | Tap the logo, pick a new image. Do **not** save yet. | The new image shows as a preview only. |
| 3.3 | Tap **Save**. | Saved message. The second organization shows the new logo. |
| 3.4 | Open the **first** organization. | Its logo and cover are **unchanged** (NEW-213: the old build replaced the first organization's logo). |
| 3.5 | Repeat 3.2–3.4 for the **cover**, and add one gallery photo. | Only the second organization changes. |
| 3.6 | Traveller T: search for the second organization's branch. | The new logo and cover are shown to travellers (after the listing is live; the discovery list can take up to 60 s to refresh). |

## 4. Payout & Banking (P11 item A, NEW-218)

| # | Step | Expected result |
|---|---|---|
| 4.1 | Host A (owner): Profile → **Payout & Banking**. | "Payout Setup". "Your payouts go to:" shows the saved account as `<Bank> · ****<last 4>`, or "No payout account saved yet". It shows the same account as the CMS Payouts page for this business. |
| 4.2 | Choose **Bank**, Account Title "Test Gym", IBAN `PK36SCBL0000001123456702`, tap **Save payout account**. | A "Confirm it's you" dialog asks for the password (or Google / Apple sign-in for a social account). Nothing is saved before you confirm. |
| 4.3 | Enter a wrong password, confirm. | The server's message (e.g. "Current password is incorrect") under the form; the saved account is unchanged. |
| 4.4 | Repeat with the right password. | "Payout account saved. Payout requests are paused for 24 hours." The card shows `Meezan Bank · ****6702` (the bank you picked). **The full number is not shown anywhere on the screen**, and the form is empty again. |
| 4.5 | CMS Payouts page for Host A. | The same account, masked to its last four digits. |
| 4.6 | Sign in as **Host A's front desk**, open Payout & Banking (if the menu shows it). | "Only the owner can see or change the payout account." No form, no account number, no "Try again". |
| 4.7 | Host A: **Payouts** → **Request payout** within 24 h of 4.4. | Refused with the 24-hour pause message (SEC-13). |
| 4.8 | Older build (build 20 or 21) on a second phone, Host A, Payout & Banking. | Still shows and saves the same account (old builds use `/gyms/profile`, which reads and writes the same tenant default until NEW-220 / the payout part of the removal plan runs). |

## 5. Lapse flow and the 7-day grace (R-82)

The lock itself happens 7 days after the plan stops; a device run can only check the first part on day 0
and the lock on day 7. Note the date and time of 5.3.

| # | Step | Expected result |
|---|---|---|
| 5.1 | **[Apple sandbox]** Host A (store plan bought on iPhone): Settings → App Store → Sandbox Account → Manage → cancel the GymsEra subscription. **[Google test]** on Android: Play Store → Subscriptions → cancel. | The store shows the plan ending at the end of the current (5-minute) period. |
| 5.2 | Wait until the period has ended (about 5–10 minutes; the server learns it from the store's notification), then open My Subscription and pull to refresh. | A **Plan ended** card: "Your plan ended on <date>." and "Your branches stay open until <lock date>. After that they're locked: no new members, sales or plans, and members can still check in for 7 more days." A **Choose a plan** button. Not "You don't have a subscription on this account yet" (NEW-174). |
| 5.3 | Check the lock date. | 7 days after the plan stopped. |
| 5.4 | Day 0: add a member and record a sale in a branch. | Allowed (the branches are still in their grace). |
| 5.5 | **Day 7 or later**: open My Subscription. | "Your branches are locked: no new members, sales or plans. Members can check in for 7 days after the lock." Adding a member or a sale is refused with the locked message; an existing member can still check in. |
| 5.6 | Day 7: buy a plan again (**[Apple sandbox]** / **[Google test]**) via **Choose a plan**. | After the purchase verifies, the branches unlock (adding a member works again) and the card is gone. |
| 5.7 | (Google only, optional) **[Google test]**: in Play Console use a test card that declines on renewal. | "Google Play couldn't take your renewal payment, so your plan is on hold." and **Fix payment in Google Play**. |

## 6. Purchase check before every store purchase (P9d, NEW-225, NEW-224, R-96)

| # | Step | Expected result |
|---|---|---|
| 6.1 | **[Apple sandbox] and [Google test]**: Host A has a plan bought on iPhone that still renews. On the Android phone, signed in as Host A: My Subscription → **Add more branches** → pick any plan. | Google Play does **not** open. The app shows the server's message: "Your plan is billed by Apple and renews automatically. Change or cancel it in App Store first; a Google Play plan can be bought once that plan is cancelled or has ended." |
| 6.2 | The reverse (plan bought on Android, try on iPhone). | The App Store sheet does not open: "Your plan is billed by Google Play and renews automatically. Change or cancel it in Google Play first; a App Store plan can be bought once that plan is cancelled or has ended." (The "a App Store" wording is a known copy defect, P11 report; not a fail.) |
| 6.3 | **[Apple sandbox]** On the phone that bought the plan, pick the **same** plan and cycle. | "You already have this plan and it renews automatically. There is nothing to buy." The store does not open. |
| 6.4 | **[Apple sandbox]** or **[Google test]**: Host B (paid bank-transfer plan, days left). Pick a plan with the **same or fewer** branches. | Refused, store not opened: "Your plan is paid by bank transfer until <date> (<N> paid days left). In the app you can only move to a plan with more than <n> branches. To renew or keep this plan, pay by bank transfer in the GymsEra CMS." |
| 6.5 | Host B: pick a plan with **more** branches. | A dialog "Unused bank-transfer days will be lost" with the number of days and the end date, and two buttons: **Keep my plan** and **Buy and lose N days**. |
| 6.6 | Tap **Keep my plan**. | The dialog closes; the store does not open; the plan is unchanged. |
| 6.7 | Repeat 6.5 and tap **Buy and lose N days**, complete the sandbox purchase. | The store opens; after the purchase My Subscription shows the new store plan; the CMS shows the bank plan replaced. |
| 6.8 | Offline retry: Host A with no plan (or a cancelled one). Airplane mode on, pick a plan. | The store does **not** open: "We couldn't check your plan with GymsEra, so the store was not opened. Check your connection and try again." |
| 6.9 | Airplane mode off, pick the same plan again. | The check passes and the store sheet opens (cancel it, or complete it in sandbox). |

## 7. Membership plan poster (P9d, NEW-223)

**There is no screen in build 22 or in the CMS that uploads a plan poster** (the app's
`MembershipPlansRepository.uploadPoster` and the CMS `plansApi.uploadPlanPoster` have no caller; P11 report,
question 2). This step checks only the display, after a poster is set through the API by the agent or a
developer with a test host token.

| # | Step | Expected result |
|---|---|---|
| 7.1 | A poster is set on one of Host A's visible plans (API: `POST /api/v1/membership-plans/<planId>/poster`, field `image`, JPEG or PNG). | 200; the plan's `posterUrl` is a URL on the public image store (R2), not `/uploads/...`. |
| 7.2 | Traveller T: open Host A's branch → that plan. | The plan detail shows the host's poster at the top. |
| 7.3 | Open a plan with no poster. | A plain banner, not a stock photo. |

## 8. Payment proof: upload (traveller) and viewing (host) (P9c A)

| # | Step | Expected result |
|---|---|---|
| 8.1 | Traveller T: open Host A's branch → a visible plan → book → Review → Payment. | The amount is the server's quote; the gym's bank / wallet details are listed (the business's payout account, step 4). |
| 8.2 | Try to submit a bank transfer without a screenshot. | "Screenshot proof is required to submit manual bank transfer payment." Nothing is sent. |
| 8.3 | Attach a screenshot (gallery), submit. | "Awaiting Host Approval". |
| 8.4 | Host A: Gyms tab (or Members → subscriptions) → the pending request → **View payment proof**. | The screenshot from 8.3 opens inside the app. |
| 8.5 | Host A's front desk (team member with payments access at that branch) repeats 8.4. | The proof opens. |
| 8.6 | CMS → Payments (Host A) → the same payment → proof. | The same image opens inside the dashboard. |
| 8.7 | Copy the proof link from the CMS network tab and open it in a private browser window (no sign-in). | 401, no image (proofs are private). |
| 8.8 | Host A approves the request. | Traveller T's membership starts on the approval day. |

## 9. After the run

- Cancel every sandbox / test subscription you started (5.6, 6.7, 6.9).
- Record results in the P11 section of spec §13 (or a new section for the device run) with the build number
  shown in the store (`1.0.0+22`), the phone models and OS versions.
- A pass on every step is required before `MIN_APP_VERSION_IOS` / `MIN_APP_VERSION_ANDROID` are set to build 22
  (R-62; see the NEW-220 removal plan in spec §13 P11).
