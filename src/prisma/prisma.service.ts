import { ConflictException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Postgres refusing to serialise two writes that raced.
 *
 * SQLSTATE 40001. It surfaces either as Prisma's own write-conflict code or,
 * on the row lock the ledger takes through raw SQL, as a raw query failure
 * carrying the SQLSTATE in its meta — so all three are checked rather than
 * whichever one happened to come up first.
 */
export function isSerializationFailure(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  return (
    e?.code === 'P2034' ||
    e?.meta?.code === '40001' ||
    (typeof e?.message === 'string' && e.message.includes('could not serialize access'))
  );
}

/**
 * How many times a refused transaction is re-run before giving up.
 *
 * Four attempts with these gaps covers the realistic case — two people
 * pressing a button at the same moment — without holding a request open long
 * enough to matter. Beyond that the contention is not a race, it is load, and
 * the honest answer is to tell the caller to try again.
 */
const ATTEMPTS = 4;
const BACKOFF_MS = [25, 60, 150];

/** What the caller is told when every attempt lost the race. */
const DEFAULT_CONFLICT = 'Someone else changed this at the same moment. Try again.';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Spread the retries out.
 *
 * Without jitter, two transactions that collided once wake at the same
 * instant and collide again — the backoff would keep them in lockstep rather
 * than separating them.
 */
const jittered = (ms: number): number => ms + Math.floor(Math.random() * ms);

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.log.log('Database connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Serializable by default, and retried when Postgres refuses.
   *
   * Every money path runs through here, and the cost of an occasional retry is
   * far below the cost of a double-spend.
   *
   * Serializable isolation stops two racing writes from both landing — but it
   * stops them by ABORTING one, and an unhandled abort reaches the caller as
   * "Internal server error" on what is really a routine, retryable event. So
   * this re-runs the transaction a few times, and only if it keeps losing does
   * it answer 409 — which is the truthful reply: somebody got there first.
   *
   * Re-running is safe because an aborted serializable transaction committed
   * nothing at all. That holds only while these closures stay database-only:
   * **do not send a notification, an email, or a Quidax call from inside one**,
   * or a retry will do it twice. Every current call site was checked against
   * this rule.
   *
   * `conflict` is the message the caller sees if all the attempts lose. Pass
   * one whenever the path has a better sentence than the generic default.
   */
  async serializable<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    opts: { conflict?: string } = {},
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.$transaction(fn, { isolationLevel: 'Serializable', timeout: 15_000 });
      } catch (err) {
        // A ConflictException thrown by the closure itself lands here too —
        // that is a decision, not a collision, and must pass straight through.
        if (!isSerializationFailure(err)) throw err;

        if (attempt >= ATTEMPTS - 1) {
          this.log.warn(`Gave up after ${ATTEMPTS} serialisation conflicts`);
          throw new ConflictException(opts.conflict ?? DEFAULT_CONFLICT);
        }

        await sleep(jittered(BACKOFF_MS[attempt]));
      }
    }
  }
}
