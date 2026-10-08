import { KycService } from './kyc.service';
import { KycHashService } from './kyc-hash';

describe('KycService identity hashing', () => {
  it('stores an h1: HMAC hash and the last four digits, never the number', async () => {
    const upserts: Array<{ create: Record<string, unknown>; update: Record<string, unknown> }> = [];
    const prisma = {
      kycProfile: {
        upsert: jest.fn(async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
          upserts.push(args);
          return { status: 'PENDING', submittedAt: new Date() };
        }),
      },
      user: { update: jest.fn(async () => ({ email: 'a@b.c', firstName: 'A', lastName: 'B' })) },
    };
    const mail = { send: jest.fn(async () => undefined) };
    const hasher = new KycHashService({ get: () => 'k'.repeat(32) } as never);
    const svc = new KycService(prisma as never, {} as never, mail as never, hasher);

    await svc.submitTier1('u1', { bvn: '22222223883', dateOfBirth: '1990-01-01' });

    expect(upserts[0].create.bvnHash).toBe('h1:5d06137e3fbc7507a7ffddefa365578c223d66d9d9deaa0632b460854ca86883');
    expect(upserts[0].create.bvnLast4).toBe('3883');
    expect(upserts[0].update.bvnHash).toBe(upserts[0].create.bvnHash);
    expect(JSON.stringify(upserts)).not.toContain('22222223883');
    expect(JSON.stringify(mail.send.mock.calls)).not.toContain('22222223883');
  });
});
