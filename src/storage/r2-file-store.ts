import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { FileStore, StorageUnavailableError, StoredObject, assertLinkLifetime } from './file-store';

export interface R2Settings {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/** The part of S3Client this store uses, so tests can hand in a stand-in. */
export interface S3Sender {
  send(command: unknown): Promise<unknown>;
}

/** Signs a GET for one object. Separate from S3Sender so tests can hand in a stand-in. */
export interface Presigner {
  presign(key: string, seconds: number): Promise<string>;
}

/** The real signer: a GET for one key, signed with the R2 token (spec 2026-10-21 §9). */
export function r2Presigner(client: S3Client, bucket: string): Presigner {
  return { presign: (key, seconds) => getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: seconds }) };
}

/** R2 speaks the S3 protocol; the region is always "auto". */
export function makeR2Client(s: R2Settings): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${s.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
    // The SDK retries failed calls itself; three tries in all.
    maxAttempts: 3,
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
  });
}

function isMissing(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

/**
 * Cloudflare R2. The bucket is private: nothing here builds a public URL. The
 * only link is temporaryLink: one file, minutes long, for a provider that
 * requires a link (Dojah's bill reader). Everything else leaves through the
 * API's own checked routes.
 */
export class R2FileStore implements FileStore {
  readonly driver = 'r2' as const;

  constructor(
    private readonly client: S3Sender,
    readonly bucket: string,
    private readonly signer?: Presigner,
  ) {}

  async temporaryLink(key: string, seconds: number): Promise<string> {
    assertLinkLifetime(seconds);
    if (!this.signer) throw new StorageUnavailableError('R2 link signing is not configured');
    try {
      return await this.signer.presign(key, seconds);
    } catch (err) {
      throw this.unavailable('link', err);
    }
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    await this.call('put', () =>
      this.client.send(
        new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: contentType, ContentLength: bytes.length }),
      ),
    );
  }

  async get(key: string): Promise<StoredObject | null> {
    try {
      const out = (await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))) as {
        Body?: { transformToByteArray(): Promise<Uint8Array> };
        ContentType?: string;
      };
      if (!out.Body) return null;
      const bytes = Buffer.from(await out.Body.transformToByteArray());
      return { bytes, contentType: out.ContentType ?? 'application/octet-stream' };
    } catch (err) {
      if (isMissing(err)) return null;
      throw this.unavailable('get', err);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      if (isMissing(err)) return;
      throw this.unavailable('delete', err);
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch {
      return false;
    }
  }

  private async call(op: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      throw this.unavailable(op, err);
    }
  }

  /** Only the error's name: provider messages can carry the account id or the endpoint. */
  private unavailable(op: string, err: unknown): StorageUnavailableError {
    const e = err as { name?: string; code?: string };
    return new StorageUnavailableError(`R2 ${op} failed (${e?.code ?? e?.name ?? 'unknown'})`);
  }
}
