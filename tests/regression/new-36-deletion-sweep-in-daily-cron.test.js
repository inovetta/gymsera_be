/**
 * NEW-36 (Prompt 1I follow-up): the day-30 account deletion sweep runs in the existing daily job
 * (`runExpiryCheck`, hit by node-cron in server.js and by the Vercel cron `/cron/subscription-expiry`).
 */
const { v4: uuidv4 } = require('uuid');
const { setupTestDatabases, teardownTestDatabases, factories } = require('../harness');
const { installMailFake } = require('../harness/mail-fake');
const { User } = require('../../src/models/platform');
const finalize = require('../../src/services/account-deletion-finalize.service');
const accountDeletion = require('../../src/services/account-deletion.service');
const { runExpiryCheck } = require('../../src/jobs/subscription-expiry.cron');

describe('NEW-36: deletion sweep in the daily cron', () => {
  beforeAll(async () => {
    await setupTestDatabases();
  });
  afterAll(async () => {
    await teardownTestDatabases();
  });
  beforeEach(() => {
    installMailFake();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('the daily run invokes the sweep in APPLY mode (no dryRun)', async () => {
    const spy = jest.spyOn(finalize, 'runDeletionFinalizeSweep');
    await runExpiryCheck();
    expect(spy).toHaveBeenCalledTimes(1);
    const args = spy.mock.calls[0][0] || {};
    expect(args.dryRun).not.toBe(true);
  });

  test('a due deletion is really finalized by the cron; one still inside its 30 days is not', async () => {
    const due = await factories.createUser({ role: 'MEMBER', email: `due_${uuidv4().slice(0, 6)}@gymseratest.com` });
    const waiting = await factories.createUser({ role: 'MEMBER', email: `wait_${uuidv4().slice(0, 6)}@gymseratest.com` });
    await accountDeletion.requestDeletion(due.id, { password: 'Test@12345' });
    await accountDeletion.requestDeletion(waiting.id, { password: 'Test@12345' });
    await User.update({ deletionScheduledFor: new Date(Date.now() - 60 * 1000) }, { where: { id: due.id } });

    await runExpiryCheck();

    expect((await User.findByPk(due.id)).status).toBe('DELETED');
    expect((await User.findByPk(waiting.id)).status).toBe('PENDING_DELETION');
  });

  test('a failing sweep does not stop the rest of the daily job', async () => {
    jest.spyOn(finalize, 'runDeletionFinalizeSweep').mockRejectedValue(new Error('boom'));
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runExpiryCheck()).resolves.toBeUndefined();
    expect(errors.mock.calls.flat().join(' ')).toMatch(/Account deletion sweep failed: boom/);
  });
});
