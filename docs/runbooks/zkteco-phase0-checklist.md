# ZKTeco Phase 0: device checklist (spike, one real device)

What this is for: answering the Phase 0 questions (a) to (g) in
[`ZKTECO_PUSH_DEVICE_SYNC.md` §15](../ZKTECO_PUSH_DEVICE_SYNC.md) on a real SpeedFace, using the
throw-away capture server `scripts/zk-capture-server.js` on a Mac. No production server, no
production data, nothing is deployed.

Time needed: about 2 hours on site. Fill in every **Result:** line. Afterwards, send the agent:
the files in `captures/`, this checklist with the results filled in, and photos of the Cloud Server
screen.

---

## 0. Before you start (safety)

- [ ] **Enrol only a test person** (yourself or a colleague who agrees). Use PIN **9001** for them
  in every step. Never enrol, query or delete a real member.
- [ ] Prefer a **spare device** with no members on it. If you must use a gym's live device, do it
  when nobody is scanning in. While it points at your Mac it does **not** talk to GymBioSync, so
  members' scans are not recorded there and the door rules of GymBioSync don't update.
- [ ] Make sure the door has a physical exit button or free exit. Nothing here should lock anyone
  in, but don't depend on it.
- [ ] **Photograph the device's current Cloud Server Setting screen** (every field) before
  changing anything. You need it to restore the device in step 9.
- [ ] Don't change **Device Type** (T&A PUSH / Access Control PUSH) or run any "clear data" menu.
  On some models switching the type wipes users.
- [ ] The capture server refuses wipes (`DELETE … *`) and asks for `all=1` before any whole-table
  query. Don't use `all=1` on a device that holds real members, because their names would land in
  the capture file.

Device model and serial number (Menu › System Info › Device Info): ______________________

Firmware version: ______________________

---

## 1. Mac setup

1. Connect the Mac to the **same Wi-Fi or LAN as the device**. A guest Wi-Fi network usually
   blocks devices from reaching each other ("client isolation"), so use the main network or a
   cable.
2. Turn off any VPN on the Mac.
3. Find the Mac's IP address: System Settings › Wi-Fi › Details (next to the network) › TCP/IP ›
   IP address. Or in Terminal: `ipconfig getifaddr en0` (Wi-Fi) or `ipconfig getifaddr en1`.

   Mac IP: ______________________

4. Stop the Mac from sleeping during the test. In a second Terminal window run `caffeinate -d`
   and leave it open.
5. Start the capture server from the `gymsera_be` folder (Node 20 or newer, no `npm install`
   needed):

   ```
   cd ~/Developer/Apps/InovettaTech/SaaS/gymsera_be
   node scripts/zk-capture-server.js --port 8088
   ```

   It prints the server address to type on the device, the control page link and the capture
   file name. Leave this window open: it shows every request as it arrives.
6. **Firewall prompt:** the first time, macOS asks "Do you want the application node to accept
   incoming network connections?" Click **Allow**. If you missed it: System Settings › Network ›
   Firewall › Options, find `node`, set it to "Allow incoming connections".
7. Check the Mac can be reached: on your phone (same Wi-Fi) open `http://<Mac IP>:8088/iclock/ping`.
   It must show `OK`. If it doesn't load, the device won't reach the Mac either: check step 1 and
   the firewall.
8. Open the control page on the Mac: `http://127.0.0.1:8088/zkcap`. It lists the command kinds,
   lets you queue them, and shows the state (device, registration fields, queued commands and
   results, last scans). Every step below also works from Terminal, for example:

   ```
   node scripts/zk-capture-server.js queue count-user
   node scripts/zk-capture-server.js kinds
   ```

   In Terminal, put quotes around values with spaces or `*`, for example `"name=ZK Test"`.
   Queued commands reach the device on its next poll, within about 3 seconds.

---

## 2. Point the device at the Mac

Menu names differ by firmware. On a SpeedFace it is usually **Main Menu › COMM. › Cloud Server
Setting**. Write down the real path you used: ______________________

| Field | Set to |
|---|---|
| Server Mode | ADMS |
| Enable Domain Name | OFF |
| Server Address | the Mac IP from step 1 |
| Server Port | 8088 |
| Enable Proxy Server | OFF |
| HTTPS (if present) | OFF |

Save. Within about 30 seconds the Terminal window should show `GET /iclock/cdata`, then
`REGISTERED <serial>`, then `POST /iclock/push`, then polls. The device's cloud icon should turn on.

Result (connected? how long did it take?): ______________________

> If you see `cdata` and polls but never `REGISTERED` within 2 minutes, stop the server (Ctrl+C),
> start it again with `--style gbs` (answers the way GymBioSync does, which skips registration)
> and note it here: ______________________

**Clock check:** our replies set the device clock (the `Date` header). After it connects, compare
the device's time with the Mac's time. They should match to the minute. If the device shows a
different hour, its time zone setting is wrong (Menu › System › Date Time). Record and fix it
before step 5 (e), because the expiry test depends on it.

Device time vs Mac time: ______________________ Device time zone setting: ______________________

**Baseline counts** (so you can prove the clean-up in step 8). Queue `count-user`, then
`count-biodata` with `type=9` (and `type=1` if it has fingerprints). The Terminal shows lines
like `COUNT user=12`.

Users before: ________ Faces (type 9) before: ________ Fingerprints (type 1) before: ________

---

## 3. (a) The Cloud Server screen: what it offers

Don't test HTTPS or a real hostname yet. Just record what the screen allows, so we can choose link
mode A, B or C (spec §4.2):

| Question | Answer |
|---|---|
| Is there an "Enable Domain Name" switch? | |
| With it ON, does the address field accept letters and dots (for example `k7qm3xrt.push.gymsera.com`)? | |
| Does the address field accept a `/` (a path, for example `push.gymsera.com/d/K7QM3XRT`)? | |
| Longest address it accepts (count the characters you can type; the two examples above are 25 and 27) | |
| Is there an HTTPS switch? Any certificate options? | |
| Port field: any value, or a fixed list? | |
| Proxy fields present? | |
| Is there a Comm Key (often COMM. › PC Connection › Comm Key)? Is it set? (don't change it) | |
| Any other fields (for example "Server path", "Device ID")? | |

**Optional path test on the LAN (mode A).** Only if the address field accepts `/`: set Server
Address to `<Mac IP>/d/TESTKEY1` (try with Enable Domain Name OFF, then ON) and save. In the
Terminal, look for `[path key TESTKEY1]` on the request lines. If you see it, the firmware keeps a
path. Put the address back to just the Mac IP afterwards.

Result (path kept? with which switch setting?): ______________________

---

## 4. (b) Registration body and (c) the token

Nothing to do on the device: both were captured when it connected in step 2.

**(b)** In the capture file, find `POST /iclock/registry`. Its body lists the device's
capabilities. The control page shows the same fields under `devices › registry`. Copy these
values:

| Field | Value |
|---|---|
| DeviceType (`acc` or `att`) | |
| FirmVer | |
| PushVersion / pushver | |
| MultiBioDataSupport | |
| MultiBioPhotoSupport | |
| MultiBioVersion | |
| MaxMultiBioDataCount / MaxUserCount | |
| DateFmtFunOn (1 = seconds format, 0 = YYYYMMDD) | |
| authKey present? (the Terminal says `authKey=sent` or `not sent`) | |
| MaxPackageSize (if present) | |

**(c)** In the capture file, find the requests after registration (`POST /iclock/push`,
`GET /iclock/getrequest`). Each has a `cookie:` header and a `token check:` line. The server tests
the documented formula and its variants with this run's codes, and the manual's example codes
(which GymBioSync uses).

Token check line (copy it): ______________________

Does the token change between requests? ______ Is there a `timestamp=` in the cookie? ______

---

## 5. Device tests

Set up the test person first:

1. Queue `user` with pin `9001`, name `ZK Test`, window `none`. The Terminal shows
   `RESULT #… Return=0`. Anything negative is a failure: note the code.
2. On the device, enrol the test person's face for user 9001 (usually Main Menu › User Mgt. › All
   Users › 9001 › Edit › Face). Add a fingerprint too if the model has a reader.
3. The Terminal should show uploads: `UPLOAD tablename=biodata`, maybe `biophoto` or `userpic`.

Result (Return code, which uploads appeared): ______________________

### (d) Does a user without `userauthorize` pass the door?

1. Queue `delete-userauthorize` pin `9001`, so the user truly has no access privilege (the menu
   enrolment may have created one). Note the Return code.
2. The test person scans their face. Watch the screen and the door, and the Terminal line
   `SCAN pin=9001 event=…`.
3. Queue `userauthorize` pin `9001` (time rule 1, door 1, no window). Note the Return code.
4. Scan again.

| | Screen message | Door opened? | `event=` code |
|---|---|---|---|
| Without userauthorize | | | |
| With userauthorize | | | |

Result: ______________________

### (e) Does `EndTime` block access after expiry, and in which format?

Use the format from (b): `datefmt=seconds` if DateFmtFunOn=1, `datefmt=yyyymmdd` if 0. The server
picks it from the registration automatically when you leave `datefmt` empty. Times use the
Mac's clock, so do the clock check in step 2 first.

**If DateFmtFunOn = 1 (seconds; works to the minute):**

1. **e1, window on `user` only:** queue `user` pin 9001, window `set`, start `now`, end `+3m`.
   Queue `userauthorize` pin 9001 with window `none`. Scan within the 3 minutes, then scan again
   after 4 minutes.
2. **e2, window on `userauthorize` only:** queue `user` pin 9001 with window `zero` (no limit),
   then `userauthorize` pin 9001, window `set`, start `now`, end `+3m`. Scan within 3 minutes,
   then after 4 minutes.
3. **e3, offline:** queue both with end `+3m`, wait for both `Return=0`, then **stop the capture
   server** (Ctrl+C) so the device is offline. Wait 4 minutes and scan. Then start the server
   again: the device uploads the stored scan (a new capture file starts).

**If DateFmtFunOn = 0 (YYYYMMDD; whole days only):** run e1 and e2 with end `-1d` (already
expired, so expect a refusal), then with end `+1d` (expect entry). Run e3 with end `-1d` while the
server is stopped.

| Test | Before expiry: entered? event | After expiry: entered? event | Screen message |
|---|---|---|---|
| e1 user window | | | |
| e2 userauthorize window | | | |
| e3 offline | | | |

Afterwards, queue `user` pin 9001 with window `zero` and `userauthorize` pin 9001 with window
`none`, so the test person has no limit again.

Result: ______________________

### (f) Is `ENROLL_BIO` supported?

1. Queue `enroll-bio` pin 9001 (type 9, separator `tab`).
2. Watch the device: does it ask the test person to look at the camera? Let them enrol.
3. Terminal: `RESULT #… Return=…` and an `ENROLL RESULT (type=BioData)` line.
4. If the device shows nothing, or Return is negative (for example `-708` = not supported), queue it
   again with separator `space` and note both results.

| Separator | Device prompted? | Return | BioData upload seen? |
|---|---|---|---|
| tab | | | |
| space | | | |

Result: ______________________

### (g) Template sizes, and does a `biophoto` (type 9) enrol the face?

**Sizes.** Queue `query-biodata` pin 9001 type `9`, and type `1` if fingerprints exist. In the
capture file the templates appear as `tmp=<first 40 characters>…[len=N]`. Copy N, `majorver` and
`minorver` for each:

| Type | len | majorver | minorver |
|---|---|---|---|
| 9 face | | | |
| 1 fingerprint | | | |

**Comparison photo.**

1. Take a clear, front-facing JPEG of the test person (good light, face filling about half the
   frame) and save it on the Mac, for example `~/Desktop/zk-test-face.jpg`. Smaller than 100 KB
   is safest.
2. Queue `delete-biodata` pin 9001 type `9`, then `count-biodata` type `9`. The face count should
   drop by one.
3. Queue `biophoto` pin 9001, file `/Users/<you>/Desktop/zk-test-face.jpg`, format `base64`. It
   asks the device to send the template it builds back (`PostBackTmpFlag=1`).
4. Terminal: `RESULT #… Return=…`, then hopefully `UPLOAD tablename=biodata` with the new
   template.
5. The test person scans their face. Entered?
6. If Return is negative, queue it again with format `url` (the device downloads the photo from
   the Mac instead) and note both results.

| Format | Return | Template sent back (len)? | Face scan entered? |
|---|---|---|---|
| base64 | | | |
| url | | | |

Result: ______________________

---

## 6. Optional extras (only if there's time)

- [ ] Queue `query-user` pin 9001 and look at the fields the device returns for a user.
- [ ] Queue `info`. The device answers with its parameters (`table=options` or `devicecmd`).
- [ ] Present a card (if the test person has one) and see `cardno=` on the scan line.

---

## 7. Anything unexpected

Paths the server didn't know (`UNKNOWN iclock path`), errors, repeated uploads of the same data,
the device dropping offline:

______________________

______________________

---

## 8. Clean up the device

1. Queue `delete-biodata` pin 9001 (all types), `delete-userauthorize` pin 9001, then
   `delete-user` pin 9001. All should show `Return=0`.
2. Queue `count-user` and `count-biodata` type 9 (and type 1). The counts must equal the
   baseline from step 2.

Users after: ________ Faces after: ________ Fingerprints after: ________ (equal to before? ____)

---

## 9. Restore the device's original server settings

1. On the device, open the Cloud Server Setting screen and type back **every field from the photo
   you took in step 0**: server mode, domain name switch, server address, port, HTTPS, proxy.
2. Save, and wait for the cloud icon. If the device used GymBioSync, check the GymBioSync screen
   shows it online again.
3. Scans made while the device pointed at the Mac are **not** in GymBioSync. If a real member
   scanned during the test, tell the gym.
4. Stop the capture server (Ctrl+C) and `caffeinate` (Ctrl+C).
5. Optional: remove `node` from the firewall list (System Settings › Network › Firewall › Options).

Device back on its original server? ______ Time: ______

---

## 10. What to send back

- Every file in `gymsera_be/captures/` from today. They hold the test person's name and the first
  40 characters of templates and photos, never a full template or photo. Don't send them anywhere
  public.
- This checklist with the results filled in.
- Photos of the Cloud Server screen (before, and with each option you tried).

The agent then records the answers in the spec (§15 Phase 0, and decisions D-1 to D-3 in §16),
saves sanitized samples as test fixtures, and starts Phase 1.
