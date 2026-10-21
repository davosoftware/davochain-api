import { AdvancedRunner } from './advanced-runner.service';
import { fakeDb } from './advanced.test-db';
import { MSG_FAILED_SYSTEM } from './advanced.types';

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
const row = (id: string, ageMin: number, quietMin: number, over: Record<string, unknown> = {}) => ({
  id, userId: `u-${id}`, step: 'IDENTITY', activeFor: `u-${id}`, state: 'CHECKING', createdAt: minutesAgo(ageMin), updatedAt: minutesAgo(quietMin),
  readOutcome: null, livenessOutcome: null, matchOutcome: null, addressOutcome: null, possiblyCharged: false, ...over,
});

function build(rows: Record<string, unknown>[]) {
  const db = fakeDb({ advancedVerification: rows });
  const submitter = { enqueue: jest.fn(async () => undefined) };
  const runner = new AdvancedRunner(db as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, submitter as never);
  const get = (id: string) => db.advancedVerification.rows.find((r) => r.id === id) as Record<string, unknown>;
  return { runner, submitter, get };
}

describe('AdvancedRunner.sweep (spec 2026-10-21 §6)', () => {
  it('re-queues a quiet CHECKING row, times out an hour-old one, leaves a busy one alone', async () => {
    const { runner, submitter, get } = build([row('a', 8, 7), row('b', 61, 61, { readOutcome: 'UNKNOWN' }), row('c', 1, 1), row('d', 9, 9, { state: 'IN_REVIEW' })]);
    expect(await runner.sweep()).toEqual({ requeued: 1, timedOut: 1 });
    expect(submitter.enqueue).toHaveBeenCalledTimes(1);
    expect(submitter.enqueue).toHaveBeenCalledWith('a', expect.stringMatching(/^r\d+$/));
    expect(get('b')).toMatchObject({ state: 'FAILED_SYSTEM', failureReason: 'TIMED_OUT', possiblyCharged: true, activeFor: null, customerMessage: MSG_FAILED_SYSTEM });
    expect(get('c').state).toBe('CHECKING');
    expect(get('d').state).toBe('IN_REVIEW');
  });

  it('a timed-out row with no call in doubt is not marked possibly charged', async () => {
    const { runner, get } = build([row('e', 90, 90, { readOutcome: 'SUCCEEDED' })]);
    await runner.sweep();
    expect(get('e')).toMatchObject({ state: 'FAILED_SYSTEM', possiblyCharged: false });
  });

  it('one failed re-queue does not stop the sweep', async () => {
    const { runner, submitter } = build([row('a', 8, 7), row('f', 9, 8)]);
    submitter.enqueue.mockRejectedValueOnce(new Error('redis down'));
    expect(await runner.sweep()).toEqual({ requeued: 2, timedOut: 0 });
    expect(submitter.enqueue).toHaveBeenCalledTimes(2);
  });
});

describe('final review I3: the sweep leaves rows that may only be waiting out a retry delay', () => {
  it('a row quiet for 3 minutes is left; 7 minutes is re-queued', async () => {
    const { runner, submitter } = build([row('a', 3, 3), row('b', 8, 7)]);
    expect(await runner.sweep()).toEqual({ requeued: 1, timedOut: 0 });
    expect(submitter.enqueue).toHaveBeenCalledWith('b', expect.any(String));
  });
});
