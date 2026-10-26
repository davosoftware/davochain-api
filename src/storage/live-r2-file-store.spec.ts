import { LiveR2FileStore, type R2Source } from './live-r2-file-store';
import type { FileStore } from './file-store';

/** R2 settings changed on the dashboard (spec 2026-10-26) take effect without a restart. */
function fakeStore(tag: string): FileStore & { tag: string } {
  return {
    tag,
    driver: 'r2',
    put: jest.fn(async () => undefined),
    get: jest.fn(async () => ({ bytes: Buffer.from(tag), contentType: 'text/plain' })),
    delete: jest.fn(async () => undefined),
    ping: jest.fn(async () => true),
    temporaryLink: jest.fn(async () => `https://${tag}`),
  } as never;
}

describe('LiveR2FileStore', () => {
  it('builds the store once, and again only when the account, bucket or a key changes', async () => {
    let settings = { accountId: 'a'.repeat(32), bucket: 'docs', accessKeyId: 'AK1', secretAccessKey: 'SK1' };
    const source: R2Source = async () => settings;
    const built: string[] = [];
    const store = new LiveR2FileStore(source, (s) => {
      built.push(`${s.bucket}/${s.accessKeyId}`);
      return fakeStore(`${s.bucket}/${s.accessKeyId}`);
    });

    await store.put('k', Buffer.from('x'), 'text/plain');
    await store.get('k');
    expect(built).toEqual(['docs/AK1']);

    settings = { ...settings, accessKeyId: 'AK2', secretAccessKey: 'SK2' };
    expect((await store.get('k'))!.bytes.toString()).toBe('docs/AK2');
    settings = { ...settings, bucket: 'docs-2' };
    await store.ping();
    expect(built).toEqual(['docs/AK1', 'docs/AK2', 'docs-2/AK2']);
    expect(await store.currentBucket()).toBe('docs-2');
  });

  it('missing settings: ping says no, and a write fails with a clear message instead of using stale keys', async () => {
    const store = new LiveR2FileStore(async () => null, () => fakeStore('never'));
    expect(await store.ping()).toBe(false);
    await expect(store.put('k', Buffer.from('x'), 'text/plain')).rejects.toThrow(/File storage is not set up/);
  });
});
