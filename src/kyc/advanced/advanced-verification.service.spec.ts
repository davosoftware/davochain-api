import { Prisma } from '@prisma/client';
import { lagosDate } from '../../common/dates';
import {
  AdvancedVerificationService,
  MSG_ADV_DAILY,
  MSG_ADV_DISABLED,
  MSG_ADV_IN_PROGRESS,
  MSG_ADV_TOTAL,
  MSG_NEED_BASIC,
  MSG_NEED_IDENTITY,
  MSG_NEED_RECORD,
} from './advanced-verification.service';
import { MSG_FAILED_SYSTEM } from './advanced.types';

type Row = Record<string, unknown> & { id: string; userId: string; step: string; state: string; lagosDay: string; createdAt: Date };
type Doc = { id: string; userId: string; type: string; mimeType: string; serverStored: boolean; status: string };

const today = lagosDate(new Date());

function build() {
  const user = { kycTier: 'TIER_1', kycStatus: 'APPROVED', amlStatus: 'CLEAR' };
  const rows: Row[] = [];
  const docs: Doc[] = [
    { id: 'front', userId: 'u1', type: 'NATIONAL_ID', mimeType: 'image/png', serverStored: true, status: 'PENDING' },
    { id: 'back', userId: 'u1', type: 'ID_BACK', mimeType: 'image/png', serverStored: true, status: 'PENDING' },
    { id: 'selfie', userId: 'u1', type: 'SELFIE', mimeType: 'image/jpeg', serverStored: true, status: 'PENDING' },
    { id: 'pdf', userId: 'u1', type: 'NATIONAL_ID', mimeType: 'application/pdf', serverStored: true, status: 'PENDING' },
    { id: 'used', userId: 'u1', type: 'NATIONAL_ID', mimeType: 'image/png', serverStored: true, status: 'REJECTED' },
    { id: 'legacy', userId: 'u1', type: 'NATIONAL_ID', mimeType: 'image/png', serverStored: false, status: 'PENDING' },
    { id: 'poa', userId: 'u1', type: 'PROOF_OF_ADDRESS', mimeType: 'image/png', serverStored: true, status: 'PENDING' },
    { id: 'poaPdf', userId: 'u1', type: 'PROOF_OF_ADDRESS', mimeType: 'application/pdf', serverStored: true, status: 'PENDING' },
    { id: 'others', userId: 'u2', type: 'NATIONAL_ID', mimeType: 'image/png', serverStored: true, status: 'PENDING' },
  ];
  const settings = { advancedEnabled: true, advancedDailyAttempts: 3, advancedTotalAttempts: 10, addressRecencyMonths: 3 };
  const counted = (w: { userId: string; step: string; lagosDay?: string }) =>
    rows.filter((r) => r.userId === w.userId && r.step === w.step && r.state !== 'FAILED_SYSTEM' && (!w.lagosDay || r.lagosDay === w.lagosDay)).length;
  const prisma: Record<string, any> = {
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(prisma)),
    $executeRaw: jest.fn(async () => 1),
    user: { findUniqueOrThrow: jest.fn(async () => ({ ...user })) },
    kycVerification: { findFirst: jest.fn(async (): Promise<unknown> => ({ id: 'basic' })) },
    kycDocument: {
      findFirst: jest.fn(async ({ where }: { where: { id: string; profile: { userId: string } } }) => {
        const d = docs.find((x) => x.id === where.id && x.userId === where.profile.userId);
        return d ? { type: d.type, mimeType: d.mimeType, serverStored: d.serverStored, status: d.status } : null;
      }),
    },
    advancedVerification: {
      count: jest.fn(async ({ where }: { where: { userId: string; step: string; lagosDay?: string } }) => counted(where)),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `v${rows.length + 1}`, state: 'CHECKING', createdAt: new Date(Date.now() + rows.length), ...data } as Row;
        rows.push(row);
        return row;
      }),
      findFirst: jest.fn(async ({ where }: { where: { userId: string; step: string } }) => {
        const mine = rows.filter((r) => r.userId === where.userId && r.step === where.step).sort((a, b) => +b.createdAt - +a.createdAt);
        return mine[0] ? { state: mine[0].state, customerMessage: mine[0].customerMessage ?? null } : null;
      }),
    },
  };
  const cfg = { effective: jest.fn(async () => ({ ...settings })) };
  const queue = { add: jest.fn(async () => ({})) };
  const readiness = { assertReady: jest.fn(async () => undefined), markNotReady: jest.fn() };
  const svc = new AdvancedVerificationService(prisma as never, cfg as never, queue as never, readiness as never);
  const seed = (step: string, n: number, over: Partial<Row> = {}) => {
    for (let i = 0; i < n; i++) rows.push({ id: `s${rows.length}`, userId: 'u1', step, state: 'REJECTED', lagosDay: today, createdAt: new Date(2026, 0, 1, 0, rows.length), ...over });
  };
  return { svc, user, rows, settings, prisma, queue, readiness, seed };
}

const ok = { idType: 'NATIONAL_ID' as const, frontDocumentId: 'front', backDocumentId: 'back', selfieDocumentId: 'selfie' };

describe('submitIdentity (spec §4.1)', () => {
  it('creates a CHECKING row holding the slot, and queues it', async () => {
    const { svc, rows, queue } = build();
    const r = await svc.submitIdentity('u1', ok);
    expect(r).toEqual({ verificationId: 'v1', state: 'CHECKING' });
    expect(rows[0]).toMatchObject({ userId: 'u1', step: 'IDENTITY', activeFor: 'u1', lagosDay: today, idType: 'NATIONAL_ID', frontDocumentId: 'front', backDocumentId: 'back', selfieDocumentId: 'selfie' });
    expect(queue.add).toHaveBeenCalledWith('run-advanced', { id: 'v1' }, { jobId: 'adv-v1' });
  });

  it('a queue outage still answers CHECKING (the recovery sweep queues it later)', async () => {
    const { svc, queue, rows } = build();
    queue.add.mockRejectedValueOnce(new Error('redis down'));
    await expect(svc.submitIdentity('u1', ok)).resolves.toMatchObject({ state: 'CHECKING' });
    expect(rows).toHaveLength(1);
  });

  it('503 when switched off; nothing written', async () => {
    const { svc, settings, rows } = build();
    settings.advancedEnabled = false;
    await expect(svc.submitIdentity('u1', ok)).rejects.toMatchObject({ status: 503, message: MSG_ADV_DISABLED });
    expect(rows).toHaveLength(0);
  });

  it('503 when Dojah is not ready', async () => {
    const { svc, readiness } = build();
    readiness.assertReady.mockRejectedValueOnce(new Error('wallet'));
    await expect(svc.submitIdentity('u1', ok)).rejects.toMatchObject({ status: 503 });
  });

  it('403 below Basic; 409 when already Advanced', async () => {
    const { svc, user } = build();
    user.kycTier = 'TIER_0';
    await expect(svc.submitIdentity('u1', ok)).rejects.toMatchObject({ status: 403, message: MSG_NEED_BASIC });
    user.kycTier = 'TIER_2';
    await expect(svc.submitIdentity('u1', ok)).rejects.toMatchObject({ status: 409 });
  });

  it('403 GATE_REVIEW when AML is not clear', async () => {
    const { svc, user } = build();
    user.amlStatus = 'UNDER_REVIEW';
    await expect(svc.submitIdentity('u1', ok)).rejects.toMatchObject({ status: 403 });
  });

  it("400 for a document that is not theirs, naming the field; nothing written", async () => {
    const { svc, rows } = build();
    await expect(svc.submitIdentity('u1', { ...ok, frontDocumentId: 'others' })).rejects.toMatchObject({ status: 400, message: 'frontDocumentId was not found' });
    await expect(svc.submitIdentity('u1', { ...ok, frontDocumentId: 'legacy' })).rejects.toMatchObject({ status: 400, message: 'frontDocumentId was not found' });
    expect(rows).toHaveLength(0);
  });

  it('400 for the wrong type, a PDF, an already-used document, or a passport back page', async () => {
    const { svc } = build();
    await expect(svc.submitIdentity('u1', { ...ok, selfieDocumentId: 'front' })).rejects.toMatchObject({ status: 400, message: 'selfieDocumentId must be a SELFIE upload' });
    await expect(svc.submitIdentity('u1', { ...ok, frontDocumentId: 'pdf' })).rejects.toMatchObject({ status: 400, message: 'frontDocumentId must be a photo, not a PDF' });
    await expect(svc.submitIdentity('u1', { ...ok, frontDocumentId: 'used' })).rejects.toMatchObject({ status: 400, message: 'frontDocumentId was already used in a decided check: upload it again' });
    await expect(svc.submitIdentity('u1', { ...ok, idType: 'PASSPORT', frontDocumentId: 'passport', backDocumentId: 'back' })).rejects.toMatchObject({
      status: 400,
      message: 'A passport has no back page: leave backDocumentId out',
    });
  });

  it('a national ID needs its back', async () => {
    const { svc } = build();
    await expect(svc.submitIdentity('u1', { ...ok, backDocumentId: undefined })).rejects.toMatchObject({ status: 400, message: 'backDocumentId is required for a national ID card' });
  });

  it("daily 429, total 403; failed-system attempts don't count", async () => {
    let b = build();
    b.seed('IDENTITY', 3);
    await expect(b.svc.submitIdentity('u1', ok)).rejects.toMatchObject({ status: 429, message: MSG_ADV_DAILY });
    b = build();
    b.seed('IDENTITY', 10, { lagosDay: '2026-01-01' });
    await expect(b.svc.submitIdentity('u1', ok)).rejects.toMatchObject({ status: 403, message: MSG_ADV_TOTAL });
    b = build();
    b.seed('IDENTITY', 5, { state: 'FAILED_SYSTEM' });
    await expect(b.svc.submitIdentity('u1', ok)).resolves.toMatchObject({ state: 'CHECKING' });
  });

  it('address attempts do not use up identity attempts', async () => {
    const { svc, seed } = build();
    seed('ADDRESS', 3);
    await expect(svc.submitIdentity('u1', ok)).resolves.toMatchObject({ state: 'CHECKING' });
  });

  it('409 when the unique activeFor is taken (a second submit at the same instant)', async () => {
    const { svc, prisma } = build();
    prisma.advancedVerification.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }));
    await expect(svc.submitIdentity('u1', ok)).rejects.toMatchObject({ status: 409, message: MSG_ADV_IN_PROGRESS });
  });
});

describe('submitAddress (spec §4.2)', () => {
  it('needs TIER_2', async () => {
    const { svc } = build();
    await expect(svc.submitAddress('u1', { kind: 'UTILITY_BILL', documentId: 'poa' })).rejects.toMatchObject({ status: 403, message: MSG_NEED_IDENTITY });
  });
  it('409 when already fully Advanced', async () => {
    const { svc, user } = build();
    user.kycTier = 'TIER_3';
    await expect(svc.submitAddress('u1', { kind: 'UTILITY_BILL', documentId: 'poa' })).rejects.toMatchObject({ status: 409 });
  });
  it('accepts a PDF (a person reads it later)', async () => {
    const { svc, user, rows } = build();
    user.kycTier = 'TIER_2';
    await expect(svc.submitAddress('u1', { kind: 'BANK_STATEMENT', documentId: 'poaPdf' })).resolves.toMatchObject({ state: 'CHECKING' });
    expect(rows[0]).toMatchObject({ step: 'ADDRESS', addressKind: 'BANK_STATEMENT', addressDocumentId: 'poaPdf' });
  });
  it('400 for a document of the wrong type', async () => {
    const { svc, user } = build();
    user.kycTier = 'TIER_2';
    await expect(svc.submitAddress('u1', { kind: 'UTILITY_BILL', documentId: 'front' })).rejects.toMatchObject({ status: 400, message: 'documentId must be a PROOF_OF_ADDRESS upload' });
  });
});

describe('summary', () => {
  it('NONE with full attempts before anything', async () => {
    const { svc } = build();
    expect(await svc.summary('u1')).toEqual({
      identity: { state: 'NONE', reason: null, attemptsLeft: { today: 3, total: 10 } },
      address: { state: 'NONE', reason: null, attemptsLeft: { today: 3, total: 10 } },
      recencyMonths: 3,
    });
  });
  it("shows FAILED with the didn't-use-an-attempt message, and the attempt is not counted", async () => {
    const { svc, seed } = build();
    seed('IDENTITY', 1, { state: 'FAILED_SYSTEM', customerMessage: MSG_FAILED_SYSTEM });
    expect((await svc.summary('u1')).identity).toEqual({ state: 'FAILED', reason: MSG_FAILED_SYSTEM, attemptsLeft: { today: 3, total: 10 } });
  });
  it('no reason while CHECKING or APPROVED', async () => {
    const { svc, seed } = build();
    seed('IDENTITY', 1, { state: 'APPROVED', customerMessage: 'stale' });
    expect((await svc.summary('u1')).identity).toMatchObject({ state: 'APPROVED', reason: null, attemptsLeft: { today: 2, total: 9 } });
  });
});

describe('final review I4: no readable Basic record', () => {
  it('is refused at submit (403, contact support) instead of an hour of failed retries', async () => {
    const { svc, prisma, rows } = build();
    prisma.kycVerification.findFirst.mockResolvedValueOnce(null);
    await expect(svc.submitIdentity('u1', ok)).rejects.toMatchObject({ status: 403, message: MSG_NEED_RECORD });
    expect(rows).toHaveLength(0);
  });
});
