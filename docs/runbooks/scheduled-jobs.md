# Scheduled jobs on the IIS host (P7c item 9, NEW-178)

## Why

The API runs under **iisnode**. IIS starts the Node process on the first request and stops it with
the application pool: after the **idle time-out** (20 minutes by default) and on **recycling**
(every 1,740 minutes by default, plus config changes). Two jobs were `node-cron` schedules inside
that process (`server.js`):

| Job | When | What |
|---|---|---|
| `daily` | 01:00 | billing inbox retry, store re-check, plan expiry, capacity pass, branch billing locks, member expiry, provisioning and deletion sweeps |
| `billing-inbox` | every minute | retry billing webhook events that failed, billing alerts |

On a quiet night nothing calls the API before 01:00, the process is not running, and the
daily job does not run (expiries, locks and store re-checks are a day late or more).

## Fix (recommended): Windows Task Scheduler

The same jobs run from a local command (not an HTTP route, so only someone on the server can
start it). Both paths use the same database locks (REL-03), so an overlap is skipped, not doubled.

1. Deploy this backend build.
2. In the API's `.env`, set `SCHEDULED_JOBS=external` and restart (`iisreset`). The boot log
   then says `SCHEDULED_JOBS=external: the daily job and the billing inbox retry run from Task Scheduler`.
3. Try both once by hand, from the API folder (the one with `.env`), as the account the tasks will use:
   ```
   node src\scripts\run-scheduled-job.js billing-inbox
   node src\scripts\run-scheduled-job.js daily
   ```
   Each prints `[ScheduledJob] <name> finished in N ms` and exits 0. Exit 1 = it failed (the reason is printed).
4. Create the two tasks (an elevated Command Prompt; change the folder and the account):
   ```
   schtasks /Create /TN "GymsEra\daily" /SC DAILY /ST 01:00 /RU "<service account>" /RP * ^
     /TR "cmd /c cd /d C:\inetpub\gymsera_be && node src\scripts\run-scheduled-job.js daily >> logs\scheduled-daily.log 2>&1"
   schtasks /Create /TN "GymsEra\billing-inbox" /SC MINUTE /MO 1 /RU "<service account>" /RP * ^
     /TR "cmd /c cd /d C:\inetpub\gymsera_be && node src\scripts\run-scheduled-job.js billing-inbox >> logs\scheduled-inbox.log 2>&1"
   ```
   In the task's settings: "Run whether user is logged on or not", "Do not start a new instance" if
   one is still running. The account needs read access to the API folder and its `.env`, and write
   access to `logs\`.
5. Check the next morning: Task Scheduler "Last Run Result" is `0x0`, and `logs\scheduled-daily.log`
   has the `finished` line.

Rollback: delete the two tasks and remove `SCHEDULED_JOBS` (or set `in-process`), then `iisreset`.

## Also (optional): keep the API process alive

Useful for the first request after a quiet period and for Socket.IO, but not a replacement for
Task Scheduler (a recycle still stops the process for a moment):

- Application pool → Advanced Settings: **Start Mode** `AlwaysRunning`, **Idle Time-out** `0`,
  **Regular Time Interval** (recycling) `0`, or a fixed **Specific Time** away from 01:00.
- Site → Advanced Settings: **Preload Enabled** `True` (needs the IIS *Application Initialization* feature).
  Do not add an `<applicationInitialization>` block to `web.config` unless that feature is installed:
  IIS answers 500.19 for the whole site otherwise.

```
%windir%\system32\inetsrv\appcmd set apppool "<pool>" /startMode:AlwaysRunning /processModel.idleTimeout:00:00:00 /recycling.periodicRestart.time:00:00:00
%windir%\system32\inetsrv\appcmd set site "<site>" /applicationDefaults.preloadEnabled:true
```
