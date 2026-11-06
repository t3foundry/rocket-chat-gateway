import { TASRA_SLOT_ID_PATTERN, type GetPublicKeyResponse } from '@t3foundry/open-rocket-chat-api-contract';
import { Controller, Get, HttpCode, HttpStatus, Query } from '@nestjs/common';
import { z } from 'zod';

import { zodPipe } from '../common/zod-validation.pipe';
import { PublicKeyService } from './public-key.service';

const SlotIdQuerySchema = z.object({
  slotId: z.string().regex(TASRA_SLOT_ID_PATTERN, 'slotId must be 0x followed by 32 bytes of hex'),
});

/**
 * Public endpoint — no session guard. Anyone who can reach the gateway can
 * look up a slot's master public key from the registry, because the key itself
 * carries no secret: it only enables encryption, never decryption.
 */
@Controller('tasra')
export class PublicKeyController {
  constructor(private readonly service: PublicKeyService) {}

  /**
   * `GET /api/v1/tasra/public-key?slotId=0x...`
   *
   * Returns the BLS master public key for a slot, fetched from the on-chain
   * key registry via JSON-RPC.
   */
  @Get('public-key')
  @HttpCode(HttpStatus.OK)
  async lookup(
    @Query(zodPipe(SlotIdQuerySchema)) query: z.infer<typeof SlotIdQuerySchema>,
  ): Promise<GetPublicKeyResponse> {
    return this.service.lookup(query.slotId);
  }
}
