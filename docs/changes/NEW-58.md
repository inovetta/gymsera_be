# NEW-58: payments list validator rejects status=STAFF_COLLECTED

- **Issue ID**: NEW-58
- **Title**: Payments list validator rejects `status=STAFF_COLLECTED`
- **Status**: RESOLVED

## Root cause

In `src/validators/payments.validator.js:42-45`, the `listPayments` validator validated `query('status')` with a hardcoded array:
```javascript
query('status')
  .optional()
  .isIn(['PENDING', 'COMPLETED', 'FAILED', 'REFUNDED', 'EXPIRED'])
  .withMessage('Invalid status')
```
This rejected any request with `status=STAFF_COLLECTED` with HTTP 422 `Invalid status`.

However, in `src/constants/payment-status.js:3` and `src/models/tenant/Payment.model.js:50,78,82`:
`STAFF_COLLECTED` is a core first-class status representing step 1 of 2-step verification: cash received in hand by a staff collector (`staffCollectedBy`, `collectedAt`) awaiting final verification (`verifiedBy`, `verifiedAt`) by an authorized manager or host to transition to `COMPLETED`.
Even the Swagger documentation at `src/routes/payments.routes.js:142` already advertised `STAFF_COLLECTED` in the query schema.
The query service in `src/services/payment.service.js:352` already uses `if (status) where.status = status;` directly against the database enum.

## What changed

1. `src/validators/payments.validator.js`: imported `PaymentStatus` from `../constants/payment-status` and defined `PAYMENT_STATUSES = Object.values(PaymentStatus)`, allowing all valid statuses (`['PENDING', 'STAFF_COLLECTED', 'COMPLETED', 'FAILED', 'REFUNDED', 'EXPIRED']`).
2. `src/routes/payments.routes.js`: updated Swagger query schema enum to include all valid statuses.

## Tests

`tests/regression/new-58-59-60-payouts-reports-collected.test.js`:
- `GET /payments?branchId=...&status=STAFF_COLLECTED` returns 200 and matches payments with status `STAFF_COLLECTED`.
- Manager of branch A can filter `status=STAFF_COLLECTED` at their permitted branch.
- Invalid status (`INVALID_STATUS`) is rejected with 422 (validation integrity preserved).

## Clients that might depend on old behaviour

- **CMS**: Prompt 3C noted that filtering the "Collected" tab failed with 422 and worked around it client-side. The CMS can now request `GET /payments?status=STAFF_COLLECTED` directly from the backend.
- **Mobile**: No breaking change; previously any client requesting `status=STAFF_COLLECTED` received 422, now successfully receives the collected payments.
