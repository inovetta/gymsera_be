# Build 25 (1.0.0+25): phone tests and CMS checks

**For:** the owner (or whoever tests build 25 on real phones) and the person checking the CMS.
**Covers:** NEW-265 Part A in the app (must-haves and nice-to-haves, R-108 to R-111), NEW-266 (amenities), and
the CMS "Unmatched areas" screens. Server and CMS behaviour are already covered by automated tests; this list is
what only a real phone and a real person can check.

**How to record:** run every row on **one iPhone and one Android phone**. Tick `iOS` / `Android` when it behaves
as written; when it does not, write what you saw (and a screenshot) in *Notes* and keep going. Any row marked
**STOP** blocks the release until it is fixed.

---

## 0. Before you start

- [ ] Server deployed with migration **p032** (the dry run listed **only** `p032_area_requests`, R-110), the
      NEW-266 server change, and the API restarted.
- [ ] CMS deployed from `feat/new-265-unmatched-areas`; you can sign in as a platform admin.
- [ ] Build 25 installed from **TestFlight** (iPhone) and **Play internal testing** (Android). The version at the
      bottom of **Settings** shows **1.0.0**, and TestFlight / Play shows build **25**.
- [ ] Two test host accounts that have **not** become hosts yet (call them **Host A** and **Host B**), and one
      traveller account. Use test e-mail addresses only.
- [ ] Pick a test city that already has a few areas in CMS › Cities & Areas (for example Peshawar). Note two of
      its area names (call them **Area 1** and **Area 2**).
- [ ] For typed areas, use made-up names that are clearly tests, different on each phone, for example
      `Test Town iOS 18` and `Test Town And 18`. Never use a real person's name or address.
- [ ] Location services on. Have a spot ready where "Use current location" lands on a main road with no named
      neighbourhood (or test from home and accept whatever comes back; row 4.4 says what to look for).

---

## 1. Become a Host: the area (must-have)

Run with **Host A** on iOS and **Host B** on Android.

| # | Steps | Expected | iOS | Android | Notes |
|---|---|---|---|---|---|
| 1.1 | Start Become a Host. Look at the first screen. | Title reads **"Where is your first gym located?"**. The text says it is the city and area of your first gym and that the street address comes later. No street address is asked here. | ☐ | ☐ | |
| 1.2 | Pick the city from the search. Tap the **Area** field without typing. | The city's own list of areas appears and scrolls. Areas of other cities are never shown. | ☐ | ☐ | |
| 1.3 | Type the first letters of **Area 1**. | The list narrows as you type, with no delay and no spinner. From the 3rd letter, Google suggestions may appear under our own areas; roads show "Road", landmarks "Landmark". | ☐ | ☐ | |
| 1.4 | Clear the area, tap **Next** with no area. | Message **"Please pick your area"**. You stay on the screen. **STOP** if it moves on. | ☐ | ☐ | |
| 1.5 | Type a near-miss of an existing area (for example **Area 1** with one letter wrong). Tap **"Not in the list? Keep …"**. | A sheet **"Did you mean …?"** lists the real area. Tap it: the field shows the real area, nothing is "under review". | ☐ | ☐ | |
| 1.6 | Type your test name (`Test Town iOS 18`). Tap **"Not in the list? Keep …"**. If the sheet appears, tap **"No, keep …"**. | Under the field: **"Test Town iOS 18 (under review)"**. **Next** works (a pending area counts as picked). | ☐ | ☐ | |
| 1.7 | Tap **Next**. Fill the gym details step as usual. | You reach the address step. | ☐ | ☐ | |
| 1.8 | On the address step (Step 3), look at **AREA**. | It is already filled with your Step 1 area: **"Test Town iOS 18 (under review)"**. | ☐ | ☐ | |
| 1.9 | Change the Step 3 area to **Area 2** (pick from the list). Fill the address. Tap **Continue to Packages**. | Moves on. (CMS check 5.3 later confirms the first branch got **Area 2**, and the first-branch default kept your test name.) | ☐ | ☐ | |
| 1.10 | Go back to Step 3 and clear the area. Tap **Continue to Packages**. | Message **"Please pick your area"**; you stay. Pick **Area 2** again. | ☐ | ☐ | |
| 1.11 | On Step 3 tap **Use current location**. Allow location. | Address and pin move to where you are. If you are in another city than Step 1, the area empties and fills from your location (or shows a suggestion, see 4.4). Go back to Step 1 (or check CMS 5.3): the Step 1 city and area did **not** change. **STOP** if Step 1's area changed. | ☐ | ☐ | |
| 1.12 | Put the Step 3 area back to **Area 2**. Continue through amenities (section 2), photos and plans (add one plan, shown to travellers). | Each step saves and moves on. | ☐ | ☐ | |
| 1.13 | **Resume:** before submitting, force-close the app. Open it again, go to the host tab, tap the resume button. | You land back in the flow. Step 1 still shows your test name **(under review)**; Step 3 still shows **Area 2**; your plan is still there. | ☐ | ☐ | |
| 1.14 | Submit the application. | Waiting for review screen, as before. | ☐ | ☐ | |
| 1.15 | **Weak network:** on another device or account, repeat 1.6 with the phone in airplane mode, then turn the network back on and try again. | Offline: a plain message (no raw error, no crash); nothing saved. Online again: works. | ☐ | ☐ | |

## 2. NEW-266: amenities are kept

Same accounts, during section 1.

| # | Steps | Expected | iOS | Android | Notes |
|---|---|---|---|---|---|
| 2.1 | On the amenities step select 4 items (for example **Dumbbells, Cardio, Showers, WiFi**). Tap **Next Step**. | Moves to photos. | ☐ | ☐ | |
| 2.2 | Force-close, reopen, resume, go back to the amenities step. | The same 4 items are still selected. **STOP** if they are empty. | ☐ | ☐ | |
| 2.3 | Turn on airplane mode, change one amenity, tap **Next Step**. | A plain error message; you stay on the amenities step with your choice intact. Network back on, **Next Step** works. | ☐ | ☐ | |
| 2.4 | After the admin approves the gym (section 3), open the gym as a traveller. | The branch shows exactly the 4 amenities. **STOP** if "No amenities listed". | ☐ | ☐ | |
| 2.5 | As an approved host, create **another organisation** (the new-organisation flow in the host area), pick 2 amenities, finish. | The new organisation's first branch shows those 2 amenities. | ☐ | ☐ | |

## 3. Review in the CMS, then the host and traveller see the result (must-have)

Use the CMS (section 5 has the details) together with the phones.

| # | Steps | Expected | iOS | Android | Notes |
|---|---|---|---|---|---|
| 3.1 | While the request is pending, open the app as the **traveller** and search the test city. (The gym only shows after approval; skip until 3.4 if not approved yet.) | The gym is listed under the **city** only, never under the test name. | ☐ | ☐ | |
| 3.2 | In the CMS **reject** Host A's test name with reason "Test: not a real area". | Host A gets a notification: "… was not accepted: Test: not a real area. Please pick your area again." | ☐ | ☐ | |
| 3.3 | On Host A's phone open the host tab. | The status screen shows "Test Town … was not accepted: …" and a button **Choose your area again**. Tap it: the Location step opens with the **city shown read-only** and the button **Save area**. Pick **Area 1**, tap **Save area**. You return to the host screen and the message is gone. | ☐ | ☐ | |
| 3.4 | In the CMS **approve** Host B's test name (no pin is fine). Approve the gym itself as usual. | Host B gets "… was added". In the app the area no longer says "(under review)". | ☐ | ☐ | |
| 3.5 | Traveller: search the test city, filter or look at the gym card. | Host B's gym shows the approved area name. Host A's gym shows **Area 2** (its first branch's own area, R-111: the branch area wins). | ☐ | ☐ | |
| 3.6 | (If time) reject a request that only the **draft first branch** uses (a host who kept a typed area on Step 3 only). | **Choose your area again** opens the **address step** (not Step 1). | ☐ | ☐ | |

## 4. Nice-to-haves: the same picker on the branch screens

Use an **approved** host (Host B after 3.4).

### 4.1 Edit location (branch › Location & map)

| # | Steps | Expected | iOS | Android | Notes |
|---|---|---|---|---|---|
| 4.1.1 | Open a branch whose area is pending (keep a typed name first via 4.1.3, then reopen). | The area shows "**… (under review)**". | ☐ | ☐ | |
| 4.1.2 | Change only the phone number and tap **Save Location Changes**. | Saved. Reopen: the area is still "(under review)" (the request was kept, not cleared). | ☐ | ☐ | |
| 4.1.3 | Type a new test name, tap **"Not in the list? Keep …"**, save. | Saved; reopen shows the name "(under review)"; it appears in CMS Unmatched areas. | ☐ | ☐ | |
| 4.1.4 | Pick a real area from the list, save. | Saved; reopen shows the real area; the request no longer lists this branch in the CMS. | ☐ | ☐ | |

### 4.2 Add listing (another organisation, the address step)

| # | Steps | Expected | iOS | Android | Notes |
|---|---|---|---|---|---|
| 4.2.1 | Start a new organisation in the **same city** as the first one. Reach the address step. | The area is pre-filled with the first-branch default (if it is a real area). | ☐ | ☐ | |
| 4.2.2 | Clear the area and continue. | Allowed (the area is optional here). | ☐ | ☐ | |
| 4.2.3 | Keep a typed test name instead and finish. | The new organisation is created; in the CMS the request lists **two** gyms for it (the organisation and its first branch). | ☐ | ☐ | |

### 4.3 Add branch (detailed: the automated tests only cover what is sent)

Run every row on both phones. Use an organisation with free branch capacity.

| # | Steps | Expected | iOS | Android | Notes |
|---|---|---|---|---|---|
| 4.3.1 | Open **Add branch**. On the location step, look at **AREA / NEIGHBORHOOD** before picking a city. | The area field says "Pick the city first" and cannot be typed in. | ☐ | ☐ | |
| 4.3.2 | Pick the **same city** as the organisation's first-branch default (a real area). | After a moment the area fills with that default area. It can be changed. | ☐ | ☐ | |
| 4.3.3 | Pick **another city**. | The area empties; the list now shows only the new city's areas. | ☐ | ☐ | |
| 4.3.4 | Tap the area field without typing. | The city's full list appears and scrolls. | ☐ | ☐ | |
| 4.3.5 | Type a near-miss of a real area, tap **Keep**. | "Did you mean …?" appears; picking the real area fills it (not under review). | ☐ | ☐ | |
| 4.3.6 | Type a test name, tap **Keep** (and **No, keep …** if asked). | "… (under review)" under the field. | ☐ | ☐ | |
| 4.3.7 | Tap **Next** without filling the rest. | The location step's own rules apply as before ("Please select a city" if none); the area is **not** required here. | ☐ | ☐ | |
| 4.3.8 | **Draft:** with the test name kept, force-close the app. Reopen **Add branch**. | **"Resume Draft?"** appears. Tap **Resume**: city, address and **"… (under review)"** are all back. **STOP** if the area comes back empty or as a plain area. | ☐ | ☐ | |
| 4.3.9 | Tap **Use current location**. | Address, city and pin fill from your location; the area fills from it (or shows a suggestion, see 4.4). | ☐ | ☐ | |
| 4.3.10 | Put back the kept test name. Go through photos and plans; tap **Preview Listing**, then **Submit for Review**. | The branch is created. In the CMS the request lists this branch; the branch shows no area to travellers until it is approved. | ☐ | ☐ | |
| 4.3.11 | Create a second branch with a **real** area from the list. | The branch has that area at once (CMS admin tenant › Branches shows it, no "under review"). | ☐ | ☐ | |
| 4.3.12 | Create a third branch with **no area** at all. | Created; no area shown; nothing appears in Unmatched areas. | ☐ | ☐ | |
| 4.3.13 | Start Add branch, keep a test name, leave the screen. Open **Add branch** again and choose **Start Fresh** on "Resume Draft?". | The form is empty: no area from the old draft. | ☐ | ☐ | |
| 4.3.14 | If you have 3 open requests in that city already, try a 4th typed name. | Message: "You have 3 areas waiting for review in this city …"; nothing is created; you can still pick from the list. | ☐ | ☐ | |

### 4.4 "Use current location" on a road or landmark

| # | Steps | Expected | iOS | Android | Notes |
|---|---|---|---|---|---|
| 4.4.1 | On Step 3, Edit location or Add branch, tap **Use current location** where Google returns a road or landmark rather than a neighbourhood. | The area field shows that name and offers **"Not in the list? Keep …"**. Nothing appears in the CMS until you tap **Keep**. | ☐ | ☐ | |
| 4.4.2 | Where Google returns a neighbourhood. | The area is filled with it directly (no "Keep" needed). | ☐ | ☐ | |

## 5. CMS checks (platform admin)

| # | Where | What to look for | ☐ | Notes |
|---|---|---|---|---|
| 5.1 | **Cities & Areas** | Two tabs: **Cities & Areas** and **Unmatched areas**. The cities list works exactly as before (area counts, add / edit / delete). | ☐ | |
| 5.2 | **Unmatched areas**, status **Waiting for review** | Each test name from the phones appears once per city and spelling, with its source (Typed, Google road, Google landmark), the number of gyms, who asked, the date, the gyms with a **map** link where a point is known, and similar existing areas. Two hosts typing the same spelling show as **one** row. | ☐ | |
| 5.3 | Admin › Tenants › Host A › **Gym listing** and **Branches** | While pending: "Area "…" under review" instead of an empty area. After 1.9: the branch shows **Area 2**. After a reject: "not accepted: <reason>". | ☐ | |
| 5.4 | **Approve** | The name can be corrected before approving (a different spelling is kept as another spelling). The pin is **optional**: approve once without a pin and once with one. "Apply to every request with this spelling" is ticked by default. After approval: the row leaves the list; the area appears in Cities & Areas; the gyms show the area. | ☐ | |
| 5.5 | **Merge** | Pick an existing area of the same city (similar ones are listed first). The typed spelling is added under that area's **Other spellings**; a host typing it again gets the area directly. | ☐ | |
| 5.6 | **Reject** | The button stays disabled until the reason has 3 characters. The host is notified with the reason. The row leaves the list. | ☐ | |
| 5.7 | Status filter **Approved / Merged** | Decided rows are listed; **Retry failed updates** runs without error. If a decision reported "x gyms could not be updated", Retry clears it once the gym is reachable. | ☐ | |
| 5.8 | Cities & Areas › an area › **Other spellings** | Lists merged / corrected spellings; **Delete** removes one. | ☐ | |
| 5.9 | Host side of the CMS (gym owner): Branches › add / edit, **New organisation**, Listing › Location | The area field offers **"Not in the list? Keep …"**, "Did you mean …?", and shows "(under review)", like the app. | ☐ | |
| 5.10 | Admin side: Tenant › Branches › add / edit | The area field offers the list only (no "Keep"), with the "Contact support" note: admins pick real areas. | ☐ | |
| 5.11 | Moderation word list | A typed area containing a listed word is refused with "Please choose a different name." (try in the app once). | ☐ | |

## 6. Older builds still work after the server deploy

If a phone still has build 24 (or 22/23) installed, check once:

| # | Steps | Expected | ☐ | Notes |
|---|---|---|---|---|
| 6.1 | Become a Host on the old build: pick a city and an area from the list. | Works as before. No roads or landmarks are offered. | ☐ | |
| 6.2 | Old build: an existing approved branch, edit and save its location. | Saves as before. | ☐ | |

## 7. After testing

- Send the filled table (or just the failed rows with notes and screenshots).
- If everything passes: the real gym and the App Review demo accounts can be created (R-110), then build 25 goes
  to the stores. Clean up: reject or merge the leftover test names in Unmatched areas so they do not stay in the
  queue.
