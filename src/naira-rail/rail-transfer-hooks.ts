import { Injectable, Logger } from '@nestjs/common';

/**
 * Who to tell when the rail says a transfer finished. The rail's webhook only
 * says "look at reference X"; the owner of that reference (Treasury moves start
 * with "trsy_", customer payouts with their own prefix) then asks the rail
 * itself, so a webhook's own numbers are never trusted.
 */
@Injectable()
export class RailTransferHooks {
  private readonly log = new Logger(RailTransferHooks.name);
  private readonly handlers: Array<{ prefix: string; recheck: (reference: string) => Promise<void> }> = [];

  on(prefix: string, recheck: (reference: string) => Promise<void>): void {
    this.handlers.push({ prefix, recheck });
  }

  /** A reference nobody owns is ignored. */
  async dispatch(reference: string): Promise<void> {
    const handler = this.handlers.find((h) => reference.startsWith(h.prefix));
    if (!handler) {
      this.log.warn(`A transfer webhook named a reference we don't own; ignored`);
      return;
    }
    await handler.recheck(reference);
  }
}
