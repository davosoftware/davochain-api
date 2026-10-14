import { NG_STATES, isValidLga, isValidState } from './ng-states';

describe('NG_STATES', () => {
  it('has the 36 states and the FCT, each with LGAs, 774 LGAs in total', () => {
    expect(NG_STATES).toHaveLength(37);
    expect(NG_STATES.every((s) => s.lgas.length > 0)).toBe(true);
    expect(NG_STATES.reduce((n, s) => n + s.lgas.length, 0)).toBe(774);
  });
  it('has no duplicate LGA inside a state', () => {
    for (const s of NG_STATES) expect(new Set(s.lgas.map((l) => l.toLowerCase())).size).toBe(s.lgas.length);
  });
  it('validates a state and an LGA within it', () => {
    expect(isValidState('Lagos')).toBe(true);
    expect(isValidState('FCT')).toBe(true);
    expect(isValidLga('Lagos', 'Ikeja')).toBe(true);
    expect(isValidLga('FCT', 'Municipal Area Council')).toBe(true);
    expect(isValidLga('Lagos', 'Nsukka')).toBe(false);
    expect(isValidState('Atlantis')).toBe(false);
  });
});
