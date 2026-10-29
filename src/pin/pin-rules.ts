/** Transaction PIN rules (29 Oct 2026). */
export const PIN_LENGTH = 4;

/** Wrong PINs in a row before the PIN locks. */
export const PIN_MAX_TRIES = 5;

/** How long a locked PIN stays locked. */
export const PIN_LOCK_MINUTES = 30;

/** Picked so often that a thief tries them first. */
const COMMON = new Set(['1004', '2000', '2001', '2580', '1984', '6969']);

/**
 * Why a new PIN cannot be used, or null when it can. Only ASCII digits:
 * the keypad sends nothing else, and other numerals would read the same on
 * screen while being a different PIN.
 */
export function checkNewPin(pin: string): string | null {
  if (typeof pin !== 'string' || !new RegExp(`^[0-9]{${PIN_LENGTH}}$`).test(pin)) {
    return `Your PIN must be exactly ${PIN_LENGTH} digits.`;
  }
  const d = [...pin].map(Number);
  const step = d[1] - d[0];
  const straight = Math.abs(step) <= 1 && d.every((x, i) => i === 0 || x - d[i - 1] === step);
  const abab = d[0] === d[2] && d[1] === d[3];
  const aabb = d[0] === d[1] && d[2] === d[3];
  if (straight || abab || aabb || COMMON.has(pin)) {
    return 'That PIN is too easy to guess. Choose 4 digits that are not in a row or repeated.';
  }
  return null;
}
