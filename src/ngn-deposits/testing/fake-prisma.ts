import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';

/**
 * An in-memory stand-in for PrismaService, for unit tests of the naira-deposit
 * services. It implements only what those services call: a handful of models,
 * the common where operators with SQL's NULL rules, unique keys that fail with
 * Prisma's own P2002, and `serializable` / callback-form `$transaction` that
 * roll every table back when the callback throws (the array form cannot: its
 * operations have already run). Anything else fails loudly, so a test cannot
 * pass by accident. Never imported by production code.
 */
export type Row = Record<string, unknown>;

/** The Prisma call arguments the fake understands. `select` and `include` are ignored: whole rows come back. */
interface Args {
  where?: unknown;
  data?: Row;
  create?: Row;
  update?: Row;
  orderBy?: unknown;
  take?: number;
  skip?: number;
  select?: unknown;
  include?: unknown;
}

interface ModelSpec {
  unique: string[][];
  autoId: boolean;
  decimals: string[];
  defaults: () => Row;
}

const MODELS = {
  user: {
    unique: [['id'], ['email']],
    autoId: true,
    decimals: [],
    defaults: () => ({ status: 'ACTIVE', kycTier: 'TIER_0', kycStatus: 'NOT_STARTED', amlStatus: 'NOT_SCREENED', isTest: false, phone: null }),
  },
  kycProfile: {
    unique: [['id'], ['userId']],
    autoId: true,
    decimals: [],
    defaults: () => ({
      tier: 'TIER_0', status: 'NOT_STARTED', bvnHash: null, bvnLast4: null, ninHash: null, ninLast4: null,
      addressLine: null, city: null, state: null, lga: null, postcode: null, stateOfOrigin: null, country: 'NG', rejectionReason: null,
    }),
  },
  virtualAccount: {
    unique: [['id'], ['orderRef']],
    autoId: true,
    decimals: [],
    defaults: () => ({
      provider: 'FLUTTERWAVE', orderRef: null, flwRef: null, identityType: null, isPrimary: false,
      desiredStatus: 'ACTIVE', providerStatus: null, lastSyncedAt: null, syncError: null, syncFailures: 0,
    }),
  },
  virtualAccountRequest: {
    unique: [['userId']],
    autoId: false,
    decimals: [],
    defaults: () => ({ stateSince: new Date(), windowStartedAt: null, attemptsInWindow: 0, lastError: null }),
  },
  flutterwaveCollection: {
    unique: [['id'], ['flwTransactionId'], ['transactionId']],
    autoId: true,
    decimals: ['amount', 'chargedAmount', 'appFee', 'merchantFee', 'amountSettled', 'settlementAmount'],
    defaults: () => ({
      txRef: null, flwRef: null, virtualAccountNumber: null, amount: null, chargedAmount: null, appFee: null,
      merchantFee: null, amountSettled: null, currency: null, paymentType: null, providerStatus: null,
      payerName: null, payerBankName: null, payerBankCode: null, payerAccountMasked: null,
      providerCreatedAt: null, outcome: 'UNVERIFIED', previousOutcome: null, userId: null, transactionId: null,
      firstSeenAt: new Date(), lastCheckedAt: null, checkCount: 0, webhookHint: null, settlementId: null,
      settlementStatus: null, settlementAmount: null, settledAt: null, assignedBy: null, assignReason: null,
    }),
  },
  transaction: {
    unique: [['id'], ['reference']],
    autoId: true,
    decimals: ['fromAmount', 'toAmount', 'usdValue', 'providerFee', 'providerSettledAmount', 'feeAmount'],
    defaults: () => ({
      status: 'PENDING', provider: 'QUIDAX', providerRef: null, providerFee: null, providerSettledAmount: null,
      counterpartyName: null, counterpartyBank: null, counterpartyAccountMasked: null, nameMismatch: false,
      failureReason: null, completedAt: null, usdValue: null, fromAsset: null, fromAmount: null,
      toAsset: null, toAmount: null, quidaxRef: null,
    }),
  },
  webhookEvent: {
    unique: [['id'], ['dedupHash']],
    autoId: true,
    decimals: [],
    defaults: () => ({ receivedAt: new Date(), processedAt: null, attempts: 0, lastError: null }),
  },
  alert: {
    unique: [['id']],
    autoId: true,
    decimals: [],
    defaults: () => ({ assetCode: null, threshold: null, sentAt: new Date() }),
  },
  alertRecipient: {
    unique: [['id'], ['type', 'email']],
    autoId: true,
    decimals: [],
    defaults: () => ({ enabled: true }),
  },
  adminAuditLog: {
    unique: [['id']],
    autoId: true,
    decimals: [],
    defaults: () => ({ entityId: null, before: null, after: null, ip: null, createdAt: new Date() }),
  },
  kycVerification: {
    unique: [['id'], ['activeFor']],
    autoId: true,
    decimals: [],
    defaults: () => ({
      state: 'CREATED', activeFor: null, typedMiddleName: null, recordFirstName: null, recordMiddleName: null,
      recordLastName: null, recordDateOfBirth: null, recordGender: null, recordUsable: null, match: null,
      reviewReason: null, providerCustomerRef: null, lookupOutcome: null, lookupHttpStatus: null,
      lookupStartedAt: null, lookupCompletedAt: null, possiblyCharged: false, failureReason: null,
      screeningId: null, decidedBy: null, decidedAt: null, decisionReason: null,
    }),
  },
  amlScreening: {
    unique: [['id'], ['userId', 'inputFingerprint']],
    autoId: true,
    decimals: [],
    defaults: () => ({
      status: 'PENDING', matchStatus: null, riskLevel: null, entityId: null, matches: null, category: null,
      callOutcome: null, sendCount: 0, unknownCount: 0, definiteFailCount: 0, nextAttemptAt: null,
      screenStartedAt: null, screenCompletedAt: null, possibleDuplicateCharge: false, lastError: null,
    }),
  },
  amlReviewCase: {
    unique: [['id'], ['screeningId']],
    autoId: true,
    decimals: [],
    defaults: () => ({
      status: 'OPEN', possible: false, riskLevel: null, entityId: null, matches: null, rescreenCount: 0,
      rescreenResult: null, proposedBy: null, proposedAt: null, proposalReason: null, confirmedBy: null,
      confirmedAt: null, decidedBy: null, decidedAt: null, reason: null, reportedToAuthority: null,
      reportReference: null, reportedAt: null,
    }),
  },
  adminUser: {
    unique: [['id'], ['email']],
    autoId: true,
    decimals: [],
    defaults: () => ({ isActive: true, role: 'SUB_ADMIN', permissions: [] }),
  },
  refreshToken: {
    unique: [['id']],
    autoId: true,
    decimals: [],
    defaults: () => ({ revokedAt: null }),
  },
} satisfies Record<string, ModelSpec>;

export type ModelName = keyof typeof MODELS;

const OPERATORS = new Set(['equals', 'not', 'in', 'notIn', 'lt', 'lte', 'gt', 'gte', 'startsWith', 'endsWith', 'contains', 'mode']);
const ATOMIC = new Set(['increment', 'decrement', 'set']);

function isPlain(v: unknown): v is Row {
  return v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
}

function isOperatorObject(v: unknown): v is Row {
  return isPlain(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => OPERATORS.has(k));
}

function isDecimalLike(v: unknown): boolean {
  return v !== null && typeof v === 'object' && typeof (v as { toFixed?: unknown }).toFixed === 'function';
}

function scalar(v: unknown): unknown {
  if (v === undefined) return null;
  if (v instanceof Date) return v.getTime();
  if (isDecimalLike(v)) return new Prisma.Decimal(String(v)).toFixed();
  return v;
}

function same(a: unknown, b: unknown): boolean {
  return scalar(a) === scalar(b);
}

function toDecimal(v: unknown): Prisma.Decimal | null {
  try {
    return new Prisma.Decimal(String(v));
  } catch {
    return null;
  }
}

function cmp(a: unknown, b: unknown): number {
  const x = scalar(a);
  const y = scalar(b);
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  const dx = toDecimal(x);
  const dy = toDecimal(y);
  if (dx && dy) return dx.cmp(dy);
  return String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
}

function matchValue(value: unknown, cond: unknown): boolean {
  if (!isOperatorObject(cond)) return same(value, cond);
  // Check for unsupported operators first, before any matching logic
  for (const op of Object.keys(cond)) {
    if (op === 'mode') throw new Error('FakePrisma: mode (case-insensitive matching) is not supported');
  }
  const isNull = value === null || value === undefined;
  for (const [op, arg] of Object.entries(cond)) {
    switch (op) {
      case 'equals':
        if (!same(value, arg)) return false;
        break;
      case 'not':
        if (arg === null) {
          if (isNull) return false;
        } else if (isNull || matchValue(value, arg)) {
          return false;
        }
        break;
      case 'in':
        if (isNull || !(arg as unknown[]).some((x) => same(value, x))) return false;
        break;
      case 'notIn':
        if (isNull || (arg as unknown[]).some((x) => same(value, x))) return false;
        break;
      case 'lt':
        if (isNull || !(cmp(value, arg) < 0)) return false;
        break;
      case 'lte':
        if (isNull || !(cmp(value, arg) <= 0)) return false;
        break;
      case 'gt':
        if (isNull || !(cmp(value, arg) > 0)) return false;
        break;
      case 'gte':
        if (isNull || !(cmp(value, arg) >= 0)) return false;
        break;
      case 'startsWith':
        if (typeof value !== 'string' || !value.startsWith(String(arg))) return false;
        break;
      case 'endsWith':
        if (typeof value !== 'string' || !value.endsWith(String(arg))) return false;
        break;
      case 'contains':
        if (typeof value !== 'string' || !value.includes(String(arg))) return false;
        break;
      case 'mode':
        // Already checked above, but keep this for completeness
        break;
    }
  }
  return true;
}

export function matchesWhere(row: Row, where: unknown): boolean {
  if (where === undefined || where === null) return true;
  if (!isPlain(where)) throw new Error('FakePrisma: where must be a plain object');
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue; // Prisma ignores undefined filters
    if (key === 'NOT') {
      throw new Error('FakePrisma: NOT is not supported (its NULL handling differs from SQL); use { field: { not: … } }');
    }
    if (key === 'AND') {
      const list = Array.isArray(cond) ? cond : [cond];
      if (!list.every((w) => matchesWhere(row, w))) return false;
      continue;
    }
    if (key === 'OR') {
      if (!(cond as unknown[]).some((w) => matchesWhere(row, w))) return false;
      continue;
    }
    // Prisma's compound-unique form, e.g. { userId_inputFingerprint: { userId, inputFingerprint } }.
    if (isPlain(cond) && !isOperatorObject(cond) && key.includes('_') && !(key in row)) {
      if (!matchesWhere(row, cond)) return false;
      continue;
    }
    if (!matchValue(row[key], cond)) return false;
  }
  return true;
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  if (!orderBy) return rows;
  const list = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, 'asc' | 'desc'>>;
  return [...rows].sort((a, b) => {
    for (const entry of list) {
      const [field, dir] = Object.entries(entry)[0];
      const av = a[field];
      const bv = b[field];
      if ((av === null || av === undefined) && (bv === null || bv === undefined)) continue;
      // Postgres: NULLS LAST for ASC, NULLS FIRST for DESC.
      if (av === null || av === undefined) return dir === 'asc' ? 1 : -1;
      if (bv === null || bv === undefined) return dir === 'asc' ? -1 : 1;
      const c = cmp(av, bv);
      if (c !== 0) return dir === 'asc' ? c : -c;
    }
    return 0;
  });
}

export function p2002(target: string[] = ['reference']): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the fields: (${target.join(',')})`,
    { code: 'P2002', clientVersion: 'fake', meta: { target } },
  );
}

function p2025(model: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`No ${model} record was found for an update.`, {
    code: 'P2025',
    clientVersion: 'fake',
  });
}

class FakeModel {
  constructor(
    private readonly db: FakePrisma,
    private readonly name: ModelName,
  ) {}

  private get table(): Row[] {
    return this.db.table(this.name);
  }

  private get spec(): ModelSpec {
    return MODELS[this.name];
  }

  async findUnique(args: Args): Promise<Row | null> {
    this.db.hook(this.name, 'findUnique');
    const row = this.table.find((r) => matchesWhere(r, args.where));
    return row ? { ...row } : null;
  }

  async findUniqueOrThrow(args: Args): Promise<Row> {
    this.db.hook(this.name, 'findUniqueOrThrow');
    const row = this.table.find((r) => matchesWhere(r, args.where));
    if (!row) throw p2025(this.name);
    return { ...row };
  }

  async findFirst(args: Args = {}): Promise<Row | null> {
    this.db.hook(this.name, 'findFirst');
    const rows = sortRows(this.table.filter((r) => matchesWhere(r, args.where)), args.orderBy);
    return rows[0] ? { ...rows[0] } : null;
  }

  async findMany(args: Args = {}): Promise<Row[]> {
    this.db.hook(this.name, 'findMany');
    let rows = sortRows(this.table.filter((r) => matchesWhere(r, args.where)), args.orderBy);
    if (args.skip) rows = rows.slice(Number(args.skip));
    if (args.take !== undefined) rows = rows.slice(0, Number(args.take));
    return rows.map((r) => ({ ...r }));
  }

  async count(args: Args = {}): Promise<number> {
    this.db.hook(this.name, 'count');
    return this.table.filter((r) => matchesWhere(r, args.where)).length;
  }

  async create(args: Args): Promise<Row> {
    this.db.hook(this.name, 'create');
    return this.insert(args.data ?? {});
  }

  async update(args: Args): Promise<Row> {
    this.db.hook(this.name, 'update');
    return this.change(args.where, args.data ?? {});
  }

  async updateMany(args: Args): Promise<{ count: number }> {
    this.db.hook(this.name, 'updateMany');
    this.db.recordWrite(args.data);
    let count = 0;
    for (const row of this.table) {
      if (!matchesWhere(row, args.where)) continue;
      const next = this.apply({ ...row }, args.data ?? {});
      this.assertUnique(next, row);
      Object.assign(row, next);
      count++;
    }
    return { count };
  }

  /** Like Prisma: removes the one matching row and returns it, or throws P2025. */
  async delete(args: Args): Promise<Row> {
    this.db.hook(this.name, 'delete');
    const at = this.table.findIndex((r) => matchesWhere(r, args.where));
    if (at < 0) throw p2025(this.name);
    const [row] = this.table.splice(at, 1);
    return { ...row };
  }

  async upsert(args: Args): Promise<Row> {
    this.db.hook(this.name, 'upsert');
    const exists = this.table.some((r) => matchesWhere(r, args.where));
    return exists ? this.change(args.where, args.update ?? {}) : this.insert(args.create ?? {});
  }

  private insert(data: Row): Row {
    this.db.recordWrite(data);
    const now = new Date();
    const row: Row = { ...this.spec.defaults(), createdAt: now, updatedAt: now };
    if (this.spec.autoId) row.id = randomUUID();
    this.apply(row, data);
    this.assertUnique(row, null);
    this.table.push(row);
    return { ...row };
  }

  private change(where: unknown, data: Row): Row {
    this.db.recordWrite(data);
    const row = this.table.find((r) => matchesWhere(r, where));
    if (!row) throw p2025(this.name);
    const next = this.apply({ ...row }, data);
    this.assertUnique(next, row);
    Object.assign(row, next);
    return { ...row };
  }

  private apply(row: Row, data: Row): Row {
    for (const [key, value] of Object.entries(data ?? {})) {
      if (value === undefined) continue;
      if (isPlain(value) && Object.keys(value).length === 1 && ATOMIC.has(Object.keys(value)[0])) {
        const [op, arg] = Object.entries(value)[0];
        if (this.spec.decimals.includes(key)) {
          // Decimal arithmetic for decimal columns
          if (op === 'set') {
            row[key] = new Prisma.Decimal(String(arg));
          } else if (op === 'increment') {
            row[key] = new Prisma.Decimal(String(row[key] ?? 0)).plus(String(arg));
          } else {
            row[key] = new Prisma.Decimal(String(row[key] ?? 0)).minus(String(arg));
          }
        } else {
          // Number arithmetic for non-decimal columns
          if (op === 'set') row[key] = arg;
          else if (op === 'increment') row[key] = Number(row[key] ?? 0) + Number(arg);
          else row[key] = Number(row[key] ?? 0) - Number(arg);
        }
      } else if (this.spec.decimals.includes(key) && value !== null) {
        row[key] = new Prisma.Decimal(String(value));
      } else {
        row[key] = value;
      }
    }
    row.updatedAt = new Date();
    return row;
  }

  private assertUnique(candidate: Row, self: Row | null): void {
    for (const columns of this.spec.unique) {
      if (columns.some((c) => candidate[c] === null || candidate[c] === undefined)) continue; // NULLs never collide
      const clash = this.table.find((r) => r !== self && columns.every((c) => same(r[c], candidate[c])));
      if (clash) throw p2002(columns);
    }
  }
}

export class FakePrisma {
  private tables = new Map<string, Row[]>();
  private readonly writes: unknown[] = [];
  private readonly failures: Array<{ model: string; op: string; error: unknown }> = [];

  readonly user = new FakeModel(this, 'user');
  readonly kycProfile = new FakeModel(this, 'kycProfile');
  readonly virtualAccount = new FakeModel(this, 'virtualAccount');
  readonly virtualAccountRequest = new FakeModel(this, 'virtualAccountRequest');
  readonly flutterwaveCollection = new FakeModel(this, 'flutterwaveCollection');
  readonly transaction = new FakeModel(this, 'transaction');
  readonly webhookEvent = new FakeModel(this, 'webhookEvent');
  readonly alert = new FakeModel(this, 'alert');
  readonly alertRecipient = new FakeModel(this, 'alertRecipient');
  readonly adminAuditLog = new FakeModel(this, 'adminAuditLog');
  readonly kycVerification = new FakeModel(this, 'kycVerification');
  readonly amlScreening = new FakeModel(this, 'amlScreening');
  readonly amlReviewCase = new FakeModel(this, 'amlReviewCase');
  readonly refreshToken = new FakeModel(this, 'refreshToken');
  readonly adminUser = new FakeModel(this, 'adminUser');

  /** Raw SQL the code under test ran (advisory locks and the like): recorded, not executed. */
  readonly rawCalls: string[] = [];
  async $executeRaw(strings: TemplateStringsArray, ..._values: unknown[]): Promise<number> {
    this.rawCalls.push(strings.join('?'));
    return 0;
  }
  async $queryRaw<T = unknown>(strings: TemplateStringsArray, ..._values: unknown[]): Promise<T> {
    this.rawCalls.push(strings.join('?'));
    return [{ ok: 1 }] as T;
  }

  table(name: string): Row[] {
    let rows = this.tables.get(name);
    if (!rows) {
      rows = [];
      this.tables.set(name, rows);
    }
    return rows;
  }

  /** Copies of the stored rows, for assertions. */
  rows(name: ModelName): Row[] {
    return this.table(name).map((r) => ({ ...r }));
  }

  /** Every data object handed to a write, in order — for "this value was never stored" checks. */
  allWrites(): unknown[] {
    return [...this.writes];
  }

  recordWrite(data: unknown): void {
    this.writes.push(data);
  }

  /** Make the next `op` on `model` throw `error`. */
  failNext(model: ModelName, op: string, error: unknown): void {
    this.failures.push({ model, op, error });
  }

  hook(model: string, op: string): void {
    const i = this.failures.findIndex((f) => f.model === model && f.op === op);
    if (i >= 0) {
      const [failure] = this.failures.splice(i, 1);
      throw failure.error;
    }
  }

  async serializable<T>(fn: (tx: FakePrisma) => Promise<T>): Promise<T> {
    return this.atomically(fn);
  }

  async $transaction(arg: ((tx: FakePrisma) => Promise<unknown>) | Array<Promise<unknown>>): Promise<unknown> {
    // Array form cannot roll back: its operations have already run. Only callback form is atomic.
    if (Array.isArray(arg)) return Promise.all(arg);
    return this.atomically(arg);
  }

  private async atomically<T>(fn: (tx: FakePrisma) => Promise<T>): Promise<T> {
    const snapshot = new Map([...this.tables].map(([name, rows]) => [name, rows.map((r) => ({ ...r }))]));
    try {
      return await fn(this);
    } catch (err) {
      this.tables = snapshot;
      throw err;
    }
  }
}
