import type { GetDeploymentResponse } from '@t3foundry/open-rocket-chat-api-contract';
import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';

import { TasraDeploymentService } from './deployment.service';

/**
 * Public endpoint — no session guard, for the same reason the slot's group key is
 * public: a chain id and a contract address are on-chain facts, and a client has
 * to know them before it can seal anything. Hiding them would only push every
 * client into hard-coding a deployment that may not match its slot.
 */
@Controller('tasra')
export class TasraDeploymentController {
  constructor(private readonly deployment: TasraDeploymentService) {}

  /**
   * `GET /api/v1/tasra/deployment`
   *
   * The chain identity a `tasra-encrypt/v2` manifest must name, so a client does
   * not encrypt to a slot while describing a different registry.
   */
  @Get('deployment')
  @HttpCode(HttpStatus.OK)
  describe(): GetDeploymentResponse {
    return this.deployment.describe();
  }
}
