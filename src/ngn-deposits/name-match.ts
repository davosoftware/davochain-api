/** Upper-case words of two or more letters, with accents removed. */
function tokens(name: string): string[] {
  const plain = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  const words: string[] = plain.match(/[A-Z]+/g) ?? [];
  return words.filter((t) => t.length > 1);
}

/**
 * Does the sender, as their bank names them, look like our user (spec §6.5.1)?
 *
 * Every word of the user's first and last name must appear in the sender's
 * name; order, case, punctuation and extra (middle) names don't matter. Null
 * means there is nothing to compare. A mismatch is credited anyway and flagged
 * (decision D4): somebody paying in for a relative is ordinary.
 */
export function nameMatches(firstName: string, lastName: string, payerName: string | null | undefined): boolean | null {
  if (!payerName || /^\s*N\/?A\s*$/i.test(payerName)) return null;
  const payer = new Set(tokens(payerName));
  const required = [...tokens(firstName), ...tokens(lastName)];
  if (payer.size === 0 || required.length === 0) return null;
  return required.every((t) => payer.has(t));
}
