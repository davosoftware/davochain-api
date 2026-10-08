import { lagosDate } from './dates';

describe('lagosDate', () => {
  it('formats the calendar date in Lagos (UTC+1)', () => {
    expect(lagosDate(new Date('2026-10-07T12:00:00Z'))).toBe('2026-10-07');
  });

  it('rolls over at midnight Lagos time, not UTC', () => {
    expect(lagosDate(new Date('2026-10-07T23:30:00Z'))).toBe('2026-10-08');
    expect(lagosDate(new Date('2026-10-07T22:59:59Z'))).toBe('2026-10-07');
  });
});
