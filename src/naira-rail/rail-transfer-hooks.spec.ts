import { RailTransferHooks } from './rail-transfer-hooks';
import { parseFlutterwaveWebhook } from '../ngn-deposits/webhook-payload';

describe('A transfer webhook reaches whoever owns the reference', () => {
  it('the owner of the prefix is asked to re-check; a reference nobody owns is ignored', async () => {
    const hooks = new RailTransferHooks();
    const treasury = jest.fn(async () => undefined);
    hooks.on('trsy_', treasury);
    await hooks.dispatch('trsy_abc');
    await hooks.dispatch('someone_else');
    expect(treasury).toHaveBeenCalledTimes(1);
    expect(treasury).toHaveBeenCalledWith('trsy_abc');
  });

  it("the webhook's transfer reference is read from the body (only the reference: the rail is asked for the rest)", () => {
    const parsed = parseFlutterwaveWebhook({ event: 'transfer.completed', data: { id: 77, reference: 'trsy_abc', status: 'SUCCESSFUL', amount: 1000 } });
    expect(parsed.kind).toBe('TRANSFER');
    expect(parsed.transferReference).toBe('trsy_abc');
    expect(parseFlutterwaveWebhook({ event: 'charge.completed', data: { id: 5, reference: 'x' } }).transferReference).toBeNull();
  });
});
