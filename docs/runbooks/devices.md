# ZKTeco access devices: sync engine, jobs and alerts (Phase 2)

Spec: `docs/ZKTECO_PUSH_DEVICE_SYNC.md` (§7, §8, §14; §15 "Phase 2 as built"). Phase 0 device results are
not in yet: every open point is a `DEVICE_*` setting (`.env.example`, `src/config/devices.config.js`).

## What runs where

| Path | What it does |
|---|---|
| Real time (in the request) | A membership change (created, activated, payment verified, renewed, frozen, cancelled, expired by the cron, branch changed), a new member, a staff device-access change, consent given or withdrawn, a member deleted: an outbox row (`capacity_outbox`, `event_type = 'DEVICE_RECONCILE'`) in the same transaction, processed right after commit in the background. Only queue rows are written; the request never waits for a device and never fails because of one. A tenant without devices writes nothing. |
| `device-watchdog` (every minute) | Commands sent with no answer for 60 s go back to the queue with 30 s, 2 min, 10 min, 1 h backoff, then `failed`; queued commands past `expires_at` expire; devices silent for 10 minutes are marked offline and the owner gets one notification per incident; platform alerts below. |
| `device-sync` (every 5 minutes) | Each device's full desired-state sweep when its last one is 15 minutes old, or when a local midnight of its branch has passed since (so expired members are removed within 5 minutes of midnight, branch time). Failed pairs are retried after 1 hour, 3 times a day. Outbox rows a crash left behind. |
| `device-audit` (hourly) | Once a local day per device, from 02:00 branch time plus 0 to 59 minutes by device: `DATA COUNT user` and `DATA QUERY user`. The answer comes back in packs; extras are removed, PINs of no member are listed as unlinked (never removed on their own), missing members are sent again. Report in `device_audits`. |
| `device-retention` (daily, 03:30) | Templates and photos waiting for consent for 7 days (deleted here and on the device that enrolled them); members whose last package ended 90 days ago (D-4); retired PINs held 180 days; `device_state` history after 7 days; processed device outbox rows after 7 days. |

Deletion of a member and withdrawal of consent act at once (not through the retention job).

## Before the first device stores biometric data

1. Tenant migration **023** before the code (`node src/scripts/run-tenant-migrations.js --dry-run`, read it, then
   without the flag). It adds tables only, plus `device_commands.batch_id`, three columns on `access_device_details`
   and `gym_staff.device_access` (default 0). A fresh tenant then has 43 tables.
2. `BIOMETRIC_DATA_KEY` in the API `.env`: `1:<64 hex>` (generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
   A different key per environment, never in git. Without it a template upload fails (the device is answered
   `OK`, nothing is stored, the log says `BIOMETRIC_DATA_KEY is not set`). Rotation: [secrets-rotation.md](secrets-rotation.md) section 3c.
3. The four tasks below (or `SCHEDULED_JOBS` left in-process for a local server).

## Task Scheduler

From the API folder, as the account the other GymsEra tasks use ([scheduled-jobs.md](scheduled-jobs.md)):

```
schtasks /Create /TN "GymsEra\device-watchdog" /SC MINUTE /MO 1 /RU "<service account>" /RP * ^
  /TR "cmd /c cd /d C:\inetpub\gymsera_be && node src\scripts\run-scheduled-job.js device-watchdog >> logs\scheduled-devices.log 2>&1"
schtasks /Create /TN "GymsEra\device-sync" /SC MINUTE /MO 5 /RU "<service account>" /RP * ^
  /TR "cmd /c cd /d C:\inetpub\gymsera_be && node src\scripts\run-scheduled-job.js device-sync >> logs\scheduled-devices.log 2>&1"
schtasks /Create /TN "GymsEra\device-audit" /SC HOURLY /MO 1 /ST 00:07 /RU "<service account>" /RP * ^
  /TR "cmd /c cd /d C:\inetpub\gymsera_be && node src\scripts\run-scheduled-job.js device-audit >> logs\scheduled-devices.log 2>&1"
schtasks /Create /TN "GymsEra\device-retention" /SC DAILY /ST 03:30 /RU "<service account>" /RP * ^
  /TR "cmd /c cd /d C:\inetpub\gymsera_be && node src\scripts\run-scheduled-job.js device-retention >> logs\scheduled-devices.log 2>&1"
```

"Do not start a new instance" if one is still running. Each job also takes its own MySQL lock, so an overlap is
skipped. Each prints `[ScheduledJob] device-… : {counts}` and `finished in N ms`, exit 0.

## Where to look

| Table (tenant database) | What |
|---|---|
| `device_member_sync` | per device and member: `desired`, `state` (`in_sync`, `pending_add`, `pending_update`, `pending_remove`, `failed`, `removed`), `last_return_code` |
| `device_commands` | the queue: `queued`, `sent`, `acked`, `failed`, `expired`, `superseded`; `return_code` from the device |
| `device_error_logs` | `source = 'server'`: `device_storage_full`, `command_failed`, `no_answer`, `template_version_mismatch`, `command_unsupported`, `denied_but_desired`, `granted_not_desired`, `granted_retired_pin`; `source = 'device'`: the device's own error log |
| `device_access_events` | every scan; `attendance_note` says what happened (`check_in`, `check_out`, `duplicate`, `unlinked_pin`, `retired_pin`, or the refusal code, e.g. `member_checkin_grace_expired`) |
| `device_unlinked_users` | PINs a device knows that are no member (scan, upload or audit) |
| `device_audits` | nightly audit reports |

Never copy `member_biometrics.template_enc` or a photo file anywhere; they are encrypted and useless without the key, and
personal data with it.

## DEVICE_STORAGE_FULL

**What it means**
At least one device answered `-18`, `-3` or `-604` in the last hour: it has no room for more users, templates or photos.
New members are not added to it (their pair is `failed`); members already on it still work. The alert lists the device ids.

**First checks**
1. `SELECT device_id, COUNT(*) FROM device_error_logs WHERE kind = 'device_storage_full' AND created_at > NOW() - INTERVAL 1 DAY GROUP BY device_id;` in the tenant database.
2. On the device page: user and face counts against `MaxUserCount` (`access_device_details.counts_json`, `capabilities_json`).
3. Unlinked users and old hand-added users take space: `device_unlinked_users` for that device.

**Rollback**
Nothing to roll back. Free space on the device (delete unlinked users, or move members to a second device on the same
branch); the sweep retries failed pairs after an hour, 3 times a day.

## DEVICE_GRANTED_NOT_DESIRED

**What it means**
A device opened the door for someone GymsEra does not admit (expired, cancelled, deleted, PIN retired), in the last hour
(safety layer 4, spec §7.4). Each one was removed from that device at once (priority 0). Usually the device missed a
removal (offline, a command failed) or someone added the person on the device menu.

**First checks**
1. `SELECT * FROM device_error_logs WHERE kind IN ('granted_not_desired', 'granted_retired_pin') ORDER BY id DESC LIMIT 20;` and the matching `device_access_events` rows.
2. Is the device getting its commands? `device_commands` for it with `status = 'sent'` older than a minute, or `failed`.
3. Does the device keep `EndTime`? On firmware that ignores it (Phase 0 point e) only the sync removes people.

**Rollback**
Nothing to roll back: the removal is already queued. If the same person keeps getting in, disable the device
(`PATCH /host/devices/:id` `enabled: false`) and check its door wiring and menu users on site.

## Common situations

- **A member is not on the device**: `device_member_sync` row for (device, member). No row: GymsEra does not admit them at that
  branch (no ACTIVE package that started and covers the branch, a visit-limited package used up, a suspended account) or
  the branch is locked past the check-in grace (D-5: no adds). `failed`: see `last_return_code` (§8.1 table in the spec).
- **Device offline**: the owner got one notification. Commands wait in the queue and are delivered when it polls again.
- **"Enrol on the device menu with PIN …"**: the device answered `-708` to `ENROLL_BIO`; enrol there with the PIN shown.
- **Unlinked users**: link or delete them on the device (CMS screen in Phase 3). They are never made members automatically.

## Pre-release check: 50-device load test

Before a release that touches the device engine, run on a developer machine with the local MySQL:

```
npm run test:zk-load
```

It runs `tests/integration/zkteco-p2-load.test.js` with the strict timing limits (slowest poll under 2000 ms,
95th percentile under 1000 ms). Normal CI runs the same test with the same correctness checks but generous timing
limits (`ZK_LOAD_MAX_MS=10000`, `ZK_LOAD_P95_MS=5000` in `.github/workflows/ci.yml`), so a few ms of runner noise
does not fail the build. If this check fails locally, treat it as a real slowdown: find the slow poll in the
`[zkteco-p2-load]` log line before releasing, do not raise the limits.

## Phase 3: manual push, wipe, owner alerts, capture photos

- **Push now does not land in 15 s.** The CMS says "No answer in 15 seconds"; the commands stay queued. Check the
  device page: Online? Last seen? If offline, the change lands when it reconnects. `device_push_requests` holds every
  request (`result_json` once it ended); the tenant audit log has `devices.push` and `devices.push_result`.
- **A second press does nothing new.** By design: the same person pushing the same member inside 10 s (a branch or
  a device inside `DEVICE_PUSH_BRANCH_WINDOW_SECONDS`, 60) gets the first request back.
- **A device stuck on "Wiping".** It deletes its users the next time it connects; the watchdog removes it anyway
  after `DEVICE_WIPE_WAIT_DAYS` (7). If it never comes back, delete the users on the device menu.
- **Owner alerts** (`device_offline`, `device_error_rate`, `device_capacity` notifications) go to the tenant owner,
  once per incident, only for branches whose Device settings keep "Send device alerts" on. The threshold for errors
  is `DEVICE_ALERT_ERRORS_PER_HOUR` (20).
- **Capture photos (D-6)** are stored only for a branch with "Keep capture photos" on, under
  `device-captures/<tenant>/<branch>/` in the private store (encrypted with `BIOMETRIC_DATA_KEY`), deleted after
  30 days by `device-retention`, and at once when the branch turns the switch off.
- **First sync slow, or many -27 after enabling batching.** `DEVICE_BIO_BATCH_SIZE=1` sends one member per biodata
  command (Phase 0 confirms multi-member biodata on the real firmware).

## Phase 4: leaving GymBioSync, token enforce, move, hardening

### Leaving GymBioSync without a gap (per device)

GymBioSync puts the old system's customer number on the device as the PIN, with no end date. Those numbers can
equal a GymsEra PIN of somebody else, so the device must be **imported before GymsEra manages it**.

1. CMS › Access devices › Add device, tick **"This device already has members on it from GymBioSync"** (or, for a
   device already added: device page › Import from device). The device is now in **import hold**: it keeps its
   users exactly as GymBioSync left them and gets only read commands (DATA QUERY / COUNT / INFO / CHECK).
2. Type the GymsEra server address on the device (setup card). It connects; GymBioSync stops reaching it.
3. Import page › **Start import**. Users and templates arrive in 1 to 3 minutes (status "Ready to match").
4. Match: upload a CSV (`pin` plus `member_id`, `email` or `phone`; export it from the old system), then fix the
   rest one by one. Every red line ("This PIN belongs to another GymsEra member") needs **Remove** (deleted from
   the device at go-live; the member, if matched, gets a new PIN and keeps the face) or a different match.
5. **Apply**. Nothing changes on the device. Wrong? **Roll back** (only before go-live) and match again.
6. Cut-over page: check the counts. Record consent for members listed under "Biometric consent" (their faces stay
   on this device only, 7 days after go-live). **Go live**. The audit right after removes matched members with no
   active package and lists unmatched device users under Unlinked users.
7. "Verified" turns done when the device has confirmed the members and the audit finished. Stop the GymBioSync
   Windows service on the gym PC, then press **GymBioSync is stopped**.

An import whose answers never arrive fails after `DEVICE_IMPORT_QUERY_HOURS` (2); a ready import untouched for
7 days is cancelled by `device-retention` (the device **stays** in hold: start again). Staging templates are
emptied when the import is applied, rolled back, cancelled or fails.

### Token enforce (from log)

`DEVICE_TOKEN_MODE` only sets the mode of devices added after the change. Existing devices:

1. `node src/scripts/device-token-mode.js --to enforce` (dry run). It lists devices that would switch (sent a
   matching token and were seen within `DEVICE_TOKEN_SEEN_HOURS`) and skips the rest with a reason
   (`token_absent`, `token_mismatch`, `token_unknown`, `not_seen_recently`, `not_active`).
2. Same with `--apply` (optionally `--tenant <id>` / `--device <id>`).
3. Watch the device page (Status, last seen) for 10 minutes. A device that goes offline: `--to log --device <id> --apply`.

cdata GET, registry and push never need the token (the device learns its SessionID from push); everything else
without the right token answers 401 and is not stored. Set `DEVICE_TOKEN_MODE=enforce` for new devices only after
Phase 0 (c) confirmed the formula on the real firmware.

### Key rotation drill (`BIOMETRIC_DATA_KEY`, twice a year and before go-live)

On a staging copy (never production data in a test): enrol two test templates, then follow
`secrets-rotation.md` section 3c with a new key version: dry run (0 unreadable), `--apply`, dry run again
(0 on an older key), remove the old key, restart, Push now a test member and check the device holds the face.
**Finish or cancel every import first**: staging templates (`device_import_templates`) are not rewritten by the
script. Record the date and the result in spec §13.

### Backup and restore of biometric tables

- Templates live only in tenant tables `member_biometrics` and `device_import_templates` (AES-256-GCM); photos in
  the private store under `biometrics/<tenant>/…` and `device-captures/<tenant>/…`. A tenant dump contains them
  encrypted: it is useless without `BIOMETRIC_DATA_KEY`, and the key must **never** be stored with the dump.
- Keep every key version that encrypted data in a backup still kept (the rotation's old entry goes to the password
  manager, not away).
- After a restore: run `node src/scripts/rotate-biometric-key.js` (dry run) — every tenant must show 0 unreadable.
  Then Sync now on each device (the devices still hold what they had; the reconcile fixes the difference) and a
  Full audit.
- A member who withdrew consent or was deleted after the backup was taken must be deleted again after a restore
  (check `audit_logs` for `biometrics.*` and `devices.*` actions since the backup time).

### Rate limits, sizes, alerts

Per device and per iisnode process: `DEVICE_RATE_PER_SECOND` (2) and `DEVICE_RATE_BURST` (20); over it the device
gets 429 and retries after ErrorDelay. An unknown serial or key is answered from memory for
`DEVICE_UNCLAIMED_RATE_SECONDS` (10). registry, push, getrequest, devicecmd and ping take at most
`DEVICE_MAX_SMALL_BODY` (64 KB); uploads 10 MB. Add a Cloudflare rate rule on the push host as the outer limit.
New owner alert: **"Access device key used by another device"** (`device_serial_mismatch`, once per incident):
re-pair the device unless it was just replaced. Capacity (90%) now counts users GymsEra did not put there.

### Move a device

Device page › Manage › Move to another branch (devices.manage at both branches). The old branch's members are
removed at once (no exit grace), the new branch's sent. Not possible during an import or a wipe.

## Phase 5: T&A PUSH (attendance protocol) devices

A device whose Cloud Server menu says **Device Type: T&A PUSH** (the first real SpeedFace-V5L, ZAM180 Ver3.4.9) is
supported as well as Access Control PUSH (spec §15 "Phase 5 as built", D-9). What is different for support:

- **Connecting.** It never registers: the first `GET /iclock/cdata?…DeviceType=att` from its key (or serial, when serial
  pairing is on) activates it. The device page shows **Device type: T&A PUSH (attendance)**. A device that stays
  "Waiting for the device" has the wrong key or serial: check Unclaimed contacts as before.
- **First contact uploads everything** (users with names, fingerprints, faces, months of punches) for a few minutes
  without polling: commands wait until it is done. Old punches are stored as **history** (live feed: "From the device
  history … not counted"), never as visits. Users it uploads go to **Unlinked users**, unless it was added with
  "already has members from GymBioSync": then they fill the import (Import from device opens by itself).
- **What it is sent** (until the device test settles the defaults): no `userauthorize`, no end date on the device
  (`StartTime=0 EndTime=0`), members as `DATA UPDATE user`. So an expired member is removed by the real-time triggers or
  the 15-minute sweep **while the device is online**; an offline T&A PUSH device keeps admitting them until it reconnects.
  Per device: `PATCH /host/devices/:id {"attOptions": {"userAuthorize": true|false|null, "validityMode": "none"|"datetime"|"seconds"|null, "userCommandForm": "user"|"userinfo"|null}}` (null = default).
- **Polling.** It polls every `Delay` seconds of our answer (`DEVICE_REQUEST_DELAY`, or the device's `pollDelaySeconds`, 1 to 5).
  "Polls every" on the device page is the last measured gap. If it drifts to 30 s: power-cycle the device first; then try
  `DEVICE_ATT_DELAY_FIELDS=Delay,RequestDelay`, then `DEVICE_ATT_SET_OPTION_DELAY=true`.
- **Token.** It sends no Cookie: it stays in log mode. `device-token-mode.js --to enforce` lists it as `att_device` and
  never switches it.
- **Time zone.** Punches older than activation minus `DEVICE_HISTORY_SKEW_MINUTES` (10) are history. A device whose own
  time zone differs from the branch's makes live punches look old: set the device's time zone to the branch's.

Settings (all optional): `DEVICE_ATT_DELAY_FIELDS`, `DEVICE_ATT_SET_OPTION_DELAY`, `DEVICE_ATT_STAMPS`,
`DEVICE_ATT_USERAUTHORIZE`, `DEVICE_ATT_VALIDITY`, `DEVICE_ATT_USER_FORM`, `DEVICE_HISTORY_SKEW_MINUTES` (`.env.example`).
Migrations before the code: platform `p030_access_devices_att`, tenant `026_device_att_options`.
