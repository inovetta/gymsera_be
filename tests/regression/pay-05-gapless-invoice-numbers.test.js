/**
 * PAY-05: Gapless, per-branch invoice numbers regression test.
 *
 * Verifies:
 * 1. Invoice numbers are sequential and gapless per branch (INV-<branchCode>-000001, 000002, ...).
 * 2. 50 parallel invoice creations under concurrency yield zero duplicates and zero gaps.
 * 3. Distinct branches maintain independent sequences.
 * 4. Existing invoices preserve their historical numbers.
 */
const { setupTestDatabases, teardownTestDatabases } = require('../harness');
const { getNextInvoiceNumber } = require('../../src/services/invoice-sequence.service');

describe('PAY-05: Gapless per-branch invoice sequences', () => {
  let dbHarness;
  let tenantSeq;
  let models;
  let branchA;
  let branchB;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    tenantSeq = dbHarness.tenant1.sequelize;
    models = dbHarness.tenant1.models;

    // Create two test branches in tenant1
    const { Gym, Branch } = models;
    let gym = await Gym.findOne();
    if (!gym) {
      gym = await Gym.create({
        name: 'Iron Gym',
        phone: '+923001234567',
      });
    }
    branchA = await Branch.create({
      gymId: gym.id,
      branchName: 'Downtown Branch',
      timezone: 'Asia/Karachi',
    });
    branchB = await Branch.create({
      gymId: gym.id,
      branchName: 'Uptown Branch',
      timezone: 'Asia/Karachi',
    });
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('generates sequential, gapless invoice numbers for a branch', async () => {
    const num1 = await getNextInvoiceNumber(tenantSeq, branchA.id);
    const num2 = await getNextInvoiceNumber(tenantSeq, branchA.id);
    const num3 = await getNextInvoiceNumber(tenantSeq, branchA.id);

    expect(num1).toMatch(/-000001$/);
    expect(num2).toMatch(/-000002$/);
    expect(num3).toMatch(/-000003$/);
  });

  test('50 concurrent invoice requests produce 50 gapless numbers with 0 duplicates', async () => {
    // Generate 50 invoice numbers in parallel on branchA
    const promises = Array.from({ length: 50 }, () =>
      getNextInvoiceNumber(tenantSeq, branchA.id)
    );

    const results = await Promise.all(promises);
    expect(results).toHaveLength(50);

    const uniqueSet = new Set(results);
    expect(uniqueSet.size).toBe(50); // Zero collisions

    // Extract sequence numbers and ensure they form a strictly gapless range
    const seqNumbers = results
      .map((inv) => parseInt(inv.split('-').pop(), 10))
      .sort((a, b) => a - b);

    // Initial 3 were 1, 2, 3 -> these 50 must be 4 through 53
    for (let i = 0; i < seqNumbers.length; i++) {
      expect(seqNumbers[i]).toBe(4 + i);
    }
  });

  test('branch B maintains an independent sequence starting at 000001', async () => {
    const bNum1 = await getNextInvoiceNumber(tenantSeq, branchB.id);
    const bNum2 = await getNextInvoiceNumber(tenantSeq, branchB.id);

    expect(bNum1).toMatch(/-000001$/);
    expect(bNum2).toMatch(/-000002$/);

    // Branch tags must differ between branches
    const tagA = branchA.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase();
    const tagB = branchB.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase();

    expect(bNum1).toContain(tagB);
    expect(bNum1).not.toContain(tagA);
  });

  test('preserves existing historical invoice numbers', async () => {
    const { Invoice } = models;
    const historical = await Invoice.create({
      userId: '3d32ddca-fe09-44c8-bc3c-92cec22bc2a2',
      invoiceNo: 'INV-20250507-AB12C3',
      invoiceType: 'MEMBERSHIP',
      subtotal: 1000,
      totalAmount: 1000,
      dueDate: '2025-05-07',
      status: 'PAID',
    });

    const fetched = await Invoice.findByPk(historical.id);
    expect(fetched.invoiceNo).toBe('INV-20250507-AB12C3');
  });
});
