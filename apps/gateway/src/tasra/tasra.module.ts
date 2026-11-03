import { Module } from '@nestjs/common';

import { TasraIssuerController } from './issuer.controller';
import { TasraIssuerService } from './issuer.service';

@Module({
  controllers: [TasraIssuerController],
  providers: [TasraIssuerService],
  exports: [TasraIssuerService],
})
export class TasraModule {}
