import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Exactly one runner per scheduled job, however many API replicas there are.
 *
 * A Postgres advisory lock looks like the obvious tool, but Prisma pools
 * connections: the lock and the unlock can land on different connections and
 * the lock outlives the job. A row with an expiry has no such trap — a crashed
 * runner's lease simply runs out. Times are computed by Postgres in UTC, so the
 * server's clock and time zone never matter.
 */
@Injectable()
export class JobLeaseService {
  private readonly log = new Logger(JobLeaseService.name);
  private readonly owner = randomUUID();

  constructor(private readonly prisma: PrismaService) {}

  async run<T>(
    name: string,
    ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<{ ran: true; result: T } | { ran: false }> {
    const ttl = Math.max(1, Math.floor(ttlMs));
    const rows = await this.prisma.$queryRaw<{ name: string }[]>`
      INSERT INTO "job_leases" ("name", "owner", "lockedUntil")
      VALUES (${name}, ${this.owner}, (now() AT TIME ZONE 'UTC') + (${ttl}::int * interval '1 millisecond'))
      ON CONFLICT ("name") DO UPDATE
        SET "owner" = EXCLUDED."owner", "lockedUntil" = EXCLUDED."lockedUntil"
        WHERE "job_leases"."lockedUntil" < (now() AT TIME ZONE 'UTC')
      RETURNING "name"`;
    if (rows.length === 0) {
      this.log.debug(`Skipped ${name}: another runner holds the lease`);
      return { ran: false };
    }
    try {
      return { ran: true, result: await fn() };
    } finally {
      await this.prisma.$executeRaw`
        UPDATE "job_leases" SET "lockedUntil" = (now() AT TIME ZONE 'UTC')
        WHERE "name" = ${name} AND "owner" = ${this.owner}`;
    }
  }
}
