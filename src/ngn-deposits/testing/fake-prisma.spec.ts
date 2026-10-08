import { Prisma } from '@prisma/client';
import { FakePrisma, p2002 } from './fake-prisma';

const va = (extra: Record<string, unknown> = {}) => ({
  data: { userId: 'u', accountNumber: '1', accountName: 'A B', bankName: 'X', txRef: 't', source: 'CREATED', ...extra },
});

describe('FakePrisma', () => {
  it('creates rows with defaults and an id, and hands back copies', async () => {
    const db = new FakePrisma();
    const row = await db.virtualAccount.create(va());
    expect(row).toMatchObject({ isPrimary: false, desiredStatus: 'ACTIVE', syncFailures: 0, orderRef: null });
    expect(typeof row.id).toBe('string');
    row.isPrimary = true;
    expect(db.rows('virtualAccount')[0].isPrimary).toBe(false);
  });

  it('raises P2002 on a duplicate unique key, but never for NULLs', async () => {
    const db = new FakePrisma();
    await db.transaction.create({ data: { userId: 'u', type: 'DEPOSIT', reference: 'r1' } });
    const err = await db.transaction.create({ data: { userId: 'u', type: 'DEPOSIT', reference: 'r1' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((err as { code: string }).code).toBe('P2002');
    await db.virtualAccount.create(va({ source: 'DISCOVERED' }));
    await expect(db.virtualAccount.create(va({ accountNumber: '2', source: 'DISCOVERED' }))).resolves.toBeTruthy();
  });

  it('filters with SQL semantics: NULL never equals, never differs, never sits in a list', async () => {
    const db = new FakePrisma();
    for (const providerStatus of [null, 'active', 'inactive']) {
      await db.virtualAccount.create(va({ accountNumber: String(providerStatus), providerStatus }));
    }
    const pick = async (where: Record<string, unknown>) =>
      (await db.virtualAccount.findMany({ where })).map((r) => r.providerStatus);
    expect(await pick({ providerStatus: { not: 'active' } })).toEqual(['inactive']);
    expect(await pick({ providerStatus: null })).toEqual([null]);
    expect(await pick({ providerStatus: { not: null } })).toEqual(['active', 'inactive']);
    expect(await pick({ providerStatus: { in: ['active'] } })).toEqual(['active']);
    expect(await pick({ providerStatus: { notIn: ['active'] } })).toEqual(['inactive']);
    expect(await pick({ OR: [{ providerStatus: null }, { providerStatus: 'inactive' }] })).toEqual([null, 'inactive']);
  });

  it('compares dates, and stores decimal columns as exact Decimals', async () => {
    const db = new FakePrisma();
    await db.flutterwaveCollection.create({
      data: { flwTransactionId: '1', firstSource: 'SWEEP', lastCheckedAt: new Date('2026-10-01T00:00:00Z'), amount: '1500.50' },
    });
    await db.flutterwaveCollection.create({
      data: { flwTransactionId: '2', firstSource: 'SWEEP', lastCheckedAt: new Date('2026-10-07T00:00:00Z') },
    });
    const stale = await db.flutterwaveCollection.findMany({ where: { lastCheckedAt: { lt: new Date('2026-10-05T00:00:00Z') } } });
    expect(stale.map((r) => r.flwTransactionId)).toEqual(['1']);
    expect(stale[0].amount).toBeInstanceOf(Prisma.Decimal);
    expect((stale[0].amount as Prisma.Decimal).toFixed()).toBe('1500.5');
  });

  it('increments, and refuses to update a row that is not there', async () => {
    const db = new FakePrisma();
    await db.flutterwaveCollection.create({ data: { flwTransactionId: '1', firstSource: 'WEBHOOK' } });
    await db.flutterwaveCollection.update({ where: { flwTransactionId: '1' }, data: { checkCount: { increment: 1 } } });
    await db.flutterwaveCollection.update({ where: { flwTransactionId: '1' }, data: { checkCount: { increment: 2 } } });
    expect(db.rows('flutterwaveCollection')[0].checkCount).toBe(3);
    await expect(db.flutterwaveCollection.update({ where: { flwTransactionId: 'nope' }, data: {} })).rejects.toMatchObject({ code: 'P2025' });
  });

  it('upserts: creates once, then updates', async () => {
    const db = new FakePrisma();
    const args = {
      where: { flwTransactionId: '9' },
      create: { flwTransactionId: '9', firstSource: 'SWEEP' },
      update: { checkCount: { increment: 1 } },
    };
    await db.flutterwaveCollection.upsert(args);
    await db.flutterwaveCollection.upsert(args);
    expect(db.rows('flutterwaveCollection')).toHaveLength(1);
    expect(db.rows('flutterwaveCollection')[0].checkCount).toBe(1);
  });

  it('rolls every table back when a serializable callback throws', async () => {
    const db = new FakePrisma();
    await expect(
      db.serializable(async (t) => {
        await t.transaction.create({ data: { userId: 'u', type: 'DEPOSIT', reference: 'r' } });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(db.rows('transaction')).toHaveLength(0);
  });

  it('fails the next matching call once, on demand', async () => {
    const db = new FakePrisma();
    db.failNext('transaction', 'create', p2002(['reference']));
    const data = { userId: 'u', type: 'DEPOSIT', reference: 'r' };
    await expect(db.transaction.create({ data })).rejects.toMatchObject({ code: 'P2002' });
    await expect(db.transaction.create({ data })).resolves.toBeTruthy();
  });

  it('orders and limits', async () => {
    const db = new FakePrisma();
    for (const id of ['3', '1', '2']) {
      await db.flutterwaveCollection.create({ data: { flwTransactionId: id, firstSource: 'SWEEP', firstSeenAt: new Date(Number(id) * 1000) } });
    }
    const rows = await db.flutterwaveCollection.findMany({ orderBy: { firstSeenAt: 'asc' }, take: 2 });
    expect(rows.map((r) => r.flwTransactionId)).toEqual(['1', '2']);
  });

  it('records every write payload, and refuses NOT', async () => {
    const db = new FakePrisma();
    await db.alert.create({ data: { type: 'NGN_RECONCILIATION', payload: { a: 1 } } });
    expect(db.allWrites()).toEqual([{ type: 'NGN_RECONCILIATION', payload: { a: 1 } }]);
    await expect(db.alert.findMany({ where: { NOT: { type: 'X' } } })).rejects.toThrow(/NOT is not supported/);
    await expect(db.alert.findMany({ where: { type: { equals: 'X', mode: 'insensitive' } } })).rejects.toThrow(/mode/);
  });

  it('keeps decimal columns exact through increment, decrement and set', async () => {
    const db = new FakePrisma();
    await db.flutterwaveCollection.create({ data: { flwTransactionId: '1', firstSource: 'SWEEP', amount: '1500.10' } });
    await db.flutterwaveCollection.update({ where: { flwTransactionId: '1' }, data: { amount: { increment: '0.20' } } });
    let row = db.rows('flutterwaveCollection')[0];
    expect(row.amount).toBeInstanceOf(Prisma.Decimal);
    expect((row.amount as Prisma.Decimal).toFixed()).toBe('1500.3');
    await db.flutterwaveCollection.update({ where: { flwTransactionId: '1' }, data: { amount: { decrement: '0.3' } } });
    row = db.rows('flutterwaveCollection')[0];
    expect((row.amount as Prisma.Decimal).toFixed()).toBe('1500');
    await db.flutterwaveCollection.update({ where: { flwTransactionId: '1' }, data: { amount: { set: '7.25' } } });
    row = db.rows('flutterwaveCollection')[0];
    expect((row.amount as Prisma.Decimal).toFixed()).toBe('7.25');
  });
});
