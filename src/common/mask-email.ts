/** "ada@davochain.test" → "a**@davochain.test": enough to recognise, not to harvest. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`;
}
