import { BadRequestException } from '@nestjs/common';
import { AssetsService } from './assets.service';
import { dec } from '../common/money';

/** An amount outside the provider's transfer limits is the customer's to fix: 400, never 404 (FLUTTER_API Appendix F #12). */
describe('AssetsService.assertTransferable', () => {
  const svc = new AssetsService({} as never, {} as never);
  const btc = { code: 'btc', transferMin: '0.00015', transferMax: '5' } as never;

  it('below the minimum is a 400 naming the minimum', () => {
    const run = () => svc.assertTransferable(btc, dec('0.0001'));
    expect(run).toThrow(BadRequestException);
    expect(run).toThrow('Minimum BTC transfer is 0.00015');
  });

  it('above the maximum is a 400 naming the maximum', () => {
    const run = () => svc.assertTransferable(btc, dec('6'));
    expect(run).toThrow(BadRequestException);
    expect(run).toThrow('Maximum BTC transfer is 5');
  });

  it('exactly at either limit is allowed', () => {
    expect(() => svc.assertTransferable(btc, dec('0.00015'))).not.toThrow();
    expect(() => svc.assertTransferable(btc, dec('5'))).not.toThrow();
  });

  it('a coin with no limits allows any amount', () => {
    expect(() => svc.assertTransferable({ code: 'usdt', transferMin: null, transferMax: null } as never, dec('0.000001'))).not.toThrow();
  });
});
