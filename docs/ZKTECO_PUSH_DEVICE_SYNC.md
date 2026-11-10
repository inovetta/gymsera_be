# GymsEra × ZKTeco Push Devices: Design Spec

| | |
|---|---|
| Status | Draft for review (owner decisions in §16) |
| Date | 2026-11-10 |
| Applies to | `gymsera_be` (API), `gymsera_cms` (web), `gyms_era` (app) |
| Device protocol | ZKTeco **Security PUSH Communication Protocol**, protocol 3.1.2, doc 4.8 (Jan 2024) |
| Reference code | `GymBiosyncService` (C# Windows service, Push mode, one gym, one device) |
| Public endpoint | `https://push.gymsera.com/...` (recommended) or `https://api.gymsera.com/...` |

> **For the Claude Code agent:** follow Prompt G rules. Read this spec, the existing schema and
> permission system, and `GymBiosyncService` before writing code. Table and route names in this
> document are **proposals**: map them to the real member, membership, branch, attendance and
> permission tables you find, and list every mapping in your first report. Build in the phases
> of §15, one PR per phase. Write the test first, then the fix. Never touch production data.

---

## 1. Goal in one paragraph

A gym owner adds a ZKTeco face, fingerprint, palm or card terminal to a **branch** in the CMS or
the app and marks it as a **check-in** or **check-out** device. GymsEra gives them a server address
with a short unique key. They type it into the device's Cloud Server (ADMS) settings. From then on,
the device talks only to `api.gymsera.com` (no PC, no local service). GymsEra:

1. Saves everything the device reports about itself (model, firmware, capabilities, counts).
2. Keeps the device's user list equal to "members who may enter this branch right now". It adds
   active members with their profile, card and biometric data, and removes members whose fee has
   expired.
3. Sends changes in real time when a member is created, a package is assigned or activated, or a
   payment is verified, frozen, cancelled or expired.
4. Runs three independent backup layers that repair anything the real-time path missed.
5. Records every scan as a check-in or check-out, linked to the member and the branch.
6. Gives staff a **"Push to device"** button (web and app) with a **15-second** result.

---

## 2. How the Push protocol works (what matters for us)

The device is always the client. It opens HTTP requests to our server, and we can only reach it by
answering those requests. There is no inbound connection to the gym's network, which is why this
works through any router or 4G modem.

| Step | Device request | Our response |
|---|---|---|
| Connect | `GET /iclock/cdata?SN=…&options=all&pushver=…` | If the device is known and claimed: `registry=ok`, `RegistryCode=…`, config lines. If not: `OK` (this asks it to register). |
| Register | `POST /iclock/registry?SN=…` body `DeviceType=acc,~DeviceName=…,FirmVer=…,MultiBioDataSupport=…,…` | `RegistryCode=<random, up to 32 chars>`, or **HTTP 406** to refuse |
| Get config | `POST /iclock/push?SN=…` | `ServerVersion`, `ErrorDelay`, `RequestDelay`, `Realtime=1`, `SessionID`, `TimeoutSec`, `MultiBioDataSupport`, `MultiBioPhotoSupport`, … |
| Heartbeat and commands | `GET /iclock/getrequest?SN=…` every `RequestDelay` seconds | `OK` or one or more lines `C:<CmdID>:<command>` (joined with `\n`) |
| Command result | `POST /iclock/devicecmd?SN=…` body `ID=<CmdID>&Return=<code>&CMD=<type>` | `OK`. A return code ≥ 0 means success, < 0 means failure (Appendix 1). |
| Query results | `POST /iclock/querydata?SN=…&cmdid=…&tablename=…&count=…&packcnt=…&packidx=…` | `<tablename>=<count>` |
| Uploads | `POST /iclock/cdata?SN=…&table=rtlog` (scans), `table=rtstate`, `table=options`, `table=tabledata&tablename=user / biodata / templatev10 / userpic / biophoto / errorlog` | `OK`, or `user=N`, `biodata=N`, `userpic=N` |
| Heartbeat during big uploads | `GET/POST /iclock/ping?SN=…` | `OK` |

Facts from the document that shape the design:

- **The device sends its serial number (`SN`) on every request.** It is the only identifier the
  protocol guarantees.
- **The `Date` response header sets the device clock** (GMT format). Every response must carry
  a correct `Date`.
- **Authentication is weak by design.** After registration the device sends `Cookie: token=…`,
  documented as MD5 of `RegistryCode + SerialNumber + SessionID`. I checked the document's own
  example and it does **not** match a plain concatenation, so token checking must start in
  log-only mode and be confirmed on a real device (Phase 0, §15).
- **One response can carry several commands**, and one `DATA UPDATE` can carry several records of
  the same table, separated by `\n` (protocol §9.1.1). The device limits package size (`MaxPackageSize` in
  registration, error `-106` above 4 MB).
- **Users can carry their own validity window.** `DATA UPDATE user … StartTime=… EndTime=…` and
  `DATA UPDATE userauthorize … StartTime … EndTime`. The device then refuses the member after
  `EndTime` **even if it is offline**. We use this as a passive safety layer (§7.4).
- **Access-control (`acc`) devices need an access privilege.** A user without a
  `userauthorize` row (time rule plus door) cannot open the door. `GymBiosyncService` never sends
  `userauthorize`. Phase 0 must confirm whether your SpeedFace firmware needs it (§15).
- **Biometric types** (Appendix 18): 1 fingerprint, 2 near-infrared face, 6 palm print, 7 finger
  vein, 8 palm (vein), **9 visible-light face**, **10 visible-light palm**. Cards go in
  `user.CardNo`.
- **Template versions must match.** A template only works on a device with the same algorithm
  major version (`-30` = "integrated template algorithm's version is inconsistent"). The device
  reports versions in `MultiBioVersion`. For visible-light face, sending the **comparison photo**
  (`DATA UPDATE biophoto … Type=9`) lets any model build its own template. This is our
  cross-model fallback.
- **The device can enrol remotely**: `ENROLL_BIO TYPE=9 NO=0 PIN=… RETRY=3 OVERWRITE=1 MODE=1`
  makes the device prompt the member and upload the result (protocol §9.6.2).
- **Event codes** (Appendix 2): 0–19 and 200–253 are normal events (door opened after
  verification), 20–99 are errors (for example 22 invalid time period, 23 unauthorized access,
  27 not registered, 29 privilege expired), 100–199 are alarms. 4000+ are extended codes
  (Appendix 19).
- **Each access record has a device-unique `index`**, which we use to drop duplicates.

---

## 3. What we keep from GymBioSync and what we change

GymBioSync proves the protocol works with your SpeedFace devices: handshake, `biodata` and
`templatev10` parsing, `DATA UPDATE user / biodata`, `DATA DELETE`, `DATA QUERY`, real-time `rtlog`.
Port the **knowledge**, not the code (it is C# and built for a single site).

**Keep (port to Node with tests):**
- Parsers that accept both tab and space separators, the `biodata` and `biodatapin=` quirk,
  `templatev10`, the three photo formats (`biophoto`, `userpic`, `ATTPHOTO` with `pin=<time>-<pin>.jpg`),
  and the positional `ATTLOG` fallback.
- The command strings that already work on your devices. Note that it uses `Majorver=13` for
  fingerprint and `Majorver=40 Minorver=1` for visible-light face, while the document lists
  other versions. **Always send the version stored with the template** (from the device that
  enrolled it). Never hard-code a version.
- The flow "query the device, compare with the database, add active members, delete the rest"
  (`SendRequestAsync`, `ProcessActiveCustomers`). It becomes the nightly audit in §8.3.

**Must change (each is a real defect for a multi-gym cloud service):**

| GymBioSync behaviour | Why it breaks in GymsEra | New rule |
|---|---|---|
| `RegistryCode` and `SessionID` hard-coded to the document's example values | Every device shares the same "secret" | Random per device, stored, rotatable |
| Any SN that calls in is accepted (`GetOrCreateDevice`) | Any device on the internet could join and receive member data | Only devices claimed by a host (§4) |
| `EnqueueCommand(null, …)` sends to the default device, or to **all** devices | Across tenants this leaks one gym's members to another gym's device | Every command has exactly one `device_id`; there is no broadcast API |
| Queue and caches in memory plus a JSON file | Lost on IIS recycle; iisnode runs several processes | Queue and state in MySQL |
| `devicecmd` results are logged only | Failed adds are never retried | Results drive retry and alerts (§8.1) |
| Full request bodies logged (templates, photos) | Biometric data in log files | Never log bodies; log sizes and counts only |
| Time zone fixed at UTC+5 | Wrong for other regions and for DST | Use the branch's time zone |
| Check-in vs check-out from `inoutstatus` | Depends on device setup | Taken from the device's direction in GymsEra |
| Validity guessed from template length (`< 300`) | Fragile | Validate base64 and the type and version fields |

---

## 4. Linking a device: tenant, branch, direction, key

### 4.1 Hierarchy

```
Tenant (hosting / business account)
 └─ Organization (gym brand)
     └─ Branch
         ├─ Device "Front door IN"   direction = in
         └─ Device "Front door OUT"  direction = out
```

A branch can have any number of devices. A device belongs to exactly one branch. Moving it to
another branch is an explicit "move" that wipes and re-syncs it (§10.3). Supported directions are
`in`, `out` and `both` (one device used for both; record as check-in, or use `inoutstatus` when the
device has IN and OUT keys).

### 4.2 The device key and URL

When a host adds a device, GymsEra creates a **device key**: 8 characters from an unambiguous
alphabet (no 0/O/1/I/L), for example `K7QM-3XRT`, shown with a hyphen and stored without it. The
key is unique across the whole platform and identifies tenant, branch and device without any
lookup by the user.

ZKTeco firmware differs in what the Cloud Server screen accepts, so we support three ways to
present the key. Phase 0 decides which one your models use.

| Mode | What the host types on the device | How the server finds the device | Works on |
|---|---|---|---|
| **A. Path key** (preferred if supported) | Server address `push.gymsera.com/d/K7QM3XRT`, port 443, HTTPS on | URL starts `/d/K7QM3XRT/iclock/...` | Firmware that keeps a path in the address field |
| **B. Host key** (reliable fallback) | Server address `k7qm3xrt.push.gymsera.com`, port 443 (or 80) | `Host` header (the protocol requires it on every request) | Any firmware with "Enable domain name" |
| **C. Serial pairing** | Server address `push.gymsera.com`; the host types the device's **serial number** into GymsEra when adding it | `SN` query parameter, matched to a pre-claimed serial | Every device. Weakest: the serial is printed on the device. |

Rules for all modes:

1. **No auto-join.** A request is accepted only when key, serial or both match a device a host
   created. Unknown serials get `OK` on `cdata` and **406** on `registry`. Their serial, IP and
   time go into a small `unclaimed_devices` table (7-day expiry, rate-limited) so support can
   help a host who mistyped.
2. **First contact binds the serial.** In modes A and B, the first valid request stores the `SN`
   on the device row. After that the pair (key, SN) must always match. The same key with a
   different SN gets 406 and a "serial mismatch" alert in the CMS. This stops a copied key from
   being used on another device.
3. **Re-pair** (new key, unbind serial) is an explicit owner or admin action, for example after
   replacing a broken device.
4. In mode C we also require, where the firmware sends it, the registration field `authKey`
   (the device's **Comm Key**) to equal a code GymsEra shows the host. If it isn't sent, mode C
   stays available only behind a per-tenant setting with a warning (§16, D-2).

### 4.3 Hostname, TLS and Cloudflare

- **Use a dedicated hostname** `push.gymsera.com` (plus wildcard `*.push.gymsera.com` for mode B)
  that reaches the **same** Node app as `api.gymsera.com`. It is not a separate backend. The
  device endpoints then have their own Cloudflare rules and never interfere with the app API. How
  the hostname reaches the app on IIS, and the rule that it may only carry device paths, are in
  §4.5.
- **Cloudflare rules for that hostname only:**
  - Turn off "Always Use HTTPS" redirects, because older firmware can't follow a redirect.
  - Turn off Bot Fight Mode and challenges, because the device's User-Agent is `iClock Proxy/…` and
    a challenge page breaks it.
  - Keep the WAF on, with a rate limit per IP.
  - Allow request bodies up to at least 10 MB (photos).
- **Prefer HTTPS.** Templates and photos are biometric data. If a model only does plain HTTP,
  allow port 80 for that device and flag it "unencrypted" in the CMS. Whether to allow it at all
  is your decision (§16, D-3).
- Wildcard DNS and certificates for `*.push.gymsera.com`: check your Cloudflare plan supports a
  proxied wildcard and an edge certificate for a second-level wildcard (an Advanced Certificate
  may be needed). If not, use mode A or C, or keys at the first level such as
  `k7qm3xrt-push.gymsera.com` (covered by the free `*.gymsera.com` certificate). Verify this in
  Phase 0. I have not checked your plan.

### 4.4 What the host sees after adding a device

```
Device added: "Front door IN" (Branch: DHA Phase 6, check-in)

On the device go to: Menu › Comm › Cloud Server Setting
  Server mode ............ ADMS
  Enable domain name ..... ON
  Server address ......... k7qm3xrt.push.gymsera.com
  Server port ............ 443
  HTTPS .................. ON            (if your model has it)
  Proxy server ........... OFF

Waiting for the device to connect…   ● (turns green within ~10 s of saving)
```

The screen polls the device status every 2 s while it's open, and shows the first contact,
the model and the firmware as soon as they arrive.

### 4.5 Routing `push.gymsera.com` to the API on IIS

**Owner's choice: option 1, a separate IIS site that reverse-proxies to the API.** Option 2 is
kept as a fallback. Both reach the same `gymsera_be` app. Nothing new is deployed as a service.

**The one rule that matters for both: `push.gymsera.com` may only carry device paths.** Only
`/iclock/*` and `/d/<key>/iclock/*` pass, and everything else returns 404. Cloudflare's rules are
relaxed on this hostname for the devices, so without this rule it would be a back door into
`/api/v1/...`. The rule is enforced **twice**: once in IIS and once in the backend, so a
mistake in one doesn't open the other.

#### Option 1 (chosen): separate site `push.gymsera.com` with URL Rewrite + ARR

```
Device ──HTTPS──▶ Cloudflare ──▶ IIS site "push.gymsera.com"
                                     │  web.config: only /iclock/* and /d/*/iclock/*
                                     ▼  (everything else → 404)
                                 http://127.0.0.1:8085  ← local-only binding on the API site
                                     ▼
                                 gymsera_be (same app as api.gymsera.com)
```

Server setup (one time, PowerShell as administrator):

1. Install IIS **URL Rewrite** and **Application Request Routing (ARR)** if missing. Check:
   `Get-WebGlobalModule | Where-Object Name -match 'Rewrite|ApplicationRequestRouting'`
2. Turn the ARR proxy on:
   `Set-WebConfigurationProperty -pspath 'MACHINE/WEBROOT/APPHOST' -filter 'system.webServer/proxy' -name 'enabled' -value 'True'`
3. Add a **local-only** binding to the existing API site, so the proxy never goes back out
   through the internet and Cloudflare: `http`, IP `127.0.0.1`, port `8085` (any free port),
   no host name. Open nothing in the firewall for it.
4. Allow the proxy to set the forwarding headers. In IIS Manager › server › URL Rewrite ›
   View Server Variables, add `HTTP_X_ORIGINAL_HOST` and `HTTP_X_FORWARDED_PROTO`.
5. Create the IIS site `push.gymsera.com` (its own empty folder) with bindings for
   `push.gymsera.com` and, for mode B, `*.push.gymsera.com` (IIS 10 supports wildcard host
   bindings). Put this `web.config` in its folder:

```xml
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="Devices to API" stopProcessing="true">
          <match url="^(iclock/.*|d/[A-Za-z0-9]{8}/iclock/.*)$" />
          <serverVariables>
            <set name="HTTP_X_ORIGINAL_HOST" value="{HTTP_HOST}" />
            <set name="HTTP_X_FORWARDED_PROTO" value="https" />
          </serverVariables>
          <action type="Rewrite" url="http://127.0.0.1:8085/{R:1}" appendQueryString="true" />
        </rule>
        <rule name="Everything else is 404" stopProcessing="true">
          <match url=".*" />
          <action type="CustomResponse" statusCode="404" statusReason="Not Found"
                  statusDescription="Not Found" />
        </rule>
      </rules>
    </rewrite>
    <security>
      <requestFiltering>
        <requestLimits maxAllowedContentLength="10485760" />  <!-- 10 MB, photos -->
      </requestFiltering>
    </security>
    <httpErrors existingResponse="PassThrough" />
  </system.webServer>
</configuration>
```

Three things the backend must do, because of the proxy:

1. **Read the original host from `X-Original-Host`.** Mode B identifies the device by its host
   name (`k7qm3xrt.push.gymsera.com`). Behind the proxy, `Host` is `127.0.0.1:8085`.
2. **Read the real client IP** from `CF-Connecting-IP` (set by Cloudflare), falling back to
   `X-Forwarded-For` (added by ARR). Trust these headers **only** when the request arrives from
   `127.0.0.1` (Express: `app.set('trust proxy', 'loopback')`). Otherwise every device looks like
   127.0.0.1, and rate limits and IP alerts become useless.
3. **Second copy of the path rule:** a request whose `X-Original-Host` is `push.*` (or that
   arrives on the local binding) may only reach the device router. Anything else is 404. A test
   must cover this.

ARR's default proxy timeout is short. Set it to at least 30 s in
`system.webServer/proxy` › `timeout`, so a slow photo upload isn't cut off. Device requests
themselves must still answer in under 1 s (§5).

#### Option 2 (fallback): extra binding on the existing API site

Add `push.gymsera.com` (and `*.push.gymsera.com`) as bindings on the **existing** API site.
There's no ARR, no second site, and no extra hop, and the host and client IP arrive untouched.
The path rule then lives only in the backend: a request whose `Host` is `push.*` may only reach
`/iclock` and `/d/*/iclock`. It is simpler, but the protection is in code only, so the test in
point 3 above is mandatory. Use this if ARR can't be installed or gives trouble.

#### Real protection versus a hidden address

Moving the devices to their own hostname limits **what** that hostname can reach. It doesn't
make `api.gymsera.com` secret, because the app and CMS still use it. The protections that
actually keep the API safe are in Appendix A.

---

## 5. Server endpoints (device side)

All under `/iclock/*`. Also mounted under `/d/:deviceKey/iclock/*` for mode A.

| Method and path | Handler duty |
|---|---|
| `GET /iclock/cdata` (`options=all`) | Resolve the device (§4.2). If it is claimed and active: return `registry=ok`, its `RegistryCode` and the config (§5.1). Else `OK`. Update `last_seen`, IP, `pushver`. |
| `POST /iclock/registry` | Resolve. If allowed: parse and store all registration fields (§6.2), return `RegistryCode=<device's code>`. Else **406**. |
| `POST /iclock/push` | Return the config (§5.1). |
| `GET /iclock/getrequest` | Heartbeat. Return queued commands (§8.1) or `OK`. |
| `POST /iclock/devicecmd` | Parse one or more `ID=&Return=&CMD=` lines and update the commands. |
| `POST /iclock/cdata?table=rtlog` (and `ATTLOG`) | Scans become access events and check-ins (§7.3). |
| `POST /iclock/cdata?table=rtstate` | Door, relay and alarm status into `device_state`. |
| `POST /iclock/cdata?table=options` | Device parameters and counts (`UserCount`, `FPCount`, `FaceCount`, …). |
| `POST /iclock/cdata?table=tabledata&tablename=user` | Users created on the device (§7.5). Reply `user=N`. |
| `… tablename=biodata` / `templatev10` | Templates enrolled on the device (§7.5). Reply `biodata=N`. |
| `… tablename=userpic` / `biophoto` / `ATTPHOTO` | Photos to the private store (§7.5, §14). Reply `userpic=N`. |
| `… tablename=errorlog` | Store the device error log (Appendix 17). |
| `POST /iclock/cdata?type=BioData` | Results of remote enrolment `ENROLL_BIO` (§7.6). |
| `POST /iclock/querydata` | Query results, which can arrive in several packs (`packcnt` and `packidx`). Reply `<table>=<count>`. |
| `GET|POST /iclock/ping` | Heartbeat during big uploads. Reply `OK`. |
| anything else | `OK`, log the path (no body) so new firmware calls are visible. |

Implementation requirements:
- **Separate Express router** mounted **before** the JSON parser, auth, CSRF, the SEC-06
  unknown-field middleware and the JSON error handler. Bodies are `application/push;charset=UTF-8`,
  so use `express.text({ type: () => true, limit: '10mb' })` on this router only.
- **Responses** are `text/plain; charset=utf-8`, with a correct `Date` header in GMT and a
  `Content-Length`. No cookies, no CORS headers, no HTML error pages. Unexpected errors return
  `OK` (so the device doesn't retry-storm) and are logged with the device id.
- **Speed:** the device's `TimeoutSec` is 10 s. Handlers must answer in under 1 s. Heavy work
  (image upload to R2, attendance fan-out) runs after the write is committed, never during it.
- **Rate limits:** per device about 2 req/s on average with bursts of 20. For unclaimed serials,
  1 request per 10 s per IP.
- **Multiple processes:** iisnode may run several Node processes, so nothing may live in process
  memory. All state, queues and locks are in MySQL.

### 5.1 Config we send (`cdata` registered branch and `push`)

```
registry=ok                       (cdata only)
RegistryCode=<per device>         (cdata only)
ServerVersion=3.1.2
ServerName=GymsEra
PushProtVer=3.1.2
ErrorDelay=60
RequestDelay=3                    ← must be ≤ 5 for the 15-second manual push to work
TransTimes=00:00;14:00
TransInterval=1
TransTables=User Transaction
Realtime=1
SessionID=<per device, rotates on re-pair>
TimeoutSec=10
BioPhotoFun=1
BioDataFun=1
MultiBioDataSupport=0:1:1:0:0:0:1:0:1:1:1     ← fingerprint, NIR face, palm print, palm, VL face, VL palm
MultiBioPhotoSupport=0:0:0:0:0:0:0:0:0:1:1    ← VL face and VL palm photos
PushOptionsFlag=1
```

The device keeps only the types **both** sides support (§3.1 of the protocol), so advertising
broadly is safe. Choose `RequestDelay` together with the load in §13.

---

## 6. Data model

Routing must happen **before** we know the tenant, so the device registry is in the **platform**
database. Everything about members, biometrics, commands and scans lives in the **tenant**
database (rule R-79: tenant DB names come only from `tenants.db_name`).

### 6.1 Platform DB (new migration `p0xx_access_devices`)

```sql
access_devices
  id                 BIGINT PK
  device_key         CHAR(8)  UNIQUE        -- shown as XXXX-XXXX
  serial_number      VARCHAR(32) UNIQUE NULL -- bound on first contact (modes A and B) or entered (mode C)
  tenant_id          FK tenants
  organization_id    BIGINT
  branch_id          BIGINT
  link_mode          ENUM('path','host','serial')
  registry_code      VARCHAR(32)            -- random, per device
  session_id         VARCHAR(32)            -- random, per device
  token_mode         ENUM('off','log','enforce') DEFAULT 'log'
  status             ENUM('awaiting_connection','active','disabled','replaced')
  last_seen_at, last_ip, last_pushver
  created_by, created_at, updated_at

unclaimed_device_contacts     -- capped; rows expire after 7 days
  serial_number, host, path_key, ip, first_seen_at, last_seen_at, hits
```

Cache the "key, host or SN → device and tenant" lookup for about 30 s in memory per process.
Redis is not used in production (R-88). Invalidate it on disable or re-pair by checking
`updated_at`.

### 6.2 Tenant DB (new migration `t0xx_device_sync`)

```sql
devices                         -- tenant copy and details; id = access_devices.id
  id, branch_id, name, direction ENUM('in','out','both'), enabled
  model, firmware, push_version, mac, comm_type, device_type ('acc'|'att')
  capabilities_json      -- MultiBioDataSupport, MultiBioPhotoSupport, MultiBioVersion,
                         -- MaxMultiBioDataCount, MaxUserCount, DateFmtFunOn, LockCount, …
  counts_json            -- UserCount, FPCount, FaceCount … from table=options
  door_mask TINYINT DEFAULT 1   -- AuthorizeDoorId bitmask
  timezone_id INT DEFAULT 1     -- device time rule for 24/7 access
  last_full_audit_at, last_error_code, last_error_at

member_device_identity          -- one per member per tenant
  member_id UNIQUE, pin INT UNIQUE, card_no VARCHAR(32) NULL

member_biometrics
  id, member_id, bio_type TINYINT, bio_no TINYINT, bio_index TINYINT,
  major_ver, minor_ver, format, duress, valid,
  template_enc  MEDIUMBLOB     -- AES-256-GCM, key from env BIOMETRIC_DATA_KEY
  template_sha256 CHAR(64)
  source_device_id, enrolled_at, deleted_at
  UNIQUE(member_id, bio_type, bio_no, bio_index)

member_biometric_photos         -- comparison and profile photos, files in the private R2 bucket
  id, member_id, bio_type, r2_key, sha256, source_device_id, created_at

member_biometric_consents
  member_id, consented_at, consented_by_user_id, method ('in_person'|'app'), revoked_at

device_member_sync              -- desired versus applied, per device and member
  device_id, member_id, pin
  desired  BOOLEAN              -- should be on this device now
  desired_hash  CHAR(64)        -- hash of name, card, validity window and template hashes
  applied_hash  CHAR(64) NULL   -- what the device last confirmed
  state ENUM('in_sync','pending_add','pending_update','pending_remove','failed','removed')
  attempts, last_return_code, last_error_at, updated_at
  PRIMARY KEY(device_id, member_id)

device_commands
  id BIGINT AUTO_INCREMENT      -- this is the protocol CmdID
  device_id, member_id NULL, push_request_id NULL
  kind ENUM('user_upsert','user_authorize','bio_upsert','bio_photo','user_pic',
            'user_delete','bio_delete','auth_delete','pic_delete',
            'query_users','query_bio','count','info','check','enroll_bio','control','options')
  args_json                     -- references only (member_id, bio ids), never template text
  priority TINYINT              -- 0 manual push, 5 real-time, 9 backup or audit
  status ENUM('queued','sent','acked','failed','expired','superseded')
  claim_token CHAR(26) NULL     -- set when a poll claims the command (§8.1)
  attempts, sent_at, acked_at, return_code, not_before, expires_at, created_at
  INDEX(device_id, status, priority, id)

device_push_requests            -- manual push button (§9)
  id CHAR(26) ULID, requested_by, member_id NULL, device_ids_json,
  created_at, deadline_at, result_json

device_access_events            -- every scan, granted or denied
  id, device_id, device_record_index, device_time, utc_time,
  pin, member_id NULL, card_no, event_code, verify_type, inout_status,
  result ENUM('granted','denied','alarm','other'), attendance_id NULL
  UNIQUE(device_id, device_record_index, device_time)

device_state                    -- latest rtstate per device
device_error_logs               -- table=errorlog uploads
```

The command row **does not store template data**. `args_json` points at `member_biometrics.id`,
and the command text is built when it's handed to the device. This keeps one copy of each
template (encrypted) instead of thousands in a queue.

### 6.3 PIN (device user ID)

- Each member gets a numeric `pin`, unique **within the tenant**, from a per-tenant sequence
  starting at 1001. Use digits only, because some firmware has no string PINs (`StringPinFunOn`).
- A traveller with a day pass at another tenant's gym gets a separate PIN in **that** tenant.
- The PIN never changes. When a member is deleted, the PIN is retired, not reused, for 180 days.
  This prevents an old template on an offline device from matching a new person.

---

## 7. Sync rules

### 7.1 Who belongs on a device

A member is **desired** on device *D* (branch *B*, direction *dir*) at time *t* when **all** of
these hold:

1. The member exists and is not deleted, blocked or banned.
2. They have a membership or package that is **active and verified** (payment approved, or no
   payment needed), covers **branch B**, and has `start ≤ t ≤ end`. Use the same "active" rule the
   app shows the member. Don't write a second definition.
3. It isn't frozen or paused at *t*.
4. **Check-out grace:** for `dir = out`, a member who was desired in the last
   `exit_grace_hours` (default 24) stays desired, so someone who entered just before expiry can
   still leave. The physical exit button and fire release must always work regardless (§14).
5. Staff with a "device access" flag at branch B are desired with privilege 0. Device admin
   privilege (14) is never sent from GymsEra.

The desired record for a member on device *D* contains:

```
Pin, Name (UTF-8, max 24 chars, trimmed), CardNo (if any), Privilege=0, Group=1,
StartTime / EndTime  = package window in branch local time
                       (EndTime = end date 23:59:59, plus exit grace on OUT devices)
userauthorize: AuthorizeTimezoneId = device.timezone_id, AuthorizeDoorId = device.door_mask,
               StartTime / EndTime as above
Biometrics: every valid template whose type the device supports AND whose major version
            matches the device's MultiBioVersion for that type; otherwise for face or palm
            the comparison photo (biophoto) if the device supports that photo type
Profile photo (userpic): optional, only if device advertises it and setting is on
```

`desired_hash` = SHA-256 of the record above, with template hashes instead of template data.

### 7.2 Applying a change (the reconciler)

`reconcileMember(tenant, memberId, reason)` and `reconcileDevice(tenant, deviceId, reason)` are
the **only** ways commands get created. Both:

1. Compute *desired* for each affected (device, member).
2. Compare with `device_member_sync`:
   - **Should be on, isn't or differs:** queue `user_upsert` → `user_authorize` → `bio_upsert`
     (one per type, or `bio_photo` for the fallback) → `user_pic`, then set `pending_add` or
     `pending_update`.
   - **Shouldn't be on, is:** queue `bio_delete` (each type the device supports), `pic_delete`,
     `auth_delete`, `user_delete`, then set `pending_remove`.
   - **Same hash:** nothing.
3. Mark older queued commands for the same (device, member) as `superseded`, so a quick
   activate-then-cancel doesn't add then remove on the device.
4. Be **idempotent**. Running it twice creates no new commands.

When every command of a batch is acked with `Return ≥ 0`, set `applied_hash = desired_hash` and
`state = in_sync` (or `removed`). A negative return sets `failed` with the code (§8.1).

Templates are sent as **separate commands per biometric type**, because the protocol requires
one type per multi-record `biodata` command.

### 7.3 Scans become check-ins

For each `rtlog` (or `ATTLOG`) line:

1. Parse. Drop duplicates on `(device_id, index, time)`.
2. Convert `time` (device local) to UTC with the **branch time zone**.
3. Classify: event 0–19 or 200–253 → `granted`, 20–99 or 5000–5999 → `denied`, 100–199 or
   6000–6999 → `alarm`, else `other`. Pin 0 means no person (door events).
4. Find the member by PIN in this tenant.
5. **Granted** on an `in` device → create a check-in through the **existing attendance service**
   (the same one the QR flow uses) with `source = 'device'` and the `device_id`. On an `out`
   device → check-out. On `both` → use `inoutstatus`.
6. **Denied** → save the event only, and show it in the branch live feed with the reason
   ("Not registered", "Expired", "Wrong time"). A denied scan by a member GymsEra thinks is active
   is a **drift signal**: queue `reconcileMember` for that device at priority 5.
7. Answer `OK` before any slow work.

### 7.4 Four safety layers against "expired member still gets in"

1. **Real time:** expiry, cancel or freeze triggers queue removal (§8).
2. **Backup jobs:** the three layers in §8.3.
3. **On-device validity:** `EndTime` on `user` and `userauthorize` makes the device itself
   refuse after expiry, even when offline. Phase 0 must confirm your firmware honours it and
   which format it expects (`DateFmtFunOn=1` means the seconds encoding in Appendix 5, `0` means
   `YYYYMMDD`).
4. **Detection:** a granted scan by a member GymsEra considers not desired raises an alert and
   triggers an immediate removal.

### 7.5 Data the device sends us (enrolment on the device)

- **User upload** (`tablename=user`): if the PIN matches a member, update `card_no` if the device
  has one and GymsEra doesn't, and never overwrite the name. If the PIN is unknown, save it in an
  **"unlinked device users"** list in the CMS. Staff can link it to a member or delete it from
  the device. Unknown users are never auto-created as members.
- **Template upload** (`biodata`, `templatev10`): if the PIN matches and **biometric consent** is
  on file, encrypt and store it in `member_biometrics`, then `reconcileMember` so the template
  reaches the member's **other** devices (other doors, check-out device, other branches they may
  use). Without consent, keep it pending for 7 days and show "consent needed" on the member. If
  consent isn't recorded in time, delete it here and on the device.
- **Photos** (`biophoto`, `userpic`): to the private R2 bucket under `biometrics/<tenant>/<member>/…`,
  never public.
- **Capture photos** (`ATTPHOTO`): off by default, because they are photos of everyone who walks
  in. Turn them on only with a branch setting and a retention period (§16, D-6).

### 7.6 Enrolment from the CMS or app

On the member profile: **Enroll face / finger / palm on device** opens a device picker, then sends
`ENROLL_BIO TYPE=<t> NO=<n> PIN=<pin> RETRY=3 OVERWRITE=1 MODE=1`. The device prompts the member,
and the result arrives as `type=BioData` (or a normal `biodata` upload). Same 15-second pattern as
§9, but with a 60-second window, because a person has to stand in front of the device. If the
firmware lacks `ENROLL_BIO` (`-708` "firmware does not support this command"), show "Enroll on
the device menu with PIN 1047" instead.

---

## 8. Real-time triggers and the three backup layers

### 8.1 Command delivery and retry (inside the request path)

On `getrequest`:

1. Claim commands atomically. MySQL 5.7 has no `SKIP LOCKED`, so use a single claiming update:
   `UPDATE device_commands SET status='sent', sent_at=NOW(), attempts=attempts+1, claim_token=?
   WHERE device_id=? AND status='queued' AND not_before<=NOW() ORDER BY priority, id LIMIT 20`,
   then select the rows by `claim_token`. Two processes can never hand out the same command.
2. Render each command (decrypting templates in memory only). Join them with `\n` while the total
   stays under `min(MaxPackageSize, 1 MB)`. Return the rest on the next poll.
3. On `devicecmd`: for each `ID`, set `acked` or `failed` and the return code, then update
   `device_member_sync`.

Return-code handling (Appendix 1):

| Code | Meaning | Action |
|---|---|---|
| `≥ 0` | Success | `acked` |
| `-7` | Repeated command | Treat as success |
| `-26`, `-27`, `-30` | Empty template, unknown PIN, algorithm version mismatch | `failed`. For `-27`, re-queue `user_upsert` first. For `-30`, mark the template incompatible with this device and try the photo fallback. |
| `-18`, `-3`, `-604` | Device full or out of memory | `failed`, alert "device storage full" |
| `-708` | Firmware doesn't support the command | `failed`, record capability as off |
| `-1`, `-2`, `-12`, `-725`, `-730` | Transient | Retry with backoff: 30 s, 2 min, 10 min, 1 h, then `failed` and alert |
| other negative | Unknown | `failed`, alert with the code |

### 8.2 Real-time triggers (call `reconcileMember` after commit)

Use an **outbox row in the same transaction** as the business change, so a crash between commit
and enqueue can't lose the trigger. Then process the outbox immediately in the same request,
after commit. It's a few inserts, so there's no need to wait for a job.

| Event in GymsEra | Effect on devices |
|---|---|
| Member created **with** an active package | Add to the branch's devices |
| Package assigned or activated, payment proof **verified**, bank transfer approved | Add, or extend `EndTime` |
| Package renewed or extended | Update `EndTime` |
| Package frozen or paused, cancelled, refunded, payment rejected | Remove |
| Package expires (time passes, no event) | Backup layer 2 (midnight sweep) |
| Member blocked or deleted | Remove from every device in the tenant, delete biometrics per retention |
| Name or card changed | Update |
| Biometric enrolled, replaced or deleted | Update every device where desired |
| Member's branch access changes (multi-branch plan) | Add or remove per branch |
| Device created, re-paired, moved, direction changed | `reconcileDevice` (full) |
| Branch locked by platform-plan lapse (R-82) | **Your decision, §16 D-5** |

### 8.3 The three backup services

They run through the existing Windows Task Scheduler setup (`SCHEDULED_JOBS=external`,
`run-scheduled-job.js`). Add two jobs: `device-sync` **every minute** (runs layers 1 and 2 with
their own cadence inside) and `device-audit` **daily**.

| Layer | Name | Cadence | What it does |
|---|---|---|---|
| **1** | Command watchdog | every minute | `sent` commands with no ack after 60 s go back to `queued` (attempts+1, backoff). Too many attempts → `failed` and alert. `queued` past `expires_at` → `expired`. Devices with no contact for 10 minutes are marked offline and an owner notification goes out (once per incident). |
| **2** | Desired-state sweep | every 15 min, **plus** within 5 minutes after **local midnight** of each branch | For each enabled device: recompute desired for all members of the branch, compare with `device_member_sync`, queue the differences. The midnight run removes everyone whose package ended "yesterday". Also retries `failed` rows after 1 hour (max 3 times a day). |
| **3** | Nightly device audit | daily at 02:00 branch time (staggered per device) | Ask the device what it really has: `DATA COUNT user`, then `DATA QUERY tablename=user,fielddesc=*,filter=*` and `DATA COUNT biodata Type=<t>`. Results arrive by `querydata` in packs. Compare with desired: **extra users** (expired, deleted, or added by hand on the device) are removed or listed under "unlinked", **missing users** are re-added, and `applied_hash` is reset where counts disagree. Save an audit report (counts, fixes, duration) shown on the device page. |

All three use the same `reconcile*` functions as real time. Only the trigger differs.

---

## 9. Manual "Push to device" with a 15-second timeout

### 9.1 Where it appears

- **Member profile** (CMS and app), "Access devices" card: one row per device of the member's
  branches, showing a status chip (In sync / Pending / Failed (reason) / Not entitled (reason)),
  the last synced time, and buttons **Push now** (per device) and **Push to all devices**.
- **Device page** (CMS and app): **Sync now** (pushes every pending change for that device) and
  **Run full audit** (layer 3 on demand, result in about 1–3 minutes, not 15 s).

### 9.2 Flow

```
UI ─POST /host/members/:id/device-push {deviceIds?}──▶ API
    ◀── 202 {requestId, devices:[{id, online, lastSeenSec}]}
API: reconcileMember(...) with priority 0 and push_request_id; deadline = now + 15 s
UI polls GET /host/device-push-requests/:requestId every 1 s (max 15 s)
    status per device: queued → delivered (device fetched) → applied | failed(code, text)
At 15 s: remaining devices show "No answer in 15 s". The commands STAY queued and the
backup layers keep trying; the UI says so, and the row turns green later when it lands.
```

Rules:
- If a device was last seen more than 30 s ago, the response marks it **offline straight away**,
  so the user isn't left waiting 15 s for nothing ("Device offline, last seen 14 min ago; it
  will update when it reconnects").
- If the member isn't entitled (expired, not this branch), the button doesn't push. It explains
  why, and offers **Remove from device now** if they are still on it.
- Use polling, not a 15-second held HTTP request. It works the same on web and mobile and is
  safe with iisnode.
- Permissions are in §12. Rate limit: 1 push per member per 10 s per user. Every push is written
  to the audit log (who, member, devices, result).
- For a 15-second answer to be possible, `RequestDelay` must be ≤ 5 s. With 3 s the typical
  result time is 3–6 s.

---

## 10. Host-facing screens (CMS web and mobile app)

### 10.1 Branch › Devices list
Columns: name, direction (IN/OUT), status (Online / Offline since…), model and firmware, users on
device versus expected, pending and failed changes, last scan, an HTTPS/HTTP badge. Buttons:
**Add device**, and per row: open, sync now, disable.

### 10.2 Add device (wizard, 3 steps)
1. Branch, name, direction, link mode (default from Phase 0), serial number (mode C only).
2. Setup card (§4.4) with copy buttons and a per-model help link. The key can be shown as a QR
   code so it's easy to read on site.
3. Live wait for the first contact, then show the model, firmware and capabilities. Offer
   **Import existing users from this device** (§15, migration).

### 10.3 Device detail
- Status, last seen, IP, firmware, capabilities (face, finger, palm, card) and capacity bars.
- Sync health: in sync, pending, failed (expandable with member and reason), and the last audit
  report.
- Live feed (last 50 scans: member, photo, result, time) with a 3-second poll.
- **Command log** (last 200, filterable by status), **Unlinked device users**.
- Actions: Sync now, Full audit, Re-pair (new key), Move to another branch (wipe and re-sync,
  confirmation required), Disable, **Remove** (with an option to wipe all GymsEra users from the
  device: `DATA DELETE user *`, `DATA DELETE userauthorize *`, `DATA DELETE biodata Type=<each>`;
  confirmation required).

### 10.4 Member profile › Access devices
As in §9.1, plus biometrics enrolled (types and dates, never template data), consent status,
**Enroll on device**, **Delete biometrics** (removes them here and from every device).

### 10.5 Branch live check-ins
A feed of granted and denied scans across the branch's devices. Denied rows show the reason and
a "Fix" shortcut (open member, push now).

The mobile app gets 10.1, 10.3 (without the command log), 10.4 and 10.5. The add-device wizard
can be in the app too, because staff usually set devices up on site with a phone.

---

## 11. API (CMS and app, JSON, authenticated, tenant-scoped)

Route prefix and permission names follow the existing conventions (agent maps them).

| Method | Route | Purpose |
|---|---|---|
| GET | `/host/devices?branchId=` | List |
| POST | `/host/devices` | Create → `{device, setup:{mode, serverAddress, port, https, key}}` |
| GET | `/host/devices/:id` | Detail, health, capabilities |
| PATCH | `/host/devices/:id` | Name, direction, enabled, door mask |
| POST | `/host/devices/:id/repair` | New key, unbind serial (owner or org admin) |
| POST | `/host/devices/:id/move` | Move branch (wipe and re-sync) |
| DELETE | `/host/devices/:id` | Remove `{wipeDevice: boolean}` |
| POST | `/host/devices/:id/sync` | `{mode:'quick'|'audit'}` → `{requestId}` |
| GET | `/host/devices/:id/commands?status=` | Command log |
| GET | `/host/devices/:id/unlinked-users` | Users on the device with no member |
| POST | `/host/devices/:id/unlinked-users/:pin/link` | `{memberId}` |
| GET | `/host/branches/:id/access-events?since=` | Live feed |
| POST | `/host/members/:id/device-push` | `{deviceIds?}` → `{requestId}` |
| GET | `/host/device-push-requests/:requestId` | Poll status |
| GET | `/host/members/:id/device-status` | Per-device chips |
| POST | `/host/members/:id/biometrics/enroll` | `{deviceId, type, no}` → `{requestId}` |
| DELETE | `/host/members/:id/biometrics/:bioId` | Delete one, or `all` |
| POST | `/host/members/:id/biometric-consent` | Record or revoke consent |

---

## 12. Permissions

New permission keys, added to the existing permission catalogue (deny by default, audited):

| Key | Owner | Org admin | Manager | Front desk | Trainer |
|---|---|---|---|---|---|
| `devices.view` | ✓ | ✓ | ✓ | ✓ | – |
| `devices.manage` (add, edit, re-pair, move, remove, audit) | ✓ | ✓ | ✓ (own branch) | – | – |
| `devices.push` (push now, sync now) | ✓ | ✓ | ✓ | ✓ | – |
| `biometrics.enroll` / `biometrics.delete` | ✓ | ✓ | ✓ | ✓ / – | – |

Platform admins: read-only device health for support. No push and no biometric access, the same
principle as the payout rule in NEW-228. Every action above is written to the audit log.

---

## 13. Load and limits

- Polling: devices × (1 / `RequestDelay`). 50 devices at 3 s ≈ 17 req/s of tiny requests. Make
  sure the `getrequest` path is two indexed queries at most, and add a short in-memory "nothing
  queued" cache per device (1–2 s) if needed.
- First sync of a branch with 1,000 members, faces only: about 3,000 commands. At 20 per poll
  every 3 s that's about 8 minutes. Batch multi-record `biodata` commands (same type) to cut this
  to 2–3 minutes. Show progress on the device page.
- Template sizes: fingerprint about 1–2 KB, visible-light face about 2–3 KB base64 (measure them in
  Phase 0). Photos are 20–150 KB, so don't batch more than about 5 photos per response.
- Capacity: compare desired users and templates with `MaxUserCount` and `MaxMultiBioDataCount`
  and warn at 90%.
- Logs: one line per request (device id, path, table, count, ms). **Never** log the body.

---

## 14. Security and privacy

1. **Biometric data is sensitive personal data.** Collect it only with recorded consent (§6.2),
   and offer a non-biometric option (card or PIN) to anyone who refuses.
2. Templates are encrypted at rest (AES-256-GCM, `BIOMETRIC_DATA_KEY` in `.env`, added to the
   secrets-rotation runbook). Photos go only to the private R2 bucket. Nothing is in a public URL.
3. Templates are never returned by any JSON API, never logged, and scrubbed from Sentry events.
4. Device auth: claimed-device rule, serial binding, `token_mode` log → enforce after Phase 0,
   per-device secrets, rate limits, and alerts on serial or IP changes.
5. Tenant isolation: a device row resolves to exactly one tenant DB, and every command query
   filters by `device_id`. Add a test where devices of two tenants poll the same process and must
   never see each other's members.
6. Retention (your decision, §16 D-4): delete templates and photos N days after a member leaves,
   and immediately on member deletion or consent withdrawal (including from all devices).
7. **Safety:** GymsEra controls who may *enter*. Exits must never depend on GymsEra or the
   network. Turnstiles and doors need a physical exit button or free exit and fire release. Put
   this in the setup guide.

---

## 15. Phases (one PR per phase, tests first)

**Phase 0: device spike (half a day with a real SpeedFace on site; no production data)**
Run a throw-away test endpoint and record:
- (a) Does the Cloud Server address accept a path (mode A)? A full hostname (mode B)? HTTPS?
- (b) The exact `registry` body (capabilities, `MultiBioVersion`, `DateFmtFunOn`, whether `authKey`
  is sent).
- (c) The `Cookie: token=` value, to confirm the token formula.
- (d) Does a user without `userauthorize` pass the door?
- (e) Does `EndTime` block access after expiry, and in which format?
- (f) Is `ENROLL_BIO` supported?
- (g) Template sizes, and whether a `biophoto` for type 9 enrols the face.

Save **sanitized** request samples as test fixtures (no real faces: enrol a test person).
Record the results in the spec and close decisions D-1 to D-3.

**Phase 1: protocol and device registry (backend and CMS)**
- Router, parsers, responses, platform and tenant migrations, claim, bind and re-pair.
- CMS Devices list, Add device wizard and device detail (status only).
- A **device simulator** script (`scripts/zk-device-simulator.js`) that speaks the protocol, used
  by integration tests and CI.

**Phase 2: sync engine**
- Identity and PIN, biometrics storage and encryption, consent, reconciler, command queue and
  return codes.
- Real-time triggers (outbox), scans to check-ins.
- Jobs `device-sync` and `device-audit`, plus the Task Scheduler entries and the runbook
  (`docs/runbooks/devices.md`).

**Phase 3: manual push and member screens (CMS, then app)**
- Push button with 15 s polling, member device status, live feed, unlinked users, remote enrol.

**Phase 4: migration from GymBioSync and hardening**
- "Import from device": query users and biodata from an existing device, match PINs to GymsEra
  members (CSV mapping upload or manual), store the templates (with consent), then switch the
  device over.
- Token enforce mode, capacity warnings, alerts, load test with 50 simulated devices.

### Tests required (minimum)

- **Parsers:** every table format in §2, using fixtures from the protocol document and from
  Phase 0. Tab and space separators, the `biodatapin` quirk, multi-line bodies, packs in
  `querydata`.
- **Command builders:** golden strings for each command kind, multi-record batching, size cap.
- **Reconciler:** add, update, remove, superseded, idempotent rerun; check-out grace; frozen;
  multi-branch; version mismatch leading to the photo fallback.
- **Return codes:** each row of §8.1.
- **Security:** unknown SN gets 406 on registry; key with the wrong serial gets 406; tenant
  isolation; no template in any JSON response or log line (a test that greps captured logs).
- **Jobs:** watchdog re-queue, midnight sweep across time zones, audit removes extras and re-adds
  missing.
- **Manual push:** applied within the deadline (simulator), failed code shown, offline device
  reported at once, timeout at 15 s with commands still queued.
- **Attendance:** granted IN creates a check-in, OUT a check-out, denied creates no attendance,
  duplicate `index` is ignored.

---

## 16. Decisions needed from the owner

| # | Decision | Recommendation |
|---|---|---|
| D-1 | Link mode default: path key (A), host key (B) or serial pairing (C) | B, unless Phase 0 shows A works on all your models |
| D-2 | Allow serial-only pairing (mode C) without `authKey` | No by default, per-tenant opt-in with a warning |
| D-3 | Allow plain HTTP for devices without HTTPS | Allow, but show an "unencrypted" badge and prefer HTTPS models for new installs |
| D-4 | Biometric retention after a member leaves | Delete 90 days after the last active package; immediately on deletion or consent withdrawal |
| D-5 | Branch locked by platform-plan lapse (R-82): do devices keep admitting members? | Keep admitting during the 7-day grace, then freeze sync (no new adds; expiries still removed). Members paid the gym, not us. |
| D-6 | Store capture photos (`ATTPHOTO`) from scans | Off by default, branch opt-in, 30-day retention |
| D-7 | Check-out grace on OUT devices | 24 hours |
| D-8 | Staff on devices | Yes, privilege 0 only, via a "device access" flag on the staff member |
| D-9 | Attendance-protocol (`DeviceType=att`) devices | Out of scope for v1 (security/acc protocol only); add an adapter later if needed |
| D-10 | Release timing versus the 2026-11-30 app freeze | Backend and CMS can ship any time after Phases 0–2. The app screens go into the first post-launch build, unless a launch gym needs them on day one. |
| D-11 | Device hostname routing on IIS (§4.5) | **Decided by owner:** option 1, a separate `push.gymsera.com` site with URL Rewrite + ARR to a local-only API binding, device paths only. Option 2 is the fallback. |
| D-12 | Put the CMS and website API calls behind their own domains (Appendix A) | Yes, but as its own change after the 2026-12-05 store release, not mixed into launch week |

---

## 17. Glossary

- **PIN:** the member's numeric user ID on the device.
- **Desired / applied:** what GymsEra wants on a device versus what the device last confirmed.
- **CmdID:** our `device_commands.id`, echoed back by the device in `devicecmd`.
- **Comparison photo (`biophoto`):** a photo the device converts into its own template, used when
  template versions differ between models.
- **Comm Key / `authKey`:** a password set on the device and sent at registration (on firmware
  that supports it).
- **Reverse proxy:** a web server that receives a request and passes it on to another server,
  returning the answer as if it were its own (IIS does this with URL Rewrite + ARR).

---

## Appendix A: Putting the API behind the CMS and website domains

This is not part of the device feature. It is recorded here because the owner asked for the same
technique on the front ends. Do it as a separate change (D-12).

### A.1 What it does

Today the CMS and website JavaScript call `https://api.gymsera.com/api/v1/...` directly, so the
API address is visible in the browser. After this change, each front end calls **its own domain**,
and IIS forwards the call to the API on the same server:

```
Browser on cms.gymsera.com ──▶ https://cms.gymsera.com/api/v1/...  ─┐
Browser on gymsera.com     ──▶ https://gymsera.com/api/v1/...      ─┤  IIS URL Rewrite + ARR
                                                                    ▼
                                         http://127.0.0.1:8085/api/v1/...  (local-only binding, §4.5)
                                                                    ▼
                                                     gymsera_be (unchanged)
```

Benefits:
- The browser never shows `api.gymsera.com`.
- Calls are same-origin, so CORS for the CMS and website can be removed.
- Each front end can get its own Cloudflare rate limits and WAF rules.

### A.2 What it does **not** do (read this before relying on it)

- **It doesn't make the API secret.** Anyone can open the browser's network tab and see
  `cms.gymsera.com/api/v1/...` and call it directly. It is the same API with the same
  endpoints. Hiding the address is a small extra, not a security layer.
- **The mobile app still uses `api.gymsera.com`.** The address is inside the app and visible to
  anyone who inspects its traffic. Every app ever built would also break if it disappeared.
  `api.gymsera.com` must stay online.
- The real protection comes from A.4. Those items matter much more than hiding the name.

### A.3 How to set it up

Server, once per front-end site (`cms.gymsera.com` and `gymsera.com`). ARR, the proxy switch and
the `127.0.0.1:8085` binding are shared with §4.5. Add this rule **at the top** of each front
end's existing `web.config` rules, before the Next.js handler rule:

```xml
<rule name="API through same domain" stopProcessing="true">
  <match url="^api/(.*)$" />
  <serverVariables>
    <set name="HTTP_X_ORIGINAL_HOST" value="{HTTP_HOST}" />
    <set name="HTTP_X_FORWARDED_PROTO" value="https" />
  </serverVariables>
  <action type="Rewrite" url="http://127.0.0.1:8085/api/{R:1}" appendQueryString="true" />
</rule>
```

Code changes (agent, tests first):
1. **CMS and website:** the browser bundle calls a relative base (`/api/v1`) instead of
   `NEXT_PUBLIC_API_URL`. Server-side code (Next.js server components, route handlers) calls
   `http://127.0.0.1:8085` through a new server-only variable `INTERNAL_API_URL`, so it doesn't
   go out to the internet and back.
2. **Backend:**
   - Use `trust proxy` for loopback only, and take the client IP from `CF-Connecting-IP`, then
     `X-Forwarded-For` (same rule as §4.5). **This is critical.** Without it, every CMS user
     appears as 127.0.0.1, so one person's failed logins would lock out everyone, and rate
     limits would hit all users at once.
   - Cookies, if any, must work on the front end's domain.
   - Keep the existing CORS origins until both front ends are switched and verified, then
     remove them.
3. **Uploads:** raise `maxAllowedContentLength` on the front-end sites to the API's largest
   upload (payment proofs and documents are 10 MB) and set the ARR timeout to at least 120 s for
   exports.
4. **Tests:** login and lockout use the real client IP, rate limits are per user and not global,
   payment-proof upload works through the proxy, and the browser bundle contains no
   `api.gymsera.com` string (grep the build output).

Rollout: website first (fewer users), then the CMS. Each can be rolled back by removing the rule
and redeploying the previous build.

### A.4 What actually protects the API

1. **Keep the origin server's IP private and closed.** All of `gymsera.com` should be proxied
   through Cloudflare (orange cloud). Then set the **Windows firewall** to accept ports 80 and
   443 only from Cloudflare's published IP ranges, plus local. Without this step, anyone who
   learns the server IP can bypass Cloudflare entirely. This is the strongest single step.
2. Authentication and permission checks on every route. These already exist, along with the
   deny-by-default rules (R-89 and NEW-228).
3. Rate limits and lockouts per real client IP and per account (A.3 point 2).
4. No secrets in any front-end bundle. Only `NEXT_PUBLIC_*` values reach the browser, and none
   of them may be a secret.
5. Cloudflare WAF managed rules on `api.gymsera.com`, plus Cloudflare's optional "Authenticated
   Origin Pulls", so the server only accepts connections that really come from Cloudflare.
