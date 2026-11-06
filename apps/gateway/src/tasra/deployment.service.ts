import type { GetDeploymentResponse } from '@t3foundry/open-rocket-chat-api-contract';
import {
  DEFAULT_CHAIN_ID,
  addressBookFromObject,
  createTasraChainClient,
  type AddressBook,
  type TasraChainClient,
} from '@t3foundry/tasra-sdk/chain';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';

import { ApiException } from '../common/api-exception';
import { GATEWAY_CONFIG, type GatewayConfig } from '../config/configuration';

/**
 * The gateway's half of the Tasra deployment: which chain the key registry lives
 * on, and where that registry is.
 *
 * Two callers want it for different reasons. The slot lookup needs a chain client
 * to read the registry; `GET tasra/deployment` only needs to report the pair, so a
 * client can fill in a `tasra-encrypt/v2` manifest without being provisioned with
 * an address out of band — and without the risk that the address it was provisioned
 * with describes a different deployment than the slot it encrypts to.
 */
@Injectable()
export class TasraDeploymentService implements OnModuleDestroy {
  private chainClient: TasraChainClient | null = null;
  private described: GetDeploymentResponse | null = null;

  constructor(@Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig) {}

  /**
   * Chain id and key-registry address as a manifest must spell them.
   *
   * `chainId` falls back to the SDK default for the same reason the chain client
   * does: an unset `TASRA_CHAIN_ID` means the local default deployment, not a
   * chain that cannot be named. A missing registry address is different — no
   * manifest can be written without one — so that is a configuration error rather
   * than a value to invent.
   */
  describe(): GetDeploymentResponse {
    if (this.described) return this.described;

    const cfg = this.config.tasra;
    if (!cfg?.deploymentAddresses) {
      throw ApiException.localized('internal_error', 'tasraNotConfigured');
    }

    const { KeyRegistry } = this.parseAddresses(cfg.deploymentAddresses);
    if (!KeyRegistry) {
      throw ApiException.localized('internal_error', 'tasraNotConfigured');
    }

    this.described = { chainId: cfg.chainId ?? DEFAULT_CHAIN_ID, keyRegistry: KeyRegistry };
    return this.described;
  }

  /**
   * Read-only client for the deployment, created on first use and reused.
   *
   * It carries no wallet and performs only view-function reads, so sharing it is
   * safe. Cleared when the module is destroyed so the RPC transport can drain.
   */
  getClient(): TasraChainClient {
    if (this.chainClient) return this.chainClient;

    const cfg = this.config.tasra;
    if (!cfg?.rpcUrl || !cfg?.deploymentAddresses) {
      throw ApiException.localized('internal_error', 'tasraNotConfigured');
    }

    this.chainClient = createTasraChainClient({
      rpcUrl: cfg.rpcUrl,
      // Passed explicitly so the client and `describe()` can never disagree about
      // the chain a slot was read from.
      chainId: cfg.chainId ?? DEFAULT_CHAIN_ID,
      addresses: this.parseAddresses(cfg.deploymentAddresses),
    });

    return this.chainClient;
  }

  onModuleDestroy(): void {
    // viem PublicClient transport carries an HTTP keep-alive; let it drain.
    this.chainClient = null;
  }

  /**
   * The address book, or a configuration error.
   *
   * `addressBookFromObject` validates addresses by lowercasing them and skipping
   * any entry that is still not 20 bytes of hex — so a typo does not throw, it
   * disappears, and shows up here as a missing `KeyRegistry`. `configuration.ts`
   * deliberately stops at "is a JSON object", so this is where a bad address is
   * finally refused, at the request rather than at boot.
   */
  private parseAddresses(raw: string): AddressBook {
    try {
      return addressBookFromObject(JSON.parse(raw) as Record<string, string>);
    } catch {
      throw ApiException.localized('internal_error', 'tasraNotConfigured');
    }
  }
}
