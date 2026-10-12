import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

/** api/.env, read the way Nest does: a variable already set wins. */
export function envValue(name: string): string | undefined {
  if (process.env[name] !== undefined) return process.env[name];
  try {
    for (const line of readFileSync(join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    // no .env: only the process environment counts
  }
  return undefined;
}

/** Proof scripts write real rows: never against anything but a local development database. Prints no URL. */
export function refuseUnlessLocalDevelopment(): void {
  let host = '';
  try {
    host = new URL(envValue('DATABASE_URL') ?? '').hostname;
  } catch {
    host = '';
  }
  if (envValue('NODE_ENV') !== 'development' || !LOCAL_HOSTS.includes(host)) {
    console.error('Refusing: this proof writes real rows, so it runs only with NODE_ENV=development against a local database.');
    process.exit(1);
  }
}
