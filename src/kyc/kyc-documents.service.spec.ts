import { BadRequestException, ConflictException, NotFoundException, PayloadTooLargeException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { KycDocumentsService, MAX_DOCUMENT_BYTES, MAX_PENDING_DOCUMENTS } from './kyc-documents.service';
import { MemoryFileStore } from '../storage/memory-file-store';
import { UploadIntents } from '../storage/upload-intents.service';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('a passport photo')]);
const PDF = Buffer.from('%PDF-1.7\nproof of address');
const file = (buffer: Buffer) => ({ buffer, size: buffer.length });

type Doc = { id: string; kycProfileId: string; type: string; status: string; sha256: string | null; storageKey: string; serverStored: boolean; uploadedAt: Date; mimeType: string; sizeBytes: number };

/** The few tables the upload touches, in memory. */
function fakeDb() {
  const docs: Doc[] = [];
  const intents = new Map<string, Date>();
  let failCreate: Error | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = {
    docs,
    intents,
    failNextCreate(err: Error) {
      failCreate = err;
    },
    kycProfile: { findUnique: jest.fn(async ({ where }: { where: { userId: string } }) => (where.userId === 'u1' ? { id: 'p1' } : null)) },
    kycDocument: {
      count: jest.fn(async ({ where }: { where: { kycProfileId: string; status: string } }) =>
        docs.filter((d) => d.kycProfileId === where.kycProfileId && d.status === where.status).length,
      ),
      findFirst: jest.fn(async ({ where }: { where: { kycProfileId: string; sha256: string; status: string; type: string } }) =>
        docs.find((d) => d.kycProfileId === where.kycProfileId && d.sha256 === where.sha256 && d.status === where.status && d.type === where.type) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Omit<Doc, 'id' | 'status' | 'uploadedAt'> }) => {
        if (failCreate) {
          const e = failCreate;
          failCreate = null;
          throw e;
        }
        const row = { ...data, id: `d${docs.length + 1}`, status: 'PENDING', uploadedAt: new Date() } as Doc;
        docs.push(row);
        return row;
      }),
    },
    pendingUpload: {
      create: jest.fn(async ({ data }: { data: { key: string } }) => void intents.set(data.key, new Date())),
      createMany: jest.fn(async ({ data }: { data: { key: string; createdAt: Date }[] }) => data.forEach((d) => intents.set(d.key, d.createdAt))),
      deleteMany: jest.fn(async ({ where }: { where: { key: string | { in: string[] } } }) => {
        const keys = typeof where.key === 'string' ? [where.key] : where.key.in;
        return { count: keys.filter((k) => intents.delete(k)).length };
      }),
      findMany: jest.fn(async () => []),
    },
    $executeRaw: jest.fn(async () => 0),
    // Like Postgres: a transaction that throws leaves no trace.
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      const docsBefore = [...docs];
      const intentsBefore = new Map(intents);
      try {
        return await fn(db);
      } catch (err) {
        docs.splice(0, docs.length, ...docsBefore);
        intents.clear();
        intentsBefore.forEach((v, k) => intents.set(k, v));
        throw err;
      }
    }),
  };
  return db;
}

function setup() {
  const db = fakeDb();
  const store = new MemoryFileStore();
  const svc = new KycDocumentsService(db as never, new UploadIntents(db as never, store), store);
  return { db, store, svc };
}

describe('KycDocumentsService.upload', () => {
  it('stores the file under a key the server chose and saves the record', async () => {
    const { db, store, svc } = setup();
    const out = await svc.upload('u1', 'PASSPORT', file(PNG));
    expect(out).toMatchObject({ id: 'd1', type: 'PASSPORT', status: 'PENDING', duplicate: false });
    const doc = db.docs[0];
    expect(doc.storageKey).toMatch(/^kyc\/u1\/[0-9a-f-]{36}$/);
    expect(doc).toMatchObject({ serverStored: true, mimeType: 'image/png', sizeBytes: PNG.length, sha256: createHash('sha256').update(PNG).digest('hex') });
    expect(store.has(doc.storageKey)).toBe(true);
    expect(db.intents.size).toBe(0);
  });

  it('accepts a PDF for proof of address', async () => {
    const { db, svc } = setup();
    await svc.upload('u1', 'PROOF_OF_ADDRESS', file(PDF));
    expect(db.docs[0].mimeType).toBe('application/pdf');
  });

  it('refuses BVN and NIN, which are numbers, not files', async () => {
    const { svc, store } = setup();
    await expect(svc.upload('u1', 'BVN', file(PNG))).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.upload('u1', 'NIN', file(PNG))).rejects.toBeInstanceOf(BadRequestException);
    expect(store.keys()).toEqual([]);
  });

  it('refuses a file whose content is not a photo or PDF, whatever it is called', async () => {
    const { svc, store } = setup();
    await expect(svc.upload('u1', 'PASSPORT', file(Buffer.from('<html><script>x</script>')))).rejects.toThrow(/JPEG, PNG or WebP photo, or a PDF/);
    expect(store.keys()).toEqual([]);
  });

  it('refuses an empty upload and one over 10 MB', async () => {
    const { svc } = setup();
    await expect(svc.upload('u1', 'PASSPORT', undefined)).rejects.toThrow(/Choose a file/);
    await expect(svc.upload('u1', 'PASSPORT', file(Buffer.alloc(0)))).rejects.toThrow(/Choose a file/);
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_DOCUMENT_BYTES)]);
    await expect(svc.upload('u1', 'PASSPORT', file(big))).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('refuses a customer with no verification profile', async () => {
    const { svc } = setup();
    await expect(svc.upload('nobody', 'PASSPORT', file(PNG))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses the 11th document waiting for review, before uploading anything', async () => {
    const { svc, store } = setup();
    for (let i = 0; i < MAX_PENDING_DOCUMENTS; i++) await svc.upload('u1', 'SELFIE', file(Buffer.concat([PNG, Buffer.from(String(i))])));
    const before = store.keys().length;
    await expect(svc.upload('u1', 'SELFIE', file(Buffer.concat([PNG, Buffer.from('x')])))).rejects.toBeInstanceOf(ConflictException);
    expect(store.keys().length).toBe(before);
  });

  it('gives back the first document when the same file is sent again (a retry), storing nothing new', async () => {
    const { db, store, svc } = setup();
    const first = await svc.upload('u1', 'PASSPORT', file(PNG));
    const again = await svc.upload('u1', 'PASSPORT', file(PNG));
    expect(again).toMatchObject({ id: first.id, duplicate: true });
    expect(db.docs).toHaveLength(1);
    expect(store.keys()).toHaveLength(1);
  });

  it('the same picture sent as a different document type is a new document, not a retry', async () => {
    const { db, svc } = setup();
    await svc.upload('u1', 'PASSPORT', file(PNG));
    const selfie = await svc.upload('u1', 'SELFIE', file(PNG));
    expect(selfie).toMatchObject({ type: 'SELFIE', duplicate: false });
    expect(db.docs).toHaveLength(2);
  });

  it('handles the duplicate found only inside the transaction (two retries racing): one record, our extra file removed', async () => {
    const { db, store, svc } = setup();
    // The first look (outside the lock) misses; the one under the lock finds it.
    const real = db.kycDocument.findFirst.getMockImplementation()!;
    db.kycDocument.findFirst.mockImplementationOnce(async () => null);
    db.docs.push({ id: 'd0', kycProfileId: 'p1', type: 'PASSPORT', status: 'PENDING', sha256: createHash('sha256').update(PNG).digest('hex'), storageKey: 'kyc/u1/first', serverStored: true, uploadedAt: new Date(), mimeType: 'image/png', sizeBytes: 1 });
    void real;
    const out = await svc.upload('u1', 'PASSPORT', file(PNG));
    expect(out).toMatchObject({ id: 'd0', duplicate: true });
    expect(db.docs).toHaveLength(1);
    expect(store.keys()).toEqual([]);
    expect(db.intents.size).toBe(0);
  });

  it('answers 503 when storage is down, leaving no record, no file and no intent', async () => {
    const { db, store, svc } = setup();
    store.failNext(1);
    await expect(svc.upload('u1', 'PASSPORT', file(PNG))).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(db.docs).toHaveLength(0);
    expect(store.keys()).toEqual([]);
    expect(db.intents.size).toBe(0);
  });

  it('removes the uploaded file and its intent when saving the record fails', async () => {
    const { db, store, svc } = setup();
    db.failNextCreate(new Error('database went away'));
    await expect(svc.upload('u1', 'PASSPORT', file(PNG))).rejects.toThrow('database went away');
    expect(db.docs).toHaveLength(0);
    expect(store.keys()).toEqual([]);
    expect(db.intents.size).toBe(0);
  });

  it('takes a per-customer lock so two uploads cannot both slip under the limit', async () => {
    const { db, svc } = setup();
    await svc.upload('u1', 'PASSPORT', file(PNG));
    expect(db.$executeRaw).toHaveBeenCalled();
    const sqlParts = (db.$executeRaw.mock.calls[0] as unknown[])[0] as string[];
    expect(sqlParts.join('?')).toMatch(/pg_advisory_xact_lock/);
  });
});

describe('KycDocumentsService.read', () => {
  const doc = { id: 'd1', serverStored: true, storageKey: 'kyc/u1/k', mimeType: 'image/png', type: 'PASSPORT' as const };

  it('reads a server-stored document from the file store', async () => {
    const { store, svc } = setup();
    await store.put('kyc/u1/k', PNG, 'image/png');
    expect((await svc.read(doc))?.bytes.equals(PNG)).toBe(true);
  });

  it('never reads a key from before H8, which the app chose', async () => {
    const { store, svc } = setup();
    const get = jest.spyOn(store, 'get');
    await expect(svc.read({ ...doc, serverStored: false, storageKey: 'kyc/someone-else/passport' })).rejects.toBeInstanceOf(ConflictException);
    expect(get).not.toHaveBeenCalled();
  });

  it('answers 503 when storage is down, and null when the file is not there', async () => {
    const { store, svc } = setup();
    store.failNext(1);
    await expect(svc.read(doc)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(await svc.read(doc)).toBeNull();
  });
});
