import 'reflect-metadata';
import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { KycDocumentsAdminController } from './kyc-documents-admin.controller';
import { PERMISSIONS_KEY } from './require-permissions.decorator';
import { MemoryFileStore } from '../storage/memory-file-store';

const perms = (name: string) =>
  Reflect.getMetadata(PERMISSIONS_KEY, (KycDocumentsAdminController.prototype as unknown as Record<string, () => void>)[name]);

/** Records headers and the body, and the moment the body was sent. */
function fakeRes(events: string[]) {
  const headers: Record<string, string> = {};
  return {
    headers,
    body: null as Buffer | null,
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v;
    },
    end(b: Buffer) {
      events.push('bytes');
      this.body = b;
    },
  };
}

const DOC = { id: 'doc-1', serverStored: true, storageKey: 'kyc/u1/abc', mimeType: 'image/png', type: 'PASSPORT' };

function setup(doc: object | null = DOC, object: { bytes: Buffer; contentType: string } | null | Error = { bytes: Buffer.from('png-bytes'), contentType: 'image/png' }) {
  const events: string[] = [];
  const audit = jest.fn(async () => void events.push('audit'));
  const documents = {
    describe: jest.fn(async () => doc),
    read: jest.fn(async () => {
      if (object instanceof Error) throw object;
      return object;
    }),
  };
  const store = new MemoryFileStore();
  const c = new KycDocumentsAdminController(documents as never, { audit } as never, store);
  return { c, audit, documents, events, res: fakeRes(events), store };
}

describe('Admins opening a KYC document (H8)', () => {
  it('needs kyc.view, for the file and for the storage status', () => {
    expect(perms('documentFile')).toEqual(['kyc.view']);
    expect(perms('storageStatus')).toEqual(['kyc.view']);
  });

  it('records who opened which document BEFORE any of it is sent', async () => {
    const { c, audit, events, res } = setup();
    await c.documentFile('admin-7', 'doc-1', { ip: '1.2.3.4' } as never, res as never);
    expect(audit).toHaveBeenCalledWith('admin-7', 'kyc.document.view', 'KycDocument', 'doc-1', null, { type: 'PASSPORT' }, '1.2.3.4');
    expect(events).toEqual(['audit', 'bytes']);
    expect(res.body?.toString()).toBe('png-bytes');
  });

  it('is never cached, never sniffed, and cannot run scripts', async () => {
    const { c, res } = setup();
    await c.documentFile('a', 'doc-1', {} as never, res as never);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toBe('inline; filename="doc-1.png"');
  });

  it('sends a PDF as a download, never shown inside the dashboard', async () => {
    const { c, res } = setup({ ...DOC, mimeType: 'application/pdf' }, { bytes: Buffer.from('%PDF-'), contentType: 'application/pdf' });
    await c.documentFile('a', 'doc-1', {} as never, res as never);
    expect(res.headers['content-disposition']).toBe('attachment; filename="doc-1.pdf"');
  });

  it('uses the type the server detected at upload, not what storage says', async () => {
    const { c, res } = setup(DOC, { bytes: Buffer.from('x'), contentType: 'text/html' });
    await c.documentFile('a', 'doc-1', {} as never, res as never);
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('a document from before H8 (key chosen by the app) is refused and never read from storage', async () => {
    const { c, documents, audit, res } = setup({ ...DOC, serverStored: false });
    await expect(c.documentFile('a', 'doc-1', {} as never, res as never)).rejects.toBeInstanceOf(ConflictException);
    expect(documents.read).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('an unknown document is 404', async () => {
    const { c, res } = setup(null);
    await expect(c.documentFile('a', 'nope', {} as never, res as never)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('storage down is 503 (the view is still recorded: the admin asked)', async () => {
    const { c, audit, res } = setup(DOC, new ServiceUnavailableException('down'));
    await expect(c.documentFile('a', 'doc-1', {} as never, res as never)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(audit).toHaveBeenCalled();
    expect(res.body).toBeNull();
  });

  it('a file missing from storage is 404', async () => {
    const { c, res } = setup(DOC, null);
    await expect(c.documentFile('a', 'doc-1', {} as never, res as never)).rejects.toThrow(/file is missing/);
  });

  it('storage status says which store and whether it answers, never the keys', async () => {
    const { c, store } = setup();
    expect(await c.storageStatus()).toEqual({ driver: 'memory', reachable: true, bucket: null });
    store.failNext(1);
    expect(await c.storageStatus()).toEqual({ driver: 'memory', reachable: false, bucket: null });
  });
});
