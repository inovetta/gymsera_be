/**
 * Approvable commands — field-name and validation contracts.
 *
 * These exist because the previous version of members.create validated a field
 * (`membershipPlanId`) that `gymService.enrollMember` never reads (it reads
 * `planId`) — a mismatch that would have silently let every request through
 * validation and then failed, or worse, validated nothing at all, right up until
 * a real approver hit it in production.
 */
const commands = require('../src/services/commands');

describe('members.create command', () => {
  const cmd = commands.get('members.create');

  const fakeCtx = (plan) => ({
    branchId: 'branch-1',
    tenantDb: {
      models: {
        MembershipPlan: {
          findOne: jest.fn().mockResolvedValue(plan),
        },
      },
    },
  });

  it('is registered', () => {
    expect(cmd).not.toBeNull();
  });

  it('rejects a payload with no contact info', async () => {
    await expect(cmd.validate(fakeCtx(null), { planId: 'p1' })).rejects.toThrow(
      /email address or a phone number/
    );
  });

  it('rejects a payload with no planId', async () => {
    await expect(cmd.validate(fakeCtx(null), { email: 'a@b.com' })).rejects.toThrow(
      /membership plan is required/
    );
  });

  it('validates the plan by planId, matching what enrollMember actually reads', async () => {
    const ctx = fakeCtx({ id: 'p1', status: 'ACTIVE' });
    await cmd.validate(ctx, { email: 'a@b.com', planId: 'p1' });

    expect(ctx.tenantDb.models.MembershipPlan.findOne).toHaveBeenCalledWith({
      where: { id: 'p1', status: 'ACTIVE' },
    });
  });

  it('rejects when the plan lookup finds nothing (archived or wrong id)', async () => {
    const ctx = fakeCtx(null);
    await expect(cmd.validate(ctx, { email: 'a@b.com', planId: 'gone' })).rejects.toThrow(
      /no longer exists or is inactive/
    );
  });

  it('summarizes using the member name, falling back sensibly', () => {
    expect(cmd.summarize({ fullName: 'Ahmed Raza' })).toBe('Ahmed Raza');
    expect(cmd.summarize({ fullName: 'Ahmed Raza', planName: 'Monthly' })).toBe('Ahmed Raza — Monthly');
    expect(cmd.summarize({ email: 'a@b.com' })).toBe('a@b.com');
  });
});

describe('expenses.create command', () => {
  const cmd = commands.get('expenses.create');

  it('is registered', () => {
    expect(cmd).not.toBeNull();
  });

  it('rejects a payload with no title or non-positive amount', async () => {
    const ctx = { branchId: 'b1', tenantDb: { models: {} } };
    await expect(cmd.validate(ctx, { amount: 100 })).rejects.toThrow(/needs a title/);
    await expect(cmd.validate(ctx, { title: 'Rent', amount: 0 })).rejects.toThrow(/positive amount/);
  });
});

describe('announcements.create command', () => {
  const cmd = commands.get('announcements.create');
  const ctx = { branchId: 'b1', tenantDb: { models: {} } };

  it('is registered', () => {
    expect(cmd).not.toBeNull();
  });

  it('rejects a payload missing title or message', async () => {
    await expect(cmd.validate(ctx, { message: 'hi' })).rejects.toThrow(/title and a message/);
    await expect(cmd.validate(ctx, { title: 'Hi' })).rejects.toThrow(/title and a message/);
  });

  it('rejects with no branch context', async () => {
    await expect(
      cmd.validate({ tenantDb: { models: {} } }, { title: 'Hi', message: 'there' })
    ).rejects.toThrow(/branch is required/);
  });

  it('executes by creating a sent announcement, never a draft the UI can never reach', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'a1' });
    const execCtx = { branchId: 'b1', userId: 'u1', tenantDb: { models: { Announcement: { create } } } };
    await cmd.execute(execCtx, { title: 'Closed Sunday', message: 'We are closed', tag: 'ALERT' });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: 'b1', status: 'sent', tag: 'ALERT', createdBy: 'u1' })
    );
  });
});

describe('plans.create command', () => {
  const cmd = commands.get('plans.create');

  it('is registered', () => {
    expect(cmd).not.toBeNull();
  });

  it('rejects a payload missing required fields', async () => {
    const ctx = { branchId: 'b1', tenantDb: { models: {} } };
    await expect(cmd.validate(ctx, { name: 'Monthly' })).rejects.toThrow(
      /name, a duration type and a duration value/
    );
  });

  it('rejects a negative price', async () => {
    const ctx = { branchId: 'b1', tenantDb: { models: {} } };
    await expect(
      cmd.validate(ctx, { name: 'Monthly', durationType: 'MONTHS', durationValue: 1, price: -5 })
    ).rejects.toThrow(/non-negative price/);
  });

  it('falls back to ctx.branchId when the payload has none', async () => {
    const createPlan = jest.fn().mockResolvedValue({ id: 'p1' });
    jest.doMock('../src/services/membership-plan.service', () => ({ createPlan }));
    const freshCmd = require('../src/services/commands').get('plans.create');
    const ctx = { branchId: 'branch-9', tenantDb: {} };

    await freshCmd.execute(ctx, { name: 'Monthly', durationType: 'MONTHS', durationValue: 1, price: 2000 });

    expect(createPlan).toHaveBeenCalledWith(
      ctx.tenantDb,
      expect.objectContaining({ branchId: 'branch-9', name: 'Monthly' })
    );
    jest.dontMock('../src/services/membership-plan.service');
  });
});

describe('schedule.class.create command', () => {
  const cmd = commands.get('schedule.class.create');
  const ctx = { branchId: 'b1', tenantDb: { models: {} } };

  it('is registered', () => {
    expect(cmd).not.toBeNull();
  });

  it('rejects a payload missing any required field', async () => {
    await expect(cmd.validate(ctx, { instructor: 'Ali', time: '6pm', day: 'Mon' })).rejects.toThrow(
      /name, an instructor, a time and a day/
    );
  });

  it('defaults capacity to 20 when none is given', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'c1' });
    const execCtx = { branchId: 'b1', tenantDb: { models: { ClassSchedule: { create } } } };
    await cmd.execute(execCtx, { name: 'Yoga', instructor: 'Ali', time: '6pm', day: 'Mon' });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ maxCapacity: 20, currentCapacity: 0 }));
  });
});
