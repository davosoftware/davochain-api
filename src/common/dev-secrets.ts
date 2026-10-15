/**
 * Whether a live secret (a reset code, an invitation link) may be written to
 * the log when email could not be sent (PROJECT_REVIEW M12).
 *
 * Only on a developer's own machine: NODE_ENV exactly "development". The old
 * test, "not production", also logged on staging and test servers, which can
 * have real testers and shared logs.
 */
export function mayLogSecrets(nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return nodeEnv === 'development';
}
