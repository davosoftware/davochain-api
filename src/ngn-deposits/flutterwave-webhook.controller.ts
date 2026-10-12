import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  InternalServerErrorException,
  Logger,
  PayloadTooLargeException,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AlertType, CollectionOutcome, Prisma } from '@prisma/client';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../auth/public.decorator';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { parseJsonExact } from '../common/exact-json';
import { FlutterwaveConfig } from '../flutterwave/flutterwave.config';
import { redactIds } from '../flutterwave/flutterwave.errors';
import { OpsAlertsService } from '../common/ops-alerts/ops-alerts.service';
import { PayInService } from './pay-in.service';
import { parseFlutterwaveWebhook } from './webhook-payload';

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

export const MAX_WEBHOOK_BYTES = 64 * 1024;
const HOUR = 3_600_000;

/** Constant time whatever the lengths: compare SHA-256 digests, never the strings. */
export function sameSecret(given: string | undefined, expected: string): boolean {
  if (typeof given !== 'string' || given.length === 0) return false;
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * Flutterwave's webhook (spec §6.2): authenticate, store, queue, answer.
 *
 * `verif-hash` is a static shared secret, not a signature over the body, so
 * nothing in the body is believed. The transaction id only says which payment
 * to verify with our own key (pay-in.service.ts). A forged body can at most
 * make us look up a real payment, which is credited once whoever reports it.
 * 200 means stored; anything less and Flutterwave retries.
 */
@ApiTags('webhooks')
@Controller('webhooks')
export class FlutterwaveWebhookController {
  private readonly log = new Logger(FlutterwaveWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: FlutterwaveConfig,
    private readonly payIn: PayInService,
    private readonly alerts: OpsAlertsService,
  ) {}

  @Public()
  @RateLimit('webhooks')
  @Post('flutterwave')
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest,
    @Headers('verif-hash') verifHash?: string,
  ): Promise<{ received: true }> {
    const raw = req.rawBody ?? Buffer.alloc(0);
    if (raw.length > MAX_WEBHOOK_BYTES) throw new PayloadTooLargeException('Webhook body is over 64 KB');

    const expected = await this.cfg.secretHash().catch(() => null);
    if (!expected || !sameSecret(verifHash, expected)) {
      await this.reject(raw, Boolean(verifHash));
      throw new UnauthorizedException('Invalid verif-hash');
    }

    let body: unknown;
    try {
      body = parseJsonExact(raw.toString('utf8'));
    } catch {
      throw new BadRequestException('The body is not JSON');
    }
    const parsed = parseFlutterwaveWebhook(body);
    const charge = parsed.kind === 'CHARGE' ? parsed.transactionId : null;

    try {
      await this.store(parsed.eventName, charge ? `charge:${charge}:` : `${parsed.eventName}:`, raw, body);
      if (charge) {
        await this.prisma.flutterwaveCollection.upsert({
          where: { flwTransactionId: charge },
          create: {
            flwTransactionId: charge,
            outcome: CollectionOutcome.UNVERIFIED,
            firstSource: 'WEBHOOK',
            webhookHint: parsed.hint,
          },
          update: {},
        });
      }
    } catch (err) {
      this.log.error(`Could not store a Flutterwave webhook: ${redactIds((err as Error).message)}`);
      throw new InternalServerErrorException('Could not store the webhook; Flutterwave will retry');
    }

    if (charge) {
      // Stored. If queueing fails, the re-check pass picks the payment up from its row.
      await this.payIn.enqueue(charge, 'WEBHOOK').catch((err: Error) => {
        this.log.error(`Could not queue Flutterwave payment ${charge}: ${redactIds(err.message)}`);
      });
    }
    return { received: true };
  }

  private async store(eventName: string, prefix: string, raw: Buffer, body: unknown): Promise<void> {
    const dedupHash = createHash('sha256').update(prefix).update(raw).digest('hex');
    try {
      await this.prisma.webhookEvent.create({
        data: { eventName, dedupHash, payload: (body ?? {}) as Prisma.InputJsonValue, signatureValid: true },
      });
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err; // the same delivery again: already stored
    }
  }

  private async reject(raw: Buffer, hadHeader: boolean): Promise<void> {
    const reason = hadHeader ? 'wrong' : 'missing';
    this.log.warn(`Rejected a Flutterwave webhook: ${reason} verif-hash`);
    try {
      // Determine if the body is valid JSON without storing it
      let json = false;
      try {
        parseJsonExact(raw.toString('utf8'));
        json = true;
      } catch {
        // Body is not valid JSON
      }
      const payload = { bytes: raw.length, reason, json };
      await this.prisma.webhookEvent.create({
        data: {
          eventName: 'flutterwave.unauthenticated',
          dedupHash: createHash('sha256').update(raw).digest('hex'),
          payload: payload as Prisma.InputJsonValue,
          signatureValid: false,
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') {
        this.log.error(`Could not record a rejected webhook: ${redactIds((err as Error).message)}`);
      }
    }
    await this.alerts.raise(
      AlertType.FLUTTERWAVE_WEBHOOK_REJECTED,
      'webhook-rejected',
      `Flutterwave webhook rejected: ${reason} verif-hash`,
      [
        'Compare Settings → Webhooks → Secret hash in the Flutterwave dashboard with FLW_SECRET_HASH (or System → API keys).',
        'Flutterwave retries three times, 30 minutes apart; the sweep catches anything later.',
      ],
      HOUR,
    );
  }
}
