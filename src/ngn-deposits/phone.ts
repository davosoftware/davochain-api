/**
 * Payrep wants a local number like 08012345678 (at most 11 characters).
 * Sign-up stores numbers like +2348012345678; anything that isn't a Nigerian
 * mobile number is left out (the field is optional).
 */
export function localNigerianPhone(phone: string | null | undefined): string | undefined {
  const d = (phone ?? '').replace(/\D/g, '');
  if (/^234[789]\d{9}$/.test(d)) return `0${d.slice(3)}`;
  if (/^0[789]\d{9}$/.test(d)) return d;
  if (/^[789]\d{9}$/.test(d)) return `0${d}`;
  return undefined;
}
