/**
 * Dates as a Nigerian customer reads them.
 *
 * Every user of this platform is in one time zone, and the server may well not
 * be. "6 September 2026 at 14:20 WAT" in a security email is checkable against
 * what somebody remembers doing; a UTC timestamp is an hour out and invites the
 * wrong conclusion about whether it was them.
 */
const LAGOS = 'Africa/Lagos';

export function formatLagos(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: LAGOS,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')} ${get('month')} ${get('year')} at ${get('hour')}:${get('minute')} WAT`;
}
