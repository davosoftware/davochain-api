import { DojahApi, type AmlInput } from './dojah.client';
import { DojahError } from './dojah.errors';
import { normaliseIdentity, parseAmlResult } from './normalise';
import type { AmlResult, LookupResult } from './dojah.types';

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
  readonly calls = { lookup: 0, aml: 0, balance: 0 };

  async lookup(_idType: 'BVN' | 'NIN', idNumber: string): Promise<LookupResult> {
    this.calls.lookup++;
    const fail = LOOKUP_FAILURES[idNumber];
    if (fail) throw fail();
    if (idNumber === '11111111111') return { found: false, httpStatus: 404 };
    return { found: true, identity: normaliseIdentity(LOOKUPS[idNumber] ?? LOOKUPS['22222222222']), httpStatus: 200 };
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
