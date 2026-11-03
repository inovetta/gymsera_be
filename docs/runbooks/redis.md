# Redis: what the API does without it (R-88)

**Decision R-88 (owner, 2026-11-03):** production runs **without Redis** while there is one API
instance. Set `DISABLE_REDIS=true` in the API `.env` and leave `REDIS_HOST` / `REDIS_URL` empty.
Install Redis **before** a second API instance (or a second server) is added.

## Why this is safe with one instance

Every Redis use has a fallback that is correct for a single process. Redis only adds *sharing between
processes*; with one process there is nothing to share.

| What | With Redis | Without Redis (production today) | Breaks only when |
|---|---|---|---|
| Job and cron locks (REL-03, `utils/distributed-lock.js`) | `SET NX PX` | MySQL `GET_LOCK` on the platform database | never (MySQL is shared) |
| Tenant connection-string cache (`tenantContext.js`, `iclock.service.js`, `attendance.routes.js`) | 1 h shared cache | read from the platform `tenants` row on each request | never (one more indexed read per tenant request) |
| Permission cache (`access.service.js`), user-org index (`membership.service.js`) | shared, invalidated by key | read from the database each time | never (slower, never stale) |
| Auth status / permission version (`authenticate.js`) | in-process 30 s cache, then Redis | in-process 30 s cache (`user-auth-cache.js`), then the database | two instances: a suspension or role change reaches the other instance within 30 s |
| QR nonce replay guard (`qr.utils.js`) | shared nonce set | in-memory set in the process | two instances: a QR could be replayed once on the other instance |
| Rate limits (`rateLimiters.js`) | (not used) | in process memory | two instances: each has its own budget |
| Discovery snapshot (`discovery-cache.service.js`) | (not used) | in process, 60 s TTL | two instances: a change shows on the other within the TTL |
| Alerts (`alert.service.js`) | (not used) | at most one per code per hour, in process | n/a |

## What you see in the logs

- `DISABLE_REDIS=true` or no `REDIS_HOST` / `REDIS_URL`: the API prints one boot line
  `[Redis] No REDIS_HOST or REDIS_URL configured. Redis caching disabled.`; the scheduled-job CLI
  (`run-scheduled-job.js`, Task Scheduler) prints nothing about Redis (P10 item 4).
- `REDIS_HOST` set but nothing listening (the situation seen on the server before P10): one line
  `[Redis] not reachable at <host:port> (ECONNREFUSED); this process runs without Redis ...`, then the
  process runs exactly as without Redis. Fix: set `DISABLE_REDIS=true` (R-88) or start Redis.

## Before a second API instance

1. Install Redis (Memurai on Windows, or Redis on Linux / WSL), password-protected, bound to the private
   network only; set `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` (or `REDIS_URL`) and remove `DISABLE_REDIS`.
2. Fix **NEW-200** first: `authenticate.js` imports `safeRedisSet`, which `redis.config.js` does not
   export, so the auth cache is never written to Redis (harmless today). Add the write and a test that a
   suspension or role change deletes the key on every instance.
3. Move the rate-limit store and the QR nonce set to Redis, and add the platform-DB version read for the
   discovery snapshot (handoff "Before adding a second API instance").
4. Use one `TENANT_CONN_ENCRYPTION_KEY` for every instance that shares the Redis: the cached connection
   string is encrypted with it.
