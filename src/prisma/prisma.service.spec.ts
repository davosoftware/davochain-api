import { ConflictException } from '@nestjs/common';
import { PrismaService, isSerializationFailure } from './prisma.service';

/**
 * The retry loop that now sits under every money path.
 *
 * What matters is not that it retries, but *what it refuses to retry*: a
 * decision the closure made on purpose has to reach the caller untouched, and
 * a collision that never clears has to end as a 409 rather than a 500.
 */

describe('isSerializationFailure', () => {
  it('recognises Prisma’s own write-conflict code', () => {
    expect(isSerializationFailure({ code: 'P2034' })).toBe(true);
  });

  it('recognises the raw SQLSTATE the ledger’s row lock produces', () => {
    // The ledger takes its lock through raw SQL, so the conflict surfaces as a
    // raw query failure with 40001 in the meta rather than as P2034.
    expect(isSerializationFailure({ code: 'P2010', meta: { code: '40001' } })).toBe(true);
  });

  it('recognises the message Postgres itself writes', () => {
    expect(
      isSerializationFailure({ message: 'could not serialize access due to concurrent update' }),
    ).toBe(true);
  });

  it('does not mistake ordinary failures for a collision', () => {
    expect(isSerializationFailure({ code: 'P2025' })).toBe(false);
    expect(isSerializationFailure(new Error('connection refused'))).toBe(false);
    expect(isSerializationFailure(new ConflictException('already dealt with'))).toBe(false);
    expect(isSerializationFailure(null)).toBe(false);
    expect(isSerializationFailure(undefined)).toBe(false);
  });
});

describe('serializable', () => {
  const conflict = () => Object.assign(new Error('boom'), { code: 'P2034' });

  /** A PrismaService whose $transaction is scripted, so no database is needed. */
  function withTransaction(impl: jest.Mock) {
    const svc = new PrismaService();
    (svc as unknown as { $transaction: unknown }).$transaction = impl;
    return svc;
  }

  it('returns the result when nothing collides', async () => {
    const tx = jest.fn().mockResolvedValue('done');
    await expect(withTransaction(tx).serializable(async () => 'done')).resolves.toBe('done');
    expect(tx).toHaveBeenCalledTimes(1);
  });

  it('re-runs a refused transaction and returns the retry’s result', async () => {
    const tx = jest
      .fn()
      .mockRejectedValueOnce(conflict())
      .mockRejectedValueOnce(conflict())
      .mockResolvedValue('credited');

    await expect(withTransaction(tx).serializable(async () => 'credited')).resolves.toBe(
      'credited',
    );
    expect(tx).toHaveBeenCalledTimes(3);
  });

  it('gives up as a 409, not a 500, when it keeps losing', async () => {
    const tx = jest.fn().mockRejectedValue(conflict());
    const svc = withTransaction(tx);

    await expect(svc.serializable(async () => 'never')).rejects.toBeInstanceOf(ConflictException);
    // Four attempts, then it stops. An unbounded loop would hold the request
    // open for as long as the contention lasted.
    expect(tx).toHaveBeenCalledTimes(4);
  });

  it('uses the caller’s sentence when one is given', async () => {
    const tx = jest.fn().mockRejectedValue(conflict());
    await expect(
      withTransaction(tx).serializable(async () => 'never', {
        conflict: 'That deposit was already dealt with',
      }),
    ).rejects.toThrow('That deposit was already dealt with');
  });

  it('never retries a decision the closure made on purpose', async () => {
    // The status checks inside these closures throw ConflictException to mean
    // "somebody already did this". Retrying that would run the check again and
    // again to reach the same answer, and would mask it behind the generic
    // message on the way out.
    const deliberate = new ConflictException('That deposit was already dealt with');
    const tx = jest.fn().mockRejectedValue(deliberate);

    await expect(withTransaction(tx).serializable(async () => 'never')).rejects.toBe(deliberate);
    expect(tx).toHaveBeenCalledTimes(1);
  });

  it('never retries an ordinary error', async () => {
    const broken = new Error('column does not exist');
    const tx = jest.fn().mockRejectedValue(broken);

    await expect(withTransaction(tx).serializable(async () => 'never')).rejects.toBe(broken);
    expect(tx).toHaveBeenCalledTimes(1);
  });
});
