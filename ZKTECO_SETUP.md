# ZKTeco Biometric Device Integration — GymsEra

## Overview

GymsEra supports ZKTeco fingerprint and RFID card readers natively via the **ZKTeco ADMS (Attendance Data Management System) protocol**. No separate middleware script or external service is required — the integration is built directly into the GymsEra API.

When a gym member scans their finger or RFID card on a ZKTeco device, the device pushes the event to your GymsEra API server in real time. The API looks up the member's GymsEra account, finds their active subscription, and records the attendance log automatically.

---

## Architecture

```
ZKTeco Device (fingerprint / RFID reader)
        │
        │  ADMS protocol — HTTP POST (plain text)
        │  Triggered on every scan, every 30-second heartbeat
        ▼
GymsEra API  →  /iclock/getrequest   (heartbeat)
              →  /iclock/cdata       (attendance push)
        │
        ▼
Platform DB  →  devices table       (device registry, PIN→user map)
             →  device_members table
        │
        ▼
Tenant DB    →  attendance_logs table
```

**No local PC or middleware script needed.** The ZKTeco device connects directly to your cloud API server.

---

## Database Tables (auto-created on server start)

### `devices` (Platform DB)
| Column | Type | Description |
|---|---|---|
| id | UUID | Primary key |
| tenant_id | UUID | Which gym tenant owns this device |
| branch_id | UUID | Which branch this device is installed at |
| serial_number | VARCHAR(100) | ZKTeco device serial number (unique) |
| name | VARCHAR(150) | Friendly name, e.g. "Main Gate Reader" |
| model | VARCHAR(100) | Device model, e.g. "ZK-F22" |
| ip_address | VARCHAR(50) | Device local IP (for reference) |
| status | ENUM | ACTIVE / INACTIVE |
| last_seen_at | DATETIME | Last heartbeat timestamp |
| last_sync_stamp | BIGINT | ZKTeco sync stamp (tracks upload position) |

### `device_members` (Platform DB)
| Column | Type | Description |
|---|---|---|
| id | UUID | Primary key |
| device_id | UUID | FK → devices.id |
| tenant_id | UUID | Denormalized for fast lookup |
| user_id | UUID | Platform user UUID |
| zk_pin | INTEGER | Numeric PIN on the ZKTeco device (1–9999999) |
| label | VARCHAR(200) | Optional display name |

---

## Setup Steps

### Step 1 — Register the Device in GymsEra

Before the device can push data, it must be registered in GymsEra so the system knows which tenant and branch it belongs to.

**Via Admin API:**
```
POST /api/v1/admin/devices
Authorization: Bearer <admin-jwt>
Content-Type: application/json

{
  "tenantId": "uuid-of-tenant",
  "branchId": "uuid-of-branch",
  "serialNumber": "ABC1234567",
  "name": "Main Gate Reader",
  "model": "ZK-F22",
  "ipAddress": "192.168.1.200"
}
```

Response includes the device `id` — save it.

**Via Gym Host API** (gym owner registers their own device):
```
POST /api/v1/devices
Authorization: Bearer <gym-host-jwt>
Content-Type: application/json

{
  "branchId": "uuid-of-branch",
  "serialNumber": "ABC1234567",
  "name": "Main Gate Reader",
  "model": "ZK-F22",
  "ipAddress": "192.168.1.200"
}
```

> **How to find the serial number**: On the ZKTeco device, go to **Menu → System Info** or **Menu → About**. The serial number is shown as "SN" or "Serial No".

---

### Step 2 — Configure the ZKTeco Device

The device must be told where to send attendance data. All configuration is done on the **device's touchscreen** or via the **ZKTeco web interface** (if the device model supports it).

#### 2a. Connect to your network

1. Connect the device to the gym's local network via **LAN cable** (recommended) or Wi-Fi (if supported).
2. On the device: **Menu → Communication → Ethernet**
3. Set a **static IP address** (e.g. `192.168.1.200`) so it doesn't change after reboots.
4. Set the correct **Subnet Mask** and **Gateway** for your network.

#### 2b. Configure the ADMS server URL

> This tells the device where to push attendance events.

**Menu path** (varies slightly by firmware version):
```
Menu → Cloud → Server
  OR
Menu → Communication → Cloud Attd
  OR
Menu → Communication → ADMS
```

Set the following values:

| Field | Value |
|---|---|
| **Server Address** | `your-api-domain.com` (no `https://`, just the domain) |
| **Server Port** | `443` (HTTPS) or `80` (HTTP) |
| **HTTPS** | Enable if your server uses HTTPS (recommended) |
| **Path** | `/iclock` |

> **Example**: If your API is at `https://api.gymsera.com`, the server address is `api.gymsera.com`, port `443`, HTTPS enabled, path `/iclock`.

After saving, the device will attempt to connect. A green cloud icon or "Connected" status means it's working.

#### 2c. Enable Real-Time Push

Make sure "Real-Time Push" or "Auto Push" is enabled so the device sends events immediately when they happen (rather than queuing them).

```
Menu → Communication → Auto Push → Enable
```

---

### Step 3 — Enroll Members on the Device

Each member who should be able to use the biometric scanner needs to be:
1. **Assigned a PIN** in GymsEra (a number 1–9999999)
2. **Enrolled on the device** with the same PIN + their fingerprint / RFID card

#### 3a. Assign a PIN in GymsEra

```
POST /api/v1/admin/devices/{deviceId}/members
Authorization: Bearer <admin-jwt>
Content-Type: application/json

{
  "userId": "platform-user-uuid",
  "zkPin": 1001,
  "label": "Ahmed Khan"
}
```

Or via the Gym Host API:
```
POST /api/v1/devices/{deviceId}/members
Authorization: Bearer <gym-host-jwt>

{
  "userId": "platform-user-uuid",
  "zkPin": 1001,
  "label": "Ahmed Khan"
}
```

> **PIN rules**: Must be a unique integer on each device. Keep PINs short (4 digits recommended). The same user can have different PINs on different devices.

#### 3b. Enroll on the physical device

On the ZKTeco device:
1. **Menu → User Management → New User**
2. Set **User ID / PIN** = the same number you assigned in GymsEra (e.g. `1001`)
3. Set **Name** = member's name (optional, for display on device)
4. Set **Role** = Normal User
5. Scan their **fingerprint** (place finger 3 times) and/or register their **RFID card**
6. Save

Repeat for each member.

---

### Step 4 — Test the Connection

#### Test the heartbeat

The device sends a heartbeat every 30 seconds. You can verify it's registered by checking the `last_seen_at` field:

```
GET /api/v1/admin/devices/{deviceId}
Authorization: Bearer <admin-jwt>
```

If `lastSeenAt` is recent (within the last 2 minutes), the device is connected and communicating.

#### Test attendance logging

1. Have a registered member scan their fingerprint on the device.
2. Check the attendance logs:

```
GET /api/v1/attendance?branchId={branchId}
Authorization: Bearer <gym-host-jwt>
x-tenant-id: {tenantId}
```

You should see a new log entry with `entryMethod: "DEVICE"` and the correct `userId`.

---

## API Reference

### Device Management (Admin)

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/admin/devices` | List all devices (filter by `?tenantId=`) |
| POST | `/api/v1/admin/devices` | Register a device |
| GET | `/api/v1/admin/devices/:id` | Get device details |
| PUT | `/api/v1/admin/devices/:id` | Update device (name, status, IP, branchId) |
| DELETE | `/api/v1/admin/devices/:id` | Delete device and all its PIN mappings |
| GET | `/api/v1/admin/devices/:id/members` | List all PIN mappings |
| POST | `/api/v1/admin/devices/:id/members` | Assign a PIN to a user |
| DELETE | `/api/v1/admin/devices/:id/members/:memberId` | Remove a PIN mapping |

### Device Management (Gym Host)

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/devices` | List own devices |
| POST | `/api/v1/devices` | Register a device for own tenant |
| PUT | `/api/v1/devices/:id` | Update own device |
| DELETE | `/api/v1/devices/:id` | Delete own device |
| GET | `/api/v1/devices/:id/members` | List PIN mappings |
| POST | `/api/v1/devices/:id/members` | Add PIN mapping |
| DELETE | `/api/v1/devices/:id/members/:memberId` | Remove PIN mapping |

### ADMS Protocol (ZKTeco device → server)

| Method | Path | Description |
|---|---|---|
| GET | `/iclock/getrequest?SN={serial}` | Device heartbeat |
| POST | `/iclock/cdata?SN={serial}&table=ATTLOG` | Attendance push |
| GET | `/iclock/cdata?SN={serial}&table=ATTLOG&Stamp=...` | Sync request |
| POST | `/iclock/devicecmd` | Device command response (acknowledged) |

---

## Attendance Log Entry

Each scan creates an entry in the tenant's `attendance_logs` table:

```json
{
  "id": "uuid",
  "branchId": "branch-uuid",
  "userId": "platform-user-uuid",
  "memberSubscriptionId": "subscription-uuid or null",
  "attendanceType": "CHECK_IN",
  "checkInAt": "2026-06-03T09:32:00.000Z",
  "entryMethod": "DEVICE",
  "deviceId": "ABC1234567"
}
```

> `memberSubscriptionId` can be `null` if the member has no active subscription at that branch (the log is still recorded for audit purposes).

---

## Supported ZKTeco Device Models

Any ZKTeco device that supports the **ADMS/Cloud Attd** feature works. Common compatible models:

- ZK-F22 / F18 / F21
- ZK-UA860 / UA870 / UA880
- ZK-K40 / K50 / K60
- ZK-C3-100 / C3-200 / C3-400
- ZK-IN01 / IN02
- ZK-SpeedFace series (face recognition)
- ZK-ProFace series

Models that do **not** support ADMS (older firmware) require a different integration approach. Contact ZKTeco support to confirm ADMS support for your specific model.

---

## Troubleshooting

### Device shows "Disconnected" or no heartbeat

1. Verify the server address, port, and path are entered correctly on the device.
2. Ensure the device can reach your server — test by pinging the domain from the same network.
3. Check your server's firewall allows inbound connections on port 443/80.
4. If using HTTPS, ensure your SSL certificate is valid (not self-signed; ZKTeco devices may reject self-signed certs).

### Scans not appearing in attendance logs

1. Check that the member's PIN in GymsEra matches the PIN enrolled on the device exactly.
2. Verify the member has an **ACTIVE** subscription for the correct branch.
3. Check the API logs for `[iClock] ATTLOG` entries — they will show `accepted` and `skipped` counts.
4. A `skipped` count means the PIN was not found in the `device_members` table.

### "Device not registered" error in logs

The device's serial number is not in the `devices` table. Complete Step 1 (register the device via API).

### Wrong branch getting attendance

The `branchId` stored in the `devices` table determines which branch attendance is logged against. Update the device's `branchId` if the device was moved:

```
PUT /api/v1/admin/devices/{deviceId}
{ "branchId": "correct-branch-uuid" }
```

---

## Security Notes

- ADMS endpoints (`/iclock/*`) authenticate by **device serial number**. Only devices registered in the `devices` table are accepted; all others receive HTTP 403.
- The serial number is embedded in hardware and cannot be spoofed without physical device access.
- For additional security, ensure your server is behind HTTPS and the ZKTeco device is configured to use HTTPS.
- The `/api/v1/attendance/device-notify` endpoint (legacy JSON push) still exists and requires the `x-device-api-key` header. It is kept for compatibility but the ADMS protocol is preferred.
