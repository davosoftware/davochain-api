import { DojahApi, type AmlInput } from './dojah.client';
import { DojahError } from './dojah.errors';
import { normaliseIdentity, parseAmlResult } from './normalise';
import type { AmlResult, LookupResult } from './dojah.types';
import type { FileStore } from '../storage/file-store';
import type { AdvancedIdTypeName, BillRead, IdRead, LivenessRead, MatchRead } from '../kyc/advanced/advanced.types';

/**
 * Advanced test images carry "DOJAH-MOCK:<scenario>" after a real 1-pixel PNG,
 * so the upload check still sees a PNG and the mock knows what to answer.
 */
export const MOCK_MARKER = 'DOJAH-MOCK:';
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
export function mockImage(scenario?: string): Buffer {
  return scenario ? Buffer.concat([PNG_1PX, Buffer.from(MOCK_MARKER + scenario)]) : Buffer.from(PNG_1PX);
}
const scenarioOf = (bytes: Buffer): string | null => {
  const at = bytes.indexOf(MOCK_MARKER);
  return at < 0 ? null : (bytes.subarray(at + MOCK_MARKER.length).toString().match(/^[a-z0-9-]+/)?.[0] ?? null);
};
const fromB64 = (b64: string) => scenarioOf(Buffer.from(b64, 'base64'));
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** Month names, never dd/mm: an ambiguous date is read the cautious way, which would make a "recent" test date flaky. */
const spelled = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTH[m - 1]} ${y}`;
};
const FAIL: Record<string, () => DojahError> = {
  timeout: () => new DojahError('UNKNOWN', 'mock timeout', 0),
  wallet: () => new DojahError('WALLET', 'mock 402', 402),
  '424': () => new DojahError('UNPROCESSABLE', 'mock 424', 424),
  server: () => new DojahError('SERVER', 'mock 500', 500),
};
/** "<call>-timeout", "<call>-wallet", "<call>-424" and "<call>-server" fail that call. */
const failFor = (s: string | null, call: 'id' | 'live' | 'match' | 'addr') => {
  const m = s?.match(new RegExp(`^${call}-(timeout|wallet|424|server)$`));
  if (m) throw FAIL[m[1]]();
};

const rec = (first: string, middle: string, last: string, dob: string | null, gender = 'Male') => ({
  entity: { first_name: first, middle_name: middle, last_name: last, date_of_birth: dob, gender, customer: 'mock-customer' },
});

/** Lookup scenarios by number. The first two use the sandbox's test numbers and dates of birth; the sandbox's own record is named "John Doe Adamu" (live run, 2026-10-14). */
const LOOKUPS: Record<string, unknown> = {
  '22222222222': rec('John', 'Doe', 'Ajayi', '2000-05-01'),
  '70123456789': rec('John', 'Doe', 'Ajayi', '1990-01-01', 'M'),
  '33333333333': rec('Someone', '', 'Clean', '1995-03-03'),
  '44444444444': rec('Test', '', 'Clean', '1980-12-12'),
  '55555555555': rec('Test', '', 'Clean', null),
  // AML screens the record's names, so these reach the sanctions paths end to end.
  '66666666666': rec('Test', '', 'Sanctioned', '1985-06-06'),
  '77777777777': rec('Test', '', 'Maybesanctioned', '1985-06-06'),
};
const LOOKUP_FAILURES: Record<string, () => DojahError> = {
  '40100000001': () => new DojahError('AUTH', 'mock 401', 401),
  '40300000001': () => new DojahError('IP', 'mock 403', 403),
  '40200000001': () => new DojahError('WALLET', 'mock 402', 402),
  '50000000001': () => new DojahError('SERVER', 'mock 500', 500),
  '99999999999': () => new DojahError('UNKNOWN', 'mock timeout', 0),
};

const pep = { name: 'John Doe Ajayi', source_type: 'PEP', positions: ['Commissioner'], country: 'Nigeria', score: 0.91 };
const AML: Record<string, unknown> = {
  ajayi: { entity: { entity_id: 'mock-unknown', match_status: 'Unknown', risk_level: 'Unknown', results: pep } },
  clean: { entity: { entity_id: 'mock-clear', match_status: 'No Match', risk_level: 'Low', results: [] } },
  pep: { entity: { entity_id: 'mock-pep', match_status: 'Potential Match', risk_level: 'Medium', results: [pep] } },
  sanctioned: {
    entity: { entity_id: 'mock-sanctions', match_status: 'Confirmed Match', risk_level: 'High', results: [{ name: 'Listed Person', source_type: 'SANCTION', score: 1 }] },
  },
  maybesanctioned: {
    entity: { entity_id: 'mock-maybe', match_status: 'Potential Match', risk_level: 'Medium', results: [{ name: 'Listed Person', source_type: 'Sanctions', score: 0.6 }] },
  },
};

/**
 * Principle 5: every path the sandbox cannot show. Development and test only
 * (env validation refuses it elsewhere). Unknown numbers return the clean record.
 */
export class DojahMockClient extends DojahApi {
  readonly calls = { lookup: 0, aml: 0, balance: 0, readId: 0, liveness: 0, faceMatch: 0, utilityBill: 0, ocr: 0 };

  /** The file store lets a "memory://" bill link be read back, as Dojah would fetch a real one. */
  constructor(private readonly files?: FileStore) {
    super();
  }

  async readId(i: { idType: AdvancedIdTypeName; front: string; back?: string }) {
    this.calls.readId++;
    const s = fromB64(i.front);
    failFor(s, 'id');
    const read: IdRead = {
      valid: s !== 'id-invalid',
      documentName: { NATIONAL_ID: 'Nigeria National ID Card', PASSPORT: 'Nigeria Passport', DRIVERS_LICENSE: "Nigeria Driver's Licence" }[i.idType],
      firstName: s === 'id-name' ? 'SOMEBODY' : 'SOMEONE',
      middleName: null,
      lastName: 'CLEAN',
      dateOfBirth: s === 'id-dob' ? '1990-01-01' : '1995-03-03',
      expiry: s === 'id-expired' ? '2020-01-01' : s === 'id-noexpiry' ? null : '2030-01-01',
      // A random number by default, so tests never trip the duplicate-ID check by accident.
      documentNumber: s?.startsWith('id-num-') ? s.slice(7).toUpperCase() : `A${Math.floor(Math.random() * 1e8)}`,
      unreadable: [],
    };
    return { read, portrait: s === 'id-noportrait' ? null : 'bW9jay1wb3J0cmFpdA==', httpStatus: 200 };
  }

  async liveness(selfie: string) {
    this.calls.liveness++;
    const s = fromB64(selfie);
    failFor(s, 'live');
    const read: LivenessRead = { live: s !== 'live-fail', probability: s === 'live-low' ? 80 : 98, faceDetected: s !== 'live-noface', multiFace: s === 'live-multi' };
    return { read, httpStatus: 200 };
  }

  async faceMatch(selfie: string, _idPhoto: string) {
    this.calls.faceMatch++;
    const s = fromB64(selfie);
    failFor(s, 'match');
    const read: MatchRead = { confidence: s === 'match-borderline' ? 68 : s === 'match-fail' ? 40 : 92 };
    return { read, httpStatus: 200 };
  }

  async utilityBill(url: string) {
    this.calls.utilityBill++;
    const key = url.startsWith('memory://') ? decodeURIComponent(url.slice('memory://'.length).split('?')[0]) : null;
    const stored = key && this.files ? await this.files.get(key) : null;
    const s = stored ? scenarioOf(stored.bytes) : null;
    failFor(s, 'addr');
    const read: BillRead = {
      ok: true,
      fullName: s === 'addr-name' ? 'OTHER PERSON' : 'SOMEONE CLEAN',
      street: '1 E2E Street',
      city: 'Ikeja',
      state: 'Lagos',
      issueDate: s === 'addr-old' ? '2024-01-01' : daysAgo(10),
      isRecent: s !== 'addr-old',
      provider: 'Ikeja Electric (mock)',
    };
    return { read, httpStatus: 200 };
  }

  async ocr(image: string) {
    this.calls.ocr++;
    const s = fromB64(image);
    failFor(s, 'addr');
    const name = s === 'addr-name' ? 'MR OTHER PERSON' : 'SOMEONE CLEAN';
    const lines =
      s === 'tenancy-running'
        ? ['TENANCY AGREEMENT', `Tenant: ${name}`, '1 E2E Street, Ikeja, Lagos', `from 1 January 2025 to ${spelled(daysAgo(-300))}`]
        : s === 'tenancy-ended'
          ? ['TENANCY AGREEMENT', `Tenant: ${name}`, '1 E2E Street, Ikeja, Lagos', 'from 1 January 2023 to 31 December 2024']
          : s === 'ocr-nodate'
            ? ['STATEMENT', name, '1 E2E Street, Ikeja, Lagos', 'no date printed on this page at all']
            : s === 'ocr-sparse'
              ? ['X']
              : ['ACCOUNT STATEMENT', name, '1 E2E Street, Ikeja, Lagos', `Statement date: ${spelled(s === 'addr-old' ? '2024-01-01' : daysAgo(10))}`];
    return { lines, httpStatus: 200 };
  }

  async lookup(_idType: 'BVN' | 'NIN', idNumber: string): Promise<LookupResult> {
    this.calls.lookup++;
    const fail = LOOKUP_FAILURES[idNumber];
    if (fail) throw fail();
    if (idNumber === '11111111111') return { found: false, httpStatus: 404 };
    // H8: one number verifies one account, so tests need many numbers per person:
    // a number that is not an exact special one reads as its family (first three digits).
    const family = LOOKUPS[idNumber.slice(0, 3).repeat(4).slice(0, 11)];
    return { found: true, identity: normaliseIdentity(LOOKUPS[idNumber] ?? family ?? LOOKUPS['22222222222']), httpStatus: 200 };
  }

  async screen(input: AmlInput, _reference: string): Promise<AmlResult> {
    this.calls.aml++;
    const last = input.names.trim().split(/\s+/).pop()!.toLowerCase();
    if (last === 'amlerror') throw new DojahError('SERVER', 'mock 500', 500);
    if (last === 'amltimeout') throw new DojahError('UNKNOWN', 'mock timeout', 0);
    return { parsed: parseAmlResult(AML[last] ?? AML.clean), httpStatus: 200 };
  }

  async balance(): Promise<number> {
    this.calls.balance++;
    return 0;
  }
}
