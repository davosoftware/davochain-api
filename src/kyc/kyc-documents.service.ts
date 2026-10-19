import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { KycDocumentType, KycStatus, Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { UploadIntents } from '../storage/upload-intents.service';
import { FILE_STORE, FileStore, StoredObject, storageHttpError } from '../storage/file-store';
import { DOCUMENT_TYPES, detectFileType } from '../storage/file-type';

/** BVN and NIN are numbers checked with Dojah, never pictures; everything else is a file. */
export const UPLOADABLE_DOCUMENT_TYPES = [
  KycDocumentType.PASSPORT,
  KycDocumentType.DRIVERS_LICENSE,
  KycDocumentType.VOTERS_CARD,
  KycDocumentType.SELFIE,
  KycDocumentType.PROOF_OF_ADDRESS,
] as const;
export type UploadableDocumentType = (typeof UPLOADABLE_DOCUMENT_TYPES)[number];

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
/** Waiting for review at once, per customer: enough for any real case, too few to fill a bucket. */
export const MAX_PENDING_DOCUMENTS = 10;

const TOO_BIG = 'Each document must be 10 MB or smaller';
export const LEGACY_DOCUMENT = 'This document was uploaded before secure storage and cannot be opened. Ask the customer to upload it again.';

export type StoredDocument = { id: string; serverStored: boolean; storageKey: string; mimeType: string; type: KycDocumentType };

type Db = Pick<Prisma.TransactionClient, 'kycDocument'>;
type DocumentView = { id: string; type: KycDocumentType; status: KycStatus; uploadedAt: Date; duplicate: boolean };

/**
 * ID documents (H8).
 *
 * The server reads the file, decides what it really is, picks where it goes,
 * and stores it in the private file store. Nothing the app sends becomes a
 * storage location. Uploads are crash-safe (UploadIntents) and a retried
 * upload of the same file returns the first record instead of a second one.
 */
@Injectable()
export class KycDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly intents: UploadIntents,
    @Inject(FILE_STORE) private readonly files: FileStore,
  ) {}

  async upload(userId: string, type: string, file: { buffer: Buffer; size?: number } | undefined): Promise<DocumentView> {
    if (!(UPLOADABLE_DOCUMENT_TYPES as readonly string[]).includes(type)) {
      throw new BadRequestException(`type must be one of: ${UPLOADABLE_DOCUMENT_TYPES.join(', ')}`);
    }
    const bytes = file?.buffer;
    if (!bytes || bytes.length === 0) throw new BadRequestException('Choose a file to upload');
    if (bytes.length > MAX_DOCUMENT_BYTES) throw new PayloadTooLargeException(TOO_BIG);
    const contentType = detectFileType(bytes);
    if (!contentType || !DOCUMENT_TYPES.has(contentType)) {
      throw new BadRequestException('Documents must be a JPEG, PNG or WebP photo, or a PDF');
    }

    const profile = await this.prisma.kycProfile.findUnique({ where: { userId }, select: { id: true } });
    if (!profile) throw new NotFoundException('Your verification profile was not found');
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    // A retry of an upload that already landed: nothing new to store.
    const earlier = await this.findDuplicate(this.prisma, profile.id, type as KycDocumentType, sha256);
    if (earlier) return view(earlier, true);
    await this.assertRoom(this.prisma, profile.id);

    const key = `kyc/${userId}/${randomUUID()}`;
    try {
      await this.intents.store(key, bytes, contentType);
    } catch (err) {
      throw storageHttpError(err);
    }

    try {
      const outcome = await this.prisma.$transaction(async (tx) => {
        // One upload per customer at a time from here, so two cannot both pass the count.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'kyc.documents:' + profile.id}))`;
        const twin = await this.findDuplicate(tx, profile.id, type as KycDocumentType, sha256);
        if (twin) return { doc: twin, duplicate: true };
        await this.assertRoom(tx, profile.id);
        await this.intents.claim(tx, [key]);
        const doc = await tx.kycDocument.create({
          data: {
            kycProfileId: profile.id,
            type: type as KycDocumentType,
            storageKey: key,
            mimeType: contentType,
            sizeBytes: bytes.length,
            sha256,
            serverStored: true,
          },
        });
        return { doc, duplicate: false };
      });
      if (outcome.duplicate) await this.intents.abandon([key]);
      return view(outcome.doc, outcome.duplicate);
    } catch (err) {
      // Removes the file only if the record did not commit (its intent is still ours).
      await this.intents.abandon([key]);
      throw storageHttpError(err);
    }
  }

  /** A document's details, for an admin about to open it. Null when there is no such document. */
  describe(documentId: string): Promise<StoredDocument | null> {
    return this.prisma.kycDocument.findUnique({
      where: { id: documentId },
      select: { id: true, serverStored: true, storageKey: true, mimeType: true, type: true },
    });
  }

  /**
   * The file itself. Null when storage has no such object; 503 when storage is down.
   * A key from before H8 was chosen by the app and may name anything, so it is never read.
   */
  async read(doc: StoredDocument): Promise<StoredObject | null> {
    if (!doc.serverStored) throw new ConflictException(LEGACY_DOCUMENT);
    try {
      return await this.files.get(doc.storageKey);
    } catch (err) {
      throw storageHttpError(err);
    }
  }

  /** The same file sent again as the same kind of document and still waiting: a retry. */
  private findDuplicate(db: Db, kycProfileId: string, type: KycDocumentType, sha256: string) {
    return db.kycDocument.findFirst({ where: { kycProfileId, type, sha256, status: KycStatus.PENDING } });
  }

  private async assertRoom(db: Db, kycProfileId: string): Promise<void> {
    const waiting = await db.kycDocument.count({ where: { kycProfileId, status: KycStatus.PENDING } });
    if (waiting >= MAX_PENDING_DOCUMENTS) {
      throw new ConflictException(
        `You already have ${MAX_PENDING_DOCUMENTS} documents waiting for review. Please wait for them to be checked before sending more.`,
      );
    }
  }
}

function view(doc: { id: string; type: KycDocumentType; status: KycStatus; uploadedAt: Date }, duplicate: boolean): DocumentView {
  return { id: doc.id, type: doc.type, status: doc.status, uploadedAt: doc.uploadedAt, duplicate };
}
