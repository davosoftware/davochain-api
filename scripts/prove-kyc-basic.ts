/**
 * Proves, on real Postgres (spec §13; plan review focus 3 and 4):
 *  P1 10 parallel submits → exactly 1 lookup, 1 screen, 1 verification decided
 *  P2 the attempt-limit race: 6 parallel submits with 2 attempts used today → never a 4th counted attempt
 *  P3 crash recovery: an IN_FLIGHT lookup past the lease → FAILED_SYSTEM + possiblyCharged, slot freed
 *  P4 crash recovery: an IN_FLIGHT screen past the lease → re-sent exactly once (three workers racing),
 *     then a second unknown → ERROR + one case
 *  P5 the database CHECK refuses confirmedBy = proposedBy (spec §14.1)
 *
 * Creates its own throwaway users (proof-kyc-…@davochain.invalid, isTest) and deletes
 * every row it made. Uses the Dojah MOCK only, in this process: nothing is sent to Dojah.
 *
 * Run: NODE_ENV=development npx ts-node --transpile-only --compiler-options '{"module":"CommonJS"}' scripts/prove-kyc-basic.ts
 */
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { refuseUnlessLocalDevelopment } from './local-dev-guard';

const MINUTE = 60_000;

async function main(): Promise<void> {
  refuseUnlessLocalDevelopment();
  process.env.DOJAH_USE_MOCK = 'true';
  process.env.KYC_BASIC_ENABLED = 'true';
  const { AppModule } = await import('../src/app.module');
  const { PrismaService } = await import('../src/prisma/prisma.service');
  const { DojahMockClient } = await import('../src/dojah/dojah.mock');
  const { BasicVerificationService } = await import('../src/kyc/basic-verification.service');
  const { AmlService } = await import('../src/compliance/aml.service');

  // A slow mock, so the parallel requests really overlap.
  const slow = new DojahMockClient();
  const realLookup = slow.lookup.bind(slow);
  const realScreen = slow.screen.bind(slow);
  const pause = () => new Promise((r) => setTimeout(r, 300));
  slow.lookup = async (t, n) => (await pause(), realLookup(t, n));
  slow.screen = async (i, r) => (await pause(), realScreen(i, r));

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const prisma = app.get(PrismaService);
  const svc = app.get(BasicVerificationService, { strict: false });
  const aml = app.get(AmlService, { strict: false });
  // Swap in the slow mock and an always-ready readiness, in this process only.
  Object.assign(svc as unknown as Record<string, unknown>, {
    dojah: slow,
    readiness: { assertReady: async () => undefined, markNotReady: () => undefined },
  });
  Object.assign(aml as unknown as Record<string, unknown>, { dojah: slow });

  const made: string[] = [];
  const newUser = async () => {
    const u = await prisma.user.create({
      data: { email: `proof-kyc-${randomUUID()}@davochain.invalid`, passwordHash: 'x', firstName: 'Someone', lastName: 'Clean', isTest: true },
    });
    made.push(u.id);
    return u.id;
  };
  const body = {
    idType: 'BVN' as const, idNumber: '33333333333', firstName: 'Someone', lastName: 'Clean', dateOfBirth: '1995-03-03',
    address: { street: '1 Proof St', city: 'Ikeja', state: 'Lagos', lga: 'Ikeja' }, stateOfOrigin: 'Lagos', country: 'NG' as const,
  };
  const results: Record<string, boolean> = {};
  const facts: Record<string, unknown> = {};

  try {
    // P1
    const u1 = await newUser();
    const before = { ...slow.calls };
    const burst = await Promise.allSettled(Array.from({ length: 10 }, () => svc.submit(u1, body)));
    const won = burst.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ state: string }>[];
    results.P1_oneWinner = won.length === 1;
    results.P1_winnerApproved = won[0]?.value.state === 'APPROVED';
    results.P1_rest409 = burst.filter((r) => r.status === 'rejected' && (r.reason as { status?: number }).status === 409).length === 9;
    results.P1_oneLookup = slow.calls.lookup - before.lookup === 1;
    results.P1_oneScreen = slow.calls.aml - before.aml === 1;
    results.P1_oneVerification = (await prisma.kycVerification.count({ where: { userId: u1 } })) === 1;
    facts.P1 = { fulfilled: won.length, lookups: slow.calls.lookup - before.lookup, screens: slow.calls.aml - before.aml };

    // P2: two attempts already used today (404s), then a burst of 6
    const u2 = await newUser();
    await svc.submit(u2, { ...body, idNumber: '11111111111' });
    await svc.submit(u2, { ...body, idNumber: '11111111111' });
    const burst2 = await Promise.allSettled(Array.from({ length: 6 }, () => svc.submit(u2, { ...body, idNumber: '11111111111' })));
    const counted = await prisma.kycVerification.count({ where: { userId: u2, state: { not: 'FAILED_SYSTEM' } } });
    results.P2_neverAFourth = counted === 3;
    facts.P2 = { counted, statuses: burst2.map((r) => (r.status === 'fulfilled' ? 'ok' : (r.reason as { status?: number }).status)) };

    // P3
    const u3 = await newUser();
    const v3 = await prisma.kycVerification.create({
      data: {
        userId: u3, activeFor: u3, state: 'CREATED', lookupOutcome: 'IN_FLIGHT', lookupStartedAt: new Date(Date.now() - 6 * MINUTE),
        lagosDay: '2026-10-14', idType: 'BVN', idHash: 'h1:proof', idLast4: '0000', typedFirstName: 'a', typedLastName: 'b',
        typedDateOfBirth: '2000-01-01', typedAddress: {},
      },
    });
    await svc.failStaleLookups();
    const after3 = await prisma.kycVerification.findUniqueOrThrow({ where: { id: v3.id } });
    results.P3_failedSystem = after3.state === 'FAILED_SYSTEM' && after3.possiblyCharged && after3.activeFor === null && after3.lookupOutcome === 'UNKNOWN';

    // P4: a screen that "crashed" mid-call; its one re-send times out too
    const u4 = await newUser();
    const s4 = await prisma.amlScreening.create({
      data: {
        userId: u4, inputs: { names: 'A Amltimeout', date_of_birth: '2000-01-01', nationality: 'NG' }, inputFingerprint: randomUUID(),
        callOutcome: 'IN_FLIGHT', screenStartedAt: new Date(Date.now() - 6 * MINUTE), sendCount: 1,
      },
    });
    await prisma.user.update({ where: { id: u4 }, data: { amlStatus: 'PENDING' } });
    await aml.markStaleInFlight();
    await Promise.all([aml.send(s4.id), aml.send(s4.id), aml.send(s4.id)]); // three workers race the one re-send
    await aml.markStaleInFlight();
    for (const id of await aml.dueRetries()) if (id === s4.id) await aml.send(id);
    const after4 = await prisma.amlScreening.findUniqueOrThrow({ where: { id: s4.id } });
    // sendCount is the database's own count of claimed sends, whichever server made them.
    results.P4_resentExactlyOnce = after4.sendCount === 2;
    results.P4_thenError = after4.status === 'ERROR' && after4.unknownCount === 2 && after4.possibleDuplicateCharge;
    results.P4_oneCase = (await prisma.amlReviewCase.count({ where: { screeningId: s4.id, category: 'ERROR' } })) === 1;
    results.P4_userUnderReview = (await prisma.user.findUniqueOrThrow({ where: { id: u4 } })).amlStatus === 'UNDER_REVIEW';
    facts.P4 = { sendCount: after4.sendCount, status: after4.status, unknownCount: after4.unknownCount };

    // P5
    const c5 = await prisma.amlReviewCase.findFirstOrThrow({ where: { screeningId: s4.id } });
    try {
      await prisma.$executeRaw`UPDATE "aml_review_cases" SET "proposedBy" = 'same', "confirmedBy" = 'same' WHERE "id" = ${c5.id}`;
      results.P5_checkRefuses = false;
    } catch (e) {
      results.P5_checkRefuses = /23514|aml_case_confirmer_differs/.test(String((e as Error).message) + JSON.stringify(e));
    }
  } finally {
    for (const id of made) {
      const cases = await prisma.amlReviewCase.findMany({ where: { userId: id }, select: { id: true } });
      await prisma.alert.deleteMany({ where: { assetCode: { in: cases.map((c) => `case:${c.id}`) } } });
      await prisma.amlReviewCase.deleteMany({ where: { userId: id } });
      await prisma.kycVerification.deleteMany({ where: { userId: id } });
      await prisma.amlScreening.deleteMany({ where: { userId: id } });
      await prisma.refreshToken.deleteMany({ where: { userId: id } });
      await prisma.kycProfile.deleteMany({ where: { userId: id } });
      await prisma.user.delete({ where: { id } }).catch((e: Error) => console.error(`could not delete proof user ${id}: ${e.message}`));
    }
    await app.close();
  }

  console.log(JSON.stringify({ results, facts }, null, 2));
  if (!Object.values(results).every(Boolean)) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
