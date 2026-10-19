# Slow queries and the weekly index review (OBS-04)

A procedure, not an alert: there is no alert code here. The goal is spec §12.12 OBS-04: slow queries
(over 200 ms) are logged in staging and production, and someone looks at the indexes every week.

**Status:** the MySQL settings live on the database server, outside this repository, so OBS-04 stays
`NEEDS RUNTIME CHECK` until the owner has done section 1 and ticked the checklist in section 4.
Every SQL statement below was run against MySQL 5.7.44 (the production version, spec R-20) before it
was written down. On 8.0 they work too; the only difference noted is `SET PERSIST`.

The database names this repository uses: the platform database `gymsera_platform` (or whatever
`PLATFORM_DB_NAME` says) and one database per gym named `gymsera_gym_XXXXXXXX`. The queries filter on
`LIKE 'gymsera%'`, which covers both. Adjust it if your names differ.

## 1. Switch on MySQL's slow query log (the main tool)

**Right now, without a restart** (needs the `SUPER` privilege, or `SYSTEM_VARIABLES_ADMIN` on 8.0):

```sql
SET GLOBAL slow_query_log = 1;
SET GLOBAL long_query_time = 0.2;      -- seconds: 0.2 = 200 ms
```

A global `long_query_time` applies to **new connections only**. The API keeps its pools open, so
restart the API (or wait for idle connections to recycle) before judging what the log contains.

**To keep it across a database restart**, put it in the server config (`my.cnf`, `[mysqld]` section):

```ini
slow_query_log      = 1
long_query_time     = 0.2
slow_query_log_file = /var/lib/mysql/slow.log     ; any path the mysql user can write
log_output          = FILE
```

On 8.0 `SET PERSIST slow_query_log = 1;` and `SET PERSIST long_query_time = 0.2;` do the same.
On a managed MySQL (a hosting panel, RDS, and similar) these are options in the provider's parameter
or settings screen, not a file you edit. If the host does not let you change them at all, use section 2.

**Check that it took:**

```sql
SHOW GLOBAL VARIABLES WHERE Variable_name IN ('slow_query_log', 'long_query_time', 'slow_query_log_file', 'log_output');
-- from a NEW connection, to see what new sessions get:
SELECT @@session.long_query_time;
SELECT SLEEP(0.3);                      -- should appear in the log file within a moment
```

**Do not** leave `log_queries_not_using_indexes = 1` on: it logs every small lookup on a small table and
buries the real ones. If you want it for a short investigation, pair it with `min_examined_row_limit = 1000`.

**Reading the file:** `mysqldumpslow -s t -t 20 /var/lib/mysql/slow.log` (shipped with MySQL) lists the 20
statements that cost the most total time. `pt-query-digest` (Percona Toolkit) is better if you have it.

**Privacy, important:** MySQL's slow log contains the real statement text **with its values**: e-mail
addresses, phone numbers, ids, search terms. Treat the file as personal data: restrict it to the mysql user
and the administrators, rotate it (for example weekly with `logrotate`, keep 4 weeks), and do not send it to
a third party or paste it into a ticket. The in-app fallback below never records a value.

**Rollback:** `SET GLOBAL slow_query_log = 0;` (and remove the lines from the config). Nothing else changes.

## 2. The in-app fallback (only if section 1 is impossible)

Set the environment variable on the API server and restart it:

```
SLOW_QUERY_MS=200
```

With it unset, empty, `0`, negative or not a whole number, the feature is completely off: no measuring, no
overhead, nothing logged. With it on, any statement that takes at least that many milliseconds is logged as
one JSON line (see `src/database/slow-query.js`):

```json
{"level":"warn","source":"slow-query","db":"tenant","durationMs":412,"thresholdMs":200,
 "fingerprint":"3fa91c07de","shape":"SELECT * FROM `payments` WHERE `status` = ? AND `created_at` > ? ORDER BY `created_at` DESC LIMIT ?",
 "suppressed":3,"requestId":"…","msg":"slow query"}
```

* **Only the shape and the duration.** Every literal in the statement (strings, numbers, ids, lists, comments)
  is replaced by `?` before anything is logged; the raw SQL is never written. `requestId`, `tenantId` and
  `userId` are added by the logger when the query ran inside a request, and are ids, not personal data.
* **`db`** is `platform` or `tenant`. **`fingerprint`** groups the same shape.
* **At most one line per fingerprint per 10 seconds**; `suppressed` is how many identical slow queries were
  held back since the last line, so an incident cannot flood the log.
* **Find them:** `jq 'select(.source=="slow-query")' app.log`, or count by shape:
  `jq -r 'select(.source=="slow-query") | .fingerprint + " " + .shape' app.log | sort | uniq -c | sort -rn | head`.
* **Covers** the platform connection and the tenant pools, which is every request. It does **not** cover
  migrations or one-off scripts (long DDL is expected there).
* The time includes the round trip to MySQL but not the wait for a free pool connection.
* **Rollback:** unset `SLOW_QUERY_MS` and restart.

## 3. The weekly index review

Once a week (suggested: Monday, after the weekend's traffic). About 20 minutes. Run these on the database
server as a user that can read `performance_schema` and the `sys` schema.

**3.1 What costs the most.** MySQL keeps a summary per statement shape since the last restart:

```sql
SELECT SCHEMA_NAME                               AS db,
       LEFT(DIGEST_TEXT, 200)                    AS query_shape,
       COUNT_STAR                                AS calls,
       ROUND(SUM_TIMER_WAIT / 1e12, 2)           AS total_s,
       ROUND(AVG_TIMER_WAIT / 1e9, 1)            AS avg_ms,
       ROUND(MAX_TIMER_WAIT / 1e9, 1)            AS max_ms,
       SUM_ROWS_EXAMINED                         AS rows_examined,
       SUM_ROWS_SENT                             AS rows_sent,
       SUM_NO_INDEX_USED                         AS no_index_calls
FROM performance_schema.events_statements_summary_by_digest
WHERE SCHEMA_NAME LIKE 'gymsera%'
ORDER BY SUM_TIMER_WAIT DESC
LIMIT 20;
```

Look for a high `total_s` (cheap query run very often, or an expensive one) and for `rows_examined` far above
`rows_sent` (it reads many rows to return few: the classic missing index).

**3.2 What scanned without a usable index:**

```sql
SELECT SCHEMA_NAME AS db, LEFT(DIGEST_TEXT, 200) AS query_shape, COUNT_STAR AS calls,
       ROUND(AVG_TIMER_WAIT / 1e9, 1) AS avg_ms, SUM_ROWS_EXAMINED AS rows_examined,
       SUM_NO_INDEX_USED AS no_index_calls, SUM_NO_GOOD_INDEX_USED AS no_good_index_calls
FROM performance_schema.events_statements_summary_by_digest
WHERE SCHEMA_NAME LIKE 'gymsera%'
  AND (SUM_NO_INDEX_USED > 0 OR SUM_NO_GOOD_INDEX_USED > 0)
  AND DIGEST_TEXT NOT LIKE 'SHOW%' AND DIGEST_TEXT NOT LIKE '%information_schema%'
ORDER BY SUM_ROWS_EXAMINED DESC
LIMIT 20;
```

**3.3 Foreign keys with no index on them** (spec §4.4: every foreign key is indexed). Run it **in each
database** you care about, with its name in place of `gymsera_platform`; an empty result is the good answer:

```sql
SELECT k.TABLE_NAME AS tbl, k.COLUMN_NAME AS fk_column, k.CONSTRAINT_NAME AS fk
FROM information_schema.KEY_COLUMN_USAGE k
WHERE k.TABLE_SCHEMA = 'gymsera_platform'
  AND k.REFERENCED_TABLE_NAME IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS s
                  WHERE s.TABLE_SCHEMA = k.TABLE_SCHEMA AND s.TABLE_NAME = k.TABLE_NAME
                    AND s.COLUMN_NAME = k.COLUMN_NAME AND s.SEQ_IN_INDEX = 1)
ORDER BY k.TABLE_NAME, k.COLUMN_NAME;
```

**3.4 Indexes that cost writes and buy nothing:**

```sql
-- an index another index already covers (safe to drop after you confirm the dominant one is kept)
SELECT table_schema, table_name AS tbl, redundant_index_name, dominant_index_name
FROM sys.schema_redundant_indexes WHERE table_schema LIKE 'gymsera%';

-- an index nothing has read since the server started (see the warning below)
SELECT object_schema, object_name AS tbl, index_name
FROM sys.schema_unused_indexes WHERE object_schema LIKE 'gymsera%'
ORDER BY object_schema, object_name;
```

**Warning on "unused":** it only means "not read since the last restart". After a restart, or in a quiet week,
every index looks unused. Never drop one on a single week's evidence; look at a full month (month-end
reports and billing jobs use indexes that the rest of the month does not). Unique indexes and the ones that
enforce a foreign key stay regardless.

**3.5 Where the data is** (to see which tables will matter first):

```sql
SELECT TABLE_SCHEMA AS db, TABLE_NAME AS tbl, TABLE_ROWS AS approx_rows,
       ROUND((DATA_LENGTH + INDEX_LENGTH) / 1048576, 1) AS size_mb, ROUND(INDEX_LENGTH / 1048576, 1) AS index_mb
FROM information_schema.TABLES WHERE TABLE_SCHEMA LIKE 'gymsera%'
ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC LIMIT 20;
```

**Starting a clean week** (optional; the summaries also reset when MySQL restarts):

```sql
TRUNCATE TABLE performance_schema.events_statements_summary_by_digest;
```

### What to do with a finding

1. `EXPLAIN` the statement shape with realistic values on a copy of the data, not on production.
2. Decide: a missing index (add it), a query that reads too much (change the code), or a table that is simply
   big (note it; revisit at the next review).
3. **An index change is a migration, never a hand-typed `ALTER` on production.** Platform tables: a new
   `pNNN` platform migration. Tenant tables: a new tenant migration. Both have dry-run, conflict-skip and
   re-run tests (see `tests/integration/platform-migrations-p022.test.js` for the shape), and the deploy notes
   carry the backup and rollback lines.
4. Record the decision (below), including "no action" and why.

Suggested record, one line per finding in the team's tracker:
`YYYY-MM-DD · <db>.<table> · <shape or index> · <evidence: calls, avg_ms, rows_examined> · <decision> · <owner>`

## 4. Owner checklist (this is what moves OBS-04 from "needs runtime check" to done)

- [ ] Staging: section 1 applied; `SHOW GLOBAL VARIABLES` shows `slow_query_log=ON`, `long_query_time=0.2`.
- [ ] Production: the same, in the persistent config (or the provider's settings), not only `SET GLOBAL`.
- [ ] The API was restarted after the change, and `SELECT SLEEP(0.3)` from a new connection shows up in the file.
- [ ] The slow log file is readable only by the mysql user and the administrators, and is rotated.
- [ ] If section 1 is impossible on a host: `SLOW_QUERY_MS=200` set there, and one slow-query line seen in its log.
- [ ] The first weekly review done and its findings recorded; a calendar slot exists for the next ones.
