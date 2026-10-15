import { BadRequestException } from '@nestjs/common';
import { AssetNetwork } from '@prisma/client';

/**
 * Is this a place we can send this coin? The same checks when an address is
 * saved and again when a withdrawal is sent to it, so a network switched off
 * after saving is still refused at send time (Part 2, C6).
 */
export async function assertCryptoDestination(
  prisma: { assetNetwork: { findUnique(args: { where: { assetCode_networkId: { assetCode: string; networkId: string } } }): Promise<AssetNetwork | null> } },
  input: { asset: string; network: string; address: string; destinationTag?: string | null },
): Promise<{ code: string; network: AssetNetwork }> {
  const code = input.asset.toLowerCase();
  const network = await prisma.assetNetwork.findUnique({
    where: { assetCode_networkId: { assetCode: code, networkId: input.network } },
  });
  if (!network || !network.isListed) {
    throw new BadRequestException(`${code.toUpperCase()} is not available on ${input.network}`);
  }
  // Arbitrum is deposit-only for USDT today, and nothing in the docs says so.
  if (!network.withdrawsEnabled) {
    throw new BadRequestException(`Withdrawals are disabled for ${code.toUpperCase()} on ${network.label}`);
  }
  if (network.requiresTag && !input.destinationTag) {
    throw new BadRequestException(`${network.label} requires a destination tag. Without it the funds cannot be credited.`);
  }
  if (network.addressRegex && !new RegExp(network.addressRegex).test(input.address)) {
    throw new BadRequestException(`That does not look like a valid ${network.label} address`);
  }
  return { code, network };
}
