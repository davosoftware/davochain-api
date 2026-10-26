import { ConflictException, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { AdminGuard } from './admin.guard';
import { RequirePermissions } from './require-permissions.decorator';
import { CurrentAdmin } from './current-admin.decorator';
import { AdminService } from './admin.service';
import { KycDocumentsService, LEGACY_DOCUMENT } from '../kyc/kyc-documents.service';
import { FILE_STORE, FileStore } from '../storage/file-store';
import type { R2FileStore } from '../storage/r2-file-store';
import { LiveR2FileStore } from '../storage/live-r2-file-store';
import { sendPrivateFile } from '../storage/send-file';

/**
 * ID documents for admins (H8). A file only ever leaves through here: the
 * bucket is private and no storage address is handed out. Every opening is
 * recorded in the audit log, with who and when, before any of it is sent.
 */
@Public() // opts out of the USER guard; AdminGuard takes over
@UseGuards(AdminGuard)
@RateLimit('default')
@ApiTags('admin')
@ApiBearerAuth('admin')
@Controller('admin')
export class KycDocumentsAdminController {
  constructor(
    private readonly documents: KycDocumentsService,
    private readonly admin: AdminService,
    @Inject(FILE_STORE) private readonly store: FileStore,
  ) {}

  @Get('kyc/documents/:id/file')
  @RequirePermissions('kyc.view')
  async documentFile(
    @CurrentAdmin('sub') adminId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const doc = await this.documents.describe(id);
    if (!doc) throw new NotFoundException('No such document');
    if (!doc.serverStored) throw new ConflictException(LEGACY_DOCUMENT);
    await this.admin.audit(adminId, 'kyc.document.view', 'KycDocument', doc.id, null, { type: doc.type }, req.ip);
    const object = await this.documents.read(doc);
    if (!object) throw new NotFoundException('The file is missing from storage');
    // The type detected at upload, never what storage reports.
    sendPrivateFile(res, object.bytes, doc.mimeType, doc.id);
  }

  /** Which file store is in use and whether it answers. Never any key or secret. */
  @Get('storage/status')
  @RequirePermissions('kyc.view')
  async storageStatus() {
    return {
      driver: this.store.driver,
      reachable: await this.store.ping(),
      bucket: this.store instanceof LiveR2FileStore ? await this.store.currentBucket() : this.store.driver === 'r2' ? (this.store as R2FileStore).bucket : null,
    };
  }
}
