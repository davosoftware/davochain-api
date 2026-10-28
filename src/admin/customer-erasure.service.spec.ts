import { CustomerErasureService } from './customer-erasure.service';

/**
 * Deleting a closed customer's data (decision 28 Oct 2026): now, or on the
 * day the owner chose. Everything that identifies the person goes; the money
 * records stay, linked to a "Deleted customer" row, so the books still add up.
 */
function build(user: Record<string, unknown> = {}) {
  const u = {
    id: 'u1', status: 'CLOSED', firstName: 'Ada', lastName: 'Obi', email: 'closed-u1@closed.davochain', closedBy: 'a1',
    dataDeletedAt: null, dataDeleteAt: null, ...user,
  };
  const calls: string[] = [];
  const fn = (name: string, result: unknown = { count: 1 }) => jest.fn(async (..._a: unknown[]) => (calls.push(name), result));
  const prisma: Record<string, any> = {
    user: {
      findUnique: jest.fn(async () => u),
      findMany: jest.fn(async () => [u]),
      update: fn('user.update'),
    },
    kycDocument: { findMany: jest.fn(async () => [{ storageKey: 'kyc/u1/front.jpg' }, { storageKey: 'kyc/u1/selfie.jpg' }]), deleteMany: fn('kycDocument.deleteMany') },
    giftCardTradeImage: { findMany: jest.fn(async () => [{ storageKey: 'gc/t1/1.jpg' }, { storageKey: null }]), deleteMany: fn('giftCardTradeImage.deleteMany') },
    kycProfile: { updateMany: fn('kycProfile.updateMany') },
    advancedVerification: { deleteMany: fn('advancedVerification.deleteMany') },
    kycVerification: { deleteMany: fn('kycVerification.deleteMany') },
    amlReviewCase: { deleteMany: fn('amlReviewCase.deleteMany') },
    amlScreening: { deleteMany: fn('amlScreening.deleteMany') },
    savedBankAccount: { updateMany: fn('savedBankAccount.updateMany') },
    savedCryptoAddress: { updateMany: fn('savedCryptoAddress.updateMany') },
    virtualAccount: { updateMany: fn('virtualAccount.updateMany') },
    virtualAccountRequest: { deleteMany: fn('virtualAccountRequest.deleteMany') },
    notification: { deleteMany: fn('notification.deleteMany') },
    deviceToken: { deleteMany: fn('deviceToken.deleteMany') },
    userOtp: { deleteMany: fn('userOtp.deleteMany') },
    refreshToken: { deleteMany: fn('refreshToken.deleteMany') },
    idempotencyKey: { deleteMany: fn('idempotencyKey.deleteMany') },
    adminAuditLog: { updateMany: fn('adminAuditLog.updateMany'), create: fn('adminAuditLog.create') },
    // Money records: never touched.
    transaction: { deleteMany: fn('transaction.deleteMany'), updateMany: fn('transaction.updateMany') },
    ledgerEntry: { deleteMany: fn('ledgerEntry.deleteMany') },
    balance: { deleteMany: fn('balance.deleteMany') },
  };
  prisma.$transaction = jest.fn(async (f: (tx: unknown) => unknown): Promise<unknown> => f(prisma));
  const store = { delete: jest.fn(async () => undefined) };
  const svc = new CustomerErasureService(prisma as never, store as never);
  return { svc, prisma, calls, store, u };
}

describe('CustomerErasureService.erase', () => {
  it('deletes everything that identifies the person, and keeps the money records', async () => {
    const h = build();
    await h.svc.erase('u1', { adminId: 'a1', scheduled: false });

    for (const t of [
      'kycDocument.deleteMany', 'advancedVerification.deleteMany', 'kycVerification.deleteMany', 'amlReviewCase.deleteMany',
      'amlScreening.deleteMany', 'giftCardTradeImage.deleteMany', 'virtualAccountRequest.deleteMany', 'notification.deleteMany',
      'deviceToken.deleteMany', 'userOtp.deleteMany', 'refreshToken.deleteMany', 'idempotencyKey.deleteMany',
    ]) {
      expect(h.calls).toContain(t);
    }
    // The money side is never deleted or rewritten.
    expect(h.calls).not.toContain('transaction.deleteMany');
    expect(h.calls).not.toContain('transaction.updateMany');
    expect(h.calls).not.toContain('ledgerEntry.deleteMany');
    expect(h.calls).not.toContain('balance.deleteMany');
    // AML cases go before the screenings they point at.
    expect(h.calls.indexOf('amlReviewCase.deleteMany')).toBeLessThan(h.calls.indexOf('amlScreening.deleteMany'));
  });

  it('leaves a "Deleted customer" row with no name, email, phone, password or closing details', async () => {
    const h = build();
    await h.svc.erase('u1', { adminId: 'a1', scheduled: false });
    const data = (h.prisma.user.update.mock.calls[0] as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toMatchObject({
      firstName: 'Deleted',
      lastName: 'customer',
      email: 'deleted-u1@deleted.davochain',
      phone: null,
      closedEmail: null,
      closedPhone: null,
      closedReason: 'Personal data deleted',
      username: null,
      dataDeleteAt: null,
    });
    expect(data.dataDeletedAt).toBeInstanceOf(Date);
    expect(String(data.passwordHash)).toMatch(/^!deleted/);
  });

  it('blanks the identity on what must stay linked: profile, saved destinations, naira account name', async () => {
    const h = build();
    await h.svc.erase('u1', { adminId: 'a1', scheduled: false });
    // The last update to each table is the one that blanks it.
    const arg = (name: string) => (h.prisma[name].updateMany.mock.calls.at(-1) as [{ data: Record<string, unknown> }])[0].data;
    expect(arg('kycProfile')).toMatchObject({ dateOfBirth: null, bvnHash: null, bvnLast4: null, ninHash: null, ninLast4: null, addressLine: null });
    expect(arg('savedBankAccount')).toMatchObject({ accountNumber: '**********', accountName: 'Deleted customer', nickname: null });
    expect(arg('savedCryptoAddress')).toMatchObject({ address: '[deleted]', destinationTag: null, nickname: null });
    expect(arg('virtualAccount')).toMatchObject({ accountName: 'Deleted customer' });
  });

  it('deletes the stored photos and documents, and a missing file does not stop it', async () => {
    const h = build();
    h.store.delete.mockRejectedValueOnce(new Error('R2 down'));
    await expect(h.svc.erase('u1', { adminId: 'a1', scheduled: false })).resolves.toMatchObject({ erased: true, files: 3 });
    expect(h.store.delete.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual(['kyc/u1/front.jpg', 'kyc/u1/selfie.jpg', 'gc/t1/1.jpg']);
  });

  it('scrubs the audit trail of personal details and records the deletion', async () => {
    const h = build();
    await h.svc.erase('u1', { adminId: 'a1', scheduled: true });
    expect(h.prisma.adminAuditLog.updateMany).toHaveBeenCalledWith({
      where: { entity: 'User', entityId: 'u1' },
      data: { before: { redacted: 'customer data deleted' }, after: { redacted: 'customer data deleted' } },
    });
    expect(h.prisma.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ adminUserId: 'a1', action: 'user.erase', entity: 'User', entityId: 'u1', after: { scheduled: true } }),
    });
  });

  it('only a closed account can be deleted, and only once', async () => {
    await expect(build({ status: 'ACTIVE' }).svc.erase('u1', { adminId: 'a1', scheduled: false })).rejects.toThrow('Only a closed account');
    const done = build({ dataDeletedAt: new Date() });
    await expect(done.svc.erase('u1', { adminId: 'a1', scheduled: false })).resolves.toMatchObject({ erased: false });
    expect(done.prisma.user.update).not.toHaveBeenCalled();
  });
});

describe('CustomerErasureService.runDue (the daily job)', () => {
  it('deletes the accounts whose day has come, under the owner who chose it', async () => {
    const h = build({ dataDeleteAt: new Date('2026-01-01T00:00:00Z'), closedBy: 'owner-7' });
    const r = await h.svc.runDue(new Date('2026-10-28T04:00:00Z'));
    expect(r).toEqual({ erased: 1, failed: 0 });
    const where = (h.prisma.user.findMany.mock.calls[0] as [{ where: Record<string, unknown> }])[0].where;
    expect(where).toMatchObject({ status: 'CLOSED', dataDeletedAt: null, dataDeleteAt: { lte: new Date('2026-10-28T04:00:00Z') } });
    expect(h.prisma.adminAuditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ adminUserId: 'owner-7', after: { scheduled: true } }) });
  });
});
