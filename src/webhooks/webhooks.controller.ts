import { Controller, Headers, HttpCode, Logger, Post, Req, UnauthorizedException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { SignatureService } from './signature.service';
import { Public } from '../auth/public.decorator';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { JOBS, QUEUES, jobId } from '../common/queues';
import { ApiTags } from '@nestjs/swagger';

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

/**
 * The inbound endpoint does three things and nothing else: verify, store,
 * return 200. All work happens on a worker.
 *
 * Anything other than a 200 — including a 3xx — counts as a failure upstream,
 * and the retry ladder is immediate / 1 min / 30 min / 1 hr / 24 hr and then it
 * stops FOREVER. A slow handler is therefore a lost event.
 */
@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  private readonly log = new Logger(WebhooksController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly signature: SignatureService,
    @InjectQueue(QUEUES.WEBHOOKS) private readonly queue: Queue,
  ) {}

  @Public()
  @RateLimit('webhooks')
  @Post('quidax')
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest,
    @Headers('quidax-signature') signatureHeader?: string,
  ): Promise<{ received: true }> {
    const raw = req.rawBody;
    const valid = await this.signature.verify(signatureHeader, raw);

    const payload = (req.body ?? {}) as { event?: string; data?: { id?: string } };
    const eventName = payload.event ?? 'unknown';

    // Dedup on the event name plus the resource id plus a body digest. Quidax
    // states plainly that the same event will arrive more than once.
    const dedupHash = createHash('sha256')
      .update(`${eventName}:${payload.data?.id ?? ''}:${raw?.toString('utf8') ?? ''}`)
      .digest('hex');

    if (!valid) {
      // The name came from an unauthenticated body: keep it only if it looks like an event name.
      const safeName = /^[a-z0-9._-]{1,64}$/i.test(eventName) ? eventName : 'unknown';
      // Record it — a run of these is either a misconfigured secret or someone
      // probing the endpoint, and both are worth being able to see.
      this.log.warn(`Rejected webhook signature for ${safeName}`);
      await this.prisma.webhookEvent
        .create({
          data: {
            eventName: safeName,
            dedupHash,
            // Size and reason only: an unauthenticated body is attacker-supplied and may carry anything.
            payload: { bytes: raw?.length ?? 0, reason: 'bad-signature', json: req.body !== undefined } as never,
            signatureValid: false,
          },
        })
        .catch(() => undefined);
      // H5: a 200 told the sender "accepted". Refuse it plainly.
      throw new UnauthorizedException('Invalid signature');
    }

    let toQueue: { id: string; jobId: string } | null = null;
    try {
      const stored = await this.prisma.webhookEvent.create({
        data: { eventName, dedupHash, payload: payload as never, signatureValid: true },
      });
      toQueue = { id: stored.id, jobId: jobId('wh', stored.id) };
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err;
      // H5: a duplicate delivery. If the first copy was stored but never
      // processed (Redis was down, or every retry failed), queue it again.
      const existing = await this.prisma.webhookEvent.findUnique({
        where: { dedupHash },
        select: { id: true, processedAt: true },
      });
      if (existing && !existing.processedAt) {
        toQueue = { id: existing.id, jobId: jobId('wh', existing.id, 'resent', Date.now()) };
      }
    }

    if (toQueue) {
      // The event is safely stored, so a queue failure must not lose it or make
      // Quidax think we refused it: the re-drive job picks it up (H5).
      await this.queue
        .add(JOBS.PROCESS_WEBHOOK, { webhookEventId: toQueue.id }, { jobId: toQueue.jobId })
        .catch((err: Error) => this.log.error(`Could not queue webhook event ${toQueue!.id}; the re-drive job will: ${err.message}`));
    }

    return { received: true };
  }
}
