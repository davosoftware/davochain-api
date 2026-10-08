/**
 * JSON.parse that never turns a number into a float.
 *
 * Flutterwave sends money as JSON numbers — `1500`, `1479`, and fees such as
 * `26.875`. Plain JSON.parse hands those back as doubles, and a double cannot
 * hold every decimal exactly. Here every number comes back as the exact text it
 * was written with ("26.875", "10535993"), so money becomes a Decimal without
 * ever being a float, and ids keep every digit. Strings, booleans and null are
 * unchanged.
 *
 * Relies on the reviver's third argument, `context.source` (Node 22+).
 * `assertExactJsonSupported` runs at startup so an older runtime fails loudly
 * instead of quietly parsing money through floats.
 */
type ReviverContext = { source?: string };

function exactReviver(this: unknown, _key: string, value: unknown, context?: ReviverContext): unknown {
  if (typeof value !== 'number') return value;
  if (!context || typeof context.source !== 'string') {
    throw new Error('JSON.parse source text is unavailable: Node 22 or newer is required');
  }
  return context.source;
}

export function parseJsonExact(text: string): unknown {
  return JSON.parse(text, exactReviver as (this: unknown, key: string, value: unknown) => unknown);
}

export function assertExactJsonSupported(): void {
  let probe: { a?: unknown; b?: unknown };
  try {
    probe = parseJsonExact('{"a":1.10,"b":12345678901234567890}') as { a?: unknown; b?: unknown };
  } catch (err) {
    throw new Error(
      `Exact JSON parsing is not supported by this runtime (${(err as Error).message}). Use Node 22+.`,
    );
  }
  if (probe.a !== '1.10' || probe.b !== '12345678901234567890') {
    throw new Error('Exact JSON parsing is not supported by this runtime. Use Node 22+.');
  }
}
