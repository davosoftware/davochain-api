import type { QuidaxWithdrawal } from '../quidax/quidax.types';
import type { RailTransfer } from './naira-rail';

/**
 * The rail's answer about a customer payout, in the shape the shared
 * withdrawal settle/refund path (SettlementService.applyWithdrawalWebhook)
 * reads. That path closes a withdrawal once and only once, whoever asks.
 */
export function railAsWithdrawal(t: RailTransfer): QuidaxWithdrawal {
  return {
    id: t.id,
    reference: t.reference,
    type: 'bank_account',
    currency: 'ngn',
    amount: '0',
    fee: t.fee?.toFixed() ?? '0',
    total: '0',
    txid: null,
    status: t.status,
    reason: t.reason,
  };
}

/** The settle path's event name for a finished rail transfer. */
export const railEvent = (t: RailTransfer) => (t.status === 'SUCCESSFUL' ? 'withdraw.successful' : 'withdraw.rejected');
