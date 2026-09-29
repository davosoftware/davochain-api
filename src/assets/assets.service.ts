import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Asset, AssetNetwork } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QuidaxClient } from '../quidax/quidax.client';
import { Decimal, dec, minTradeUsd } from '../common/money';
import { requiresTag } from './chain-catalogue';

@Injectable()
export class AssetsService {
  private readonly log = new Logger(AssetsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly quidax: QuidaxClient,
  ) {}

  async listed(): Promise<Array<Asset & { networks: AssetNetwork[] }>> {
    return this.prisma.asset.findMany({
      where: { isListed: true, isFiat: false },
      include: { networks: { where: { isListed: true }, orderBy: { networkId: 'asc' } } },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async require(code: string): Promise<Asset> {
    const asset = await this.prisma.asset.findUnique({ where: { code: code.toLowerCase() } });
    if (!asset || !asset.isListed) throw new NotFoundException(`Unknown asset: ${code}`);
    return asset;
  }

  async networksFor(code: string, purpose: 'deposit' | 'withdraw'): Promise<AssetNetwork[]> {
    return this.prisma.assetNetwork.findMany({
      where: {
        assetCode: code.toLowerCase(),
        isListed: true,
        ...(purpose === 'deposit' ? { depositsEnabled: true } : { withdrawsEnabled: true }),
      },
      orderBy: [{ isDefault: 'desc' }, { networkId: 'asc' }],
    });
  }

  /**
   * Sync the chain list from Quidax.
   *
   * The published docs are not usable for this: two pages disagree with each
   * other about USDT, and NEITHER carries deposits_enabled / withdraws_enabled.
   * Arbitrum is deposit-only today and nothing but the API says so.
   *
   * A chain that disappears upstream is soft-disabled, never deleted — existing
   * addresses must stay readable so users can still see where old funds went.
   */
  async syncNetworks(assetCode: string): Promise<{ synced: number; disabled: number }> {
    const code = assetCode.toLowerCase();
    const wallet = await this.quidax.fetchWallet(code, 'me');
    const upstream = wallet.networks ?? [];

    if (upstream.length === 0) {
      this.log.warn(
        `${code}: wallet returned no networks[] — falling back to default_network. ` +
          `Confirm the singular wallet endpoint returns networks[] on the live key.`,
      );
      if (wallet.default_network) {
        upstream.push({
          id: wallet.default_network,
          name: wallet.default_network,
          deposits_enabled: wallet.blockchain_enabled,
          withdraws_enabled: wallet.blockchain_enabled,
        });
      }
    }

    let synced = 0;
    for (const net of upstream) {
      await this.prisma.assetNetwork.upsert({
        where: { assetCode_networkId: { assetCode: code, networkId: net.id } },
        create: {
          assetCode: code,
          networkId: net.id,
          label: net.name,
          depositsEnabled: net.deposits_enabled,
          withdrawsEnabled: net.withdraws_enabled,
          isDefault: net.id === wallet.default_network,
          requiresTag: requiresTag(code, net.id),
        },
        update: {
          label: net.name,
          depositsEnabled: net.deposits_enabled,
          withdrawsEnabled: net.withdraws_enabled,
          isDefault: net.id === wallet.default_network,
          isListed: true,
          // Also refresh on update — a seeded row starts with requiresTag from
          // the catalogue and the live sync should confirm or correct it.
          requiresTag: requiresTag(code, net.id),
          syncedAt: new Date(),
        },
      });
      synced++;
    }

    const seen = upstream.map((n) => n.id);
    const { count: disabled } = await this.prisma.assetNetwork.updateMany({
      where: { assetCode: code, networkId: { notIn: seen }, isListed: true },
      data: { isListed: false },
    });
    if (disabled > 0) {
      this.log.warn(`${code}: ${disabled} chain(s) no longer offered upstream — soft-disabled`);
    }

    return { synced, disabled };
  }

  async syncAll(): Promise<Record<string, { synced: number; disabled: number }>> {
    const assets = await this.prisma.asset.findMany({
      where: { isListed: true, isFiat: false },
      select: { code: true },
    });
    const out: Record<string, { synced: number; disabled: number }> = {};
    for (const { code } of assets) {
      try {
        out[code] = await this.syncNetworks(code);
      } catch (err) {
        this.log.error(`${code}: network sync failed — ${(err as Error).message}`);
        out[code] = { synced: 0, disabled: 0 };
      }
    }
    return out;
  }

  /**
   * The live minimum for a coin, from three constraints — see money.ts.
   *
   * Quidax's floor is denominated in COIN, so its dollar value moves with the
   * price. This is computed per quote and never cached.
   */
  async minimumUsd(asset: Asset, priceUsd: Decimal, floorUsd: Decimal): Promise<Decimal> {
    return minTradeUsd({
      floorUsd,
      stepUsd: asset.transferStep ? dec(asset.transferStep).mul(priceUsd) : null,
      transferMinUsd: asset.transferMin ? dec(asset.transferMin).mul(priceUsd) : null,
    });
  }

  /** Reject before debiting rather than discovering the limit at settlement. */
  assertTransferable(asset: Asset, amount: Decimal): void {
    if (asset.transferMin && amount.lt(dec(asset.transferMin))) {
      throw new NotFoundException(
        `Minimum ${asset.code.toUpperCase()} transfer is ${dec(asset.transferMin).toFixed()}`,
      );
    }
    if (asset.transferMax && amount.gt(dec(asset.transferMax))) {
      throw new NotFoundException(
        `Maximum ${asset.code.toUpperCase()} transfer is ${dec(asset.transferMax).toFixed()}`,
      );
    }
  }

  /** Split an oversized amount into chunks under the transfer maximum. */
  chunkForTransfer(asset: Asset, amount: Decimal): Decimal[] {
    if (!asset.transferMax) return [amount];
    const max = dec(asset.transferMax);
    if (amount.lte(max)) return [amount];

    const chunks: Decimal[] = [];
    let left = amount;
    while (left.gt(max)) {
      chunks.push(max);
      left = left.minus(max);
    }
    if (left.gt(0)) chunks.push(left);
    return chunks;
  }
}
