import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { QuidaxClient } from './quidax.client';
import { QuidaxMockClient } from './quidax.mock';

/**
 * The Quidax stand-in keeps every account's coins in memory, so each restart
 * of a test server emptied them while our own records still showed them: the
 * customer saw coins they could not send, sell or withdraw ("Insufficient
 * balance", 29 Oct 2026). At start-up this puts each customer's coins back at
 * the stand-in from their balances here, locked ones included (they have not
 * left yet). Does nothing against the real Quidax, which keeps its balances.
 */
@Injectable()
export class QuidaxMockRestore implements OnApplicationBootstrap {
  private readonly log = new Logger(QuidaxMockRestore.name);

  constructor(
    private readonly quidax: QuidaxClient,
    private readonly prisma: PrismaService,
  ) {}

  onApplicationBootstrap(): void {
    // Not awaited: start-up must never wait on, or fail because of, this.
    void this.restore().catch((err) => this.log.error(`Restoring the Quidax stand-in failed: ${(err as Error).message}`));
  }

  /** How many customer coin balances were put back. */
  async restore(): Promise<number> {
    if (!(this.quidax instanceof QuidaxMockClient)) return 0;
    const rows = await this.prisma.balance.findMany({
      where: { asset: { isFiat: false }, user: { quidaxAccount: { isNot: null } } },
      select: { assetCode: true, available: true, locked: true, user: { select: { quidaxAccount: { select: { quidaxUserId: true } } } } },
    });
    let restored = 0;
    for (const row of rows) {
      const quidaxUserId = row.user.quidaxAccount?.quidaxUserId;
      const amount = Number(row.available) + Number(row.locked);
      if (!quidaxUserId || !(amount > 0)) continue;
      this.quidax.seed(quidaxUserId, row.assetCode, amount);
      restored++;
    }
    if (restored) this.log.log(`Quidax stand-in: ${restored} customer coin balance(s) restored from our records`);
    return restored;
  }
}
