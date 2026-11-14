# ZKTeco Phase 0: device checklist (spike, one real device)

What this is for: answering the Phase 0 questions (a) to (l) in
[`ZKTECO_PUSH_DEVICE_SYNC.md` §15](../ZKTECO_PUSH_DEVICE_SYNC.md) on a real SpeedFace, using the
throw-away capture server `scripts/zk-capture-server.js` on a Mac. No production server, no
production data, nothing is deployed.

Time needed: about 2 hours on site. Fill in every **Result:** line. Afterwards, send the agent:
the files in `captures/`, this checklist with the results filled in, and photos of the Cloud Server
screen.

Questions (a) to (g) are for a device in **Access Control PUSH** mode (`DeviceType=acc`). Questions
(h) to (l) in section 5b are for a device in **T&A PUSH** mode (`DeviceType=att`), which is what the
first real device turned out to be.

---

## What the first capture showed (2026-11-11, `captures/20261111-155035.txt`)

Device: SpeedFace-V5L, firmware ZAM180-NF50VA-Ver3.4.9, Push Service `Ver 2.0.33S-20220623`, Device
Type **T&A PUSH**, a live gym device (GymBioSync's) with about 356 users. The server ran with
`--style spec`.

- **No registration.** The device sent `GET /iclock/cdata?SN=…&options=all&language=69&pushver=2.4.1&DeviceType=att&PushOptionsFlag=1`,
  got `OK`, and never sent `POST /iclock/registry` or `POST /iclock/push`. It went on anyway:
  `POST cdata?table=options` (its parameters), `GET getrequest?INFO=<firmware>,<counts>…`, then its
  whole history.
- **History upload on first contact, about 2.5 minutes, with no polls in between** (so no command
  can reach the device during that time): `OPERLOG` with `USER` lines (all users, with names) and
  `FP` lines (fingerprint templates), one `BIODATA` post (faces, `Type=9 MajorVer=39 MinorVer=3`),
  58 `ATTLOG` posts (7,172 punches from 2026-07-09 on), then `OPERLOG` with 14,783 `OPLOG` lines.
  Each post holds up to 128 records. Every upload got `OK`, and no body was sent twice.
- **Formats.** `ATTLOG` is positional, tab-separated, 10 values plus a trailing tab: PIN, time,
  status (always 255), verify (1 fingerprint, 15 face, 4 card), workcode, then 0, 0, 255, 0, 0.
  `USER PIN=⇥Name=⇥Pri=⇥Passwd=⇥Card=⇥Grp=⇥TZ=⇥Verify=⇥ViceCard=⇥StartDatetime=⇥EndDatetime=`.
  `FP PIN=⇥FID=⇥Size=⇥Valid=⇥TMP=`. Uploads use `Stamp=9999` / `OpStamp=9999` (we never sent stamps).
- **Headers.** `User-Agent: iClock Proxy/1.09`, `Connection: close`, `Content-Type: text/plain`, `Host`
  = the IP and port typed on the device. **No `Cookie` / token at all.**
- **Polling.** After the upload, the `getrequest` interval grew by 1 to 3 seconds each time,
  from 3 s to over 30 s within 6 minutes (we never sent `Delay` / `RequestDelay`). A live fingerprint
  punch arrived as a 1-record `ATTLOG` post within a few seconds.
- **Parameters** (`table=options`): `FPVersion=10`, `FaceVersion=39`, `PvVersion=12` (palm),
  `MultiBioDataSupport=0:1:0:0:0:0:0:0:1:1`, `MultiBioPhotoSupport=0:0:0:0:0:0:0:0:0:1`,
  `UserPicURLFunOn=1`, `VisilightFun=1`. Not sent: `DeviceType` (only in the query), `DateFmtFunOn`,
  `MultiBioVersion`, `MaxPackageSize`, `authKey`.

The capture server now answers this flow itself (`--style auto`, the default): a device that says
`DeviceType=att` gets GymBioSync's option lines with this run's random codes, and every upload is
logged by table and record type.

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
  On some models switching the type wipes users. Only **write down** the options it offers (section 3).
- [ ] **A T&A PUSH device sends every user's PIN and name, all fingerprint and face templates (cut
  to 40 characters) and its whole punch history the first time it reaches the Mac.** The capture
  file then holds real member data. Keep it on this Mac, and send it to the agent only through the
  same private channel as before. If you can, use the spare device.
- [ ] If the device serves GymBioSync today, read section 9b before you start.
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

   The default style is `auto`: a T&A PUSH device (`DeviceType=att`) gets the option lines at once,
   any other device gets the spec handshake. Other choices: `--style spec` (answers `OK` and waits
   for registration, as in the first capture), `--style gbs` (GymBioSync's answers for every
   device), `--style att` (the T&A answer for every device). `--stamps 9999` (default) is the stamp
   value sent until the device reports its own. `--stamps 0` is what GymBioSync sends; it may make
   the device send its whole history again. Uploads of PIN 9001 are shown line by line; use
   `--test-pin <pin>` for another test PIN.

   > **The device keeps the stamp you give it (NEW-242).** After a session with `--stamps 9999` it uploads nothing older
   > to the next server either: pointed at GymsEra, an import then gets only the users added since. Before you point
   > the device anywhere else, end the session with `--stamps 0` (restart the server with it and let the device
   > connect once), or reset it in GymsEra afterwards: device in import hold › Import page › **Read all users again**
   > (runbook `devices.md`, "The import has fewer users than the device").
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

Save. Within about 30 seconds the Terminal window should show `GET /iclock/cdata`, then one
`FLOW <serial>: …` line, then polls. The device's cloud icon should turn on.

- Access Control PUSH device: `FLOW …: waiting for registry`, then `REGISTERED <serial>` and
  `FLOW …: registry`, then `POST /iclock/push`.
- T&A PUSH device: `FLOW …: att options (no registry expected)`, then `POST cdata table=options`,
  `DEVICE INFO …`, and `UPLOAD table=OPERLOG / BIODATA / ATTLOG …` lines for a few minutes (its
  history). Commands queued during the upload wait until it ends.

Result (connected? how long did it take? which FLOW line?): ______________________

> If you see `cdata` and polls but neither `REGISTERED` nor a T&A `FLOW` line within 2 minutes,
> stop the server (Ctrl+C), start it again with `--style gbs` (answers the way GymBioSync does,
> which skips registration) and note it here: ______________________

**Clock check:** our replies set the device clock (the `Date` header). After it connects, compare
the device's time with the Mac's time. They should match to the minute. If the device shows a
different hour, its time zone setting is wrong (Menu › System › Date Time). Record and fix it
before step 5 (e), because the expiry test depends on it.

Device time vs Mac time: ______________________ Device time zone setting: ______________________

**Baseline counts** (so you can prove the clean-up in step 8). Queue `count-user`, then
`count-biodata` with `type=9` (and `type=1` if it has fingerprints). The Terminal shows lines
like `COUNT user=12`.

Users before: ________ Faces (type 9) before: ________ Fingerprints (type 1) before: ________

On a T&A PUSH device `DATA COUNT` may not be supported (note its Return code). Use the counts the
device reports itself instead: the `DEVICE INFO` line (firmware, then users, fingerprints, punches,
…) and `UserCount` / `FPCount` / `FaceCount` in `devices › options` on the control page.

INFO line before: ______________________ UserCount / FPCount / FaceCount before: ______________________

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

**Device Type options (write down only, do not change).** Usually Main Menu › System › Device Type
Settings (or COMM. › Cloud Server Setting). Photograph the screen and any warning it shows when you
open the list, then press Back without saving.

| Question | Answer |
|---|---|
| Menu path to the setting | |
| Current value (first device: "T&A PUSH") | |
| Every option offered (exact text) | |
| Does the screen warn that changing it clears data or restarts? (exact text) | |
| Is the option locked or password-protected? | |

**Optional path test on the LAN (mode A).** Only if the address field accepts `/`: set Server
Address to `<Mac IP>/d/TESTKEY1` (try with Enable Domain Name OFF, then ON) and save. In the
Terminal, look for `[path key TESTKEY1]` on the request lines. If you see it, the firmware keeps a
path. Put the address back to just the Mac IP afterwards.

Result (path kept? with which switch setting?): ______________________

---

## 4. (b) Registration body and (c) the token

Nothing to do on the device: both were captured when it connected in step 2.

**(b)** In the capture file, find `POST /iclock/registry`. Its body lists the device's
capabilities. The control page shows the same fields under `devices › registry`. A T&A PUSH device
sends no registry: take `DeviceType` and `pushver` from the `GET /iclock/cdata` query, the rest
from `POST /iclock/cdata?table=options` (`devices › options` on the control page). Copy these
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

(The first T&A PUSH capture had **no** `cookie:` header on any request. If that stays true with
the option lines from `--style auto`, write "no cookie".)

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

## 5b. T&A PUSH device tests (h) to (l)

For a device whose `FLOW` line says `att options` (or whose cdata query has `DeviceType=att`).
Wait until the history upload has finished (no more `UPLOAD` lines for a minute, polls again)
before you queue anything. Use PIN 9001 only. Each test names both command forms: the security
form our backend sends today (`user`, `userauthorize`) and the attendance form the device uses in
its own uploads (`userinfo` = `DATA UPDATE USERINFO`).

### (h) Which flow, and does the option answer change the device's behaviour?

1. Start the server with the default `--style auto`. Point the device at it (section 2) and copy
   the `FLOW` line.
2. Watch the poll interval: in the control page `devices › polls`, or the times of the
   `getrequest` lines in the capture file. In the first capture (plain `OK`) it grew from 3 s to
   over 30 s. The option lines send `Delay=3` and `Realtime=1`.
3. Note whether the device now sends `POST /iclock/registry` or `POST /iclock/push` (the `FLOW`
   line changes to `registry` / `push without registry`), and whether it sends a `cookie:` header.
4. Did it upload its history again? (`UPLOAD table=ATTLOG Stamp=…` lines; compare the `from … to …`
   dates with the first capture.)

| Question | Answer |
|---|---|
| FLOW line(s) | |
| Poll interval after 5 minutes idle (seconds) | |
| registry or push requests seen? | |
| Cookie header present? | |
| History sent again? Which Stamp / OpStamp values did the device send? | |

### (i) What does `DATA UPDATE userauthorize` return on a T&A PUSH device?

1. Queue `user` pin 9001, name `ZK Test`, window `none`. Note the Return code.
2. Queue `userauthorize` pin 9001 (tz 1, door 1, no window). Note the Return code.
3. Queue `delete-userauthorize` pin 9001. Note the Return code.
4. Queue `userinfo` pin 9001, name `ZK Test`, window `none` (the attendance form). Note the Return
   code, and whether an `UPLOAD table=OPERLOG` with a `USER` line for 9001 follows.
5. Queue `query-user` pin 9001 and `query-userinfo` pin 9001. Note the Return codes and where the
   answer arrives (`QUERYDATA …` line, or `UPLOAD table=OPERLOG` with a 9001 line).

| Command | Return | Upload that followed (table, record type) |
|---|---|---|
| `user` | -1004 (`CMD=DATA`) | none |
| `userauthorize` | not run (2026-11-14) | |
| `delete-userauthorize` | not run (2026-11-14) | |
| `userinfo` | 0 (`CMD=DATA`); DEVICE INFO users 344 → 345 | none on its own |
| `query-user` | -1004 (`CMD=DATA`) | none |
| `query-userinfo` | 0 (`CMD=DATA`) | `UPLOAD table=OPERLOG`, one `USER` line for 9001 (before the RESULT line); no `QUERYDATA` |

Run 2026-11-14, SpeedFace-V5L ZAM180-NF50VA-Ver3.4.9, Push 2.0.33S, T&A PUSH, capture server `--style auto
--stamps 9999 --test-pin 9001` (capture `captures/20261114-123238.txt`, gitignored). Extra commands in the same run:

| Command | Return | Upload that followed (table, record type) |
|---|---|---|
| `INFO` | 0 (`CMD=INFO`) | none |
| `CHECK` | 0 (`CMD=CHECK`) | device fetched `GET cdata` options again |
| `count-user` (`DATA COUNT user`) | -1002 (`CMD=DATA`), twice | none |
| backend form (`raw`): `DATA UPDATE USERINFO PIN= Name= Pri=0 Passwd= Card= Grp=1 StartDatetime=0 EndDatetime=0` | 0 (`CMD=DATA`) | none on its own; read back with `query-userinfo`: stored, but `Verify=-1` (the `userinfo` form with `Verify=0` stored 0) |
| `delete-user` | -1004 (`CMD=DATA`) | none |
| `delete-userinfo` | 0 (`CMD=DATA`); DEVICE INFO users 345 → 344 (baseline) | none; `query-userinfo` after it returned no `USER` line |

Findings: this firmware takes only the USERINFO forms (update, delete, query); the security forms return -1004 and
`DATA COUNT` -1002. The device echoes only `CMD=DATA` for every `DATA …` command, so results match on the command id
only. Reads arrive as `OPERLOG USER` uploads. Writes produce no `OPERLOG USER` line on their own. Clean-up: 9001 gone,
DEVICE INFO 344 users / 434 fingerprints, equal to the baseline; device restored to GymsEra, stamps left at 9999.

### (j) Does an end time stop the test person, and in which format?

The device's own `USER` lines carry `StartDatetime=0⇥EndDatetime=0`, so the attendance form has a
validity window. Its format is unknown: try `seconds` first, then `datetime`
(`2026-11-11 16:00:00`, the form `ATTLOG` uses), then `yyyymmdd`. Check the device clock first
(section 2). After each command, queue `query-userinfo` pin 9001 and copy the `StartDatetime` /
`EndDatetime` the device reports back: that shows which format it stored.

1. **j1, already expired:** queue `userinfo` pin 9001, window `set`, start `-2d`, end `-1d`,
   datefmt `seconds`. The test person scans. Refused? Screen message?
2. **j2, near future:** queue `userinfo` pin 9001, window `set`, start `now`, end `+3m`. Scan within
   3 minutes, then again after 4 minutes.
3. Repeat j1 and j2 with datefmt `datetime`, then `yyyymmdd` (with `yyyymmdd` use whole days:
   end `-1d` expired, end `+1d` valid).
4. Repeat j1 with the security form: `user` pin 9001, window `set`, start `-2d`, end `-1d`.
5. Afterwards: `userinfo` pin 9001 with window `zero`, so the test person has no limit again.

| Test | Format | Return | Stored value (query) | Before end: entered? | After end: entered? Screen message |
|---|---|---|---|---|---|
| j1 userinfo expired | seconds | | | n/a | |
| j2 userinfo +3m | seconds | | | | |
| j1 userinfo expired | datetime | | | n/a | |
| j2 userinfo +3m | datetime | | | | |
| j1 userinfo expired | yyyymmdd | | | n/a | |
| j2 userinfo +1d | yyyymmdd | | | | |
| j1 user expired | seconds | | | n/a | |

### (k) Do uploads arrive as `tabledata` or inside `OPERLOG`?

1. On the device, enrol a fingerprint for user 9001, then a face (Main Menu › User Mgt. › 9001 ›
   Edit). Change the name of 9001 on the device.
2. Watch the Terminal: `UPLOAD table=OPERLOG records=… {"USER":…,"FP":…,"FACE":…}` or
   `UPLOAD table=BIODATA …` (attendance form), or `UPLOAD tablename=user / biodata …` (tabledata,
   security form). Lines for PIN 9001 are shown in full, with templates and photos cut to 40
   characters.
3. Enrol or take a profile photo if the device offers it, and note how it arrives (`USERPIC`,
   `BIOPHOTO`, `table=ATTPHOTO`).

| Action | Table and record type that arrived | Fields (copy the 9001 line) |
|---|---|---|
| Fingerprint enrolled | | |
| Face enrolled | | |
| Name changed | | |
| Photo | | |

### (l) Punch records (`ATTLOG`)

1. The test person punches with a **face**, then with a **fingerprint** (and a card, if they have
   one). Each punch shows `SCAN (ATTLOG) pin=9001 time=… status=… verify=…`.
2. **Two punches in the same second:** punch face and fingerprint as close together as you can,
   or twice quickly with the same finger. A `SAME SECOND (ATTLOG)` line appears when two records
   share PIN and second. Note whether the device keeps both or refuses the second ("already
   punched", "duplicate").
3. Copy the `ATTLOG` line for each punch from the capture file (PIN 9001 only).

| Punch | verify | status | columns | ATTLOG line (9001) |
|---|---|---|---|---|
| Face | | | | |
| Fingerprint | | | | |
| Card | | | | |
| Two in one second | | | | |

Result (h) to (l): ______________________

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

On a T&A PUSH device also queue `delete-userinfo` pin 9001 if `delete-user` did not return 0, and
compare the next `DEVICE INFO` line (or `UserCount` / `FPCount` / `FaceCount`) with the one from
section 2. 9001 must be gone before the device goes back to GymBioSync.

INFO line after: ______________________ (equal to before, apart from the punch count? ____)

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

## 9b. Device currently serves GymBioSync: how to restore

GymBioSync runs as a Windows service on the gym's PC (`GymBioSyncService`, with the GymBioSync UI).
While the device points at the Mac, GymBioSync gets nothing: no punches, and the members it adds or
removes stay queued on the PC.

**Before you start**
1. Photograph the device's Cloud Server Setting screen (server address = the PC's IP, port,
   domain name, HTTPS, proxy). You type it back from this photo.
2. On the PC, check the GymBioSync UI shows the device online, and note the PC's IP and port.
   Don't stop or uninstall the service.
3. Note the time. Pick a quiet hour, and tell the gym that scans during the test won't show in
   GymBioSync until it is restored.

**Restore**
1. Finish section 8: PIN 9001 deleted (user, fingerprints, face), counts back to the baseline.
   GymBioSync doesn't know PIN 9001; don't leave it on the device.
2. Type back every Cloud Server field from the photo and save. Don't touch Device Type.
3. On the PC, wait for the GymBioSync UI to show the device online (it answers `cdata` and the
   device polls again). If it doesn't within 2 minutes, restart the device from its menu (not the
   service).
4. Make a test punch with an existing person who agrees, and check it appears in GymBioSync.
5. **Punches made during the test.** Our capture server answered every `ATTLOG` upload with `OK`,
   so the device may treat them as delivered and not send them to GymBioSync. GymBioSync asks for
   everything again (`ATTLOGStamp=0`), so they may come back on their own. Check GymBioSync for
   punches between the start and end times of the test: present ______, missing ______. If they are
   missing, tell the gym which time window to fix by hand, and tell the agent.
6. Members GymBioSync added or removed during the test: check one change in GymBioSync arrived on
   the device after the restore.
7. **Stamps.** GymBioSync answers stamp 0, so it gets everything again. If the device goes to **GymsEra** next instead,
   it still holds the capture server's stamp (9999 by default) and sends GymsEra only part of its users: use
   **Read all users again** on its import page (runbook `devices.md`), or end this session with `--stamps 0`.

GymBioSync back online? ______ Test punch seen? ______ Punches during the test present in GymBioSync? ______

---

## 10. What to send back

- Every file in `gymsera_be/captures/` from today. On an Access Control PUSH device they hold the
  test person's name and the first 40 characters of templates and photos, never a full template
  or photo. **On a T&A PUSH device they also hold every member's PIN and name and the gym's punch
  history** (section 0). Send them only through the private channel, never anywhere public.
- This checklist with the results filled in.
- Photos of the Cloud Server screen (before, and with each option you tried).

The agent then records the answers in the spec (§15 Phase 0, and decisions D-1 to D-3 in §16),
saves sanitized samples as test fixtures, and starts Phase 1.
