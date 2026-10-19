import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { GiftCardsService } from './giftcards.service';
import { MemoryFileStore } from '../storage/memory-file-store';
import { UploadIntents } from '../storage/upload-intents.service';
import { dec } from '../common/money';

/** Gift-card photos in the file store (H8 / R2 storage spec §9). */

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAA==', 'base64');
const dataUrl = (b: Buffer, t = 'image/png') => `data:${t};base64,${b.toString('base64')}`;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

type Img = { id: string; tradeId: string; image: Buffer | null; imageType: string; storageKey: string | null; sha256: string | null; sortOrder: number };
type Trade = { id: string; userId: string; typeId: string; faceValue: string; createdAt: Date; images: Img[] };

function setup() {
  const trades: Trade[] = [];
  const intents = new Map<string, Date>();
  const store = new MemoryFileStore();
  let failCreate: Error | null = null;
  const pendingUpload = {
    create: jest.fn(async ({ data }: { data: { key: string } }) => void intents.set(data.key, new Date())),
    createMany: jest.fn(async ({ data }: { data: { key: string; createdAt: Date }[] }) => data.forEach((d) => intents.set(d.key, d.createdAt))),
    deleteMany: jest.fn(async ({ where }: { where: { key: string | { in: string[] } } }) => {
      const keys = typeof where.key === 'string' ? [where.key] : where.key.in;
      return { count: keys.filter((k) => intents.delete(k)).length };
    }),
    findMany: jest.fn(async () => []),
  };
  const giftCardTrade = {
    findMany: jest.fn(async ({ where }: { where: { userId: string; typeId: string; faceValue: string; createdAt: { gte: Date } } }) =>
      trades
        .filter((t) => t.userId === where.userId && t.typeId === where.typeId && t.faceValue === where.faceValue && t.createdAt >= where.createdAt.gte)
        .map((t) => ({ id: t.id, images: [...t.images].sort((a, b) => a.sortOrder - b.sortOrder).map((i) => ({ sha256: i.sha256 })) })),
    ),
    create: jest.fn(async ({ data }: { data: { userId: string; typeId: string; faceValue: string; images: { create: Omit<Img, 'id' | 'tradeId' | 'image'>[] } } }) => {
      if (failCreate) {
        const e = failCreate;
        failCreate = null;
        throw e;
      }
      const id = `g${trades.length + 1}`;
      trades.push({
        id,
        userId: data.userId,
        typeId: data.typeId,
        faceValue: data.faceValue,
        createdAt: new Date(),
        images: data.images.create.map((c, i) => ({ ...c, id: `${id}-i${i}`, tradeId: id, image: null })),
      });
      return { id };
    }),
  };
  const tx = { user: { findUnique: jest.fn(async () => ({ kycTier: 'TIER_1' })) }, giftCardTrade, pendingUpload };
  const prisma = {
    ...tx,
    giftCardType: {
      findUnique: jest.fn(async () => ({ id: 't1', isActive: true, minAmount: '1', maxAmount: '10000', rateNgn: '1200', currency: 'USD', name: 'Card', brand: { isActive: true, name: 'Brand', category: { isActive: true } } })),
    },
    giftCardTradeImage: {
      findFirst: jest.fn(async ({ where }: { where: { id: string; tradeId: string; trade?: { userId: string } } }) => {
        const t = trades.find((x) => x.id === where.tradeId && (!where.trade || x.userId === where.trade.userId));
        return t?.images.find((i) => i.id === where.id) ?? null;
      }),
    },
    // Like Postgres: a transaction that throws leaves no trace.
    serializable: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => {
      const tradesBefore = [...trades];
      const intentsBefore = new Map(intents);
      try {
        return await fn(tx);
      } catch (err) {
        trades.splice(0, trades.length, ...tradesBefore);
        intents.clear();
        intentsBefore.forEach((v, k) => intents.set(k, v));
        throw err;
      }
    }),
  };
  const svc = new GiftCardsService(
    prisma as never,
    {} as never,
    { notify: jest.fn(async () => undefined) } as never,
    { get: () => undefined } as never,
    { fx: jest.fn(async () => ({ ngnPerUsd: dec('1500') })), assertWithinLimits: jest.fn(async () => undefined) } as never,
    new UploadIntents(prisma as never, store),
    store,
  );
  jest.spyOn(svc, 'mine').mockImplementation(async (_u: string, id?: string) => ({ id }) as never);
  return {
    svc,
    store,
    trades,
    intents,
    failNextCreate: (e: Error) => (failCreate = e),
    oldPhoto(bytes: Buffer) {
      trades.push({ id: 'old', userId: 'u1', typeId: 't1', faceValue: '50', createdAt: new Date(0), images: [{ id: 'old-i0', tradeId: 'old', image: bytes, imageType: 'image/png', storageKey: null, sha256: null, sortOrder: 0 }] });
    },
  };
}

const submit = (svc: GiftCardsService, images: string[], faceValue = '50') => svc.submit('u1', { typeId: 't1', faceValue, images });

describe('Gift-card photos go to the file store', () => {
  it('stores each photo under a server-chosen key and keeps no bytes in the database', async () => {
    const { svc, store, trades, intents } = setup();
    await submit(svc, [dataUrl(PNG), dataUrl(JPEG, 'image/jpeg')]);
    const imgs = trades[0].images;
    expect(imgs.map((i) => i.image)).toEqual([null, null]);
    expect(imgs.map((i) => i.imageType)).toEqual(['image/png', 'image/jpeg']);
    expect(imgs.map((i) => i.sha256)).toEqual([sha(PNG), sha(JPEG)]);
    for (const i of imgs) {
      expect(i.storageKey).toMatch(/^giftcards\/u1\/[0-9a-f-]{36}$/);
      expect(store.has(i.storageKey!)).toBe(true);
    }
    expect(intents.size).toBe(0);
  });

  it('serves a stored photo from the file store, with the type found at upload', async () => {
    const { svc, trades } = setup();
    await submit(svc, [dataUrl(PNG)]);
    const out = await svc.tradeImage('u1', trades[0].id, trades[0].images[0].id);
    expect(out.image.equals(PNG)).toBe(true);
    expect(out.type).toBe('image/png');
  });

  it('still serves a photo saved in the database before file storage', async () => {
    const { svc, oldPhoto } = setup();
    oldPhoto(PNG);
    const out = await svc.tradeImage('u1', 'old', 'old-i0');
    expect(out.image.equals(PNG)).toBe(true);
  });

  it('answers 503 for a stored photo while storage is down, and 404 when the file is missing', async () => {
    const { svc, store, trades } = setup();
    await submit(svc, [dataUrl(PNG)]);
    const [t, i] = [trades[0].id, trades[0].images[0].id];
    store.failNext(1);
    await expect(svc.tradeImage('u1', t, i)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await store.delete(trades[0].images[0].storageKey!);
    await expect(svc.tradeImage('u1', t, i)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('the same photos sent again within 10 minutes (a retry) give back the first trade, storing nothing new', async () => {
    const { svc, store, trades } = setup();
    await submit(svc, [dataUrl(PNG)]);
    const again = await submit(svc, [dataUrl(PNG)]);
    expect(again).toEqual({ id: 'g1' });
    expect(trades).toHaveLength(1);
    expect(store.keys()).toHaveLength(1);
  });

  it('a different value, or different photos, is a new trade', async () => {
    const { svc, trades } = setup();
    await submit(svc, [dataUrl(PNG)]);
    await submit(svc, [dataUrl(PNG)], '60');
    await submit(svc, [dataUrl(JPEG, 'image/jpeg')]);
    expect(trades).toHaveLength(3);
  });

  it('storage down: 503, and no trade, no file and no intent are left', async () => {
    const { svc, store, trades, intents } = setup();
    store.failNext(1);
    await expect(submit(svc, [dataUrl(PNG)])).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(trades).toHaveLength(0);
    expect(store.keys()).toEqual([]);
    expect(intents.size).toBe(0);
  });

  it('storage failing on the second photo removes the first one too', async () => {
    const { svc, store, intents } = setup();
    const put = store.put.bind(store);
    let n = 0;
    jest.spyOn(store, 'put').mockImplementation(async (...a) => {
      if (++n === 2) store.failNext(1);
      return put(...a);
    });
    await expect(submit(svc, [dataUrl(PNG), dataUrl(JPEG, 'image/jpeg')])).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(store.keys()).toEqual([]);
    expect(intents.size).toBe(0);
  });

  it('a database failure while saving the trade removes the uploaded photos', async () => {
    const { svc, store, trades, intents, failNextCreate } = setup();
    failNextCreate(new Error('database went away'));
    await expect(submit(svc, [dataUrl(PNG)])).rejects.toThrow('database went away');
    expect(trades).toHaveLength(0);
    expect(store.keys()).toEqual([]);
    expect(intents.size).toBe(0);
  });
});
