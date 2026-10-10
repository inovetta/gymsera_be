# NODEMAILER-10: Upgrade Nodemailer to 10.x (Patched Major Version)

- **Issue**: High-severity security advisories in `nodemailer <= 10.0.5` (15 GitHub security advisories including SMTP command injection, addressparser ReDoS, header injection, and DNS cache cross-tenant leakage).
- **Resolution**: Upgraded `nodemailer` to `^10.1.0` (resolved `10.1.0`). Dependency upgrade only. Zero code modifications required in `src/` — full backward compatibility maintained for our SMTP usage.

---

## 1. What Changed

- **`package.json`**: Updated `"nodemailer": "^6.9.15"` to `"nodemailer": "^10.1.0"`.
- **`package-lock.json`**: Resolved `nodemailer` from `6.10.1` to `10.1.0` (engines: `node >= 20.0.0`). No other dependencies touched.
- **`src/services/email.service.js`**: No changes required. The `mailTransport` test seam (`mailTransport.send`) and template senders work identically.
- **`src/config/smtp.config.js`**: No changes required. `assertSmtpConfigured()` and SMTP configuration options `{ host, port, secure, auth, tls }` remain unchanged.

---

## 2. Breaking Changes Checked Across v7.0.0 – v10.1.0

Every breaking change between 6.10.1 and 10.1.0 was audited against GymsEra codebase usage:

| Breaking Change / Area | Upstream Version | GymsEra Usage & Impact Assessment |
|---|---|---|
| **SES v2/v3 SDK migration** (removed older SES SDKs and SES rate limiting) | v7.0.0 | **Not affected.** GymsEra connects directly to SMTP (`mail.gymsera.com:587`), not AWS SES transport. |
| **Error code rename** (`NoAuth` -> `ENOAUTH`) | v8.0.0 | **Not affected.** GymsEra logs `err.message` and rethrows; does not branch on `'NoAuth'`. |
| **DNS fallback hardening** (alternative DNS addresses fallback) | v8.0.0 | **Compatible.** Standard SMTP connection resolution remains compatible with our host config. |
| **TLS validation for remote content** (remote URLs, OAuth2 tokens, proxy CONNECT validate TLS cert by default) | v9.0.0 | **Not affected.** GymsEra does not use remote URL attachments, OAuth2 token endpoints, or HTTP/HTTPS proxy CONNECT. |
| **Node.js Engine >= 20.0.0 required** | v10.0.0 | **Verified.** Current runtime environment is Node v20.19.0. |
| **TypeScript migration (ESM & CJS)** | v10.0.0 | **Verified.** CommonJS `require('nodemailer')` in `src/services/email.service.js` continues to load and operate seamlessly. |
| **Enforce `disableFileAccess`/`disableUrlAccess` for `raw`** | v10.0.0 | **Not affected.** GymsEra does not use the `raw` option. |
| **`createTransport` options** | All | **Compatible.** `{ host, port, secure, auth, tls }` are standard SMTP options and remain fully supported. |
| **`secure` / `port` / `auth`** | All | **Compatible.** Verified with port 587, `secure: false`, and standard username/password credentials. |
| **TLS settings** (`tls.rejectUnauthorized`) | All | **Compatible.** `tls: { rejectUnauthorized: false }` passed in `smtpConfig` is honored as expected. |
| **Attachments** | All | **Not affected.** GymsEra transactional emails send HTML and plain text bodies; no file or URL attachments are used. |
| **From / To handling & addressparser** | v10.0.x | **Compatible.** Standard formatted addresses (e.g., `GymsEra <noreply@gymsera.com>`) parse without issue; security patches eliminate exponential backtracking / DoS. |
| **`envelope` handling** | v10.0.x | **Not affected.** GymsEra relies on automatic envelope generation from `from` and `to`. Custom `envelope.size` parameter injection patched. |
| **List-* headers** | v10.0.x | **Not affected.** GymsEra does not set `List-*` headers. |
| **`jsonTransport`** | v10.0.x | **Not affected.** Not used in GymsEra. |
| **`disableFileAccess` / `disableUrlAccess`** | v10.0.x | **Not affected.** Not used in GymsEra. |
| **DNS Cache** | v10.0.2 | **Compatible.** Global DNS cache decoupling prevents TLS servername reuse across transports. |

---

## 3. Vulnerability Audit Results (`npm audit --omit=dev`)

### Before Upgrade (`nodemailer@6.10.1`)
- **Vulnerabilities**: 12 (11 moderate, 1 high)
- **High-severity advisory**: `nodemailer <=10.0.5`
- **Reported CVEs/GHSAs**: 15 advisories:
  - GHSA-mm7p-fcc7-pg87 (Interpretation Conflict)
  - GHSA-c7w3-x93f-qmm8 (SMTP command injection in `envelope.size`)
  - GHSA-vvjj-xcjg-gr5g (CRLF in Transport name option)
  - GHSA-268h-hp4c-crq3 (CRLF injection in List-* header comments)
  - GHSA-wqvq-jvpq-h66f (jsonTransport disableFileAccess/disableUrlAccess bypass)
  - GHSA-rcmh-qjqh-p98v (addressparser DoS recursive calls)
  - GHSA-p6gq-j5cr-w38f (Message-level raw option bypass)
  - GHSA-8m3c-c648-2xjj (resolveContent legacy signature bypass)
  - GHSA-wmmp-3585-3rmp (IDN/Punycode domain allow-list bypass)
  - GHSA-2x7j-588g-ccc2 (Quadratic time complexity in addressparser)
  - GHSA-cc9r-2j5m-2m83 (Recipient-domain validation bypass via RFC 5322 comment mis-parsing)
  - GHSA-6vj9-mwq6-2f5v (Process-global DNS cache TLS servername reuse)
  - GHSA-8vvx-rff5-p5rq (Nested structured recipient arrays parser depth limit)
  - GHSA-v53p-9fqp-m79j (Quadratic backtracking in addressparser free-text fallback)
  - GHSA-r7g4-qg5f-qqm2 (Improper TLS Certificate Validation in OAuth2 Token Fetch)

### After Upgrade (`nodemailer@10.1.0`)
- **Vulnerabilities**: 11 moderate (0 high)
- **Nodemailer advisories**: **0** (all 15 advisories resolved).
- Remaining moderate vulnerabilities are unrelated transitive dependencies (`qs` and `uuid`).

---

## 4. Test Results

- **Full test suite (`npm test`)**:
  - **Suites**: 150 passed, 150 total.
  - **Tests**: 1417 passed, 1417 total.
  - **Time**: 887.781 s (~14.8 minutes).
- **Targeted regression tests**:
  - `tests/regression/no-outbound-network.test.js`: 9 passed. Verified that real nodemailer SMTP send is stopped at DNS lookup before connection by the test network jail.
  - `tests/regression/smtp-no-fallback.test.js`: 4 passed. Verified startup error when SMTP credentials are missing and no hard-coded fallback exists.

---

## 5. Verification Notice & Manual Staging Checklist

> [!NOTE]
> Per spec §14 R-19, automated tests run inside an outbound network jail; no test connects to a live SMTP server.
> A live SMTP send over the network cannot be verified within the automated test harness. It must be verified in the staging environment.

### Staging Verification Checklist:
1. **Environment Setup**:
   - Confirm `.env` has:
     - `SMTP_HOST=mail.gymsera.com`
     - `SMTP_PORT=587`
     - `SMTP_SECURE=false`
     - `SMTP_USER=<configured user>`
     - `SMTP_PASS=<configured pass>`
     - `SMTP_FROM=GymsEra <noreply@gymsera.com>`
2. **Send OTP Email**:
   - Trigger member registration or email verification.
   - Inspect email delivered to mailbox:
     - Header `From`: matches `GymsEra <noreply@gymsera.com>`.
     - `Subject`: `GymsEra — Email Verification Code`.
     - `HTML body`: verification card with 6-digit code.
3. **Send Password Reset Email**:
   - Trigger forgot password request via `/auth/forgot-password`.
   - Inspect email delivered to mailbox:
     - Header `From` and `Subject` correct.
     - Reset link functional and body rendered correctly.
4. **Send Tenant Approval Email**:
   - Trigger tenant approval action in admin console.
   - Inspect email delivered to gym owner mailbox.
5. **Connection & TLS Handshake**:
   - Inspect server logs to verify STARTTLS upgrade on port 587 to `mail.gymsera.com:587`.
