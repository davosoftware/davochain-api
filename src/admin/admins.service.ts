import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AdminRole } from '@prisma/client';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from '../auth/password.service';
import { AdminService } from './admin.service';
import { AdminSessionsService } from './sessions.service';
import { AdminOtpService } from './otp.service';
import { ALL_PERMISSIONS, DEFAULT_SUB_ADMIN_PERMISSIONS, isPermission } from './permissions';
import { ConfigService } from '@nestjs/config';
import { MailService } from '../common/mail.service';
import { EmailTemplateService } from '../cms/email-template.service';
import { formatLagos } from '../common/dates';

/** Where an invitation went, and how long it lasts. Never the token. */
export interface InviteResult {
  sentTo: string;
  delivered: boolean;
  expiresAt: Date;
}

/**
 * 512 KB. The UI downscales to 256px before uploading, so a real avatar lands
 * around 20 KB — this cap only exists to stop a 40 MB camera original.
 */
const MAX_AVATAR_BYTES = 512 * 1024;

/**
 * What a file *is*, not what it claims to be. A declared content type is
 * attacker-controlled; these first bytes are not.
 */
const SIGNATURES: { type: string; test: (b: Buffer) => boolean }[] = [
  {
    type: 'image/png',
    test: (b) =>
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { type: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    type: 'image/webp',
    test: (b) =>
      b.subarray(0, 4).toString('ascii') === 'RIFF' &&
      b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

/**
 * The real type of these bytes, or null if they are not an image we accept.
 *
 * Exported so it can be tested directly: this is the check standing between an
 * avatar field and someone storing an HTML file with an image content type.
 */
export function detectImageType(bytes: Buffer): string | null {
  return SIGNATURES.find((s) => s.test(bytes))?.type ?? null;
}

export interface AdminProfile {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  role: AdminRole;
  /** Every permission for an owner, who is never checked against the list. */
  permissions: string[];
  hasAvatar: boolean;
  /** Changes whenever the picture does, so a cached one is never shown stale. */
  avatarVersion: string | null;
  passwordChangedAt: Date;
  lastLoginAt: Date | null;
  createdAt: Date;
}

interface AdminRow {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  role: AdminRole;
  permissions: string[];
  avatarType: string | null;
  avatarUpdatedAt: Date | null;
  passwordChangedAt: Date;
  lastLoginAt: Date | null;
  createdAt: Date;
}

/**
 * The admin's own account, and the people who share it.
 *
 * Kept apart from AdminService, which is about the business — gates, margin,
 * KYC review. This is about who is allowed through the door.
 */
@Injectable()
export class AdminsService {
  private readonly log = new Logger(AdminsService.name);

  /** Never selects the avatar bytes. A team list is not a reason to read 5 MB. */
  private readonly select = {
    id: true,
    email: true,
    name: true,
    isActive: true,
    role: true,
    permissions: true,
    avatarType: true,
    avatarUpdatedAt: true,
    passwordChangedAt: true,
    lastLoginAt: true,
    createdAt: true,
  } as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly admin: AdminService,
    private readonly sessions: AdminSessionsService,
    private readonly otps: AdminOtpService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
    private readonly templates: EmailTemplateService,
  ) {}

  private shape(a: AdminRow): AdminProfile {
    return {
      id: a.id,
      email: a.email,
      name: a.name,
      isActive: a.isActive,
      role: a.role,
      // An owner is reported as holding everything rather than whatever happens
      // to be in their column, so the UI never hides a screen from them.
      permissions: a.role === AdminRole.OWNER ? ALL_PERMISSIONS : a.permissions,
      hasAvatar: a.avatarType !== null,
      avatarVersion: a.avatarUpdatedAt ? String(a.avatarUpdatedAt.getTime()) : null,
      passwordChangedAt: a.passwordChangedAt,
      lastLoginAt: a.lastLoginAt,
      createdAt: a.createdAt,
    };
  }

  async me(adminId: string): Promise<AdminProfile> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: adminId },
      select: this.select,
    });
    if (!admin) throw new NotFoundException('Account not found');
    return this.shape(admin);
  }

  /**
   * A name is a label; an email is the login. Changing the second one is a
   * change of identity, so it costs the current password — an unattended
   * session must not be able to move the account somewhere else.
   */
  async updateProfile(
    adminId: string,
    input: { name?: string; email?: string; currentPassword?: string },
  ): Promise<AdminProfile> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin) throw new NotFoundException('Account not found');

    const data: { name?: string; email?: string } = {};

    const name = input.name?.trim();
    if (name && name !== admin.name) {
      if (name.length < 2) throw new BadRequestException('Name is too short');
      data.name = name;
    }

    const email = input.email?.trim().toLowerCase();
    if (email && email !== admin.email) {
      if (!input.currentPassword) {
        throw new BadRequestException('Enter your current password to change your email');
      }
      if (!(await this.passwords.verify(input.currentPassword, admin.passwordHash))) {
        throw new UnauthorizedException('That password is not correct');
      }
      const taken = await this.prisma.adminUser.findUnique({ where: { email } });
      if (taken) throw new ConflictException('Another admin already uses that email');
      data.email = email;
    }

    if (Object.keys(data).length === 0) return this.shape(admin);

    const updated = await this.prisma.adminUser.update({
      where: { id: adminId },
      data,
      select: this.select,
    });
    this.log.warn(`Admin ${admin.email} updated their profile: ${Object.keys(data).join(', ')}`);
    return this.shape(updated);
  }

  /**
   * Returns a fresh token.
   *
   * Changing a password ends every session the account has — that is the whole
   * point of changing it. Without a replacement the admin doing the changing
   * would be signed out by their own action, so they get a new token and
   * everybody else is dropped.
   */
  async changePassword(
    adminId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ accessToken: string }> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin) throw new NotFoundException('Account not found');

    if (!(await this.passwords.verify(currentPassword, admin.passwordHash))) {
      throw new UnauthorizedException('Your current password is not correct');
    }
    if (await this.passwords.verify(newPassword, admin.passwordHash)) {
      throw new BadRequestException('The new password is the same as the current one');
    }

    return this.applyNewPassword(admin, newPassword, 'password changed');
  }

  /**
   * Reset with an emailed code instead of the old password.
   *
   * The route for somebody who cannot sign in at all — so it deliberately does
   * not ask for the current password, and leans entirely on the code having
   * reached an inbox only they and (for a sub-admin) an owner can read.
   */
  async resetPasswordWithOtp(
    adminId: string,
    code: string,
    newPassword: string,
  ): Promise<{ accessToken: string }> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin) throw new NotFoundException('Account not found');

    await this.otps.consume(adminId, code);

    if (await this.passwords.verify(newPassword, admin.passwordHash)) {
      throw new BadRequestException('The new password is the same as the current one');
    }

    return this.applyNewPassword(admin, newPassword, 'password reset by code');
  }

  /**
   * Write the new hash and end every session on the account.
   *
   * The caller gets a replacement token so they are not signed out by their own
   * action; everyone else — including whoever prompted the reset — is dropped.
   */
  private async applyNewPassword(
    admin: { id: string; email: string; role: AdminRole },
    newPassword: string,
    why: string,
  ): Promise<{ accessToken: string }> {
    const updated = await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: {
        passwordHash: await this.passwords.hash(newPassword),
        passwordChangedAt: new Date(),
      },
    });

    await this.sessions.revokeAllFor(admin.id, why);

    // An admin account can move money, so a password change on one is worth
    // telling its owner about whether or not they were the one who did it.
    const rendered = await this.templates.render(
      'admin.password_changed',
      {
        firstName: updated.name.split(' ')[0],
        email: updated.email,
        changedAt: formatLagos(new Date()),
        method: why,
      },
      { ignoreActive: true },
    );
    if (rendered) {
      await this.mail.send({
        to: updated.email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        templateKey: 'admin.password_changed',
      });
    }

    this.log.warn(`Admin ${admin.email}: ${why} — every session revoked`);
    return { accessToken: await this.admin.signToken(updated) };
  }

  /** Start a reset. Returns where the code went, never the code. */
  async requestPasswordReset(adminId: string) {
    return this.otps.requestPasswordReset(adminId);
  }

  /** Decode it, check it really is an image, store it. */
  async setAvatar(adminId: string, dataUrl: string): Promise<AdminProfile> {
    const match = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(dataUrl.trim());
    if (!match) throw new BadRequestException('That does not look like an image');

    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length === 0) throw new BadRequestException('The image is empty');
    if (bytes.length > MAX_AVATAR_BYTES) {
      throw new BadRequestException(
        `That image is ${Math.round(bytes.length / 1024)} KB. The limit is ${
          MAX_AVATAR_BYTES / 1024
        } KB.`,
      );
    }

    const type = detectImageType(bytes);
    if (!type) {
      throw new BadRequestException('Only PNG, JPEG and WebP images are accepted');
    }

    const updated = await this.prisma.adminUser.update({
      where: { id: adminId },
      data: { avatar: bytes, avatarType: type, avatarUpdatedAt: new Date() },
      select: this.select,
    });
    return this.shape(updated);
  }

  async clearAvatar(adminId: string): Promise<AdminProfile> {
    const updated = await this.prisma.adminUser.update({
      where: { id: adminId },
      data: { avatar: null, avatarType: null, avatarUpdatedAt: null },
      select: this.select,
    });
    return this.shape(updated);
  }

  async avatarOf(adminId: string): Promise<{ bytes: Buffer; type: string; version: string }> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: adminId },
      select: { avatar: true, avatarType: true, avatarUpdatedAt: true },
    });
    if (!admin?.avatar || !admin.avatarType) throw new NotFoundException('No picture set');
    return {
      bytes: Buffer.from(admin.avatar),
      type: admin.avatarType,
      version: String(admin.avatarUpdatedAt?.getTime() ?? 0),
    };
  }

  // ── the team ──────────────────────────────────────────────

  async team(): Promise<AdminProfile[]> {
    const rows = await this.prisma.adminUser.findMany({
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
      select: this.select,
    });
    return rows.map((r) => this.shape(r));
  }

  /**
   * The creator does not choose the password.
   *
   * One is generated, shown once, and stored only as a hash — so a new admin's
   * first password was never known to anyone who could use it against them
   * later, and nothing in the record of this call can leak a live credential.
   */
  async createAdmin(
    creator: { id: string; role: AdminRole },
    input: { email: string; name: string; role?: AdminRole; permissions?: string[] },
  ): Promise<{ admin: AdminProfile; invite: InviteResult }> {
    const email = input.email.trim().toLowerCase();
    const name = input.name.trim();
    if (name.length < 2) throw new BadRequestException('Name is too short');

    const role = input.role ?? AdminRole.SUB_ADMIN;
    if (role === AdminRole.OWNER && creator.role !== AdminRole.OWNER) {
      // Otherwise team.manage is a path to granting yourself everything.
      throw new ForbiddenException('Only an owner can create another owner');
    }

    const existing = await this.prisma.adminUser.findUnique({ where: { email } });
    if (existing) throw new ConflictException('An admin with that email already exists');

    const permissions =
      role === AdminRole.OWNER
        ? []
        : this.cleanPermissions(input.permissions ?? DEFAULT_SUB_ADMIN_PERMISSIONS);

    /*
     * The account is created with a password nobody has and nobody can guess.
     *
     * It is never disclosed, never displayed and never emailed — it exists only
     * so the row has a valid hash. The invitation is what lets the new admin
     * in, and they choose their own password at the end of it. A generated
     * password would have to travel to its owner somehow, and every route it
     * could take leaves a live credential sitting somewhere readable.
     */
    const created = await this.prisma.adminUser.create({
      data: {
        email,
        name,
        role,
        permissions,
        passwordHash: await this.passwords.hash(generatePassword()),
        createdBy: creator.id,
      },
      select: this.select,
    });

    const inviter = await this.prisma.adminUser.findUnique({
      where: { id: creator.id },
      select: { name: true },
    });

    const invite = await this.sendInvite(created.id, creator.id, inviter?.name ?? 'An owner');

    this.log.warn(`Admin ${email} created by ${creator.id} as ${role}; invitation sent`);
    return { admin: this.shape(created), invite };
  }

  /**
   * Issue a single-use invitation and email it.
   *
   * Also the "resend" path, so a link that expired before somebody got round to
   * it is one click to replace rather than a deleted-and-recreated account.
   */
  async sendInvite(adminUserId: string, invitedBy: string, inviterName?: string): Promise<InviteResult> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: adminUserId },
      select: { id: true, email: true, name: true, role: true, isActive: true },
    });
    if (!admin) throw new NotFoundException('Admin not found');
    if (!admin.isActive) throw new BadRequestException('That account is deactivated');

    // Only one live invitation at a time: two working links means an older one
    // still opens the account after somebody asked for a replacement.
    await this.prisma.adminInvite.updateMany({
      where: { adminUserId, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    const hours = this.config.get<number>('ADMIN_INVITE_TTL_HOURS') ?? 48;
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + hours * 3_600_000);

    await this.prisma.adminInvite.create({
      data: {
        adminUserId,
        // Only the hash is stored. A leaked database row is not a working link.
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt,
        invitedBy,
      },
    });

    const base = (this.config.get<string>('ADMIN_URL') ?? 'http://localhost:3100').replace(/\/$/, '');
    const inviteUrl = `${base}/invite?token=${token}`;

    const name =
      inviterName ??
      (await this.prisma.adminUser.findUnique({ where: { id: invitedBy }, select: { name: true } }))
        ?.name ??
      'An owner';

    const rendered = await this.templates.render(
      'admin.invited',
      {
        firstName: admin.name.split(' ')[0],
        lastName: admin.name.split(' ').slice(1).join(' '),
        email: admin.email,
        inviteUrl,
        role: admin.role === AdminRole.OWNER ? 'an Owner' : 'a Sub-admin',
        invitedBy: name,
        expiresIn: `${hours} hours`,
      },
      // An invitation is the only way into a new account. A dashboard toggle
      // must not be able to make it silently not arrive.
      { ignoreActive: true },
    );

    let delivered = false;
    if (rendered) {
      delivered = await this.mail.send({
        to: admin.email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        templateKey: 'admin.invited',
      });
    }

    if (!delivered && process.env.NODE_ENV !== 'production') {
      // Without this an invitation cannot be tested until SMTP exists. Guarded
      // on the environment: a production log is not a place for a live link.
      this.log.warn(`SMTP not configured — invite link for ${admin.email} is ${inviteUrl}`);
    }

    return { sentTo: admin.email, delivered, expiresAt };
  }

  /**
   * What a link is worth, before asking anyone to type a password into it.
   *
   * Never says why a bad token failed. "Expired" and "never existed" are the
   * same answer here, because distinguishing them tells somebody holding a
   * guessed token that they guessed a real one.
   */
  async checkInvite(token: string): Promise<{ valid: boolean; email?: string; name?: string; role?: AdminRole }> {
    const invite = await this.findInvite(token);
    if (!invite) return { valid: false };
    return {
      valid: true,
      email: invite.admin.email,
      name: invite.admin.name,
      role: invite.admin.role,
    };
  }

  /** Set the password the new admin chose, and burn the link. */
  async acceptInvite(token: string, password: string): Promise<{ email: string }> {
    const invite = await this.findInvite(token);
    if (!invite) {
      throw new BadRequestException(
        'That invitation is no longer valid. Ask an owner to send a new one.',
      );
    }

    await this.prisma.$transaction([
      this.prisma.adminUser.update({
        where: { id: invite.adminUserId },
        data: {
          passwordHash: await this.passwords.hash(password),
          passwordChangedAt: new Date(),
        },
      }),
      this.prisma.adminInvite.update({
        where: { id: invite.id },
        data: { consumedAt: new Date() },
      }),
    ]);

    this.log.warn(`Admin ${invite.admin.email} accepted their invitation`);
    return { email: invite.admin.email };
  }

  private async findInvite(token: string) {
    const value = token?.trim();
    if (!value) return null;

    const invite = await this.prisma.adminInvite.findUnique({
      where: { tokenHash: createHash('sha256').update(value).digest('hex') },
      include: { admin: { select: { id: true, email: true, name: true, role: true, isActive: true } } },
    });

    if (!invite) return null;
    if (invite.consumedAt) return null;
    if (invite.expiresAt.getTime() <= Date.now()) return null;
    if (!invite.admin.isActive) return null;
    return invite;
  }

  /** Drop anything that is not a permission we define, so a typo cannot grant. */
  private cleanPermissions(permissions: string[]): string[] {
    return [...new Set(permissions.filter((p) => isPermission(p)))];
  }

  /**
   * Change what a sub-admin can do.
   *
   * Owners only. Someone with team.manage can add and remove colleagues, but
   * handing them the ability to widen a grant would make every permission
   * reachable from that one.
   */
  async setPermissions(
    actor: { id: string; role: AdminRole },
    targetId: string,
    permissions: string[],
  ): Promise<AdminProfile> {
    if (actor.role !== AdminRole.OWNER) {
      throw new ForbiddenException('Only an owner can change what someone can do');
    }

    const target = await this.prisma.adminUser.findUnique({
      where: { id: targetId },
      select: { id: true, email: true, role: true },
    });
    if (!target) throw new NotFoundException('Admin not found');
    if (target.role === AdminRole.OWNER) {
      throw new BadRequestException('An owner already has everything');
    }

    const cleaned = this.cleanPermissions(permissions);
    const updated = await this.prisma.adminUser.update({
      where: { id: targetId },
      data: { permissions: cleaned },
      select: this.select,
    });

    this.log.warn(`Permissions for ${target.email} set by ${actor.id}: ${cleaned.join(', ') || 'none'}`);
    return this.shape(updated);
  }

  /**
   * Promote or demote.
   *
   * The last owner cannot be demoted — an install with no owner has nobody who
   * can grant a permission, which is unrecoverable without database access.
   */
  async setRole(
    actor: { id: string; role: AdminRole },
    targetId: string,
    role: AdminRole,
  ): Promise<AdminProfile> {
    if (actor.role !== AdminRole.OWNER) {
      throw new ForbiddenException('Only an owner can change a role');
    }

    const target = await this.prisma.adminUser.findUnique({ where: { id: targetId } });
    if (!target) throw new NotFoundException('Admin not found');
    if (target.role === role) return this.me(targetId);

    if (target.role === AdminRole.OWNER && role === AdminRole.SUB_ADMIN) {
      const otherOwners = await this.prisma.adminUser.count({
        where: { role: AdminRole.OWNER, isActive: true, id: { not: targetId } },
      });
      if (otherOwners === 0) {
        throw new ForbiddenException(
          'This is the last owner. Promote someone else before stepping down.',
        );
      }
    }

    const updated = await this.prisma.adminUser.update({
      where: { id: targetId },
      data: {
        role,
        // A demoted owner keeps nothing implicitly; an owner's own list is
        // meaningless, so promotion clears it rather than leaving a stale one.
        permissions: role === AdminRole.OWNER ? [] : DEFAULT_SUB_ADMIN_PERMISSIONS,
      },
      select: this.select,
    });

    this.log.warn(`Admin ${target.email} is now ${role} (by ${actor.id})`);
    return this.shape(updated);
  }

  /**
   * Deactivating is the only removal there is — an admin cannot be deleted,
   * because the audit log points at them and an audit trail with holes in it
   * is not an audit trail.
   */
  async setActive(
    actor: { id: string; role: AdminRole },
    targetId: string,
    isActive: boolean,
  ): Promise<AdminProfile> {
    const target = await this.prisma.adminUser.findUnique({ where: { id: targetId } });
    if (!target) throw new NotFoundException('Admin not found');

    // A sub-admin with team.manage runs the team; they do not get to switch off
    // the people who can revoke their own access.
    if (target.role === AdminRole.OWNER && actor.role !== AdminRole.OWNER) {
      throw new ForbiddenException('Only an owner can deactivate another owner');
    }

    if (!isActive) {
      if (targetId === actor.id) {
        throw new BadRequestException('You cannot deactivate your own account');
      }
      const otherActive = await this.prisma.adminUser.count({
        where: { isActive: true, id: { not: targetId } },
      });
      if (otherActive === 0) {
        throw new ForbiddenException(
          'This is the last active admin. Deactivating it would lock everyone out.',
        );
      }
      if (target.role === AdminRole.OWNER) {
        const otherOwners = await this.prisma.adminUser.count({
          where: { role: AdminRole.OWNER, isActive: true, id: { not: targetId } },
        });
        if (otherOwners === 0) {
          throw new ForbiddenException(
            'This is the last owner. Promote someone else first, or nobody can grant a permission again.',
          );
        }
      }
    }

    const updated = await this.prisma.adminUser.update({
      where: { id: targetId },
      data: { isActive },
      select: this.select,
    });

    if (!isActive) {
      // The guard would refuse them on their next request anyway; closing the
      // rows makes the session list honest and the intent explicit.
      await this.sessions.revokeAllFor(targetId, 'account deactivated');
    }

    this.log.warn(
      `Admin ${target.email} ${isActive ? 'reactivated' : 'deactivated'} by ${actor.id}`,
    );
    return this.shape(updated);
  }

  /** Live sessions for an admin, for the settings screen. */
  async sessionsFor(adminId: string, currentJti?: string) {
    return this.sessions.listFor(adminId, currentJti);
  }

  /** Sign out everywhere else, without changing the password. */
  async endOtherSessions(adminId: string, keepJti: string): Promise<{ ended: number }> {
    return { ended: await this.sessions.revokeAllFor(adminId, 'signed out elsewhere', keepJti) };
  }

  /** What this admin has been doing — the account's own audit trail. */
  async activity(adminId: string, limit = 20) {
    return this.prisma.adminAuditLog.findMany({
      where: { adminUserId: adminId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
      select: { id: true, action: true, entity: true, entityId: true, createdAt: true },
    });
  }

  /**
   * The whole audit log, filterable, for the oversight screen.
   *
   * Cursor paged rather than offset paged: the log only grows at the head, and
   * an offset would quietly skip or repeat rows as it does.
   */
  async auditLog(params: {
    adminUserId?: string;
    action?: string;
    entity?: string;
    since?: Date;
    limit?: number;
    cursor?: string;
  }) {
    const limit = Math.min(params.limit ?? 50, 200);

    const where = {
      ...(params.adminUserId ? { adminUserId: params.adminUserId } : {}),
      // A prefix, so "admin" finds admin.create and admin.password.change
      // without the caller having to know every action name.
      ...(params.action ? { action: { startsWith: params.action } } : {}),
      ...(params.entity ? { entity: params.entity } : {}),
      ...(params.since ? { createdAt: { gte: params.since } } : {}),
    };

    const rows = await this.prisma.adminAuditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        action: true,
        entity: true,
        entityId: true,
        ip: true,
        createdAt: true,
        admin: { select: { id: true, email: true, name: true, role: true } },
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const [total, actors] = await Promise.all([
      this.prisma.adminAuditLog.count({ where }),
      // The filter dropdown lists whoever actually appears in the log, not
      // every admin who has ever existed.
      this.prisma.adminUser.findMany({
        where: { auditEntries: { some: {} } },
        select: { id: true, email: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    return {
      rows: page,
      nextCursor: hasMore ? page[page.length - 1].id : null,
      total,
      actors,
    };
  }
}

/**
 * A password nobody chose, meeting the same policy as a user's: length first,
 * with a letter and a digit guaranteed rather than hoped for.
 */
export function generatePassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O — they read as 1 and 0
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const all = upper + lower + digits;

  const chars = [
    upper[randomInt(upper.length)],
    lower[randomInt(lower.length)],
    digits[randomInt(digits.length)],
  ];
  while (chars.length < 20) chars.push(all[randomInt(all.length)]);

  // Fisher-Yates, so the guaranteed classes are not always the first three.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
