import { Prisma, TxStatus } from '@prisma/client';

/** A transaction that is still in flight. Only these may be closed. */
export const OPEN_STATUSES: TxStatus[] = [TxStatus.PENDING, TxStatus.PROCESSING, TxStatus.RECONCILING];

/**
 * Close a transaction, but only from an open state, inside the caller's write
 * (PROJECT_REVIEW H6).
 *
 * Call it FIRST in the serializable closure, before any ledger movement, and
 * move money only when it returns true. A webhook, its re-delivery and the
 * reconciler can race to finish the same transaction; exactly one of them
 * moves the row, and the others see false and leave the money alone. If the
 * closure fails afterwards, the status change rolls back with it.
 */
export async function closeOpen(
  t: Prisma.TransactionClient,
  id: string,
  data: Prisma.TransactionUpdateManyMutationInput,
): Promise<boolean> {
  const { count } = await t.transaction.updateMany({ where: { id, status: { in: OPEN_STATUSES } }, data });
  return count === 1;
}
