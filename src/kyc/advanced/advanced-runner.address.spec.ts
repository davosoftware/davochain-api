import { DojahMockClient, mockImage } from '../../dojah/dojah.mock';
import { MemoryFileStore } from '../../storage/memory-file-store';
import { KycHashService } from '../kyc-hash';
import { SYSTEM_ACTOR_ID } from '../../common/system-actor';
import { AdvancedApprover } from './advanced-approver';
import { AdvancedRunner } from './advanced-runner.service';
import { fakeDb } from './advanced.test-db';
import { MSG_IN_REVIEW, REJECT_MESSAGES, tooOldMessage } from './advanced.types';

const SETTINGS = { livenessMin: 90, faceMatchPass: 75, faceMatchReview: 60, addressRecencyMonths: 3 };
const hasher = new KycHashService({ get: () => undefined } as never);

async function harness(kind: string, scenario?: string, mimeType = 'image/png') {
  const files = new MemoryFileStore();
  await files.put('kyc/u1/poa', mockImage(scenario), mimeType);
  const db = fakeDb({
    advancedVerification: [
      {
        id: 'v1', userId: 'u1', step: 'ADDRESS', activeFor: 'u1', state: 'CHECKING', addressKind: kind, addressDocumentId: 'poa',
        frontDocumentId: null, backDocumentId: null, selfieDocumentId: null,
        readOutcome: null, readSends: 0, livenessOutcome: null, livenessSends: 0, matchOutcome: null, matchSends: 0, addressOutcome: null, addressSends: 0,
        findings: {}, reviewReasons: [], possiblyCharged: false, createdAt: new Date(), updatedAt: new Date(),
      },
    ],
    kycDocument: [{ id: 'poa', storageKey: 'kyc/u1/poa', mimeType, status: 'PENDING' }],
    user: [{ id: 'u1', kycTier: 'TIER_2', kycStatus: 'APPROVED', email: 'u1@x.test', firstName: 'Someone', lastName: 'Clean' }],
    kycProfile: [{ userId: 'u1', tier: 'TIER_2', status: 'APPROVED', addressLine: '1 E2E Street', city: 'Ikeja', state: 'Lagos' }],
    kycVerification: [{ userId: 'u1', state: 'APPROVED', recordFirstName: 'Someone', recordMiddleName: null, recordLastName: 'Clean', recordDateOfBirth: '1995-03-03', createdAt: new Date() }],
    refreshToken: [{ userId: 'u1', revokedAt: null }],
  });
  const dojah = new DojahMockClient(files);
  const approver = new AdvancedApprover(db as never, { send: jest.fn(async () => undefined) } as never, { onKycChanged: jest.fn(async () => undefined) } as never);
  const runner = new AdvancedRunner(
    db as never, dojah, { effective: jest.fn(async () => SETTINGS) } as never, files, hasher, approver,
    { raise: jest.fn(async () => undefined) } as never, { enqueue: jest.fn() } as never, { assertReady: jest.fn(), markNotReady: jest.fn() } as never,
  );
  const row = () => db.advancedVerification.rows[0] as Record<string, unknown>;
  return { db, files, dojah, runner, row, user: db.user.rows[0] as Record<string, unknown> };
}

describe('AdvancedRunner, Step B (spec 2026-10-21 §4.2, §7.2, §9)', () => {
  it('a recent utility bill via a 5-minute link: approved to TIER_3; the sharing is audited, the link never stored', async () => {
    const h = await harness('UTILITY_BILL');
    const linkSpy = jest.spyOn(h.files, 'temporaryLink');
    await h.runner.run('v1');
    expect(linkSpy).toHaveBeenCalledWith('kyc/u1/poa', 300);
    expect(h.row()).toMatchObject({ state: 'APPROVED', addressSends: 1, addressOutcome: 'SUCCEEDED' });
    expect(h.user.kycTier).toBe('TIER_3');
    expect(h.db.adminAuditLog.rows).toEqual([
      expect.objectContaining({ adminUserId: SYSTEM_ACTOR_ID, action: 'kyc.document.shared_with_provider', entity: 'KycDocument', entityId: 'poa' }),
    ]);
    expect(JSON.stringify(h.db.adminAuditLog.rows) + JSON.stringify(h.row())).not.toMatch(/memory:\/\//);
    expect(h.row().findings).toMatchObject({ linkShared: true, address: { source: 'BILL', name: 'FULL', address: 'MATCH' } });
  });

  it('an old bill is rejected with the recency message (N months)', async () => {
    const h = await harness('UTILITY_BILL', 'addr-old');
    await h.runner.run('v1');
    expect(h.row()).toMatchObject({ state: 'REJECTED', rejectCode: 'DOC_TOO_OLD', customerMessage: tooOldMessage(3) });
    expect(h.user.kycTier).toBe('TIER_2');
  });

  it('a bank statement goes through the text reader; only the summary is kept', async () => {
    const h = await harness('BANK_STATEMENT');
    await h.runner.run('v1');
    expect(h.dojah.calls).toMatchObject({ ocr: 1, utilityBill: 0 });
    expect(h.row().state).toBe('APPROVED');
    expect(JSON.stringify(h.row().findings)).not.toMatch(/ACCOUNT STATEMENT|E2E STREET/i);
    expect(h.row().findings).toMatchObject({ address: { source: 'TEXT', name: 'FULL', address: 'MATCH' } });
    expect(h.db.adminAuditLog.rows).toHaveLength(0); // no link for the text reader
  });

  it('tenancy: a running agreement approves, an ended one is too old', async () => {
    const running = await harness('TENANCY', 'tenancy-running');
    await running.runner.run('v1');
    expect(running.row().state).toBe('APPROVED');
    const ended = await harness('TENANCY', 'tenancy-ended');
    await ended.runner.run('v1');
    expect(ended.row()).toMatchObject({ state: 'REJECTED', rejectCode: 'DOC_TOO_OLD' });
  });

  it('a PDF goes to review with no Dojah call', async () => {
    const h = await harness('BANK_STATEMENT', undefined, 'application/pdf');
    await h.runner.run('v1');
    expect(h.row()).toMatchObject({ state: 'IN_REVIEW', reviewReasons: ['PDF'], customerMessage: MSG_IN_REVIEW });
    expect(h.dojah.calls).toMatchObject({ ocr: 0, utilityBill: 0 });
  });

  it('a 424 from the reader rejects as DOC_UNREADABLE', async () => {
    const h = await harness('GOVERNMENT_LETTER', 'addr-424');
    await h.runner.run('v1');
    expect(h.row()).toMatchObject({ state: 'REJECTED', rejectCode: 'DOC_UNREADABLE', customerMessage: REJECT_MESSAGES.DOC_UNREADABLE });
  });

  it('a name not found goes to review', async () => {
    const h = await harness('BANK_STATEMENT', 'addr-name');
    await h.runner.run('v1');
    expect(h.row()).toMatchObject({ state: 'IN_REVIEW', reviewReasons: expect.arrayContaining(['NAME_NOT_FOUND']) });
  });

  it('after a crash that lost the evidence of a successful call, a person decides (no second paid call)', async () => {
    const h = await harness('BANK_STATEMENT');
    Object.assign(h.row(), { addressOutcome: 'SUCCEEDED', addressSends: 1, findings: {} });
    await h.runner.run('v1');
    expect(h.row()).toMatchObject({ state: 'IN_REVIEW', reviewReasons: ['SYSTEM'] });
    expect(h.dojah.calls.ocr).toBe(0);
  });
});
