import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DevicePlatform } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CredentialsService } from '../common/credentials.service';
import { ServerSettingsService } from '../settings/server-settings.service';

/**
 * Firebase Cloud Messaging.
 *
 * Loaded lazily and only when credentials are present, so the app boots and
 * every other feature works with push simply switched off. Notifications are
 * written to the database first either way — the row is the record, the push
 * is the delivery, and a missing delivery must never mean a missing record.
 *
 * See docs/PUSH.md for how to obtain the service account.
 */

interface FirebaseMessaging {
  /** Up to 500 messages, each with its own phone and data, in one call. */
  sendEach(messages: Array<{
    token: string;
    notification: { title: string; body: string };
    data?: Record<string, string>;
    android?: unknown;
    apns?: unknown;
  }>): Promise<{
    successCount: number;
    failureCount: number;
    responses: { success: boolean; error?: { code: string; message: string } }[];
  }>;
  sendEachForMulticast(message: {
    tokens: string[];
    notification: { title: string; body: string };
    data?: Record<string, string>;
    android?: unknown;
    apns?: unknown;
  }): Promise<{
    successCount: number;
    failureCount: number;
    responses: { success: boolean; error?: { code: string; message: string } }[];
  }>;
}

/** The most messages Firebase takes in one sendEach call. */
const SEND_EACH_MAX = 500;

/** Firebase says this phone will never take a message again (app removed, token replaced). */
function isDeadToken(res: { success: boolean; error?: { code: string } } | undefined): boolean {
  const code = res?.error?.code ?? '';
  return !!res && !res.success && (code.includes('registration-token-not-registered') || code.includes('invalid-argument'));
}

@Injectable()
export class PushService implements OnModuleInit {
  private readonly log = new Logger(PushService.name);
  private messaging: FirebaseMessaging | null = null;
  private enabled = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly credentials: CredentialsService,
    /** Live values from System → Server settings (spec 2026-10-26); .env when absent. */
    @Optional() private readonly settings?: ServerSettingsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const projectId = (this.settings ? this.settings.get<string>('FCM_PROJECT_ID') : this.config.get<string>('FCM_PROJECT_ID'));
    const clientEmail = (this.settings ? this.settings.get<string>('FCM_CLIENT_EMAIL') : this.config.get<string>('FCM_CLIENT_EMAIL'));
    const rawKey =
      (await this.credentials.get('fcm.privateKey').catch(() => undefined)) ??
      this.config.get<string>('FCM_PRIVATE_KEY');

    if (!projectId || !clientEmail || !rawKey) {
      this.log.warn(
        'Push disabled — FCM credentials not set. Notifications are still stored and readable ' +
          'at GET /v1/notifications. See docs/PUSH.md.',
      );
      return;
    }

    try {
      // Imported at runtime, via the modular subpaths, so firebase-admin stays
      // optional: an install that never sends push should not pay for it at
      // boot, and the CJS root export does not interop cleanly under ESM.
      const { cert, getApps, initializeApp } = await import('firebase-admin/app');
      const { getMessaging } = await import('firebase-admin/messaging');

      const app =
        getApps().length > 0
          ? getApps()[0]
          : initializeApp({
              credential: cert({
                projectId,
                clientEmail,
                // Env vars cannot hold real newlines, so the PEM is stored with
                // literal \n and restored here. This is the single most common
                // reason FCM setup fails.
                privateKey: rawKey.replace(/\\n/g, '\n'),
              }),
            });

      this.messaging = getMessaging(app) as unknown as FirebaseMessaging;
      this.enabled = true;
      this.log.log(`Push enabled for Firebase project ${projectId}`);
    } catch (err) {
      this.log.error(
        `Push disabled — could not initialise Firebase: ${(err as Error).message}. ` +
          'Run: npm install firebase-admin',
      );
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Register a device. The token is the key — a device can change hands. */
  async registerDevice(input: {
    userId: string;
    token: string;
    platform: DevicePlatform;
    appVersion?: string;
  }) {
    return this.prisma.deviceToken.upsert({
      where: { token: input.token },
      create: {
        userId: input.userId,
        token: input.token,
        platform: input.platform,
        appVersion: input.appVersion ?? null,
      },
      update: {
        // Reassign on conflict: if this token now reports a different user, the
        // device was handed over or someone signed in on it, and messages must
        // follow the current owner.
        userId: input.userId,
        appVersion: input.appVersion ?? null,
        lastSeenAt: new Date(),
        disabledAt: null,
      },
      select: { id: true, platform: true, createdAt: true },
    });
  }

  async unregisterDevice(userId: string, token: string): Promise<void> {
    await this.prisma.deviceToken.deleteMany({ where: { userId, token } });
  }

  /**
   * Deliver one notification row to every live device of its owner.
   *
   * Returns quietly when push is off or the user has no devices — neither is
   * an error, and treating them as one would fill the log with noise on a
   * perfectly healthy install.
   */
  /**
   * A broadcast wave (29 Oct 2026): many phones, each with its own message,
   * so every push carries that customer's own notificationId (the app opens
   * and marks read that exact inbox item). Firebase takes at most 500 a call.
   * Phones Firebase says are gone are switched off, as in deliver(). Push
   * switched off: nothing sent, nothing failed.
   */
  async sendMessages(
    messages: Array<{ token: string; title: string; body: string; data: Record<string, string> }>,
  ): Promise<{ sent: number; failed: number }> {
    if (!messages.length || !this.messaging) return { sent: 0, failed: 0 };
    let sent = 0;
    let failed = 0;
    for (let i = 0; i < messages.length; i += SEND_EACH_MAX) {
      const group = messages.slice(i, i + SEND_EACH_MAX);
      const result = await this.messaging.sendEach(
        group.map((m) => ({
          token: m.token,
          notification: { title: m.title, body: m.body },
          data: m.data,
          android: { priority: 'high', notification: { channelId: 'davochain' } },
          apns: { payload: { aps: { sound: 'default' } } },
        })),
      );
      sent += result.successCount;
      failed += result.failureCount;
      const dead = group.filter((_, k) => isDeadToken(result.responses[k])).map((m) => m.token);
      if (dead.length) {
        await this.prisma.deviceToken.updateMany({ where: { token: { in: dead } }, data: { disabledAt: new Date() } });
      }
    }
    return { sent, failed };
  }

  async deliver(notificationId: string): Promise<{ sent: number; pruned: number }> {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
    });
    if (!notification || notification.sentAt) return { sent: 0, pruned: 0 };

    const devices = await this.prisma.deviceToken.findMany({
      where: { userId: notification.userId, disabledAt: null },
      select: { token: true },
    });
    if (devices.length === 0 || !this.messaging) {
      // Stamp it anyway: there was nothing to deliver to, and leaving it unsent
      // would make the worker retry it forever.
      await this.prisma.notification.update({
        where: { id: notificationId },
        data: { sentAt: new Date() },
      });
      return { sent: 0, pruned: 0 };
    }

    const tokens = devices.map((d) => d.token);
    const result = await this.messaging.sendEachForMulticast({
      tokens,
      notification: { title: notification.title, body: notification.body },
      // The app routes on these. Every value must be a string — FCM rejects
      // anything else in the data payload.
      data: {
        type: notification.type,
        notificationId: notification.id,
        ...(notification.transactionId ? { transactionId: notification.transactionId } : {}),
        ...(notification.broadcastId ? { broadcastId: notification.broadcastId } : {}),
      },
      android: { priority: 'high', notification: { channelId: 'davochain' } },
      apns: { payload: { aps: { sound: 'default' } } },
    });

    // Prune tokens FCM says are dead, so a user who reinstalled does not keep
    // costing a failed send on every notification forever.
    const dead: string[] = [];
    result.responses.forEach((res, i) => {
      const code = res.error?.code ?? '';
      if (
        !res.success &&
        (code.includes('registration-token-not-registered') || code.includes('invalid-argument'))
      ) {
        dead.push(tokens[i]);
      }
    });

    if (dead.length > 0) {
      await this.prisma.deviceToken.updateMany({
        where: { token: { in: dead } },
        data: { disabledAt: new Date() },
      });
    }

    await this.prisma.notification.update({
      where: { id: notificationId },
      data: { sentAt: new Date() },
    });

    if (result.failureCount > 0) {
      this.log.warn(
        `Push ${notificationId}: ${result.successCount} sent, ${result.failureCount} failed, ${dead.length} pruned`,
      );
    }

    return { sent: result.successCount, pruned: dead.length };
  }

  /** Devices for the admin user screen. */
  async devicesFor(userId: string) {
    return this.prisma.deviceToken.findMany({
      where: { userId },
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
        platform: true,
        appVersion: true,
        lastSeenAt: true,
        disabledAt: true,
      },
    });
  }
}
