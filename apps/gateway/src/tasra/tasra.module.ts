import { Module } from '@nestjs/common';

import { TasraDcqlService } from './dcql.service';
import { TasraDeploymentController } from './deployment.controller';
import { TasraDeploymentService } from './deployment.service';
import { TasraIssuerController } from './issuer.controller';
import { TasraIssuerService } from './issuer.service';
import { PublicKeyController } from './public-key.controller';
import { PublicKeyService } from './public-key.service';
import { TasraSlotRuleService } from './slot-rule.service';
import { TasraStatusListController } from './status-list.controller';
import { TasraStatusListService } from './status-list.service';

@Module({
  controllers: [
    TasraDeploymentController,
    TasraIssuerController,
    PublicKeyController,
    TasraStatusListController,
  ],
  providers: [
    TasraDcqlService,
    TasraDeploymentService,
    TasraIssuerService,
    PublicKeyService,
    TasraSlotRuleService,
    TasraStatusListService,
  ],
  exports: [TasraDcqlService, TasraDeploymentService, TasraIssuerService, PublicKeyService],
})
export class TasraModule {}
