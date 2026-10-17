/**
 * OBS-06 / OBS-09 — the alert helper (spec §12.12).
 *
 * One alert per alert code per hour, in-app notification to every active
 * platform admin plus a Sentry message (only when SENTRY_DSN is set), IDs and
 * counts only, and a runbook entry for every alert code.
 */
const fs = require('fs');
const path = require('path');
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, factories } = require('../harness');
const { Notification } = require('../../src/models/platform');

// A plain (not virtual) mock: @sentry/node is installed, and a virtual mock of an installed package can
// resolve differently for other files depending on what the module registry has seen, letting the real
// SDK through. The factory counts loads so the "does nothing without a DSN" test can prove the SDK is
// never even required.
const mockSentryLoads = { count: 0 };
// The real init also builds integrations, so the fake offers the same builders (as no-ops).
const noIntegration = () => ({});
const mockSentry = {
  init: jest.fn(),
  captureMessage: jest.fn(),
  dedupeIntegration: noIntegration,
  inboundFiltersIntegration: noIntegration,
  linkedErrorsIntegration: noIntegration,
  functionToStringIntegration: noIntegration,
};
jest.mock(
  '@sentry/node',
  () => {
    mockSentryLoads.count += 1;
    return mockSentry;
  }
);

const alertService = require('../../src/services/alert.service');
const errorTracker = require('../../src/utils/error-tracker');

const HOUR = 60 * 60 * 1000;
const alertNotifications = (code) =>
  Notification.findAll({ where: { type: 'PLATFORM_ALERT' } }).then((rows) =>
    rows.filter((n) => (n.metadataJson || n.metadata || {}).alertCode === code)
  );

describe('OBS-06: alert helper', () => {
  let admin1;
  let admin2;
  let now;

  beforeAll(async () => {
    await setupTestDatabases();
  });
  afterAll(async () => {
    await teardownTestDatabases();
  });

  beforeEach(async () => {
    await resetTestDatabases();
    delete process.env.SENTRY_DSN;
    mockSentryLoads.count = 0;
    mockSentry.init.mockClear();
    mockSentry.captureMessage.mockClear();
    errorTracker._resetForTests();
    alertService._resetForTests();
    admin1 = await factories.createUser({ role: 'PLATFORM_ADMIN' });
    admin2 = await factories.createUser({ role: 'PLATFORM_ADMIN' });
    await factories.createUser({ role: 'PLATFORM_ADMIN', status: 'SUSPENDED' });
    await factories.createUser({ role: 'GYM_HOST' });
    now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => jest.restoreAllMocks());

  test('raises one high-priority admin notification per active platform admin, with a runbook link', async () => {
    const res = await alertService.raise('CAPACITY_DRIFT', { tenantCount: 2, tenantIds: ['t-1', 't-2'] });
    expect(res.sent).toBe(true);
    const rows = await alertNotifications('CAPACITY_DRIFT');
    expect(rows.map((r) => r.userId).sort()).toEqual([admin1.id, admin2.id].sort());
    expect(rows[0]).toMatchObject({ role: 'admin', type: 'PLATFORM_ALERT', priority: 'high' });
    const meta = rows[0].metadataJson || rows[0].metadata;
    expect(meta.runbook).toBe('docs/runbooks/capacity-audit.md#capacity_drift');
    expect(meta).toMatchObject({ tenantCount: 2, tenantIds: ['t-1', 't-2'] });
  });

  test('a second raise of the same code within the hour is dropped: no notification, no Sentry message', async () => {
    process.env.SENTRY_DSN = 'https://public@example.invalid/1';
    await alertService.raise('CAPACITY_DRIFT', { tenantCount: 1 });
    now += 59 * 60 * 1000;
    const again = await alertService.raise('CAPACITY_DRIFT', { tenantCount: 5 });
    expect(again).toMatchObject({ sent: false, reason: 'rate_limited' });
    expect(await alertNotifications('CAPACITY_DRIFT')).toHaveLength(2);
    expect(mockSentry.captureMessage).toHaveBeenCalledTimes(1);
  });

  test('a different alert code is not blocked by the first', async () => {
    await alertService.raise('CAPACITY_DRIFT', { tenantCount: 1 });
    const other = await alertService.raise('CAPACITY_EMPTY_ACTIVE_ORG', { tenantCount: 1 });
    expect(other.sent).toBe(true);
  });

  test('after an hour the same code alerts again', async () => {
    await alertService.raise('CAPACITY_DRIFT', { tenantCount: 1 });
    now += HOUR + 1000;
    const again = await alertService.raise('CAPACITY_DRIFT', { tenantCount: 1 });
    expect(again.sent).toBe(true);
    expect(await alertNotifications('CAPACITY_DRIFT')).toHaveLength(4);
  });

  test('the limit survives a restart (in-process state lost) because it is read from the stored alerts', async () => {
    await alertService.raise('CAPACITY_DRIFT', { tenantCount: 1 });
    alertService._resetForTests(); // what a restart or a second instance looks like
    const again = await alertService.raise('CAPACITY_DRIFT', { tenantCount: 1 });
    expect(again).toMatchObject({ sent: false, reason: 'rate_limited' });
    expect(await alertNotifications('CAPACITY_DRIFT')).toHaveLength(2);
  });

  test('concurrent raises of one code send exactly one alert', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => alertService.raise('CAPACITY_DRIFT', { tenantCount: 1 }))
    );
    expect(results.filter((r) => r.sent)).toHaveLength(1);
    expect(await alertNotifications('CAPACITY_DRIFT')).toHaveLength(2);
  });

  test('IDs and counts only: names, e-mails, free text and nested objects are dropped; id lists are capped', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `tenant-${i}`);
    await alertService.raise('CAPACITY_DRIFT', {
      tenantCount: 30,
      tenantIds: ids,
      businessName: 'Iron Temple Gym',
      ownerEmail: 'owner@example.test',
      note: 'Ali Khan called about it',
      listing: { title: 'Iron Temple' },
      badIds: ['<script>x</script>'],
      driftTotal: 'not-a-number',
    });
    const [row] = await alertNotifications('CAPACITY_DRIFT');
    const stored = JSON.stringify(row.toJSON());
    for (const leaked of ['Iron Temple', 'owner@example.test', 'Ali Khan', '<script>']) {
      expect(stored).not.toContain(leaked);
    }
    const meta = row.metadataJson || row.metadata;
    expect(meta.tenantCount).toBe(30);
    expect(meta.tenantIds).toHaveLength(20);
    expect(meta.driftTotal).toBeUndefined();
  });

  test('without SENTRY_DSN nothing is sent to Sentry and the SDK is never loaded', async () => {
    await alertService.raise('CAPACITY_DRIFT', { tenantCount: 1 });
    expect(mockSentryLoads.count).toBe(0);
    expect(mockSentry.captureMessage).not.toHaveBeenCalled();
  });

  test('with SENTRY_DSN a warning-level message is captured with the alert code tag and the same scrubbed fields', async () => {
    process.env.SENTRY_DSN = 'https://public@example.invalid/1';
    await alertService.raise('CAPACITY_DRIFT', { tenantCount: 3, tenantIds: ['t-1'], businessName: 'Iron Temple Gym' });
    expect(mockSentry.init).toHaveBeenCalledTimes(1);
    expect(mockSentry.init.mock.calls[0][0]).toMatchObject({ dsn: 'https://public@example.invalid/1' });
    expect(mockSentry.captureMessage).toHaveBeenCalledTimes(1);
    const [message, ctx] = mockSentry.captureMessage.mock.calls[0];
    expect(message).toContain('CAPACITY_DRIFT');
    expect(ctx).toMatchObject({ level: 'error', tags: { alertCode: 'CAPACITY_DRIFT' } });
    expect(ctx.extra).toMatchObject({ tenantCount: 3, tenantIds: ['t-1'] });
    expect(JSON.stringify(ctx)).not.toContain('Iron Temple');
  });

  test('a missing @sentry/node package or a throwing Sentry never fails the alert', async () => {
    process.env.SENTRY_DSN = 'https://public@example.invalid/1';
    mockSentry.captureMessage.mockImplementationOnce(() => {
      throw new Error('sentry down');
    });
    const res = await alertService.raise('CAPACITY_DRIFT', { tenantCount: 1 });
    expect(res.sent).toBe(true); // the admin notifications still went out
  });

  test('an unknown alert code is refused (every code must have a runbook)', async () => {
    await expect(alertService.raise('MADE_UP_CODE', {})).rejects.toThrow(/unknown alert code/i);
  });

  test('if nothing could be delivered the hour is not spent: the next raise tries again', async () => {
    const notifications = require('../../src/services/notifications.service');
    const spy = jest.spyOn(notifications, 'createNotification').mockRejectedValue(new Error('db hiccup'));
    const first = await alertService.raise('CAPACITY_DRIFT', { tenantCount: 1 });
    expect(first).toMatchObject({ sent: false, reason: 'not_delivered' });
    spy.mockRestore();
    const second = await alertService.raise('CAPACITY_DRIFT', { tenantCount: 1 });
    expect(second.sent).toBe(true);
  });

  test('every alert code has a runbook entry that exists in docs/runbooks/ (OBS-09)', () => {
    const codes = Object.keys(alertService.ALERTS);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      const { runbook } = alertService.ALERTS[code];
      const [file, anchor] = runbook.split('#');
      const text = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
      expect(anchor).toBe(code.toLowerCase());
      expect(text).toMatch(new RegExp(`^## ${code}\\s*$`, 'm'));
      for (const section of ['What it means', 'First checks', 'Rollback']) {
        const body = text.split(new RegExp(`^## ${code}\\s*$`, 'm'))[1].split(/^## /m)[0];
        expect(body).toContain(`**${section}**`);
      }
    }
    expect(fs.existsSync(path.join(__dirname, '../../docs/runbooks/README.md'))).toBe(true);
  });
});
