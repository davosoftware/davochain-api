import { MemoryFileStore } from './memory-file-store';
import { StorageUnavailableError, storageHttpError, STORAGE_UNAVAILABLE_MESSAGE } from './file-store';
import { ServiceUnavailableException } from '@nestjs/common';

describe('MemoryFileStore', () => {
  it('gives back exactly what was put, with its type', async () => {
    const store = new MemoryFileStore();
    await store.put('kyc/u/1', Buffer.from('abc'), 'image/png');
    const got = await store.get('kyc/u/1');
    expect(got?.bytes.toString()).toBe('abc');
    expect(got?.contentType).toBe('image/png');
  });

  it('keeps its own copy, so a caller changing its buffer later changes nothing stored', async () => {
    const store = new MemoryFileStore();
    const buf = Buffer.from('abc');
    await store.put('k', buf, 'image/png');
    buf[0] = 0x7a;
    expect((await store.get('k'))?.bytes.toString()).toBe('abc');
  });

  it('returns null for a key that was never stored', async () => {
    expect(await new MemoryFileStore().get('nope')).toBeNull();
  });

  it('deletes, and deleting again is fine', async () => {
    const store = new MemoryFileStore();
    await store.put('k', Buffer.from('a'), 'image/png');
    await store.delete('k');
    await store.delete('k');
    expect(await store.get('k')).toBeNull();
    expect(store.has('k')).toBe(false);
  });

  it('refuses past its size cap as an outage, not a crash', async () => {
    const store = new MemoryFileStore(10);
    await store.put('a', Buffer.alloc(8), 'image/png');
    await expect(store.put('b', Buffer.alloc(8), 'image/png')).rejects.toBeInstanceOf(StorageUnavailableError);
    // Replacing a key counts only the new size.
    await expect(store.put('a', Buffer.alloc(9), 'image/png')).resolves.toBeUndefined();
  });

  it('can be told to fail its next calls, to rehearse an outage', async () => {
    const store = new MemoryFileStore();
    store.failNext(2);
    await expect(store.put('k', Buffer.from('a'), 'image/png')).rejects.toBeInstanceOf(StorageUnavailableError);
    await expect(store.get('k')).rejects.toBeInstanceOf(StorageUnavailableError);
    expect(await store.ping()).toBe(true);
  });

  it('ping says false during an outage instead of throwing', async () => {
    const store = new MemoryFileStore();
    store.failNext(1);
    expect(await store.ping()).toBe(false);
  });
});

describe('storageHttpError', () => {
  it('turns a storage outage into a 503 with a plain message', () => {
    const err = storageHttpError(new StorageUnavailableError('down'));
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).message).toBe(STORAGE_UNAVAILABLE_MESSAGE);
  });

  it('passes anything else through untouched', () => {
    const other = new Error('x');
    expect(storageHttpError(other)).toBe(other);
  });
});

describe('MemoryFileStore.temporaryLink', () => {
  it('makes a memory link that names the key and its expiry', async () => {
    const link = await new MemoryFileStore().temporaryLink('kyc/u 1/x', 300);
    expect(link).toMatch(/^memory:\/\/kyc%2Fu%201%2Fx\?expires=\d+$/);
  });
  it('refuses a lifetime outside 1–600 seconds', async () => {
    await expect(new MemoryFileStore().temporaryLink('k', 0)).rejects.toThrow(RangeError);
    await expect(new MemoryFileStore().temporaryLink('k', 601)).rejects.toThrow(RangeError);
    await expect(new MemoryFileStore().temporaryLink('k', 1.5)).rejects.toThrow(RangeError);
  });
});
