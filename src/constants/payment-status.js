const PaymentStatus = {
  PENDING: 'PENDING',
  STAFF_COLLECTED: 'STAFF_COLLECTED', // staff confirmed cash received; awaiting tenant final approval
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
  // PAY-08: a member's pending payment nobody verified before its deadline.
  // Nothing was activated; the payment can no longer be verified.
  EXPIRED: 'EXPIRED',
};

const PaymentMethod = {
  CASH: 'CASH',
  BANK_TRANSFER: 'BANK_TRANSFER',
  CARD: 'CARD',
  WALLET: 'WALLET',
  ONLINE: 'ONLINE',
  POS: 'POS',
  /**
   * TEST — development/QA only.
   * Requires `X-Test-Payment-Key` header matching PAYMENT_TEST_KEY env var.
   * Always auto-completes — use to exercise full payment + invoice + subscription flows
   * without a real payment gateway.
   */
  TEST: 'TEST',
};

const InvoiceStatus = {
  DRAFT: 'DRAFT',
  ISSUED: 'ISSUED',
  PAID: 'PAID',
  OVERDUE: 'OVERDUE',
  CANCELLED: 'CANCELLED',
};

module.exports = { PaymentStatus, PaymentMethod, InvoiceStatus };

