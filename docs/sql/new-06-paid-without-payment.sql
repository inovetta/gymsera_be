-- NEW-06 — READ-ONLY. Finds tenants on a plan marked PAID with no evidence that anyone paid.
-- Every statement is a SELECT. Run against the PLATFORM database (the one holding tenant_subscriptions).
--
-- Background: until the NEW-06 fix, POST /host/subscription/upgrade let any host create an
-- ACTIVE / PAID row for any PlatformPackage with no payment. Those rows look like this:
--   platform = 'MANUAL', platform_package_id set, billing_plan_id NULL, payment_status = 'PAID',
--   no external ids, no last_verified_at, no bank_transfer_ref, auto_renew = 1.
--
-- A PAID row counts as paid when ANY of these holds:
--   store    platform IN ('IOS','ANDROID','STRIPE') AND last_verified_at IS NOT NULL (the provider confirmed it)
--   bank     bank_transfer_ref is set, or external_transaction_id starts with 'bank:' (admin verified a pay-later tenant)
--   invoice  the tenant has a platform_invoices row with status = 'PAID'
-- Anything else is "unexplained". Unexplained does not prove fraud (an old manual deal an admin
-- marked paid by hand would show here too): it is the list to look at.

-- 1. The tenants to look at: unexplained PAID rows, newest first.
SELECT
  t.id                      AS tenant_id,
  t.business_name,
  t.status                  AS tenant_status,
  s.id                      AS subscription_id,
  s.status                  AS subscription_status,
  s.platform,
  s.platform_package_id,
  s.billing_plan_id,
  s.amount,
  s.currency,
  s.start_date,
  s.end_date,
  s.auto_renew,
  s.created_at
FROM tenant_subscriptions s
JOIN tenants t ON t.id = s.tenant_id
WHERE s.payment_status = 'PAID'
  AND NOT (s.platform IN ('IOS','ANDROID','STRIPE') AND s.last_verified_at IS NOT NULL)
  AND (s.bank_transfer_ref IS NULL OR s.bank_transfer_ref = '')
  AND (s.external_transaction_id IS NULL OR s.external_transaction_id NOT LIKE 'bank:%')
  AND NOT EXISTS (
    SELECT 1 FROM platform_invoices i WHERE i.tenant_id = s.tenant_id AND i.status = 'PAID'
  )
ORDER BY s.created_at DESC;

-- 2. The same rows that match the exact NEW-06 signature (strongest suspects).
SELECT s.tenant_id, s.id AS subscription_id, s.platform_package_id, s.amount, s.start_date, s.end_date, s.status, s.created_at
FROM tenant_subscriptions s
WHERE s.payment_status = 'PAID'
  AND s.platform = 'MANUAL'
  AND s.platform_package_id IS NOT NULL
  AND s.billing_plan_id IS NULL
  AND s.external_original_transaction_id IS NULL
  AND s.external_transaction_id IS NULL
  AND s.last_verified_at IS NULL
  AND (s.bank_transfer_ref IS NULL OR s.bank_transfer_ref = '')
ORDER BY s.created_at DESC;

-- 3. Tenants that are entitled to branches right now (ACTIVE or GRACE) through an unexplained PAID row.
--    These are the ones that actually get something for free today.
SELECT s.tenant_id, s.id AS subscription_id, s.status, s.platform, s.end_date
FROM tenant_subscriptions s
WHERE s.status IN ('ACTIVE','GRACE')
  AND s.payment_status = 'PAID'
  AND NOT (s.platform IN ('IOS','ANDROID','STRIPE') AND s.last_verified_at IS NOT NULL)
  AND (s.bank_transfer_ref IS NULL OR s.bank_transfer_ref = '')
  AND (s.external_transaction_id IS NULL OR s.external_transaction_id NOT LIKE 'bank:%')
  AND NOT EXISTS (SELECT 1 FROM platform_invoices i WHERE i.tenant_id = s.tenant_id AND i.status = 'PAID');

-- 4. Context for the list: how every PAID row is explained (counts per reason).
SELECT
  CASE
    WHEN s.platform IN ('IOS','ANDROID','STRIPE') AND s.last_verified_at IS NOT NULL THEN 'store-verified'
    WHEN (s.bank_transfer_ref IS NOT NULL AND s.bank_transfer_ref <> '') OR s.external_transaction_id LIKE 'bank:%' THEN 'bank-verified'
    WHEN EXISTS (SELECT 1 FROM platform_invoices i WHERE i.tenant_id = s.tenant_id AND i.status = 'PAID') THEN 'paid platform invoice'
    ELSE 'UNEXPLAINED'
  END AS evidence,
  COUNT(*) AS rows_n
FROM tenant_subscriptions s
WHERE s.payment_status = 'PAID'
GROUP BY evidence;
