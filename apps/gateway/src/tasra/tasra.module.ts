import { Module } from '@nestjs/common';

import { TasraDcqlService } from './dcql.service';
import { TasraDeploymentController } from './deployment.controller';
import { TasraDeploymentService } from './deployment.service';
import { TasraIssuerController } from './issuer.controller';
import { TasraIssuerService } from './issuer.service';
import { PublicKeyController } from './public-key.controller';
import { PublicKeyService } from './public-key.service';

@Module({
  controllers: [TasraDeploymentController, TasraIssuerController, PublicKeyController],
  providers: [TasraDcqlService, TasraDeploymentService, TasraIssuerService, PublicKeyService],
  exports: [TasraDcqlService, TasraDeploymentService, TasraIssuerService, PublicKeyService],
})
export class TasraModule {}
