import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CredentialsService } from '../common/credentials.service';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Quidax signs as:
 *
 *   quidax-signature: timestamp=<unix>, v1=<hex>
 *   v1 = HMAC_SHA256(secret, `${timestamp}.${rawBody}`)
 *
 * The body must be the RAW BYTES. Nest's parser re-serialises JSON and
 * re-stringifying will not reproduce them — key order, whitespace and number
 * formatting all differ — so a parsed body fails verification on every event.
 * main.ts sets rawBody:true for exactly this.
 */
@Injectable()
export class SignatureService {
  private readonly log = new Logger(SignatureService.name);

  constructor(private readonly config: ConfigService,
    private readonly credentials: CredentialsService,
  ) {}

  async verify(header: string | undefined, rawBody: Buffer | undefined): Promise<boolean> {
    const secret = await this.credentials.get('quidax.webhookSecret');

    // With the mock in charge there is no upstream signing anything.
    if (!secret) {
      if (this.config.get<boolean>('QUIDAX_USE_MOCK')) return true;
      this.log.error('QUIDAX_WEBHOOK_SECRET is not set — rejecting webhook');
      return false;
    }

    if (!header || !rawBody) return false;

    const parsed = this.parseHeader(header);
    if (!parsed) return false;

    // Close the replay window.
    const toleranceSec = this.config.get<number>('QUIDAX_WEBHOOK_TOLERANCE_SECONDS') ?? 300;
    const ageSec = Math.abs(Date.now() / 1000 - parsed.timestamp);
    if (ageSec > toleranceSec) {
      this.log.warn(`Rejected webhook: timestamp ${Math.round(ageSec)}s outside tolerance`);
      return false;
    }

    const expected = createHmac('sha256', secret)
      .update(`${parsed.timestamp}.${rawBody.toString('utf8')}`)
      .digest('hex');

    return this.constantTimeEqual(expected, parsed.signature);
  }

  private parseHeader(header: string): { timestamp: number; signature: string } | null {
    let timestamp: number | null = null;
    let signature: string | null = null;

    for (const part of header.split(',')) {
      const [k, v] = part.trim().split('=');
      if (k === 'timestamp') timestamp = Number(v);
      if (k === 'v1') signature = v;
    }
    if (timestamp === null || Number.isNaN(timestamp) || !signature) {
      this.log.warn('Malformed quidax-signature header');
      return null;
    }
    return { timestamp, signature };
  }

  private constantTimeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}
