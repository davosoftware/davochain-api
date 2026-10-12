import { ServiceUnavailableException } from '@nestjs/common';

export class HashBusyError extends ServiceUnavailableException {
  constructor() {
    super('The service is busy, try again shortly');
  }
}

/**
 * At most `concurrency` password hashes at once in this process, up to
 * `maxQueue` waiting, each waiting at most `waitMs` (spec §4.3). scrypt holds
 * ~32 MB per hash, so this bounds a login burst's memory to
 * concurrency × 32 MB instead of letting it grow until the process dies.
 *
 * Per process on purpose: it protects this process's memory. The limits that
 * must be shared across servers live in Redis and Postgres.
 */
export class HashSemaphore {
  private running = 0;
  private readonly waiting: Array<{ go: () => void }> = [];

  constructor(
    private readonly concurrency: number,
    private readonly maxQueue: number,
    private readonly waitMs = 10_000,
  ) {}

  get inFlight(): number {
    return this.running;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.concurrency) {
      this.running++;
      return Promise.resolve();
    }
    if (this.waiting.length >= this.maxQueue) return Promise.reject(new HashBusyError());
    return new Promise<void>((resolve, reject) => {
      const entry = {
        go: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        const at = this.waiting.indexOf(entry);
        if (at >= 0) this.waiting.splice(at, 1);
        reject(new HashBusyError());
      }, this.waitMs);
      this.waiting.push(entry);
    });
  }

  /** Hand the slot straight to the next waiter, or give it back. */
  private release(): void {
    const next = this.waiting.shift();
    if (next) next.go();
    else this.running--;
  }
}
