import { BadRequestException } from '@nestjs/common';
import { assertCryptoDestination } from './destination-rules';

const BTC = { isListed: true, withdrawsEnabled: true, requiresTag: false, addressRegex: '^bc1[a-z0-9]{8,}$', label: 'Bitcoin' };

function prisma(network: Record<string, unknown> | null) {
  return { assetNetwork: { findUnique: jest.fn(async () => network) } } as never;
}
const input = { asset: 'BTC', network: 'btc', address: 'bc1qxyz12345678' };

describe('assertCryptoDestination: one set of address rules for saving and sending', () => {
  it('accepts a good address and returns the coin code and network', async () => {
    await expect(assertCryptoDestination(prisma(BTC), input)).resolves.toMatchObject({ code: 'btc', network: { label: 'Bitcoin' } });
  });

  it('refuses a network that is not listed', async () => {
    await expect(assertCryptoDestination(prisma(null), input)).rejects.toThrow(new BadRequestException('BTC is not available on btc'));
  });

  it('refuses a network with withdrawals switched off', async () => {
    await expect(assertCryptoDestination(prisma({ ...BTC, withdrawsEnabled: false }), input)).rejects.toThrow(
      new BadRequestException('Withdrawals are disabled for BTC on Bitcoin'),
    );
  });

  it('needs the tag where the network needs one', async () => {
    await expect(assertCryptoDestination(prisma({ ...BTC, requiresTag: true, label: 'XRP' }), input)).rejects.toThrow(
      new BadRequestException('XRP requires a destination tag. Without it the funds cannot be credited.'),
    );
  });

  it('refuses an address that does not fit the network', async () => {
    await expect(assertCryptoDestination(prisma(BTC), { ...input, address: '0xabc' })).rejects.toThrow(
      new BadRequestException('That does not look like a valid Bitcoin address'),
    );
  });
});
