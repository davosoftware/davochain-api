import { BadRequestException } from '@nestjs/common';
import { AdminsService } from './admins.service';
import { SiteSettingsService } from './site-settings.service';

/** A PNG of roughly `bytes` bytes: the real signature, then padding. */
const png = (bytes: number) => {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return `data:image/png;base64,${Buffer.concat([head, Buffer.alloc(bytes - head.length, 1)]).toString('base64')}`;
};
const MB = 1024 * 1024;

describe('admin picture limits (C7): profile pictures and the site logo up to 2 MB', () => {
  it('a 1.5 MB profile picture is saved; 2.5 MB is refused naming the 2 MB limit', async () => {
    const update = jest.fn(async () => ({ id: 'a1' }));
    const svc = new AdminsService({ adminUser: { update } } as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    jest.spyOn(svc as unknown as { shape: (r: unknown) => unknown }, 'shape').mockImplementation((r) => r);
    await expect(svc.setAvatar('a1', png(1.5 * MB))).resolves.toBeTruthy();
    const err = await svc.setAvatar('a1', png(2.5 * MB)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toMatch(/limit is 2048 KB/);
  });

  it('a 1.5 MB site logo is saved; 2.5 MB is refused naming the 2 MB limit', async () => {
    const upsert = jest.fn(async () => ({ id: 'site' }));
    const svc = new SiteSettingsService({ siteSetting: { upsert, findUnique: jest.fn(async () => null) } } as never);
    jest.spyOn(svc, 'get').mockResolvedValue({} as never);
    await expect(svc.setLogo(png(1.5 * MB), 'a1')).resolves.toBeTruthy();
    const err = await svc.setLogo(png(2.5 * MB), 'a1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toMatch(/limit is 2048 KB/);
  });
});
