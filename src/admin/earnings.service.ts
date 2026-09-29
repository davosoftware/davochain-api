import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Decimal, dec } from '../common/money';

/**
 * Which ladder earned it.
 *
 * Deliberately the same four names as FeeKind: every earning on this screen was
 * produced by one of the four fee ladders an admin can edit, and calling them
 * anything else would invite the question of which ladder to change.
 */
export type EarningKind = 'RATE' | 'SWAP' | 'WITHDRAWAL' | 'NGN_WITHDRAWAL' | 'GIFT_CARD';

/** The currency the fee was CHARGED in — never converted, never blended. */
export type EarningCurrency = 'NGN' | 'USD';

export interface EarningQuery {
  kind?: EarningKind;
  currency?: EarningCurrency;
  /** BUY | SELL | SWAP | WITHDRAWAL — narrows within a ladder. */
  type?: string;
  search?: string;
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
  sort?: 'createdAt' | 'fee';
  direction?: 'asc' | 'desc';
}

export interface EarningRow {
  id: string;
  reference: string;
  kind: EarningKind;
  type: string;
  currency: EarningCurrency;
  /** What the platform kept. The earning itself. */
  fee: string;
  /** What reached the user, in the fee's currency. */
  amount: string;
  /** amount + fee — what the trade was worth gross. */
  total: string;
  fromAsset: string | null;
  toAsset: string | null;
  userId: string;
  name: string;
  email: string;
  createdAt: string;
}

export interface EarningTotals {
  count: number;
  ngn: string;
  usd: string;
}

/**
 * One database row as the dashboard reads it.
 *
 * `amount` is DERIVED rather than selected, so it can never contradict the two
 * figures beside it: what reached the user is always the gross less what we
 * kept, whichever side of the trade the fee was taken from. A buyer pays gross
 * and receives net; a seller is credited net. Both land here as the same three
 * numbers that add up.
 */
export function toRow(r: RawRow): EarningRow {
  /*
   * Rounded BEFORE the subtraction, not after.
   *
   * The rate fee is a product of two 18-decimal columns, so it routinely has
   * more precision than money does. Rounding the fee and the amount separately
   * lets each land on a different side of a half-kobo and the row stops adding
   * up — ₦396,718.63 + ₦3,281.38 = ₦400,000.01 against a total of ₦400,000.00,
   * which is a screen telling an admin that arithmetic does not work.
   *
   * Taking the difference of the two ROUNDED figures makes the three columns
   * consistent by construction. Nothing is lost: the totals under the tabs are
   * summed in the database at full precision, independently of this.
   */
  const fee = dec(r.fee).toDecimalPlaces(2);
  const total = dec(r.total).toDecimalPlaces(2);

  return {
    id: r.id,
    reference: r.reference,
    kind: r.kind,
    type: r.type,
    currency: r.currency,
    fee: fee.toFixed(2),
    amount: total.minus(fee).toFixed(2),
    total: total.toFixed(2),
    fromAsset: r.fromAsset,
    toAsset: r.toAsset,
    userId: r.userId,
    name: `${r.firstName} ${r.lastName}`.trim(),
    email: r.email,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Big enough for a year of trading, small enough not to fell the server. */
const MAX_EXPORT = 10_000;
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 200;

/**
 * A typed search term, with its LIKE wildcards made literal.
 *
 * The wildcards belong to us, not to whoever is typing. An unescaped '%' or '_'
 * in the box would quietly match everything, which looks like a broken filter
 * rather than a search for a literal underscore — and every transaction
 * reference contains one, so this is a term people really do type.
 *
 * The backslash has to be escaped first, or escaping the wildcards would
 * produce backslashes this then reads as escapes of its own.
 *
 * Backslash is what Postgres uses to escape a LIKE pattern by default, which is
 * why this also works through Prisma's `contains` — Prisma does not escape
 * anything itself, so without this a search for '%' returns every row there is.
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The same term as a full ILIKE pattern, for hand-written SQL. */
export function searchPattern(term: string): string {
  return `%${escapeLike(term)}%`;
}

export interface RawRow {
  id: string;
  reference: string;
  kind: EarningKind;
  type: string;
  currency: EarningCurrency;
  fee: Prisma.Decimal;
  // No `amount` — the query does not select one. It is derived in toRow(), so
  // there is no second copy that could disagree with fee and total.
  total: Prisma.Decimal;
  fromAsset: string | null;
  toAsset: string | null;
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  createdAt: Date;
}

/**
 * Every fee the platform has earned, one row per transaction that produced one.
 *
 * There is no earnings table, and deliberately so. An earning is not a separate
 * event — it is a column on the trade that generated it, and a second table
 * would be a copy that can drift from the thing it copies. The dashboard's four
 * Earnings figures are aggregates over exactly these columns, so this screen and
 * that card are two readings of one source and cannot disagree.
 *
 * Raw SQL rather than Prisma because the rate fee is a PRODUCT of two stored
 * columns (the trade's dollar size times the naira gate that was live when it
 * settled) which no aggregate helper can express, and because filtering and
 * paging on a computed column has to happen in the database — pulling every
 * trade into Node to add them up is the query this replaces.
 *
 * Only COMPLETED transactions. A pending trade has earned nothing yet and a
 * failed one earned nothing ever; counting either would make this screen
 * disagree with the ledger.
 */
@Injectable()
export class EarningsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every completed transaction that produced a fee, with the fee worked out.
   *
   * One transaction yields at most one earning, so this is a projection rather
   * than a union — there is no way for a trade to appear twice.
   *
   * The four CASE arms are the four ladders, in the order they are tested:
   * BUY/SELL first (a buy also has fromAsset 'ngn', so it must be claimed
   * before the naira-withdrawal arm can see it), then SWAP, then the two
   * withdrawals split on whether naira or a coin left.
   */
  private base(): Prisma.Sql {
    return Prisma.sql`
      SELECT
        t."id",
        t."reference",
        t."type"::text AS "type",
        t."fromAsset",
        t."toAsset",
        t."createdAt",
        t."userId",
        u."firstName",
        u."lastName",
        u."email",

        CASE
          WHEN t."type" IN ('BUY', 'SELL') THEN 'RATE'
          WHEN t."type" = 'SWAP' THEN 'SWAP'
          WHEN t."type" = 'GIFT_CARD' THEN 'GIFT_CARD'
          WHEN t."type" = 'WITHDRAWAL' AND t."fromAsset" = 'ngn' THEN 'NGN_WITHDRAWAL'
          ELSE 'WITHDRAWAL'
        END AS "kind",

        CASE
          WHEN t."type" IN ('BUY', 'SELL') THEN 'NGN'
          WHEN t."type" = 'WITHDRAWAL' AND t."fromAsset" = 'ngn' THEN 'NGN'
          WHEN t."type" = 'GIFT_CARD' THEN 'NGN'
          ELSE 'USD'
        END AS "currency",

        -- What we kept. On a buy or sell it is folded into the rate and has to
        -- be reconstructed; everywhere else it was charged as a line and stored.
        CASE
          WHEN t."type" IN ('BUY', 'SELL') THEN t."usdValue" * t."gateApplied"
          WHEN t."type" = 'WITHDRAWAL' AND t."fromAsset" = 'ngn' THEN t."feeAmount"
          WHEN t."type" = 'GIFT_CARD' THEN t."feeAmount"
          ELSE t."feeUsd"
        END AS "fee",

        -- What the trade was worth gross, in the fee's own currency. Which
        -- stored column that is depends on which side the fee came off:
        -- a buyer pays gross and receives net, a seller is credited net.
        CASE
          WHEN t."type" = 'BUY' THEN t."fromAmount"
          WHEN t."type" = 'SELL' THEN t."toAmount" + (t."usdValue" * t."gateApplied")
          WHEN t."type" = 'SWAP' THEN t."usdValue"
          WHEN t."type" = 'WITHDRAWAL' AND t."fromAsset" = 'ngn' THEN t."fromAmount"
          -- What the desk got for the card: what the user was paid plus the margin.
          WHEN t."type" = 'GIFT_CARD' THEN t."toAmount" + t."feeAmount"
          ELSE t."usdValue" + t."feeUsd"
        END AS "total"

      FROM "transactions" t
      JOIN "users" u ON u."id" = t."userId"
      WHERE t."status" = 'COMPLETED'
        AND (
          -- A fee of exactly zero is not an earning. It contributes nothing to
          -- any total, so leaving it out changes no figure — it only keeps the
          -- table free of rows that say the platform earned nothing.
          (
            t."type" IN ('BUY', 'SELL')
            AND t."usdValue" IS NOT NULL
            AND t."gateApplied" IS NOT NULL
            AND t."usdValue" * t."gateApplied" > 0
          )
          OR (t."type" = 'SWAP' AND t."feeUsd" > 0)
          OR (t."type" = 'WITHDRAWAL' AND t."fromAsset" = 'ngn' AND t."feeAmount" > 0)
          OR (
            t."type" = 'WITHDRAWAL'
            AND t."fromAsset" IS DISTINCT FROM 'ngn'
            AND t."feeUsd" > 0
          )
          -- A gift card margin can be NEGATIVE when the desk cleared a card
          -- below the rate quoted, and that is exactly the number somebody
          -- needs to see. <> 0 rather than > 0.
          OR (t."type" = 'GIFT_CARD' AND t."feeAmount" IS NOT NULL AND t."feeAmount" <> 0)
        )
    `;
  }

  /**
   * The filters, as clauses over the projection above.
   *
   * `kind` and `currency` are computed columns, which is why this reads them
   * back off the CTE rather than restating the CASE arms — one definition of
   * what a swap fee is, not two that can drift apart.
   */
  private clauses(query: EarningQuery): Prisma.Sql {
    const parts: Prisma.Sql[] = [Prisma.sql`TRUE`];

    if (query.kind) parts.push(Prisma.sql`e."kind" = ${query.kind}`);
    if (query.currency) parts.push(Prisma.sql`e."currency" = ${query.currency}`);
    if (query.type) parts.push(Prisma.sql`e."type" = ${query.type}`);
    if (query.from) parts.push(Prisma.sql`e."createdAt" >= ${query.from}`);
    if (query.to) parts.push(Prisma.sql`e."createdAt" <= ${query.to}`);

    const term = query.search?.trim();
    if (term) {
      const pattern = searchPattern(term);
      parts.push(Prisma.sql`(
        e."email" ILIKE ${pattern} ESCAPE '\\'
        OR e."firstName" ILIKE ${pattern} ESCAPE '\\'
        OR e."lastName" ILIKE ${pattern} ESCAPE '\\'
        OR (e."firstName" || ' ' || e."lastName") ILIKE ${pattern} ESCAPE '\\'
        OR e."reference" ILIKE ${pattern} ESCAPE '\\'
      )`);
    }

    return Prisma.join(parts, ' AND ');
  }

  /**
   * Rows for one page.
   *
   * Sorting by fee across a mixed page ranks naira against dollars, so the
   * screen only offers it once a single currency is in view. The API still
   * honours the parameter — it is the caller's business what it means — but
   * nothing in the dashboard asks for it in that state.
   */
  async list(query: EarningQuery): Promise<{
    rows: EarningRow[];
    page: number;
    pageSize: number;
    total: number;
  }> {
    const pageSize = Math.min(Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const page = Math.max(query.page ?? 1, 1);

    const [rows, totals] = await Promise.all([
      this.rows(query, pageSize, (page - 1) * pageSize),
      this.totals(query),
    ]);

    return { rows, page, pageSize, total: totals.count };
  }

  /** Every matching row, for a CSV. Capped, and the caller is told if it hit. */
  async all(query: EarningQuery): Promise<{ rows: EarningRow[]; truncated: boolean }> {
    const rows = await this.rows(query, MAX_EXPORT + 1, 0);
    return {
      rows: rows.slice(0, MAX_EXPORT),
      truncated: rows.length > MAX_EXPORT,
    };
  }

  private async rows(query: EarningQuery, limit: number, offset: number): Promise<EarningRow[]> {
    const direction =
      query.direction === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
    // A fixed pair of fragments rather than an interpolated column name: there
    // is no string from the request anywhere near the ORDER BY.
    const column =
      query.sort === 'fee' ? Prisma.sql`e."fee"` : Prisma.sql`e."createdAt"`;

    const raw = await this.prisma.$queryRaw<RawRow[]>`
      WITH e AS (${this.base()})
      SELECT * FROM e
      WHERE ${this.clauses(query)}
      ORDER BY ${column} ${direction}, e."id" ASC
      LIMIT ${limit} OFFSET ${offset}
    `;

    return raw.map(toRow);
  }

  /**
   * What the matching rows add up to.
   *
   * Two sums, never one. The rate fee is naira folded into a naira trade and
   * the swap fee is a flat dollar charge on a trade with no naira leg at all;
   * adding them needs an exchange rate, and picking one would make today's rate
   * silently rewrite last month's earnings every time the page loads.
   */
  async totals(query: EarningQuery): Promise<EarningTotals> {
    const rows = await this.prisma.$queryRaw<
      { count: bigint; ngn: Prisma.Decimal; usd: Prisma.Decimal }[]
    >`
      WITH e AS (${this.base()})
      SELECT
        COUNT(*) AS "count",
        COALESCE(SUM(CASE WHEN e."currency" = 'NGN' THEN e."fee" ELSE 0 END), 0) AS "ngn",
        COALESCE(SUM(CASE WHEN e."currency" = 'USD' THEN e."fee" ELSE 0 END), 0) AS "usd"
      FROM e
      WHERE ${this.clauses(query)}
    `;

    const row = rows[0];
    return {
      count: Number(row?.count ?? 0),
      ngn: (row ? dec(row.ngn) : new Decimal(0)).toFixed(2),
      usd: (row ? dec(row.usd) : new Decimal(0)).toFixed(2),
    };
  }

  /**
   * The headline figures and what each ladder has earned.
   *
   * Scoped by date and tab-independent, so the four numbers beneath the tabs
   * stay put while somebody clicks between them — a count that moved every time
   * you changed tab would be telling you about the tab, not about the business.
   */
  async summary(query: EarningQuery): Promise<{
    all: EarningTotals;
    byKind: Record<EarningKind, EarningTotals>;
  }> {
    const kinds: EarningKind[] = ['RATE', 'SWAP', 'WITHDRAWAL', 'NGN_WITHDRAWAL', 'GIFT_CARD'];
    const scope: EarningQuery = { from: query.from, to: query.to };

    const [all, ...perKind] = await Promise.all([
      this.totals(scope),
      ...kinds.map((kind) => this.totals({ ...scope, kind })),
    ]);

    return {
      all,
      byKind: Object.fromEntries(kinds.map((k, i) => [k, perKind[i]])) as Record<
        EarningKind,
        EarningTotals
      >,
    };
  }
}
