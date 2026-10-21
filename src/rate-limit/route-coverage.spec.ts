import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { RATE_LIMIT_KEY } from './rate-limit.decorator';
import { POLICY_NAMES } from './policies';

interface Route {
  id: string;
  isPublic: boolean;
  policy: string | undefined;
}

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return controllerFiles(full);
    return name.endsWith('.controller.ts') ? [full] : [];
  });
}

/** Every route the API serves, read from Nest's own decorator metadata, without booting the app. */
function routes(): Route[] {
  const out: Route[] = [];
  for (const file of controllerFiles(join(__dirname, '..'))) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(file) as Record<string, unknown>;
    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function' || Reflect.getMetadata(PATH_METADATA, exported) === undefined) continue;
      const cls = exported as { prototype: Record<string, unknown> };
      const base = String(Reflect.getMetadata(PATH_METADATA, cls));
      for (const name of Object.getOwnPropertyNames(cls.prototype)) {
        const handler = cls.prototype[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
        const path = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
        out.push({
          id: `${base}/${path}`.replace(/\/+$/, '').replace(/\/{2,}/g, '/'),
          isPublic: Boolean(Reflect.getMetadata(IS_PUBLIC_KEY, handler) ?? Reflect.getMetadata(IS_PUBLIC_KEY, cls)),
          policy: (Reflect.getMetadata(RATE_LIMIT_KEY, handler) ?? Reflect.getMetadata(RATE_LIMIT_KEY, cls)) as string | undefined,
        });
      }
    }
  }
  return out;
}

describe('rate-limit route coverage', () => {
  const all = routes();

  it('finds the API routes', () => {
    expect(all.length).toBeGreaterThan(50);
  });

  it('names only policies that exist', () => {
    const unknown = all.filter((r) => r.policy !== undefined && !(POLICY_NAMES as readonly string[]).includes(r.policy));
    expect(unknown).toEqual([]);
  });

  it('gives every public route an explicit policy, so none silently inherits the signed-in default', () => {
    expect(all.filter((r) => r.isPublic && r.policy === undefined).map((r) => r.id)).toEqual([]);
  });

  it('puts the sign-in, reset and webhook routes under the policies the spec names', () => {
    const policyOf = (id: string) => all.find((r) => r.id === id)?.policy;
    expect(policyOf('auth/login')).toBe('auth.login');
    expect(policyOf('admin/auth/login')).toBe('auth.login');
    expect(policyOf('auth/register')).toBe('auth.register');
    expect(policyOf('auth/reset/request')).toBe('auth.reset');
    expect(policyOf('admin/auth/reset/request')).toBe('auth.reset');
    expect(policyOf('auth/reset/confirm')).toBe('auth.resetConfirm');
    expect(policyOf('admin/auth/reset/confirm')).toBe('auth.resetConfirm');
    // An invitation token is a credential like a reset code: guessing is limited the same way.
    expect(policyOf('admin/auth/invite')).toBe('auth.resetConfirm');
    expect(policyOf('admin/auth/invite/accept')).toBe('auth.resetConfirm');
    expect(policyOf('auth/refresh')).toBe('auth.refresh');
    expect(policyOf('auth/change-password')).toBe('auth.changePassword');
    expect(policyOf('admin/me/password')).toBe('auth.changePassword');
    expect(policyOf('webhooks/quidax')).toBe('webhooks');
    expect(policyOf('webhooks/payrep')).toBe('webhooks');
    expect(policyOf('health')).toBe('public');
    expect(policyOf('giftcards/catalogue')).toBe('public');
  });
});
