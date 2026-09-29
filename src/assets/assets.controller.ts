import { Controller, Get, Param, Query } from '@nestjs/common';
import { AssetsService } from './assets.service';
import { Public } from '../auth/public.decorator';
import { ApiTags } from '@nestjs/swagger';

@ApiTags('assets')
@Controller('assets')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  /** The crypto page. Public — a signed-out user can browse what is listed. */
  @Public()
  @Get()
  async list() {
    const assets = await this.assets.listed();
    return assets.map((a) => ({
      code: a.code,
      name: a.name,
      displayScale: a.displayScale,
      networks: a.networks.map((n) => ({
        id: n.networkId,
        label: n.label,
        depositsEnabled: n.depositsEnabled,
        withdrawsEnabled: n.withdrawsEnabled,
        requiresTag: n.requiresTag,
        isDefault: n.isDefault,
      })),
    }));
  }

  @Public()
  @Get(':code/networks')
  async networks(
    @Param('code') code: string,
    @Query('purpose') purpose: 'deposit' | 'withdraw' = 'deposit',
  ) {
    await this.assets.require(code);
    const nets = await this.assets.networksFor(code, purpose);
    return nets.map((n) => ({
      id: n.networkId,
      label: n.label,
      requiresTag: n.requiresTag,
      confirmations: n.confirmations,
      isDefault: n.isDefault,
    }));
  }
}
