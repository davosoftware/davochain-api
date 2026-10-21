import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { KycController } from './kyc.controller';
import { AdvancedVerificationService } from './advanced/advanced-verification.service';
import { KycService } from './kyc.service';
import { BasicVerificationService } from './basic-verification.service';
import { KycDocumentsService, MAX_DOCUMENT_BYTES } from './kyc-documents.service';
import { RATE_LIMIT_KEY } from '../rate-limit/rate-limit.decorator';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('photo')]);

describe('POST /kyc/documents (multipart upload, H8)', () => {
  let app: INestApplication;
  const upload = jest.fn();

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [KycController],
      providers: [
        { provide: KycService, useValue: {} },
        { provide: BasicVerificationService, useValue: {} },
        { provide: AdvancedVerificationService, useValue: {} },
        { provide: KycDocumentsService, useValue: { upload } },
      ],
    }).compile();
    app = mod.createNestApplication();
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { sub: 'u1' };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });

  afterAll(() => app.close());
  beforeEach(() => upload.mockReset());

  it('hands the uploaded bytes and the type to the service and answers 201', async () => {
    upload.mockResolvedValue({ id: 'd1', type: 'PASSPORT', status: 'PENDING', uploadedAt: new Date(0), duplicate: false });
    const res = await request(app.getHttpServer())
      .post('/kyc/documents')
      .field('type', 'PASSPORT')
      .attach('file', PNG, { filename: 'whatever.exe', contentType: 'application/x-msdownload' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'd1', type: 'PASSPORT', status: 'PENDING', uploadedAt: new Date(0).toISOString() });
    const [userId, type, file] = upload.mock.calls[0];
    expect(userId).toBe('u1');
    expect(type).toBe('PASSPORT');
    // The service gets the bytes; the client's file name and claimed type play no part.
    expect(Buffer.compare(file.buffer, PNG)).toBe(0);
  });

  it('answers 200, not 201, when it was the same file again (a retry): nothing new was created', async () => {
    upload.mockResolvedValue({ id: 'd1', type: 'PASSPORT', status: 'PENDING', uploadedAt: new Date(0), duplicate: true });
    const res = await request(app.getHttpServer()).post('/kyc/documents').field('type', 'PASSPORT').attach('file', PNG, 'p.png');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('d1');
  });

  it('refuses a file over 10 MB with 413 and a plain message, before the service runs', async () => {
    const res = await request(app.getHttpServer())
      .post('/kyc/documents')
      .field('type', 'PASSPORT')
      .attach('file', Buffer.alloc(MAX_DOCUMENT_BYTES + 1), 'big.png');
    expect(res.status).toBe(413);
    expect(res.body.message).toBe('Each document must be 10 MB or smaller');
    expect(upload).not.toHaveBeenCalled();
  });

  it('refuses the old JSON body that named its own storage location', async () => {
    const res = await request(app.getHttpServer())
      .post('/kyc/documents')
      .send({ type: 'PASSPORT', storageKey: 'kyc/someone-else/file', mimeType: 'image/png', sizeBytes: 10 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/multipart\/form-data/);
    expect(upload).not.toHaveBeenCalled();
  });

  it('refuses a type outside the uploadable list, and extra form fields', async () => {
    const bad = await request(app.getHttpServer()).post('/kyc/documents').field('type', 'BVN').attach('file', PNG, 'p.png');
    expect(bad.status).toBe(400);
    const extra = await request(app.getHttpServer())
      .post('/kyc/documents')
      .field('type', 'PASSPORT')
      .field('storageKey', 'kyc/x')
      .attach('file', PNG, 'p.png');
    expect(extra.status).toBe(400);
    expect(upload).not.toHaveBeenCalled();
  });

  it('refuses two files in one request', async () => {
    const res = await request(app.getHttpServer())
      .post('/kyc/documents')
      .field('type', 'PASSPORT')
      .attach('file', PNG, 'a.png')
      .attach('file', PNG, 'b.png');
    expect(res.status).toBe(400);
    expect(upload).not.toHaveBeenCalled();
  });

  it('is rate limited by the kyc.documents policy', () => {
    expect(Reflect.getMetadata(RATE_LIMIT_KEY, KycController.prototype.attach)).toBe('kyc.documents');
  });
});
