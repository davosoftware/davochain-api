/**
 * Proves that an admin cleared for the dashboard but not the desk is refused
 * the desk endpoints — which is the whole reason the dashboard now has to cope
 * without them.
 *
 * Creates a throwaway sub-admin, signs in as them, and deactivates it again.
 *
 * Run: npx ts-node --compiler-options {"module":"CommonJS"} scripts/prove-desk-permission.ts
 */
import { PrismaClient } from '@prisma/client';
import { PasswordService } from '../src/auth/password.service';

const API = 'http://localhost:3000/v1';
const EMAIL = 'desk-perm-probe@davochain.local';
const PASSWORD = 'Str0ng!Passw0rd#2026';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const passwords = new PasswordService();
  const passwordHash = await passwords.hash(PASSWORD);

  await prisma.adminUser.upsert({
    where: { email: EMAIL },
    create: {
      email: EMAIL,
      name: 'Desk permission probe',
      passwordHash,
      role: 'SUB_ADMIN',
      isActive: true,
      // The dashboard, and nothing of the desk.
      permissions: ['overview.view'],
    },
    update: { passwordHash, isActive: true, permissions: ['overview.view'] },
  });

  const login = await fetch(`${API}/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const body = (await login.json()) as { accessToken?: string; tokens?: { accessToken: string } };
  const token = body.accessToken ?? body.tokens?.accessToken;
  console.log(`login                          ${login.status}`);
  if (!token) {
    console.log(JSON.stringify(body).slice(0, 300));
    process.exit(1);
  }

  const headers = { authorization: `Bearer ${token}` };
  const routes = [
    ['/admin/me', 'their profile', 200],
    ['/admin/overview', 'the dashboard figures', 200],
    ['/admin/transactions?limit=8', 'recent activity', 403],
    ['/admin/inventory/fuel', 'the treasury gauge', 403],
    ['/admin/inventory', 'the inventory table', 403],
    ['/admin/reconciliation', 'drift', 403],
    // Each 403 above is a panel the dashboard must render without, not an
    // error to replace the whole page with.
  ] as const;

  let bad = 0;
  for (const [path, what, want] of routes) {
    const res = await fetch(`${API}${path}`, { headers });
    const ok = res.status === want;
    if (!ok) bad++;
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'} ${String(res.status).padEnd(4)} ${what.padEnd(24)} ${path}`,
    );
  }

  const me = (await (await fetch(`${API}/admin/me`, { headers })).json()) as {
    permissions: string[];
  };
  console.log(`\npermissions the dashboard sees: ${JSON.stringify(me.permissions)}`);
  console.log(`  overview.view  ${me.permissions.includes('overview.view')}`);
  console.log(`  inventory.view ${me.permissions.includes('inventory.view')}  <- gates the desk`);

  await prisma.adminUser.update({ where: { email: EMAIL }, data: { isActive: false } });
  await prisma.$disconnect();

  console.log(`\n${bad === 0 ? 'PASS' : `${bad} FAILED`}\n`);
  process.exit(bad === 0 ? 0 : 1);
}

void main();
