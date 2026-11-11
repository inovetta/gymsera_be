# ZKTeco access devices: security review checklist

For every change to the device code (`src/routes/device-push.routes.js`, `src/services/devices/*`,
`src/jobs/device-jobs.js`, the host device routes) and before each device release. Spec:
`docs/ZKTECO_PUSH_DEVICE_SYNC.md` §4, §5, §13, §14. Tick each line with the test or file that proves it.

## Who is calling
- [ ] No auto-join: an unknown key or serial gets OK on cdata and 406 on registry, is recorded (capped, 7 days) and
      is answered from memory for `DEVICE_UNCLAIMED_RATE_SECONDS` (`zkteco-p1-device-router`, `zkteco-p4-hardening`).
- [ ] A key with another serial gets 406, is recorded, and the owner is alerted once (`device_serial_mismatch`).
- [ ] Token: log by default; enforce only through `src/scripts/device-token-mode.js` after a matching token; cdata
      GET, registry and push exempt; a refused request stores nothing.
- [ ] Proxy headers (`X-Original-Host`, `CF-Connecting-IP`, `X-Forwarded-For`) are used for display and key lookup
      only, never to grant anything (iisnode named pipe, Phase 1 correction 1).
- [ ] HTTPS required when `DEVICE_ALLOW_HTTP=false`.

## Tenant isolation
- [ ] A device row resolves to exactly one tenant; every command query filters by `device_id`.
- [ ] Two tenants' devices on one process never see each other's members (`zkteco-p1-device-router`, `zkteco-p4-push-load`).
- [ ] Host routes: `tenantContext.forTeamRoutes` + `can(...)` at the device's branch; another tenant gets 404; platform
      admins read only (`devices_read_only_for_platform_admins`); persona tests for every route (`zkteco-p*-permissions`).
- [ ] Move needs devices.manage at both branches.

## Biometric data
- [ ] Stored only with consent; without it, kept on the enrolling device only for 7 days (from go-live for an import).
- [ ] AES-256-GCM at rest (`member_biometrics`, `device_import_templates`, photo files); key versions; rotation tested.
- [ ] Never in a JSON response (`templatesOf` returns ids and slots only), never in a log line
      (`src/utils/log-redaction.js` rules; `zkteco-p4-hardening` greps the redacted output), never in `args_json`.
- [ ] Imported templates are held until go-live and reach no device before; rollback deletes them.
- [ ] Deletion: one template, withdrawal, member deletion and retention reach every device (planCommands deletes a type
      before sending fewer of it).

## Device safety
- [ ] Nothing is deleted on a device in import hold (claim filter `READ_ONLY_KINDS`; wipe, audit, link and push refused).
- [ ] Device admins (privilege > 0) found on a device are never imported or removed; GymsEra sends privilege 0 only.
- [ ] PINs never shared: imported PINs kept; the sequence moves past every device PIN; retired PINs held 180 days.
- [ ] Exits never depend on GymsEra (physical exit button, fire release) — in the setup guide.

## Abuse and load
- [ ] Per-device rate limit (429, nothing stored), small-body cap (413), uploads 10 MB, Cloudflare rule on the push host.
- [ ] Replays change nothing: devicecmd results for a command not `sent`, rtlog by index, query packs by (cmd, pack).
- [ ] `getrequest` stays two indexed queries when idle; load tests pass (`npm run test:zk-load`, `npm run test:zk-push-load`).
- [ ] SQL: fixed statements only (SEC-16 guard); dates through `sql-time#utc` (NEW-237).

## Operations
- [ ] Owner alerts: offline, error rate, capacity 90% (counts all device users), serial mismatch; branch switch respected.
- [ ] Runbook `docs/runbooks/devices.md` matches the code (settings, jobs, cut-over, token enforce, backup/restore).
