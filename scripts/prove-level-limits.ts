/**
 * Proves the gift-card daily limit holds under a race on real Postgres (level
 * policy, 15 Oct 2026): two ₦600,000 cards submitted at once against a
 * ₦1,000,000 daily limit (on top of whatever the user already sold today):
 * exactly one is accepted.
 *
 * Creates a throwaway gift-card category, brand and type, sets the Basic
 * GIFTCARD_SELL rule, and puts everything back afterwards. No money moves (a
 * submitted card credits nothing until an admin approves it). Refuses to run
 * unless NODE_ENV is development and the database is on this machine.
 *
 * Run: npx ts-node --transpile-only --compiler-options '{"module":"CommonJS"}' scripts/prove-level-limits.ts <Basic user email>
 */
import { randomUUID } from 'node:crypto';
import { GiftCardTradeStatus, PolicyAction, PolicyLevel } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { GiftCardsService } from '../src/giftcards/giftcards.service';
import { LevelPolicyService } from '../src/levels/level-policy.service';
import { startOfLagosDay } from '../src/levels/level-policy.service';
import { dec } from '../src/common/money';
import { refuseUnlessLocalDevelopment } from './local-dev-guard';

/** A 1×1 PNG: the smallest photo the submit route accepts. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function main(): Promise<void> {
  refuseUnlessLocalDevelopment();
  const email = process.argv[2];
  if (!email) throw new Error('Usage: prove-level-limits.ts <Basic user email>');

  const prisma = new PrismaService();
  await prisma.$connect();
  const tag = `prove-levels-${randomUUID().slice(0, 8)}`;
  const key = { level_action: { level: PolicyLevel.BASIC, action: PolicyAction.GIFTCARD_SELL } };
  const before = await prisma.levelRule.findUnique({ where: key });
  let categoryId: string | null = null;
  const created: string[] = [];
  try {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const category = await prisma.giftCardBrandCategory.create({ data: { name: tag } });
    categoryId = category.id;
    const brand = await prisma.giftCardBrand.create({ data: { name: tag, categoryId } });
    // $500 at ₦1,200/$ = ₦600,000 a card.
    const type = await prisma.giftCardType.create({ data: { brandId: brand.id, name: tag, minAmount: '1', maxAmount: '10000', rateNgn: '1200' } });

    const soldToday = dec(
      (
        await prisma.giftCardTrade.aggregate({
          where: { userId: user.id, status: { not: GiftCardTradeStatus.REJECTED }, createdAt: { gte: startOfLagosDay() } },
          _sum: { expectedNgn: true },
        })
      )._sum.expectedNgn ?? 0,
    );
    const limit = soldToday.plus(1_000_000);
    await prisma.levelRule.upsert({
      where: key,
      create: { level: PolicyLevel.BASIC, action: PolicyAction.GIFTCARD_SELL, allowed: true, currency: 'NGN', maxPerDay: limit.toFixed(), updatedBy: 'prove-level-limits' },
      update: { allowed: true, currency: 'NGN', minPerTx: null, maxPerTx: null, maxPerDay: limit.toFixed(), updatedBy: 'prove-level-limits' },
    });

    const policy = new LevelPolicyService(prisma, { price: async () => ({ ngnPerUsd: '1500' }) } as never);
    const cards = new GiftCardsService(prisma, {} as never, { notify: async () => undefined } as never, { get: () => undefined } as never, policy, {} as never, {} as never);
    // mine() reads the trade back for the app; not needed here.
    (cards as unknown as { mine: (u: string, id: string) => Promise<unknown> }).mine = async (_u, id) => id;

    const submit = () => cards.submit(user.id, { typeId: type.id, faceValue: '500', images: [PNG] });
    const results = await Promise.allSettled([submit(), submit()]);
    for (const r of results) if (r.status === 'fulfilled') created.push(r.value as unknown as string);
    const rows = await prisma.giftCardTrade.count({ where: { typeId: type.id } });
    const refused = results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason?.message));

    const proven = created.length === 1 && rows === 1;
    if (!proven) process.exitCode = 1;
    console.log(JSON.stringify({ exactlyOneAccepted: proven, accepted: created.length, rowsWritten: rows, refusedWith: refused }));
  } finally {
    await prisma.giftCardTrade.deleteMany({ where: { id: { in: created } } });
    if (categoryId) {
      await prisma.giftCardType.deleteMany({ where: { brand: { categoryId } } });
      await prisma.giftCardBrand.deleteMany({ where: { categoryId } });
      await prisma.giftCardBrandCategory.delete({ where: { id: categoryId } });
    }
    if (before) {
      const { level: _l, action: _a, ...rest } = before;
      await prisma.levelRule.update({ where: key, data: rest });
    } else {
      await prisma.levelRule.deleteMany({ where: { level: PolicyLevel.BASIC, action: PolicyAction.GIFTCARD_SELL } });
    }
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
