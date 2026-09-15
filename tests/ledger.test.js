/**
 * Ledger — business dates, day lifecycle, reconciliation, and the race-safe close.
 *
 * The ledger deliberately holds no copy of "what was collected" — that's the
 * `payments` table, filtered by branch + business date. These tests cover the two
 * things that do live here: LedgerDay's OPEN/CLOSED state machine (and its
 * concurrency-safety), and LedgerAdjustment's append-only reconciliation trail.
 */
jest.mock('../src/services/audit.service', () => ({
  record: jest.fn().mockResolvedValue(null),
  snapshot: jest.fn((x) => x),
}));

const auditService = require('../src/services/audit.service');
const ledgerService = require('../src/services/ledger.service');

describe('computeBusinessDate — timezone-safe business dates', () => {
  it('resolves a UTC-late-evening timestamp to the next branch-local day', () => {
    // 2026-01-01 20:30 UTC is already 2026-01-02 01:30 in Asia/Karachi (+5:00)
    const result = ledgerService.computeBusinessDate(new Date('2026-01-01T20:30:00Z'), 'Asia/Karachi');
    expect(result).toBe('2026-01-02');
  });

  it('falls back to Asia/Karachi when no timezone is given', () => {
    const withDefault = ledgerService.computeBusinessDate(new Date('2026-01-01T20:30:00Z'), undefined);
    expect(withDefault).toBe('2026-01-02');
  });

  it('is stable for a mid-day UTC timestamp regardless of timezone offset direction', () => {
    const result = ledgerService.computeBusinessDate(new Date('2026-06-15T12:00:00Z'), 'America/New_York');
    expect(result).toBe('2026-06-15');
  });
});

describe('weekRange / monthRange — pure date math', () => {
  it('weekRange returns the Monday-to-Sunday span containing the date', () => {
    // 2026-09-16 is a Wednesday
    const [from, to] = ledgerService.weekRange('2026-09-16');
    expect(from).toBe('2026-09-14'); // Monday
    expect(to).toBe('2026-09-20'); // Sunday
  });

  it('weekRange handles a Sunday correctly (week ending, not starting)', () => {
    const [from, to] = ledgerService.weekRange('2026-09-20'); // Sunday
    expect(from).toBe('2026-09-14');
    expect(to).toBe('2026-09-20');
  });

  it('monthRange returns the first and last calendar day of the month', () => {
    const [from, to] = ledgerService.monthRange('2026-02-15');
    expect(from).toBe('2026-02-01');
    expect(to).toBe('2026-02-28'); // 2026 is not a leap year
  });

  it('monthRange handles a leap year February correctly', () => {
    const [from, to] = ledgerService.monthRange('2028-02-10');
    expect(to).toBe('2028-02-29');
  });
});

describe('getOrCreateLedgerDay', () => {
  it('reuses an existing row rather than creating a duplicate', async () => {
    const existing = { id: 'day-1', branchId: 'branch-1', businessDate: '2026-09-15', status: 'OPEN' };
    const LedgerDay = {
      findOne: jest.fn().mockResolvedValue(existing),
      create: jest.fn(),
    };
    const tenantDb = { models: { LedgerDay } };

    const result = await ledgerService.getOrCreateLedgerDay(tenantDb, 'branch-1', '2026-09-15');

    expect(result).toBe(existing);
    expect(LedgerDay.create).not.toHaveBeenCalled();
  });

  it('creates a new OPEN day on first touch', async () => {
    const created = { id: 'day-2', branchId: 'branch-1', businessDate: '2026-09-15', status: 'OPEN' };
    const LedgerDay = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(created),
    };
    const tenantDb = { models: { LedgerDay } };

    const result = await ledgerService.getOrCreateLedgerDay(tenantDb, 'branch-1', '2026-09-15');

    expect(result).toBe(created);
    expect(LedgerDay.create).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: 'branch-1', businessDate: '2026-09-15', status: 'OPEN' })
    );
  });

  it('recovers from a concurrent duplicate-key race by re-reading the winner', async () => {
    const winner = { id: 'day-3', branchId: 'branch-1', businessDate: '2026-09-15', status: 'OPEN' };
    const LedgerDay = {
      findOne: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(winner),
      create: jest.fn().mockRejectedValue(new Error('Duplicate entry')),
    };
    const tenantDb = { models: { LedgerDay } };

    const result = await ledgerService.getOrCreateLedgerDay(tenantDb, 'branch-1', '2026-09-15');

    expect(result).toBe(winner);
  });
});

describe('closeDay — race-safe conditional update', () => {
  const buildTenantDb = (dayOverrides = {}) => {
    const day = {
      id: 'day-1',
      branchId: 'branch-1',
      businessDate: '2026-09-15',
      status: 'OPEN',
      reload: jest.fn().mockImplementation(function () {
        this.status = 'CLOSED';
        return Promise.resolve(this);
      }),
      ...dayOverrides,
    };
    const Payment = { findAll: jest.fn().mockResolvedValue([]) };
    const LedgerDay = {
      findByPk: jest.fn().mockResolvedValue(day),
      update: jest.fn().mockResolvedValue([1]),
    };
    return { tenantDb: { models: { Payment, LedgerDay }, tenantId: 'tenant-1' }, day, LedgerDay };
  };

  it('closes an OPEN day and stamps who/when', async () => {
    const { tenantDb, LedgerDay } = buildTenantDb();
    const ctx = { tenantDb, tenantId: 'tenant-1', userId: 'user-1' };

    await ledgerService.closeDay(ctx, { ledgerDayId: 'day-1' });

    expect(LedgerDay.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'CLOSED', closedBy: 'user-1' }),
      { where: { id: 'day-1', status: 'OPEN' } }
    );
    expect(auditService.record).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ action: 'ledger.close', targetId: 'day-1' })
    );
  });

  it('rejects closing a day that is already CLOSED', async () => {
    const { tenantDb } = buildTenantDb({ status: 'CLOSED' });
    const ctx = { tenantDb, tenantId: 'tenant-1', userId: 'user-1' };

    await expect(ledgerService.closeDay(ctx, { ledgerDayId: 'day-1' })).rejects.toThrow(/already closed/);
  });

  it('rejects with 409 when a concurrent close won the race (0 rows affected)', async () => {
    const { tenantDb, LedgerDay } = buildTenantDb();
    LedgerDay.update.mockResolvedValue([0]); // someone else's UPDATE already flipped status
    const ctx = { tenantDb, tenantId: 'tenant-1', userId: 'user-1' };

    await expect(ledgerService.closeDay(ctx, { ledgerDayId: 'day-1' })).rejects.toThrow(
      /just closed by someone else/
    );
  });

  it('404s when the ledger day does not exist', async () => {
    const { tenantDb, LedgerDay } = buildTenantDb();
    LedgerDay.findByPk.mockResolvedValue(null);
    const ctx = { tenantDb, tenantId: 'tenant-1', userId: 'user-1' };

    await expect(ledgerService.closeDay(ctx, { ledgerDayId: 'missing' })).rejects.toThrow(/not found/);
  });
});

describe('addAdjustment — append-only reconciliation', () => {
  const buildTenantDb = (day) => {
    const LedgerDay = { findByPk: jest.fn().mockResolvedValue(day) };
    const LedgerAdjustment = { create: jest.fn().mockImplementation((data) => Promise.resolve({ id: 'adj-1', ...data })) };
    return { tenantDb: { models: { LedgerDay, LedgerAdjustment } }, LedgerAdjustment };
  };

  it('requires a reason', async () => {
    const { tenantDb } = buildTenantDb({ id: 'day-1', branchId: 'branch-1' });
    const ctx = { tenantDb, userId: 'user-1', branchId: 'branch-1' };

    await expect(
      ledgerService.addAdjustment(ctx, { ledgerDayId: 'day-1', type: 'DISCREPANCY_NOTE', reason: '   ' })
    ).rejects.toThrow(/reason is required/);
  });

  it('404s when the ledger day does not exist', async () => {
    const { tenantDb } = buildTenantDb(null);
    const ctx = { tenantDb, userId: 'user-1', branchId: 'branch-1' };

    await expect(
      ledgerService.addAdjustment(ctx, { ledgerDayId: 'missing', type: 'DISCREPANCY_NOTE', reason: 'test' })
    ).rejects.toThrow(/not found/);
  });

  it('rejects when the caller\'s resolved branch does not match the ledger day\'s real branch', async () => {
    const { tenantDb } = buildTenantDb({ id: 'day-1', branchId: 'branch-OTHER' });
    const ctx = { tenantDb, userId: 'user-1', branchId: 'branch-1' };

    await expect(
      ledgerService.addAdjustment(ctx, { ledgerDayId: 'day-1', type: 'DISCREPANCY_NOTE', reason: 'test' })
    ).rejects.toThrow(/does not belong to this branch/);
  });

  it('creates the adjustment and logs it to the audit trail', async () => {
    const { tenantDb, LedgerAdjustment } = buildTenantDb({ id: 'day-1', branchId: 'branch-1' });
    const ctx = { tenantDb, userId: 'user-1', branchId: 'branch-1' };

    const adjustment = await ledgerService.addAdjustment(ctx, {
      ledgerDayId: 'day-1',
      type: 'VARIANCE_ADJUSTMENT',
      relatedPaymentId: 'payment-1',
      amount: -500,
      reason: 'Cash short at handover',
    });

    expect(LedgerAdjustment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        ledgerDayId: 'day-1',
        type: 'VARIANCE_ADJUSTMENT',
        amount: -500,
        reason: 'Cash short at handover',
        createdBy: 'user-1',
      })
    );
    expect(adjustment.id).toBe('adj-1');
    expect(auditService.record).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ action: 'ledger.adjustment.create', targetId: 'day-1' })
    );
  });
});

describe('getDayLedger — expected / collected / verified / variance', () => {
  it('computes totals correctly from a mix of payment statuses', async () => {
    const payments = [
      { id: 'p1', amount: '1000.00', method: 'CASH', status: 'COMPLETED', staffCollectedBy: 'staff-1', createdBy: 'staff-1' },
      { id: 'p2', amount: '2000.00', method: 'CASH', status: 'STAFF_COLLECTED', staffCollectedBy: 'staff-2', createdBy: 'staff-2' },
      { id: 'p3', amount: '500.00', method: 'BANK_TRANSFER', status: 'PENDING', staffCollectedBy: null, createdBy: 'staff-1' },
    ];
    const Payment = { findAll: jest.fn().mockResolvedValue(payments) };
    const LedgerDay = {
      findOne: jest.fn().mockResolvedValue({ id: 'day-1', branchId: 'branch-1', businessDate: '2026-09-15', status: 'OPEN' }),
    };
    const LedgerAdjustment = { findAll: jest.fn().mockResolvedValue([]) };
    const Branch = { findByPk: jest.fn().mockResolvedValue({ id: 'branch-1', timezone: 'Asia/Karachi' }) };
    const tenantDb = { models: { Payment, LedgerDay, LedgerAdjustment, Branch } };

    const result = await ledgerService.getDayLedger(tenantDb, 'branch-1', '2026-09-15');

    expect(result.totals.expected).toBe(3500);
    expect(result.totals.collected).toBe(3000); // COMPLETED + STAFF_COLLECTED, not PENDING
    expect(result.totals.verified).toBe(1000); // COMPLETED only
    expect(result.totals.pending).toBe(500); // expected - collected
    expect(result.totals.variance).toBe(2000); // collected - verified
    expect(result.byMethod).toEqual({ CASH: 3000, BANK_TRANSFER: 500 });
    expect(result.byCollector).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ collectorId: 'staff-1', total: 1000, count: 1 }),
        expect.objectContaining({ collectorId: 'staff-2', total: 2000, count: 1 }),
      ])
    );
  });
});

describe('ledger.close command', () => {
  const commands = require('../src/services/commands');
  const cmd = commands.get('ledger.close');

  it('is registered', () => {
    expect(cmd).not.toBeNull();
  });

  it('rejects closing an already-CLOSED day at validate time', async () => {
    const LedgerDay = { findByPk: jest.fn().mockResolvedValue({ id: 'day-1', status: 'CLOSED' }) };
    const ctx = { tenantDb: { models: { LedgerDay } }, branchId: 'branch-1' };

    await expect(cmd.validate(ctx, { ledgerDayId: 'day-1' })).rejects.toThrow(/already closed/);
  });

  it('passes validation for an OPEN day', async () => {
    const LedgerDay = { findByPk: jest.fn().mockResolvedValue({ id: 'day-1', status: 'OPEN' }) };
    const ctx = { tenantDb: { models: { LedgerDay } }, branchId: 'branch-1' };

    await expect(cmd.validate(ctx, { ledgerDayId: 'day-1' })).resolves.toBeUndefined();
  });
});
