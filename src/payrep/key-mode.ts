/** Live keys only in production, test keys everywhere else (spec §8). Never names a key. */
export function payrepKeyModeProblem(clientId: string, clientSecret: string, nodeEnv: string): string | null {
  const mode = (s: string, p: 'pk' | 'sk') => (s.startsWith(`${p}_test_`) ? 'test' : s.startsWith(`${p}_live_`) ? 'live' : null);
  const a = mode(clientId, 'pk');
  const b = mode(clientSecret, 'sk');
  if (!a || !b) return 'Payrep keys must start with pk_test_/sk_test_ (test system) or pk_live_/sk_live_ (live)';
  if (a !== b) return "The Payrep client ID and secret don't match: one is a test key and one is live";
  if (nodeEnv === 'production' && a === 'test') return 'Payrep TEST keys cannot be used in production';
  if (nodeEnv !== 'production' && a === 'live') return `Payrep LIVE keys can only be used in production (NODE_ENV is ${nodeEnv})`;
  return null;
}
