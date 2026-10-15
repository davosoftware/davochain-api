import { AlertType } from '@prisma/client';
import { WebhookRedriveService } from './webhook-redrive.service';

/**
 * H5 (PROJECT_REVIEW): a stored, genuine Quidax event that was never processed
 * (Redis was down when it arrived, or every retry failed) is queued again, and
 * a backlog that keeps growing raises an alert. Without this, the event was
 * simply lost: Quidax stops re-sending after about a day.
 */
function build(events: Array<{ id: string; receivedAt: Date }>, oldest: Date | null) {
  const prisma = {
    webhookEvent: {
      findMany: jest.fn(async () => events),
      findFirst: jest.fn(async () => (oldest ? { receivedAt: oldest } : null)),
    },
  };
  const queue = { add: jest.fn(async () => undefined) };
  const alerts = { raise: jest.fn(async () => true) };
  const leases = { run: jest.fn(async (_n: string, _t: number, fn: () => Promise<unknown>) => ({ ran: true, result: await fn() })) };
  const svc = new WebhookRedriveService(prisma as never, queue as never, alerts as never, leases as never);
  return { svc, prisma, queue, alerts };
}
const ago = (min: number) => new Date(Date.now() - min * 60_000);

describe('H5: unprocessed webhook events are re-driven', () => {
  it('queues every stored, genuine, unprocessed event again', async () => {
    const { svc, queue, prisma } = build([{ id: 'e1', receivedAt: ago(10) }, { id: 'e2', receivedAt: ago(5) }], ago(10));
    expect(await svc.redrive()).toBe(2);
    expect(queue.add).toHaveBeenCalledTimes(2);
    const where = JSON.stringify((prisma.webhookEvent.findMany.mock.calls[0] as unknown as [{ where: unknown }])[0].where);
    expect(where).toContain('"processedAt":null');
    expect(where).toContain('"signatureValid":true');
    expect(where).toContain('"attempts"');
  });

  it('uses a fresh job id, so a job BullMQ already gave up on can run again', async () => {
    const { svc, queue } = build([{ id: 'e1', receivedAt: ago(10) }], ago(10));
    await svc.redrive();
    const opts = (queue.add.mock.calls[0] as unknown[])[2] as { jobId: string };
    expect(opts.jobId).not.toBe('wh-e1');
    expect(opts.jobId).toContain('e1');
  });

  it('raises an alert when an event has waited more than 30 minutes', async () => {
    const { svc, alerts } = build([], ago(45));
    await svc.redrive();
    expect(alerts.raise).toHaveBeenCalledWith(AlertType.RECONCILIATION_DRIFT, 'quidax-webhook-backlog', expect.any(String), expect.any(Array));
  });

  it('stays quiet when nothing is waiting', async () => {
    const { svc, alerts } = build([], null);
    expect(await svc.redrive()).toBe(0);
    expect(alerts.raise).not.toHaveBeenCalled();
  });
});
