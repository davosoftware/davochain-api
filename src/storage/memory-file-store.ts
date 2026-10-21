import { FileStore, StorageUnavailableError, StoredObject, assertLinkLifetime } from './file-store';

const DEFAULT_CAP_BYTES = 200 * 1024 * 1024;

/**
 * The store used by tests, e2e and local development. Files vanish when the
 * process stops, which is why production refuses it (env.validation.ts).
 */
export class MemoryFileStore implements FileStore {
  readonly driver = 'memory' as const;
  private readonly objects = new Map<string, StoredObject>();
  private failures = 0;

  constructor(private readonly capBytes = DEFAULT_CAP_BYTES) {}

  /** Rehearse an outage: the next `count` calls fail as if R2 were down. */
  failNext(count = 1): void {
    this.failures = count;
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  keys(): string[] {
    return [...this.objects.keys()];
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    this.maybeFail('put');
    const used = this.usedBytes() - (this.objects.get(key)?.bytes.length ?? 0);
    if (used + bytes.length > this.capBytes) throw new StorageUnavailableError('memory store is full');
    this.objects.set(key, { bytes: Buffer.from(bytes), contentType });
  }

  async get(key: string): Promise<StoredObject | null> {
    this.maybeFail('get');
    const found = this.objects.get(key);
    return found ? { bytes: Buffer.from(found.bytes), contentType: found.contentType } : null;
  }

  async delete(key: string): Promise<void> {
    this.maybeFail('delete');
    this.objects.delete(key);
  }

  async ping(): Promise<boolean> {
    try {
      this.maybeFail('ping');
      return true;
    } catch {
      return false;
    }
  }

  /** Not a web link: the Dojah mock reads "memory://<key>" back from this store. */
  async temporaryLink(key: string, seconds: number): Promise<string> {
    assertLinkLifetime(seconds);
    this.maybeFail('link');
    return `memory://${encodeURIComponent(key)}?expires=${Date.now() + seconds * 1000}`;
  }

  private maybeFail(op: string): void {
    if (this.failures > 0) {
      this.failures--;
      throw new StorageUnavailableError(`memory store ${op} failed (rehearsed outage)`);
    }
  }

  private usedBytes(): number {
    let total = 0;
    for (const o of this.objects.values()) total += o.bytes.length;
    return total;
  }
}
