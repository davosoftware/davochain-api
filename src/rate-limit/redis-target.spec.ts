import { isLocalRedisHost, pauseTestAllowed } from './redis-target';

describe('which Redis the pause test may freeze', () => {
  it('accepts only this machine', () => {
    for (const ok of ['localhost', '127.0.0.1', '::1', '[::1]', ' LOCALHOST ']) expect(isLocalRedisHost(ok)).toBe(true);
    for (const bad of ['redis.internal', '10.0.0.5', 'my-redis.cache.amazonaws.com', '', '127.0.0.2']) expect(isLocalRedisHost(bad)).toBe(false);
  });

  it('allows a remote target only when someone opts in explicitly', () => {
    expect(pauseTestAllowed('10.0.0.5', {})).toBe(false);
    expect(pauseTestAllowed('10.0.0.5', { ALLOW_REDIS_PAUSE_TEST: '1' })).toBe(true);
    expect(pauseTestAllowed('10.0.0.5', { ALLOW_REDIS_PAUSE_TEST: 'yes' })).toBe(false);
    expect(pauseTestAllowed('localhost', {})).toBe(true);
  });
});
