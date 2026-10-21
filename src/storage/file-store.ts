import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Where uploaded files live (H8).
 *
 * Every file the API keeps — ID documents, gift-card photos — goes in and out
 * through this one plug, so the provider (Cloudflare R2 today) can be swapped
 * without touching the code that uses it. Keys are always chosen by the
 * server; nothing a client sends ever becomes part of one.
 */
export const FILE_STORE = Symbol('FILE_STORE');

export interface StoredObject {
  bytes: Buffer;
  contentType: string;
}

export interface FileStore {
  readonly driver: 'memory' | 'r2';
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  /** Null when there is no such object. */
  get(key: string): Promise<StoredObject | null>;
  /** Succeeds when the object is already gone. */
  delete(key: string): Promise<void>;
  /** Whether the store answers right now. Never throws. */
  ping(): Promise<boolean>;
  /**
   * A link that opens ONE file for `seconds` (1–600), for a provider that only
   * accepts links (Dojah's bill reader, spec 2026-10-21 §9). Never logged or stored.
   */
  temporaryLink(key: string, seconds: number): Promise<string>;
}

/** A temporary link lives 1 to 600 seconds, whole seconds. */
export function assertLinkLifetime(seconds: number): void {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) throw new RangeError('A temporary link lives 1 to 600 seconds');
}

/** The store could not be reached, timed out, or refused us. Never a missing object. */
export class StorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageUnavailableError';
  }
}

export const STORAGE_UNAVAILABLE_MESSAGE = 'File storage is unavailable right now. Please try again shortly.';

/** A storage outage as the 503 a caller should see; anything else unchanged. */
export function storageHttpError(err: unknown): unknown {
  return err instanceof StorageUnavailableError ? new ServiceUnavailableException(STORAGE_UNAVAILABLE_MESSAGE) : err;
}
