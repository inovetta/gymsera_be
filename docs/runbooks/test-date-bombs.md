# Test date bombs: running the backend suite on a future day (NEW-207)

A test that hard-codes a calendar date for something that must still be current (a membership end date, an
invoice due date) starts failing on the day that date passes: FLOW-09 failed every CI run from 2026-11-01
(NEW-199). Since P10b:

- Tests use `daysFromToday(n)` from `tests/harness/dates.js` for current or future dates.
- `tests/regression/new-207-no-future-calendar-dates.test.js` fails when a test sets `endDate`, `dueDate`,
  `expiresAt`, `validUntil`, `renewsAt` or `currentPeriodEnd` to a literal date that is today or later.
  A literal date in the past is fine: it stays in the past.

## Running the whole suite as if it were another day

Use this before a year change, or when a suite fails only on some days. Local Docker only (R-19).

1. A MySQL 5.7 whose clock is shifted with libfaketime, on its own port (3309):

   ```sh
   # Dockerfile
   FROM --platform=linux/amd64 mysql:5.7-debian
   RUN sed -i 's|deb.debian.org|archive.debian.org|g; s|security.debian.org|archive.debian.org|g; /buster-updates/d' /etc/apt/sources.list \
       && rm -f /etc/apt/sources.list.d/mysql.list \
       && apt-get -o Acquire::Check-Valid-Until=false update && apt-get install -y --no-install-recommends faketime

   docker build -t gymsera-mysql57-faketime .
   docker run -d --name gymsera-test-mysql57-2027 -p 3309:3306 -e MYSQL_ALLOW_EMPTY_PASSWORD=yes \
     -e LD_PRELOAD=/usr/lib/x86_64-linux-gnu/faketime/libfaketimeMT.so.1 \
     -e 'FAKETIME=@2027-01-02 09:00:00' -e FAKETIME_DONT_FAKE_MONOTONIC=1 gymsera-mysql57-faketime
   docker exec gymsera-test-mysql57-2027 mysql -uroot -e 'select now()'   # 2027-01-02 ...
   ```

2. The suite with Node's clock shifted the same way (`tests/harness/fake-now.js`, loaded by `jest.config.js`,
   does nothing unless `TEST_FAKE_NOW` is set; node processes started by tests get the same clock):

   ```sh
   MYSQL_HOST=127.0.0.1 MYSQL_USER=root MYSQL_PASSWORD= \
   PLATFORM_DB_HOST=127.0.0.1 PLATFORM_DB_USER=root PLATFORM_DB_PASS= \
   TENANT_DB_HOST=127.0.0.1 TENANT_DB_USER=root TENANT_DB_PASS= TENANT_DB_ADMIN_USER=root TENANT_DB_ADMIN_PASS= \
   TEST_MYSQL_PORT=3309 DISABLE_REDIS=true TEST_FAKE_NOW=2027-01-02T09:00:00Z \
   caffeinate -i npx jest --runInBand --forceExit --testTimeout=60000 --testPathIgnorePatterns obs-04-slow-query
   ```

## Known artifacts (not date bombs)

- `p10-new177-apple-cert-oids`: its certificates are made with `openssl -days 30` at run time, on the real clock,
  so they look expired to a shifted Node. On the real day both clocks agree.
- `obs-04-slow-query`: `SELECT SLEEP()` hangs in a libfaketime MySQL. Run it with `TEST_FAKE_NOW` against the
  normal test MySQL (3308) instead.

Result on 2026-11-03 for 2027-01-02: 296 / 297 suites, 2781 / 2787 tests; the only failure is the NEW-177
artifact above. OBS-04: 41 / 41 with Node at 2027-01-02 on the normal MySQL.

Remove the container afterwards: `docker rm -f gymsera-test-mysql57-2027`.
