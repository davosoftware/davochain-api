import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const svc = new PasswordService();

  it('round-trips a password', async () => {
    const hash = await svc.hash('correct horse battery staple');
    expect(await svc.verify('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await svc.hash('correct horse battery staple');
    expect(await svc.verify('Correct horse battery staple', hash)).toBe(false);
    expect(await svc.verify('', hash)).toBe(false);
  });

  it('salts — the same password never produces the same hash twice', async () => {
    const [a, b] = await Promise.all([svc.hash('same-password'), svc.hash('same-password')]);
    expect(a).not.toBe(b);
    expect(await svc.verify('same-password', a)).toBe(true);
    expect(await svc.verify('same-password', b)).toBe(true);
  });

  it('stores its parameters in the hash so they can be raised later', async () => {
    const hash = await svc.hash('x'.repeat(20));
    const [scheme, n, r, p, salt, digest] = hash.split('$');
    expect(scheme).toBe('scrypt');
    expect(Number(n)).toBe(32768);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
    expect(Buffer.from(salt, 'base64')).toHaveLength(16);
    expect(Buffer.from(digest, 'base64')).toHaveLength(64);
  });

  it('returns false on a malformed hash instead of throwing', async () => {
    for (const bad of ['', 'nonsense', 'bcrypt$1$2$3$4', 'scrypt$only$three$parts']) {
      await expect(svc.verify('any', bad)).resolves.toBe(false);
    }
  });

  it('flags a hash made with weaker parameters for rehash', () => {
    expect(svc.needsRehash('scrypt$16384$8$1$c2FsdA==$aGFzaA==')).toBe(true);
    expect(svc.needsRehash('bcrypt$2b$12$whatever')).toBe(true);
  });

  it('does not flag a current hash', async () => {
    expect(svc.needsRehash(await svc.hash('current'))).toBe(false);
  });

  it('normalises unicode so the same typed password always matches', async () => {
    const composed = 'café-password-1'; // é as a single code point
    const decomposed = 'café-password-1'; // e + combining acute
    expect(composed).not.toBe(decomposed); // genuinely different byte sequences
    const hash = await svc.hash(composed);
    expect(await svc.verify(decomposed, hash)).toBe(true);
  });
});
