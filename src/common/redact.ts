/**
 * BVNs, NINs and phone numbers are 11 digits; none of them belong in a log, an
 * exception or a stored error. Transaction ids (8–10 digits), account numbers
 * (10) and bank session ids (25+) are left readable.
 */
export function redactIds(text: string): string {
  return text.replace(/(?<!\d)\d{11}(?!\d)/g, '[REDACTED]');
}
