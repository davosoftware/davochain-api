import { Global, Module } from '@nestjs/common';
import { TransactionPinService } from './transaction-pin.service';
import { TransactionPinController } from './transaction-pin.controller';
import { TransactionPinGuard } from './requires-pin';

/** Global: the guard is used on routes across several modules. */
@Global()
@Module({
  controllers: [TransactionPinController],
  providers: [TransactionPinService, TransactionPinGuard],
  exports: [TransactionPinService, TransactionPinGuard],
})
export class TransactionPinModule {}
