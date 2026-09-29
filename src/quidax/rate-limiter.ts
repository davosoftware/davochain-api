/**
 * Token-bucket limiter, shared across the process.
 *
 * The 300/min ceiling is ONE budget covering production, staging, the admin
 * dashboard and any developer pointed at the live key — it is one API key.
 * Background work gets its own small lane so a fee-claim run of 400 receivables
 * can never starve live trading.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
    readonly name: string,
  ) {
    this.tokens = capacity;
  }

  static perMinute(rate: number, name: string): TokenBucket {
    return new TokenBucket(rate, rate / 60_000, name);
  }

  static perSecond(rate: number, name: string): TokenBucket {
    return new TokenBucket(rate, rate / 1_000, name);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }

  async take(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.scheduleDrain();
    });
  }

  private draining = false;
  private scheduleDrain(): void {
    if (this.draining) return;
    this.draining = true;
    const tick = () => {
      this.refill();
      while (this.tokens >= 1 && this.queue.length > 0) {
        this.tokens -= 1;
        this.queue.shift()!();
      }
      if (this.queue.length > 0) {
        setTimeout(tick, Math.ceil(1 / this.refillPerMs));
      } else {
        this.draining = false;
      }
    };
    setTimeout(tick, Math.ceil(1 / this.refillPerMs));
  }

  get pending(): number {
    return this.queue.length;
  }

  get available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}

/**
 * Coalesces concurrent identical requests into one upstream call.
 *
 * A thousand users watching the BTC buy screen must not become a thousand
 * quotations. With a 3s window they become one call every 3 seconds, and each
 * user still gets their own fresh 12-second countdown.
 */
export class SingleFlight<T> {
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly cache = new Map<string, { value: T; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

  async run(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = fn()
      .then((value) => {
        this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  invalidate(key?: string): void {
    if (key) this.cache.delete(key);
    else this.cache.clear();
  }
}
