import { HashBusyError, HashSemaphore } from './hash-semaphore';

function deferred() {
  let release!: () => void;
  const done = new Promise<void>((r) => (release = r));
  return { done, release };
}

describe('HashSemaphore', () => {
  it('never runs more than its concurrency at once', async () => {
    const gate = new HashSemaphore(2, 10);
    let running = 0;
    let peak = 0;
    const work = () =>
      gate.run(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
      });
    await Promise.all(Array.from({ length: 8 }, work));
    expect(peak).toBe(2);
    expect(gate.inFlight).toBe(0);
  });

  it('refuses at once with a 503 when the queue is full, then serves the queued one', async () => {
    const gate = new HashSemaphore(1, 1);
    const first = deferred();
    const a = gate.run(() => first.done);
    const b = gate.run(async () => 'b ran');
    const c = gate.run(async () => 'c ran');
    await expect(c).rejects.toBeInstanceOf(HashBusyError);
    await c.catch((err: HashBusyError) => {
      expect(err.getStatus()).toBe(503);
      expect(err.message).toBe('The service is busy, try again shortly');
    });
    first.release();
    await a;
    await expect(b).resolves.toBe('b ran');
  });

  it('gives a waiter that passes its deadline a 503 and takes it out of the queue', async () => {
    const gate = new HashSemaphore(1, 5, 50);
    const first = deferred();
    const a = gate.run(() => first.done);
    const started = Date.now();
    await expect(gate.run(async () => 'late')).rejects.toBeInstanceOf(HashBusyError);
    expect(Date.now() - started).toBeLessThan(500);
    expect(gate.queued).toBe(0);
    first.release();
    await a;
  });

  it('frees the slot when the work throws', async () => {
    const gate = new HashSemaphore(1, 1);
    await expect(gate.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(gate.run(async () => 'next')).resolves.toBe('next');
    expect(gate.inFlight).toBe(0);
  });
});
