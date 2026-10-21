import { RailTransferHooks } from './rail-transfer-hooks';

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
});
