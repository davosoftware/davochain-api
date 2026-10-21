/**
 * TEST ONLY. A tiny in-memory stand-in for the Prisma calls the Advanced code
 * makes, so the runner, approver and review service can be tested end to end
 * without Postgres. Real concurrency is proved by scripts/prove-kyc-advanced.ts.
 */
type Rec = Record<string, unknown>;

function cmp(val: unknown, op: string, bound: unknown): boolean {
  const a = val instanceof Date ? val.getTime() : (val as number);
  const b = bound instanceof Date ? bound.getTime() : (bound as number);
  if (val === null || val === undefined) return false;
  return op === 'lt' ? a < b : op === 'lte' ? a <= b : op === 'gt' ? a > b : a >= b;
}

export function matches(row: Rec, where: Rec | undefined): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (v === undefined) continue;
    const val = row[k];
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      const cond = v as Rec;
      if ('in' in cond && !(cond.in as unknown[]).includes(val)) return false;
      if ('not' in cond && (cond.not === null ? val !== null && val !== undefined : val === cond.not)) return false;
      for (const op of ['lt', 'lte', 'gt', 'gte']) if (op in cond && !cmp(val, op, cond[op])) return false;
      continue;
    }
    if ((val ?? null) !== v) return false;
  }
  return true;
}

function apply(row: Rec, data: Rec): void {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && 'increment' in (v as Rec)) {
      row[k] = ((row[k] as number) ?? 0) + ((v as Rec).increment as number);
    } else {
      row[k] = v;
    }
  }
  row.updatedAt = new Date();
}

export function table(rows: Rec[] = []) {
  return {
    rows,
    findUnique: jest.fn(async ({ where }: { where: Rec }) => rows.find((r) => matches(r, where)) ?? null),
    findUniqueOrThrow: jest.fn(async ({ where }: { where: Rec }) => {
      const r = rows.find((x) => matches(x, where));
      if (!r) throw new Error(`not found: ${JSON.stringify(where)}`);
      return r;
    }),
    findFirst: jest.fn(async ({ where, orderBy }: { where?: Rec; orderBy?: Rec } = {}) => {
      const found = rows.filter((r) => matches(r, where));
      if (orderBy?.createdAt === 'desc') found.sort((a, b) => +(b.createdAt as Date) - +(a.createdAt as Date));
      if (orderBy?.createdAt === 'asc') found.sort((a, b) => +(a.createdAt as Date) - +(b.createdAt as Date));
      return found[0] ?? null;
    }),
    findMany: jest.fn(async ({ where, take }: { where?: Rec; take?: number } = {}) => rows.filter((r) => matches(r, where)).slice(0, take ?? Infinity)),
    count: jest.fn(async ({ where }: { where?: Rec } = {}) => rows.filter((r) => matches(r, where)).length),
    create: jest.fn(async ({ data }: { data: Rec }) => {
      const r = { id: `id${rows.length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...data };
      rows.push(r);
      return r;
    }),
    update: jest.fn(async ({ where, data }: { where: Rec; data: Rec }) => {
      const r = rows.find((x) => matches(x, where));
      if (!r) throw new Error(`update: not found ${JSON.stringify(where)}`);
      apply(r, data);
      return r;
    }),
    updateMany: jest.fn(async ({ where, data }: { where: Rec; data: Rec }) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => apply(r, data));
      return { count: hit.length };
    }),
  };
}

/** A database with the Advanced tables. `$transaction(fn)` runs fn on the same object. */
export function fakeDb(seed: Partial<Record<'advancedVerification' | 'kycDocument' | 'user' | 'kycProfile' | 'kycVerification' | 'refreshToken' | 'adminAuditLog', Rec[]>> = {}) {
  const db = {
    advancedVerification: table(seed.advancedVerification),
    kycDocument: table(seed.kycDocument),
    user: table(seed.user),
    kycProfile: table(seed.kycProfile),
    kycVerification: table(seed.kycVerification),
    refreshToken: table(seed.refreshToken),
    adminAuditLog: table(seed.adminAuditLog),
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(db)),
    $executeRaw: jest.fn(async () => 1),
  };
  return db;
}
