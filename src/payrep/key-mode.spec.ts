import { payrepKeyModeProblem } from './key-mode';

describe('payrepKeyModeProblem (spec §8)', () => {
  it('test keys outside production are fine', () => expect(payrepKeyModeProblem('pk_test_a', 'sk_test_b', 'development')).toBeNull());
  it('live keys in production are fine', () => expect(payrepKeyModeProblem('pk_live_a', 'sk_live_b', 'production')).toBeNull());
  it('live keys anywhere else are refused, naming no key', () => {
    const p = payrepKeyModeProblem('pk_live_a', 'sk_live_secret', 'development');
    expect(p).toMatch(/LIVE keys can only be used in production/);
    expect(p).not.toContain('secret');
  });
  it('test keys in production are refused', () => expect(payrepKeyModeProblem('pk_test_a', 'sk_test_b', 'production')).toMatch(/TEST keys cannot be used in production/));
  it('a mixed pair is refused', () => expect(payrepKeyModeProblem('pk_test_a', 'sk_live_b', 'development')).toMatch(/don't match/));
  it('keys without a known prefix are refused', () => expect(payrepKeyModeProblem('abc', 'def', 'development')).toMatch(/pk_test_/));
});
