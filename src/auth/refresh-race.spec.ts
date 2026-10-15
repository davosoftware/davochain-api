import { createHash } from 'node:crypto';
import { AuthService } from './auth.service';

/**
 * M1 (PROJECT_REVIEW): a refresh token is single use. Two refreshes with the
 * same token at the same moment both passed the "not revoked" check, so one
 * stolen token became two live session chains.
 *
 * Now the old token is claimed first, in one conditional update. The loser of
 * a near-simultaneous race (an app firing two refreshes) gets 401 without its
 * whole session family being signed out; a reuse long after is still treated
 * as theft and signs the family out.
 */
const tick = () => new Promise((r) => setImmediate(r));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function build(revokedAt: Date | null = null) {
  const row = { id: 'rt1', userId: 'u1', family: 'fam1', tokenHash: sha('old-token'), revokedAt, replacedBy: null as string | null, expiresAt: new Date(Date.now() + 86_400_000) };
  const familyRevoked: string[] = [];
  const prisma = {
    refreshToken: {
      findUnique: jest.fn(async () => (await tick(), { ...row })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => (await tick(), Object.assign(row, data))),
      updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        await tick();
        if ('family' in where) {
          familyRevoked.push(String(where.family));
          return { count: 1 };
        }
        if (where.id === row.id && where.revokedAt === null && row.revokedAt === null) {
          Object.assign(row, data);
          return { count: 1 };
        }
        return { count: 0 };
      }),
    },
  };
  const svc = Object.create(AuthService.prototype) as AuthService;
  Object.assign(svc, { prisma, log: { warn: jest.fn() } });
  let issued = 0;
  jest.spyOn(svc as unknown as { issueTokens: () => Promise<unknown> }, 'issueTokens').mockImplementation(async () => {
    issued++;
    return { accessToken: `a${issued}`, refreshToken: `r${issued}` };
  });
  jest.spyOn(svc as unknown as { hashToken: (t: string) => string }, 'hashToken').mockImplementation((t: string) => sha(t));
  return { svc, row, familyRevoked, issued: () => issued };
}

describe('M1: a refresh token is used once, even when sent twice at once', () => {
  it('a normal refresh issues new tokens and retires the old one', async () => {
    const { svc, row, issued } = build();
    await expect(svc.refresh('old-token')).resolves.toMatchObject({ accessToken: 'a1' });
    expect(issued()).toBe(1);
    expect(row.revokedAt).toBeInstanceOf(Date);
  });

  it('two refreshes at the same moment: exactly one succeeds', async () => {
    const { svc, issued } = build();
    const results = await Promise.allSettled([svc.refresh('old-token'), svc.refresh('old-token')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(issued()).toBe(1);
  });

  it('the near-simultaneous loser does not sign the whole session family out', async () => {
    const { svc, familyRevoked } = build();
    await Promise.allSettled([svc.refresh('old-token'), svc.refresh('old-token')]);
    expect(familyRevoked).toEqual([]);
  });

  it('reusing a token retired long ago is treated as theft: the family is signed out', async () => {
    const { svc, familyRevoked } = build(new Date(Date.now() - 3_600_000));
    await expect(svc.refresh('old-token')).rejects.toMatchObject({ status: 401 });
    expect(familyRevoked).toEqual(['fam1']);
  });
});
