/**
 * Proves the level_policy migration seeded today's behaviour exactly
 * (spec §7.1). Read-only. Run:
 * npx ts-node --transpile-only --compiler-options '{"module":"CommonJS"}' scripts/prove-level-seed.ts
 */
import { PrismaClient } from '@prisma/client';
import { refuseUnlessLocalDevelopment } from './local-dev-guard';

const ACTIONS = ['BUY', 'SELL', 'SWAP', 'CRYPTO_DEPOSIT', 'CRYPTO_WITHDRAW', 'NGN_DEPOSIT', 'NGN_WITHDRAW', 'GIFTCARD_SELL'];

async function main() {
  refuseUnlessLocalDevelopment();
  const prisma = new PrismaClient();
  try {
    const rules = await prisma.levelRule.findMany();
    const tier1 = await prisma.kycTierLimit.findUnique({ where: { tier: 'TIER_1' } });
    const tier3 = await prisma.kycTierLimit.findUnique({ where: { tier: 'TIER_3' } });
    const r = (level: string, action: string) => rules.find((x) => x.level === level && x.action === action)!;
    const same = (a: unknown, b: unknown) => Number(a ?? 0) === Number(b ?? 0);
    const checks = {
      everyRowPresent: rules.length === 24 && ['NONE', 'BASIC', 'ADVANCED'].every((l) => ACTIONS.every((a) => r(l, a))),
      noneAllOff: ACTIONS.every((a) => !r('NONE', a).allowed),
      basicAllOn: ACTIONS.every((a) => r('BASIC', a).allowed),
      basicTradeDaily5000Usd: ['BUY', 'SELL', 'SWAP'].every((a) => r('BASIC', a).currency === 'USD' && Number(r('BASIC', a).maxPerDay) === 5000),
      basicNgnFromTier1:
        same(r('BASIC', 'NGN_WITHDRAW').maxPerTx, tier1?.ngnWithdrawSingle) &&
        same(r('BASIC', 'NGN_WITHDRAW').maxPerDay, tier1?.ngnWithdrawDaily) &&
        same(r('BASIC', 'NGN_DEPOSIT').maxPerDay, tier1?.ngnDepositDaily),
      advancedNgnFromTier3: same(r('ADVANCED', 'NGN_DEPOSIT').maxPerDay, tier3?.ngnDepositDaily),
      cooloffsZero: (await prisma.levelCooloff.findMany()).every((c) => c.afterSignupHours === 0 && c.afterCredentialChangeHours === 0),
      platform50000Usd: Number((await prisma.platformLimit.findUnique({ where: { id: 'default' } }))?.tradingMaxPerDay) === 50000,
    };
    console.log(JSON.stringify(checks));
    if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
