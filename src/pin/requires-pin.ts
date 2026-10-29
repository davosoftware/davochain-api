import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, UseGuards, applyDecorators } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import { TransactionPinService } from './transaction-pin.service';

/** The header the app puts the 4-digit PIN in (29 Oct 2026). */
export const PIN_HEADER = 'x-transaction-pin';

/**
 * Checks the transaction PIN. A route guard, so it runs after the global ones:
 * the customer is signed in, verified and allowed to do this before a PIN
 * try is spent.
 */
@Injectable()
export class TransactionPinGuard implements CanActivate {
  constructor(private readonly pins: TransactionPinService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined>; user?: { sub: string } }>();
    if (!req.user) throw new UnauthorizedException();
    const raw = req.headers[PIN_HEADER];
    const pin = (Array.isArray(raw) ? raw[0] : raw)?.trim() || undefined;
    await this.pins.verify(req.user.sub, pin);
    return true;
  }
}

/** Money leaves the wallet, or a swap runs: ask for the PIN. */
export const RequiresPin = () =>
  applyDecorators(
    UseGuards(TransactionPinGuard),
    ApiHeader({ name: 'X-Transaction-Pin', required: true, description: 'The customer\'s 4-digit transaction PIN' }),
  );
