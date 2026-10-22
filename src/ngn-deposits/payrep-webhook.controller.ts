import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  InternalServerErrorException,
  Logger,
  Optional,
  PayloadTooLargeException,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AlertType, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../auth/public.decorator';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { parseJsonExact } from '../common/exact-json';
import { redactIds } from '../common/redact';
import { OpsAlertsService } from '../common/ops-alerts/ops-alerts.service';
import { RailTransferHooks } from '../naira-rail/rail-transfer-hooks';
import { PayrepConfig } from '../payrep/payrep.config';
import { verifyPayrepWebhook } from '../payrep/webhook-signature';
import { collectionKey } from '../payrep/payrep.parse';

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

export const MAX_WEBHOOK_BYTES = 64 * 1024;
const HOUR = 3_600_000;
type Obj = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);

/**
 * A copy safe to store: any identity-number field is dropped, and any 11-digit
 * number left in a text value is redacted. Account events may carry the
 * customer's BVN or NIN, which DavoChain never keeps (final review I4).
 */
const IDENTITY_KEY = /(^|_)(bvn|nin)(_|$)|identity|id_number/i;
function withoutIdentity(v: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (typeof v === 'string') return redactIds(v);
  if (Array.isArray(v)) return v.map((x) => withoutIdentity(x, depth + 1));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Obj).filter(([k]) => !IDENTITY_KEY.test(k)).map(([k, x]) => [k, withoutIdentity(x, depth + 1)]));
  }
  return v;
}

const TRANSFER_EVENTS =['transfer.success', 'transfer.failed', 'transfer.pending'];
const DEPOSIT_EVENTS = ['deposit.success', 'deposit.pending', 'collection.success', 'collection.pending'];

/** What a webhook told us about a deposit: a hint to look up, never believed about money. */
export interface CollectionHint {
  transactionId: string;
  accountNumber: string | null;
  referenceNumber: string | null;
  createdAt: string | null;
  event: string;
}

/** The deposit side registers here (pay-in.service.ts). */
export abstract class DepositIntake {
  abstract intake(hint: CollectionHint, source: 'WEBHOOK' | 'SWEEP'): Promise<void>;
}

/**
 * Payrep's webhook (spec §6.1): check the signature (the one recipe, §2.5 C1),
 * store, answer 200 fast, then hand on. The body is never believed about money:
 * a transfer's owner asks Transaction Status, and a deposit is confirmed with
 * fetch_transactions before it is credited.
 */
@ApiTags('webhooks')
@Controller('webhooks')
export class PayrepWebhookController {
  private readonly log = new Logger(PayrepWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: PayrepConfig,
    private readonly alerts: OpsAlertsService,
    @Optional() private readonly hooks?: RailTransferHooks,
    @Optional() private readonly deposits?: DepositIntake,
  ) {}

  @Public()
  @RateLimit('webhooks')
  @Post('payrep')
  @HttpCode(200)
  async receive(
    @Req() req: RawBodyRequest,
    @Headers('x-timestamp') timestamp?: string,
    @Headers('x-signature') signature?: string,
    @Headers('x-webhook-id') webhookId?: string,
  ): Promise<{ received: true }> {
    const raw = req.rawBody ?? Buffer.alloc(0);
    if (raw.length > MAX_WEBHOOK_BYTES) throw new PayloadTooLargeException('Webhook body is over 64 KB');

    const secret = await this.cfg.webhookSecret().catch(() => null);
    const verdict = verifyPayrepWebhook({ secret, timestamp, signature, raw, nowMs: Date.now() });
    if (verdict !== 'OK') {
      await this.refused(raw, verdict, timestamp, signature);
      throw new UnauthorizedException('Invalid Payrep signature');
    }

    let body: Obj;
    try {
      body = (parseJsonExact(raw.toString('utf8')) ?? {}) as Obj;
    } catch {
      throw new BadRequestException('The body is not JSON');
    }
    const event = s(body.event) ?? s(body.event_type) ?? 'unknown';
    // Wrapped as {event, data} per the docs, or flat (fields beside the event): accept both.
    const data = (body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : body) as Obj;
    // A collection carries no transaction_id and a null reference_number on the sandbox: the bank's reference is the id.
    const id = s(data.transaction_id) ?? collectionKey(data);

    try {
      await this.store(event, id, raw, body, webhookId);
    } catch (err) {
      this.log.error(`Could not store a Payrep webhook: ${redactIds((err as Error).message)}`);
      throw new InternalServerErrorException('Could not store the webhook; Payrep will retry');
    }

    // Stored already: a failure from here on is caught by the sweep and the re-checks, not by a Payrep retry.
    await this.handOn(event, data).catch((err: Error) => this.log.error(`Payrep ${event}: ${redactIds(err.message)}`));
    return { received: true };
  }

  private async handOn(event: string, data: Obj): Promise<void> {
    const reference = s(data.reference_number);
    const txId = s(data.transaction_id) ?? collectionKey(data);
    const depositId = collectionKey(data);
    if (TRANSFER_EVENTS.includes(event)) {
      if (reference && this.hooks) await this.hooks.dispatch(reference);
      return;
    }
    if (event === 'transfer.reversal') {
      await this.alerts.raise(
        AlertType.PAYOUT_REVERSED,
        `reversal:${reference ?? txId ?? 'unknown'}`,
        `Payrep reversed a transfer that had succeeded: ₦${s(data.amount) ?? '?'}`,
        [
          `Our reference: ${reference ?? 'none'}`,
          `Payrep id: ${txId ?? 'none'}`,
          'Nothing was changed automatically (spec C4). Check the main account and decide what the customer or Treasury record should show.',
        ],
        24 * HOUR,
      );
      return;
    }
    if (event === 'deposit.reversed' || event === 'collection.reversed') {
      await this.alerts.raise(
        AlertType.DEPOSIT_REVERSED,
        `reversed:${txId ?? reference ?? 'unknown'}`,
        `Payrep reversed a deposit: ₦${s(data.amount) ?? '?'}`,
        [`Payrep id: ${txId ?? 'none'}`, `Account: ${s(data.account_number) ?? 'unknown'}`, 'Nothing was clawed back automatically. Review the customer balance.'],
        24 * HOUR,
      );
      return;
    }
    if (DEPOSIT_EVENTS.includes(event) && depositId && this.deposits) {
      await this.deposits.intake({ transactionId: depositId, accountNumber: s(data.account_number), referenceNumber: reference, createdAt: s(data.created_at), event }, 'WEBHOOK');
    }
    // deposit.failed, account.*, tier.*, dispute.*, compliance.charge: stored only.
  }

  /** Stored already processed: the Quidax re-drive (webhook-redrive.service.ts) must never pick these up. */
  private async store(event: string, id: string | null, raw: Buffer, body: Obj, webhookId?: string): Promise<void> {
    const dedupHash = id
      ? createHash('sha256').update(`payrep:${event}:${id}`).digest('hex')
      : createHash('sha256').update('payrep:').update(raw).digest('hex');
    try {
      await this.prisma.webhookEvent.create({
        data: {
          eventName: `payrep.${event}`,
          dedupHash,
          payload: { ...(withoutIdentity(body) as Obj), _webhookId: webhookId ?? null } as Prisma.InputJsonValue,
          signatureValid: true,
          processedAt: new Date(),
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err; // the same event again: already stored
    }
  }

  private async refused(raw: Buffer, verdict: string, timestamp?: string, signature?: string): Promise<void> {
    this.log.warn(`Refused a Payrep webhook: ${verdict}`);
    try {
      // Outside production, keep what check-payrep needs to confirm the recipe (C1). Never in production.
      const capture = this.cfg.nodeEnv !== 'production' ? { timestamp: timestamp ?? null, signature: signature ?? null, body: raw.toString('base64') } : null;
      await this.prisma.webhookEvent.create({
        data: {
          eventName: 'payrep.unauthenticated',
          dedupHash: createHash('sha256').update(`${Date.now()}:${Math.random()}:`).update(raw).digest('hex'),
          payload: { bytes: raw.length, verdict, capture } as Prisma.InputJsonValue,
          signatureValid: false,
          processedAt: new Date(),
        },
      });
      const recent = await this.prisma.webhookEvent.count({ where: { eventName: 'payrep.unauthenticated', receivedAt: { gte: new Date(Date.now() - HOUR) } } });
      if (recent >= 3) {
        await this.alerts.raise(
          AlertType.NAIRA_WEBHOOK_REJECTED,
          'webhook-rejected',
          `Payrep webhooks refused: ${recent} in the last hour (${verdict})`,
          [
            'Compare the Payrep portal → API Keys → Webhooks signing secret with PAYREP_WEBHOOK_SECRET (or System → API keys).',
            'A clock more than 5 minutes off on this server also causes this.',
            'Deposits are still found by the 30-minute sweep.',
          ],
          HOUR,
        );
      }
    } catch (err) {
      this.log.error(`Could not record a refused Payrep webhook: ${redactIds((err as Error).message)}`);
    }
  }
}
