import type { GetPublicKeyResponse } from '@t3foundry/open-rocket-chat-api-contract';
import { Injectable } from '@nestjs/common';

import { ApiException } from '../common/api-exception';
import { TasraDeploymentService } from './deployment.service';

/**
 * Reads a slot's master public key and epoch from the on-chain key registry.
 *
 * The chain client and its address book belong to `TasraDeploymentService`, which
 * shares one read-only client across the routes that need it; this service is the
 * slot-specific part — turning a registry record into the response, or into the
 * `not_found` a client can act on.
 */
@Injectable()
export class PublicKeyService {
  constructor(private readonly deployment: TasraDeploymentService) {}

  async lookup(slotId: string): Promise<GetPublicKeyResponse> {
    const client = this.deployment.getClient();

    const slot = await client.readers.keyRegistry.getKeySlot(slotId as `0x${string}`).catch(() => {
      // A revert and an unreachable RPC are indistinguishable here, and neither
      // says anything about the slot: both are the gateway failing to read a
      // registry it claims to be configured for.
      throw ApiException.localized('internal_error', 'tasraNotConfigured');
    });

    if (!slot.exists) {
      throw ApiException.localized('not_found', 'resourceNotFound');
    }

    return {
      publicKey: slot.publicKey as `0x${string}`,
      epoch: Number(slot.epoch),
    };
  }
}
