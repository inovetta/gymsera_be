# ZKTeco Quick Configuration Card — GymsEra

> Print this page and keep it at the gym. It covers everything needed to connect a new device.

---

## Your Server Details

| Setting | Value |
|---|---|
| **Server Address** | `api.gymsera.com` _(replace with your domain)_ |
| **Server Port** | `443` |
| **HTTPS** | Yes / Enabled |
| **ADMS Path** | `/iclock` |

---

## Step 1 — Network Setup (on the device screen)

```
Menu → Communication → Ethernet
```

| Field | Set To |
|---|---|
| IP Mode | Static |
| IP Address | e.g. `192.168.1.200` _(pick any free IP on your LAN)_ |
| Subnet Mask | `255.255.255.0` |
| Gateway | Your router IP, e.g. `192.168.1.1` |
| DNS | `8.8.8.8` |

Save and reboot if prompted.

---

## Step 2 — ADMS Server (on the device screen)

Exact menu path depends on firmware — try these in order:

```
Menu → Cloud → Server
Menu → Communication → Cloud Attd
Menu → Communication → ADMS
```

| Field | Value |
|---|---|
| Server Address | `api.gymsera.com` |
| Port | `443` |
| HTTPS / SSL | **Enabled** |
| Path / Domain | `/iclock` |

After saving, look for a **green cloud icon** or **"Connected"** status. If you see it, the device is talking to GymsEra.

---

## Step 3 — Enable Real-Time Push

```
Menu → Communication → Auto Push → ON
```

This ensures attendance events are sent immediately when a member scans, not queued.

---

## Step 4 — Register the Device in GymsEra

Call this API once per device (use Postman, curl, or the admin CMS when available):

```bash
curl -X POST https://api.gymsera.com/api/v1/admin/devices \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "TENANT_UUID",
    "branchId": "BRANCH_UUID",
    "serialNumber": "DEVICE_SERIAL",
    "name": "Main Gate Reader",
    "model": "ZK-F22",
    "ipAddress": "192.168.1.200"
  }'
```

> Find the serial number: **Menu → System Info → SN**

---

## Step 5 — Add a Member PIN

For each gym member who will use the biometric scanner:

### 5a. Register their PIN in GymsEra

```bash
curl -X POST https://api.gymsera.com/api/v1/admin/devices/DEVICE_ID/members \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "USER_UUID",
    "zkPin": 1001,
    "label": "Ahmed Khan"
  }'
```

> PIN must be a number between 1 and 9999999. Must be unique on each device.

### 5b. Enroll on the physical device

```
Menu → User Management → New User
  User ID / PIN  =  1001   ← same number as above
  Name           =  Ahmed Khan
  Role           =  Normal User
→ Enroll Fingerprint  (scan 3 times)
   OR
→ Enroll RFID Card   (tap card)
Save
```

---

## Verification Checklist

| Check | How to verify |
|---|---|
| Device is connected | `GET /api/v1/admin/devices/{id}` — `lastSeenAt` is within 2 minutes |
| Member scan is logged | `GET /api/v1/attendance` — new row with `entryMethod: "DEVICE"` |
| Heartbeat in server logs | Look for `[iClock] Heartbeat: SN=...` in API logs |
| Attendance parsed | Look for `[iClock] ATTLOG SN=...: accepted=1 skipped=0` |

---

## PIN Assignment Rules

| Rule | Detail |
|---|---|
| PIN range | 1 to 9999999 |
| Uniqueness | Each PIN must be unique **per device** |
| Cross-device | Same user can have different PINs on different devices |
| Recommended format | Use 4-digit PINs starting from 1001 (easy to manage) |

---

## Common Errors

| Symptom | Cause | Fix |
|---|---|---|
| Cloud icon red / no connection | Wrong server address, port, or path | Re-check Step 2 settings |
| `accepted=0 skipped=1` in logs | Member's PIN not in device_members table | Complete Step 5a |
| Attendance logged, no subscription | Member has no ACTIVE subscription for this branch | Member must have active subscription |
| Device not registered (403) | Serial not in devices table | Complete Step 4 |
| HTTPS error on device | Server SSL cert issue | Ensure cert is from a trusted CA |

---

## UUIDs Reference Sheet

Fill in and keep with this card:

| Item | UUID |
|---|---|
| Tenant ID | ________________________________ |
| Branch ID | ________________________________ |
| Device ID (after registration) | ________________________________ |
| Admin JWT (refresh monthly) | ________________________________ |

---

## API Quick Reference

```
Base URL: https://api.gymsera.com/api/v1

Register device:   POST   /admin/devices
List devices:      GET    /admin/devices?tenantId=XXX
Get device:        GET    /admin/devices/{id}
Update device:     PUT    /admin/devices/{id}
Delete device:     DELETE /admin/devices/{id}

Add member PIN:    POST   /admin/devices/{id}/members
List member PINs:  GET    /admin/devices/{id}/members
Remove member PIN: DELETE /admin/devices/{id}/members/{memberId}

View attendance:   GET    /attendance?branchId=XXX
```

---

_GymsEra — ZKTeco Config Card v1.0 — keep with the device installation_
