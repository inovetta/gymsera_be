# Store price check (BILL-15)

A daily, **read-only** job (03:40 server time, `PRICE_VERIFICATION_CRON` to change it) reads each active plan's
subscription product from the Play Developer API and compares the catalog prices with the base-plan prices in
Play Console. It never changes a price, a plan or a sync status; it only records what it found
(`billing_plan_price_checks`) and raises the alerts below. It does nothing unless `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`
and `GOOGLE_PLAY_PACKAGE_NAME` are set. Run it by hand with `node src/scripts/run-price-verification.js`.

iOS is not checked: Apple's App Store Server API cannot read product prices (it needs an App Store Connect API
key, which is not set up). iOS prices stay **admin-attested**, and so does any plan whose product is not in Play
Console yet.

How a match is decided: for each price the catalog holds in a currency, Google holds the same amount for that
currency in at least one region. The billing period must also be one month (monthly) or one year (annual).

## BILLING_PRICE_MISMATCH

**What it means**
`mismatchCount` active billing plans (`planIds`, up to 20) have a price in the catalog that Play Console does not
hold for the same currency, or a base plan with the wrong billing period. People buying that plan on Android pay
the Play Console price, not the catalog price.

**First checks**
1. Admin > Billing plans: the plan shows "Mismatch" with the date of the check. Open its details (monthly / annual, currency, what the catalog expects and what Google holds, in minor units).
2. Decide which side is right. Usually the catalog was edited and Play Console was not (or the other way round).
3. Fix it where it is wrong: edit the catalog price in the admin, or change the base plan price in Play Console. Prices of existing subscribers are not affected either way (they keep the price they bought at).
4. Re-run `node src/scripts/run-price-verification.js` to confirm; the badge turns to "Verified".

**Rollback**
The job changed nothing, so there is nothing to undo. If the check itself is wrong (for example a region lists the
same currency at a deliberately different price), at least one region must still carry the catalog amount to count
as a match; otherwise the plan stays "Mismatch" until the catalog or Play Console is aligned.

## BILLING_PRICE_CHECK_FAILED

**What it means**
The job could not read `failureCount` plans from Google (not "product missing", which is recorded quietly as
unverifiable). Those plans were not checked tonight and keep their previous result until it is 48 hours old, after
which the screen shows "admin-attested" again.

**First checks**
1. Logs: `[PriceVerification] Google read failed for plan <id>: <message>`. A 401/403 means the service account lost access or the Play Console permission "View app information and download bulk reports" / "Manage store presence" is missing.
2. `GOOGLE_PLAY_PACKAGE_NAME` must match the app in Play Console exactly.
3. If every plan failed, check the service-account JSON in the environment and Google's status page.

**Rollback**
Nothing was changed. Fix the credential or permission, then run `node src/scripts/run-price-verification.js`.
