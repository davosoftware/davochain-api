import { DojahMockClient, mockImage } from '../../dojah/dojah.mock';
import { MemoryFileStore } from '../../storage/memory-file-store';
import { StorageUnavailableError } from '../../storage/file-store';
import { KycHashService } from '../kyc-hash';
import { AdvancedApprover } from './advanced-approver';
import { AdvancedRunner, BusyError } from './advanced-runner.service';
import { fakeDb } from './advanced.test-db';
import { MSG_FAILED_SYSTEM, MSG_IN_REVIEW, REJECT_MESSAGES } from './advanced.types';

const SETTINGS = { livenessMin: 90, faceMatchPass: 75, faceMatchReview: 60, addressRecencyMonths: 3 };
const hasher = new KycHashService({ get: () => 'test-kyc-hash-key-at-least-32-chars-long!!' } as never);

async function harness(s: { front?: string; selfie?: string } = {}) {
  const files = new MemoryFileStore();
  await files.put('kyc/u1/front', mockImage(s.front), 'image/png');
  await files.put('kyc/u1/back', mockImage('back'), 'image/png');
  await files.put('kyc/u1/selfie', mockImage(s.selfie), 'image/jpeg');
  const db = fakeDb({
    advancedVerification: [
      {
        id: 'v1', userId: 'u1', step: 'IDENTITY', activeFor: 'u1', state: 'CHECKING', idType: 'NATIONAL_ID',
        frontDocumentId: 'front', backDocumentId: 'back', selfieDocumentId: 'selfie', addressDocumentId: null,
        readOutcome: null, readSends: 0, livenessOutcome: null, livenessSends: 0, matchOutcome: null, matchSends: 0, addressOutcome: null, addressSends: 0,
        findings: {}, reviewReasons: [], possiblyCharged: false, createdAt: new Date(), updatedAt: new Date(),
      },
    ],
    kycDocument: ['front', 'back', 'selfie'].map((id) => ({ id, storageKey: `kyc/u1/${id}`, mimeType: 'image/png', status: 'PENDING' })),
    user: [{ id: 'u1', kycTier: 'TIER_1', kycStatus: 'APPROVED', email: 'u1@x.test', firstName: 'Someone', lastName: 'Clean' }],
    kycProfile: [{ userId: 'u1', tier: 'TIER_1', status: 'APPROVED', addressLine: '1 E2E Street', city: 'Ikeja', state: 'Lagos' }],
    kycVerification: [{ userId: 'u1', state: 'APPROVED', recordFirstName: 'Someone', recordMiddleName: null, recordLastName: 'Clean', recordDateOfBirth: '1995-03-03', createdAt: new Date() }],
    refreshToken: [{ userId: 'u1', revokedAt: null }],
  });
  const dojah = new DojahMockClient(files);
  const mail = { send: jest.fn(async () => undefined) };
  const referrals = { onKycChanged: jest.fn(async () => undefined) };
  const approver = new AdvancedApprover(db as never, mail as never, referrals as never);
  const cfg = { effective: jest.fn(async () => SETTINGS) };
  const alerts = { raise: jest.fn(async () => undefined) };
  const readiness = { assertReady: jest.fn(), markNotReady: jest.fn() };
  const submitter = { enqueue: jest.fn(async () => undefined) };
  const runner = new AdvancedRunner(db as never, dojah, cfg as never, files, hasher, approver, alerts as never, submitter as never, readiness as never);
  const row = () => db.advancedVerification.rows[0] as Record<string, unknown>;
  const patch = (p: Record<string, unknown>) => Object.assign(row(), p);
  const user = db.user.rows[0] as Record<string, unknown>;
  const docStatuses = () => db.kycDocument.rows.map((d) => d.status);
  return { db, files, dojah, runner, row, patch, user, docStatuses, mail, readiness, alerts };
}

const cleanRead = { valid: true, documentName: 'Nigeria National ID Card', firstName: 'SOMEONE', middleName: null, lastName: 'CLEAN', dateOfBirth: '1995-03-03', expiry: '2030-01-01', documentNumber: null, unreadable: [] };

describe('AdvancedRunner, Step A (spec 2026-10-21 §6, §7.1)', () => {
  it('clear pass: three calls, approved, TIER_2, sessions revoked, documents approved, minimal data kept', async () => {
    const h = await harness({ front: 'id-num-a12345678' });
    await h.runner.run('v1');
    expect(h.row()).toMatchObject({ state: 'APPROVED', activeFor: null, readSends: 1, livenessSends: 1, matchSends: 1, docLast4: '5678' });
    expect(h.dojah.calls).toMatchObject({ readId: 1, liveness: 1, faceMatch: 1 });
    expect(h.user).toMatchObject({ kycTier: 'TIER_2', kycStatus: 'APPROVED' });
    expect(h.db.kycProfile.rows[0].tier).toBe('TIER_2');
    expect(h.db.refreshToken.rows[0].revokedAt).toBeInstanceOf(Date);
    expect(h.docStatuses()).toEqual(['APPROVED', 'APPROVED', 'APPROVED']);
    const stored = JSON.stringify(h.row());
    expect(stored).not.toContain('bW9jay1wb3J0cmFpdA'); // the portrait
    expect(stored).not.toContain('A12345678'); // the full number
    expect(h.mail.send).toHaveBeenCalledWith(expect.objectContaining({ key: 'kyc.approved', variables: expect.objectContaining({ tier: 'Advanced (in progress)' }) }));
  });

  it('an expired ID stops after the read: no liveness, no match; Basic is untouched', async () => {
    const h = await harness({ front: 'id-expired' });
    await h.runner.run('v1');
    expect(h.row()).toMatchObject({ state: 'REJECTED', rejectCode: 'ID_EXPIRED', customerMessage: REJECT_MESSAGES.ID_EXPIRED, activeFor: null });
    expect(h.dojah.calls).toMatchObject({ readId: 1, liveness: 0, faceMatch: 0 });
    expect(h.user).toMatchObject({ kycTier: 'TIER_1', kycStatus: 'APPROVED' });
    expect(h.docStatuses()).toEqual(['REJECTED', 'REJECTED', 'REJECTED']);
    expect(h.mail.send).toHaveBeenCalledWith(expect.objectContaining({ key: 'kyc.rejected' }));
  });

  it('Dojah 424 on the read rejects as ID_UNREADABLE', async () => {
    const h = await harness({ front: 'id-424' });
    await h.runner.run('v1');
    expect(h.row()).toMatchObject({ state: 'REJECTED', rejectCode: 'ID_UNREADABLE', readOutcome: 'DEFINITELY_FAILED' });
  });

  it('a borderline face match goes to review and keeps the slot', async () => {
    const h = await harness({ selfie: 'match-borderline' });
    await h.runner.run('v1');
    expect(h.row()).toMatchObject({ state: 'IN_REVIEW', reviewReasons: ['FACE_MATCH_BORDERLINE'], activeFor: 'u1', customerMessage: MSG_IN_REVIEW });
    expect(h.user.kycTier).toBe('TIER_1');
  });

  it('a selfie that is not live is rejected before the face match is paid for', async () => {
    const h = await harness({ selfie: 'live-fail' });
    await h.runner.run('v1');
    expect(h.row()).toMatchObject({ state: 'REJECTED', rejectCode: 'SELFIE_NOT_LIVE' });
    expect(h.dojah.calls.faceMatch).toBe(0);
  });

  it('resume after a crash between read and match: re-reads once, skips liveness', async () => {
    const h = await harness();
    h.patch({
      readOutcome: 'SUCCEEDED', readSends: 1, livenessOutcome: 'SUCCEEDED', livenessSends: 1,
      findings: { id: cleanRead, liveness: { live: true, probability: 98, faceDetected: true, multiFace: false } },
    });
    await h.runner.run('v1');
    expect(h.dojah.calls).toMatchObject({ readId: 1, liveness: 0, faceMatch: 1 });
    expect(h.row()).toMatchObject({ state: 'APPROVED', readSends: 2 });
    expect(h.row().findings).toMatchObject({ readAgain: true });
  });

  it("a call still IN_FLIGHT inside the lease is someone else's: BusyError, nothing sent", async () => {
    const h = await harness();
    h.patch({ readOutcome: 'IN_FLIGHT', readStartedAt: new Date() });
    await expect(h.runner.run('v1')).rejects.toBeInstanceOf(BusyError);
    expect(h.dojah.calls.readId).toBe(0);
  });

  it('UNKNOWN once is re-sent; UNKNOWN twice ends FAILED_SYSTEM, possiblyCharged, slot freed', async () => {
    const h = await harness({ selfie: 'live-timeout' });
    await expect(h.runner.run('v1')).rejects.toThrow(/timeout/);
    expect(h.row()).toMatchObject({ livenessOutcome: 'UNKNOWN', livenessSends: 1, state: 'CHECKING' });
    await expect(h.runner.run('v1')).rejects.toThrow(/timeout/);
    expect(h.row()).toMatchObject({ livenessSends: 2, possiblyCharged: true });
    await h.runner.run('v1');
    expect(h.row()).toMatchObject({ state: 'FAILED_SYSTEM', failureReason: 'UNKNOWN_TWICE', possiblyCharged: true, activeFor: null, customerMessage: MSG_FAILED_SYSTEM });
    expect(h.dojah.calls.liveness).toBe(2);
    expect(h.dojah.calls.readId).toBe(1);
  });

  it('an empty wallet fails the attempt at once, marks Dojah not ready and alerts', async () => {
    const h = await harness({ front: 'id-wallet' });
    await h.runner.run('v1');
    expect(h.row()).toMatchObject({ state: 'FAILED_SYSTEM', failureReason: 'WALLET', activeFor: null });
    expect(h.readiness.markNotReady).toHaveBeenCalledWith('wallet');
    expect(h.alerts.raise).toHaveBeenCalled();
  });

  it('a duplicate ID number on another approved customer goes to review', async () => {
    const h = await harness({ front: 'id-num-dup12345' });
    h.db.advancedVerification.rows.push({ id: 'other', userId: 'u2', step: 'IDENTITY', state: 'APPROVED', docHash: hasher.hash('NATIONAL_ID:DUP12345'), docDateOfBirth: '1995-03-03' });
    await h.runner.run('v1');
    expect(h.row()).toMatchObject({ state: 'IN_REVIEW', reviewReasons: ['DUPLICATE_ID'] });
  });

  it('storage down: throws to retry, nothing paid, still CHECKING', async () => {
    const h = await harness();
    h.files.failNext(1);
    await expect(h.runner.run('v1')).rejects.toBeInstanceOf(StorageUnavailableError);
    expect(h.row().state).toBe('CHECKING');
    expect(h.dojah.calls.readId).toBe(0);
  });

  it('a row no longer CHECKING is left alone', async () => {
    const h = await harness();
    h.patch({ state: 'REJECTED' });
    await h.runner.run('v1');
    expect(h.dojah.calls.readId).toBe(0);
  });

  it('the ID has no face photo: review, no face match paid', async () => {
    const h = await harness({ front: 'id-noportrait' });
    await h.runner.run('v1');
    expect(h.row()).toMatchObject({ state: 'IN_REVIEW', reviewReasons: ['NO_ID_PHOTO'] });
    expect(h.dojah.calls).toMatchObject({ readId: 1, faceMatch: 0 }); // no second paid read: the photo wasn't lost, there isn't one
  });
});
