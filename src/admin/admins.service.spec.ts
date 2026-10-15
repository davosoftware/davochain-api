import { detectImageType, generatePassword } from './admins.service';

/**
 * The two pieces of this service that have to be right on their own, without a
 * database in front of them: what counts as an image, and what counts as a
 * password nobody chose.
 */
describe('detectImageType', () => {
  const png = (extra = 8) =>
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extra)]);
  const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8)]);
  const webp = () =>
    Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii')]);

  it('recognises the three formats we accept', () => {
    expect(detectImageType(png())).toBe('image/png');
    expect(detectImageType(jpeg())).toBe('image/jpeg');
    expect(detectImageType(webp())).toBe('image/webp');
  });

  it('refuses a file that only claims to be an image', () => {
    // The exact payload this check exists for: HTML stored under an image
    // content type, which some browsers will happily execute if served back.
    expect(detectImageType(Buffer.from('<script>alert(1)</script>'))).toBeNull();
    expect(detectImageType(Buffer.from('<svg onload="alert(1)"/>'))).toBeNull();
    expect(detectImageType(Buffer.from('GIF89a'))).toBeNull();
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
  });

  it('is not fooled by the magic bytes appearing later in the file', () => {
    const hidden = Buffer.concat([Buffer.from('not an image'), png()]);
    expect(detectImageType(hidden)).toBeNull();
  });

  it('does not read past the end of a very short buffer', () => {
    expect(() => detectImageType(Buffer.from([0xff]))).not.toThrow();
    expect(detectImageType(Buffer.from([0xff]))).toBeNull();
    // "RIFF" with nothing after it — a truncated WebP header.
    expect(detectImageType(Buffer.from('RIFF', 'ascii'))).toBeNull();
  });
});

describe('generatePassword', () => {
  it('meets the same policy the API enforces on a chosen one', () => {
    for (let i = 0; i < 200; i++) {
      const pw = generatePassword();
      expect(pw.length).toBeGreaterThanOrEqual(10);
      expect(pw).toMatch(/[a-zA-Z]/);
      expect(pw).toMatch(/[0-9]/);
    }
  });

  it('leaves out the characters people misread when copying by hand', () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePassword()).not.toMatch(/[IO01l]/);
    }
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generatePassword()));
    expect(seen.size).toBe(500);
  });

  it('does not always put the guaranteed classes in the same place', () => {
    // Without the shuffle every password would start upper/lower/digit, which
    // hands an attacker three positions for free.
    const firstChars = new Set(Array.from({ length: 100 }, () => generatePassword()[0]));
    expect(firstChars.size).toBeGreaterThan(5);
  });
});

describe('the system actor (plan ruling 7)', () => {
  it('is hidden from the team list and cannot be changed', async () => {
    const { AdminsService } = await import('./admins.service');
    const { SYSTEM_ACTOR_ID } = await import('../common/system-actor');
    const findMany = jest.fn(async () => []);
    const svc = Object.create(AdminsService.prototype) as InstanceType<typeof AdminsService>;
    Object.assign(svc, { prisma: { adminUser: { findMany, findUnique: jest.fn() } }, select: {}, shape: (r: unknown) => r });
    await svc.team();
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { not: SYSTEM_ACTOR_ID } } }));
    const owner = { id: 'o1', role: 'OWNER' as never };
    await expect(svc.setActive(owner, SYSTEM_ACTOR_ID, true)).rejects.toMatchObject({ status: 404 });
    await expect(svc.setRole(owner, SYSTEM_ACTOR_ID, 'OWNER' as never)).rejects.toMatchObject({ status: 404 });
    await expect(svc.setPermissions(owner, SYSTEM_ACTOR_ID, [])).rejects.toMatchObject({ status: 404 });
    await expect(svc.sendInvite(SYSTEM_ACTOR_ID, 'o1')).rejects.toMatchObject({ status: 404 });
  });
});

/**
 * C1 (PROJECT_REVIEW): team.manage must not be a path to granting more than
 * the creator could grant through setPermissions, which is owner-only.
 */
describe('creating an admin (C1)', () => {
  async function service() {
    const { AdminsService } = await import('./admins.service');
    const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new', ...data }));
    const svc = Object.create(AdminsService.prototype) as InstanceType<typeof AdminsService>;
    Object.assign(svc, {
      prisma: {
        adminUser: {
          findUnique: jest.fn(async ({ where }: { where: { id?: string; email?: string } }) =>
            where.email ? null : { id: where.id, name: 'Inviter', role: 'OWNER', isActive: true, email: 'o@x.invalid' },
          ),
          create,
        },
      },
      passwords: { hash: jest.fn(async () => 'hash') },
      select: {},
      shape: (r: unknown) => r,
      log: { warn: jest.fn() },
    });
    const sendInvite = jest.spyOn(svc, 'sendInvite').mockResolvedValue({ sentTo: 'x', delivered: true } as never);
    return { svc, create, sendInvite };
  }
  const subAdmin = { id: 's1', role: 'SUB_ADMIN' as never };
  const owner = { id: 'o1', role: 'OWNER' as never };

  it('refuses a sub-admin who asks for anything beyond the standard view permissions', async () => {
    const { svc, create } = await service();
    await expect(
      svc.createAdmin(subAdmin, { email: 'me+2@x.invalid', name: 'Second Me', permissions: ['transactions.approve', 'users.view'] }),
    ).rejects.toMatchObject({ status: 403 });
    expect(create).not.toHaveBeenCalled();
  });

  it('lets a sub-admin create an admin with the standard view permissions, or a subset', async () => {
    const { svc, create } = await service();
    await svc.createAdmin(subAdmin, { email: 'a@x.invalid', name: 'Helper', permissions: ['users.view', 'kyc.view'] });
    expect(create.mock.calls[0][0].data.permissions).toEqual(['users.view', 'kyc.view']);
    await svc.createAdmin(subAdmin, { email: 'b@x.invalid', name: 'Helper Two' });
    const { DEFAULT_SUB_ADMIN_PERMISSIONS } = await import('./permissions');
    expect(create.mock.calls[1][0].data.permissions).toEqual(DEFAULT_SUB_ADMIN_PERMISSIONS);
  });

  it('still lets an owner grant any permission', async () => {
    const { svc, create } = await service();
    await svc.createAdmin(owner, { email: 'c@x.invalid', name: 'Approver', permissions: ['transactions.approve'] });
    expect(create.mock.calls[0][0].data.permissions).toEqual(['transactions.approve']);
  });

  it('only lets an owner re-send an invitation to an owner', async () => {
    const { svc, sendInvite } = await service();
    await expect(svc.resendInvite(subAdmin, 'owner-2')).rejects.toMatchObject({ status: 403 });
    expect(sendInvite).not.toHaveBeenCalled();
    await svc.resendInvite(owner, 'owner-2');
    expect(sendInvite).toHaveBeenCalledWith('owner-2', 'o1');
  });
});
