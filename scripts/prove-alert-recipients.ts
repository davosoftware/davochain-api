/**
 * Proves two admins cannot, at the same moment, remove (or disable) the last
 * two recipients of a security alert (spec §3.3, acceptance A3): exactly one
 * of the two parallel changes succeeds and one recipient remains enabled.
 *
 * Uses throwaway rows on the local dev database and deletes them afterwards.
 * Refuses if ADMIN_LOCKOUT already has enabled recipients there, so it never
 * touches real configuration.
 *
 * Run: npx ts-node --transpile-only --compiler-options '{"module":"CommonJS"}' scripts/prove-alert-recipients.ts
 */
import { AlertType, PrismaClient } from '@prisma/client';
import { AlertRecipientsService } from '../src/common/ops-alerts/alert-recipients.service';
import { refuseUnlessLocalDevelopment } from './local-dev-guard';

const TYPE = AlertType.ADMIN_LOCKOUT;
const PREFIX = 'rl-proof-';

async function race(svc: AlertRecipientsService, prisma: PrismaClient, how: 'remove' | 'disable') {
  const a = await svc.add(TYPE, `${PREFIX}a-${Date.now()}@davochain.test`);
  const b = await svc.add(TYPE, `${PREFIX}b-${Date.now()}@davochain.test`);
  const act = (id: string) => (how === 'remove' ? svc.remove(id) : svc.setEnabled(id, false));
  const results = await Promise.allSettled([act(a.id), act(b.id)]);
  const enabled = await prisma.alertRecipient.count({ where: { type: TYPE, enabled: true, email: { startsWith: PREFIX } } });
  const refused = results.filter((r) => r.status === 'rejected' && (r.reason as { status?: number }).status === 409).length;
  await prisma.alertRecipient.deleteMany({ where: { email: { startsWith: PREFIX } } });
  return { how, succeeded: results.filter((r) => r.status === 'fulfilled').length, refused409: refused, stillEnabled: enabled };
}

async function main(): Promise<void> {
  refuseUnlessLocalDevelopment();
  const prisma = new PrismaClient();
  try {
    const real = await prisma.alertRecipient.count({ where: { type: TYPE, enabled: true, NOT: { email: { startsWith: PREFIX } } } });
    if (real > 0) throw new Error(`${TYPE} already has ${real} enabled recipient(s) here; refusing to run beside real configuration`);
    const svc = new AlertRecipientsService(prisma as never, { get: () => [] } as never);
    const results = [];
    for (let run = 0; run < 3; run++) results.push(await race(svc, prisma, 'remove'), await race(svc, prisma, 'disable'));
    const proven = results.every((r) => r.succeeded === 1 && r.refused409 === 1 && r.stillEnabled === 1);
    if (!proven) process.exitCode = 1;
    console.log(JSON.stringify({ proven, results }));
  } finally {
    await prisma.$disconnect();
  }
}

void main();
