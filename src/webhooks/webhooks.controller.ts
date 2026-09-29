import { Controller, Headers, HttpCode, Logger, Post, Req } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { SignatureService } from './signature.service';
import { Public } from '../auth/public.decorator';
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
      // Record it — a run of these is either a misconfigured secret or someone
      // probing the endpoint, and both are worth being able to see.
      this.log.warn(`Rejected webhook signature for ${eventName}`);
      await this.prisma.webhookEvent
        .create({
          data: {
            eventName,
            dedupHash,
            payload: payload as never,
            signatureValid: false,
          },
        })
        .catch(() => undefined);
      return { received: true };
    }

    const stored = await this.prisma.webhookEvent
      .create({
        data: { eventName, dedupHash, payload: payload as never, signatureValid: true },
      })
      .catch(() => null); // unique violation = duplicate delivery, already queued

    if (stored) {
      await this.queue.add(
        JOBS.PROCESS_WEBHOOK,
        { webhookEventId: stored.id },
        { jobId: jobId('wh', stored.id) },
      );
    }

    return { received: true };
  }
}
