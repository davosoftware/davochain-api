import { Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { DojahModule } from '../dojah/dojah.module';
import { VirtualAccountsService } from '../ngn-deposits/virtual-accounts.service';
import { AmlService, VA_SWITCH, type VaSwitch } from './aml.service';

/**
 * AML screening. The naira-deposit module already imports the KYC module, so
 * importing it back here would be a module cycle: the deposit-account switch is
 * looked up lazily, at the moment a block or release needs it.
 */
@Module({
  imports: [DojahModule],
  providers: [
    AmlService,
    {
      provide: VA_SWITCH,
      inject: [ModuleRef],
      useFactory: (moduleRef: ModuleRef): VaSwitch => ({
        setDesiredForUser: (userId, desired, opts) =>
          moduleRef.get(VirtualAccountsService, { strict: false }).setDesiredForUser(userId, desired, opts),
      }),
    },
  ],
  exports: [AmlService, VA_SWITCH],
})
export class ComplianceModule {}
