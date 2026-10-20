import { CredentialsService } from './credentials.service';

/**
 * OPEN_ISSUES A4: a provider key saved on the dashboard (System → API keys) is
 * kept in each server's memory. It used to be kept until that server
 * restarted, so a key changed through one server stayed old on the others.
 * Now a copy is kept for at most a minute.
 */
function setup() {
  let stored: string | null = null;
  const prisma = {
    integrationCredential: { findUnique: jest.fn(async () => (stored ? { ciphertext: stored } : null)) },
  };
  const config = { get: (k: string) => (k === 'CREDENTIALS_KEY' ? 'a-test-passphrase' : k === 'QUIDAX_SECRET_KEY' ? 'env-key' : undefined) };
  const svc = new CredentialsService(prisma as never, config as never);
  svc.onModuleInit();
  const encrypt = (v: string) => (svc as unknown as { encrypt(v: string): string }).encrypt(v);
  return { svc, prisma, setStored: (v: string) => (stored = encrypt(v)) };
}

describe('Provider keys: each server re-reads within a minute (A4)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('serves the cached copy for up to a minute, then reads the database again', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { svc, prisma, setStored } = setup();
    setStored('old-key');
    expect(await svc.get('quidax.secretKey' as never)).toBe('old-key');

    // Another server changes the key in the database.
    setStored('new-key');
    now.mockReturnValue(1_000_000 + 59_000);
    expect(await svc.get('quidax.secretKey' as never)).toBe('old-key');

    now.mockReturnValue(1_000_000 + 61_000);
    expect(await svc.get('quidax.secretKey' as never)).toBe('new-key');
    expect(prisma.integrationCredential.findUnique).toHaveBeenCalledTimes(2);
  });

  it('falls back to the .env value when nothing is stored, and re-checks it the same way', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(5_000_000);
    const { svc, setStored } = setup();
    expect(await svc.get('quidax.secretKey' as never)).toBe('env-key');
    setStored('dashboard-key');
    now.mockReturnValue(5_000_000 + 61_000);
    expect(await svc.get('quidax.secretKey' as never)).toBe('dashboard-key');
  });
});
