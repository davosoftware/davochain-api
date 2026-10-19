import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { R2FileStore } from './r2-file-store';
import { StorageUnavailableError } from './file-store';

/** A stand-in for the S3 client: records every command, answers with `reply`. */
function fakeClient(reply: (cmd: unknown) => unknown) {
  const sent: unknown[] = [];
  return {
    sent,
    client: {
      send: jest.fn(async (cmd: unknown) => {
        sent.push(cmd);
        const r = reply(cmd);
        if (r instanceof Error) throw r;
        return r;
      }),
    },
  };
}

const err = (name: string, status?: number) =>
  Object.assign(new Error(name), { name, $metadata: status ? { httpStatusCode: status } : {} });

const body = (text: string) => ({ transformToByteArray: async () => new Uint8Array(Buffer.from(text)) });

describe('R2FileStore', () => {
  it('puts to its own bucket with the type and length', async () => {
    const f = fakeClient(() => ({}));
    const store = new R2FileStore(f.client as never, 'bucket-1');
    await store.put('kyc/u/1', Buffer.from('abcd'), 'image/png');
    const cmd = f.sent[0] as PutObjectCommand;
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input).toMatchObject({ Bucket: 'bucket-1', Key: 'kyc/u/1', ContentType: 'image/png', ContentLength: 4 });
  });

  it('reads an object back as bytes with its type', async () => {
    const f = fakeClient(() => ({ Body: body('hi'), ContentType: 'application/pdf' }));
    const got = await new R2FileStore(f.client as never, 'b').get('k');
    expect(f.sent[0]).toBeInstanceOf(GetObjectCommand);
    expect(got?.bytes.toString()).toBe('hi');
    expect(got?.contentType).toBe('application/pdf');
  });

  it('returns null when the object does not exist', async () => {
    const f = fakeClient(() => err('NoSuchKey', 404));
    expect(await new R2FileStore(f.client as never, 'b').get('k')).toBeNull();
  });

  it.each([
    ['a timeout', err('TimeoutError')],
    ['a server error', err('InternalError', 500)],
    ['a network failure', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
    ['bad keys', err('InvalidAccessKeyId', 403)],
  ])('reports %s as storage being unavailable', async (_label, failure) => {
    const f = fakeClient(() => failure);
    const store = new R2FileStore(f.client as never, 'b');
    await expect(store.put('k', Buffer.from('a'), 'image/png')).rejects.toBeInstanceOf(StorageUnavailableError);
    await expect(store.get('k')).rejects.toBeInstanceOf(StorageUnavailableError);
    await expect(store.delete('k')).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it('never repeats the provider error text, which can carry the account id', async () => {
    const f = fakeClient(() => err('InternalError', 500));
    await expect(new R2FileStore(f.client as never, 'b').get('k')).rejects.toThrow(/^R2 get failed \(InternalError\)$/);
  });

  it('deletes, and a missing object is not an error', async () => {
    const f = fakeClient(() => ({}));
    await new R2FileStore(f.client as never, 'b').delete('k');
    expect(f.sent[0]).toBeInstanceOf(DeleteObjectCommand);
    const g = fakeClient(() => err('NoSuchKey', 404));
    await expect(new R2FileStore(g.client as never, 'b').delete('k')).resolves.toBeUndefined();
  });

  it('ping checks the bucket and never throws', async () => {
    const ok = fakeClient(() => ({}));
    expect(await new R2FileStore(ok.client as never, 'b').ping()).toBe(true);
    expect(ok.sent[0]).toBeInstanceOf(HeadBucketCommand);
    const down = fakeClient(() => err('TimeoutError'));
    expect(await new R2FileStore(down.client as never, 'b').ping()).toBe(false);
  });
});
