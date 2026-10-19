import { UploadIntents, INTENT_MAX_AGE_MS } from './upload-intents.service';
import { MemoryFileStore } from './memory-file-store';
import { StorageUnavailableError } from './file-store';

/** Just the pending_uploads table, in memory. */
function fakePrisma() {
  const rows = new Map<string, Date>();
  const table = {
    create: jest.fn(async ({ data }: { data: { key: string; createdAt?: Date } }) => {
      if (rows.has(data.key)) throw Object.assign(new Error('dup'), { code: 'P2002' });
      rows.set(data.key, data.createdAt ?? new Date());
    }),
    createMany: jest.fn(async ({ data }: { data: { key: string; createdAt: Date }[] }) => {
      for (const d of data) if (!rows.has(d.key)) rows.set(d.key, d.createdAt);
    }),
    deleteMany: jest.fn(async ({ where }: { where: { key: string | { in: string[] } } }) => {
      const keys = typeof where.key === 'string' ? [where.key] : where.key.in;
      let count = 0;
      for (const k of keys) if (rows.delete(k)) count++;
      return { count };
    }),
    findMany: jest.fn(async ({ where }: { where: { createdAt: { lt: Date } } }) =>
      [...rows.entries()].filter(([, at]) => at < where.createdAt.lt).map(([key, createdAt]) => ({ key, createdAt })),
    ),
  };
  return { rows, prisma: { pendingUpload: table } };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('UploadIntents', () => {
  it('records the intent before the file goes in, and leaves both on success', async () => {
    const { rows, prisma } = fakePrisma();
    const store = new MemoryFileStore();
    const order: string[] = [];
    prisma.pendingUpload.create.mockImplementationOnce(async ({ data }) => {
      order.push('intent');
      rows.set(data.key, new Date());
    });
    const put = store.put.bind(store);
    jest.spyOn(store, 'put').mockImplementation(async (...a) => {
      order.push('put');
      return put(...a);
    });
    await new UploadIntents(prisma as never, store).store('kyc/u/1', PNG, 'image/png');
    expect(order).toEqual(['intent', 'put']);
    expect(rows.has('kyc/u/1')).toBe(true);
    expect(store.has('kyc/u/1')).toBe(true);
  });

  it('cleans up both when the upload fails, and reports storage as unavailable', async () => {
    const { rows, prisma } = fakePrisma();
    const store = new MemoryFileStore();
    store.failNext(1);
    await expect(new UploadIntents(prisma as never, store).store('k', PNG, 'image/png')).rejects.toBeInstanceOf(
      StorageUnavailableError,
    );
    expect(rows.size).toBe(0);
    expect(store.keys()).toEqual([]);
  });

  it('keeps the intent when the upload failed AND the clean-up delete failed, so the sweeper finishes it', async () => {
    const { rows, prisma } = fakePrisma();
    const store = new MemoryFileStore();
    store.failNext(2); // the put, then the clean-up delete
    await expect(new UploadIntents(prisma as never, store).store('k', PNG, 'image/png')).rejects.toBeInstanceOf(
      StorageUnavailableError,
    );
    expect(rows.has('k')).toBe(true);
  });

  it('uploads nothing when the intent cannot be recorded', async () => {
    const { prisma } = fakePrisma();
    prisma.pendingUpload.create.mockRejectedValueOnce(new Error('db down'));
    const store = new MemoryFileStore();
    await expect(new UploadIntents(prisma as never, store).store('k', PNG, 'image/png')).rejects.toThrow('db down');
    expect(store.keys()).toEqual([]);
  });

  it('claim removes every intent inside the caller transaction', async () => {
    const { rows, prisma } = fakePrisma();
    rows.set('a', new Date());
    rows.set('b', new Date());
    await new UploadIntents(prisma as never, new MemoryFileStore()).claim(prisma as never, ['a', 'b']);
    expect(rows.size).toBe(0);
  });

  it('claim refuses when an intent is gone (the sweeper took it), so nothing points at a deleted file', async () => {
    const { rows, prisma } = fakePrisma();
    rows.set('a', new Date());
    await expect(
      new UploadIntents(prisma as never, new MemoryFileStore()).claim(prisma as never, ['a', 'b']),
    ).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it('abandon deletes the file only while its intent is still unclaimed', async () => {
    const { rows, prisma } = fakePrisma();
    const store = new MemoryFileStore();
    await store.put('mine', PNG, 'image/png');
    await store.put('committed', PNG, 'image/png');
    rows.set('mine', new Date());
    // "committed": a transaction that DID commit (its intent is gone) but answered with an error.
    await new UploadIntents(prisma as never, store).abandon(['mine', 'committed']);
    expect(store.has('mine')).toBe(false);
    expect(store.has('committed')).toBe(true);
    expect(rows.size).toBe(0);
  });

  it('abandon never throws, and puts the intent back when the file could not be deleted', async () => {
    const { rows, prisma } = fakePrisma();
    const store = new MemoryFileStore();
    await store.put('k', PNG, 'image/png');
    rows.set('k', new Date());
    store.failNext(1);
    await expect(new UploadIntents(prisma as never, store).abandon(['k'])).resolves.toBeUndefined();
    expect(rows.has('k')).toBe(true);
    expect(store.has('k')).toBe(true);
  });

  it('sweep removes intents older than 30 minutes with their files, and leaves fresh ones', async () => {
    const { rows, prisma } = fakePrisma();
    const store = new MemoryFileStore();
    const now = new Date('2026-10-19T12:00:00Z');
    await store.put('old', PNG, 'image/png');
    await store.put('fresh', PNG, 'image/png');
    rows.set('old', new Date(now.getTime() - INTENT_MAX_AGE_MS - 1));
    rows.set('fresh', new Date(now.getTime() - 60_000));
    expect(await new UploadIntents(prisma as never, store).sweep(now)).toBe(1);
    expect(store.keys()).toEqual(['fresh']);
    expect([...rows.keys()]).toEqual(['fresh']);
  });

  it('sweep keeps the intent for next time when storage is down', async () => {
    const { rows, prisma } = fakePrisma();
    const store = new MemoryFileStore();
    const now = new Date();
    rows.set('old', new Date(now.getTime() - INTENT_MAX_AGE_MS - 1));
    store.failNext(1);
    expect(await new UploadIntents(prisma as never, store).sweep(now)).toBe(0);
    expect(rows.has('old')).toBe(true);
  });
});
