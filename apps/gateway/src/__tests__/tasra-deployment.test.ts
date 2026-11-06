import { DEFAULT_CHAIN_ID } from '@t3foundry/tasra-sdk/chain';
import { describe, expect, it } from 'vitest';

import { ApiException } from '../common/api-exception';
import type { GatewayConfig } from '../config/configuration';
import { TasraDeploymentService } from '../tasra/deployment.service';
import { PublicKeyService } from '../tasra/public-key.service';

// Checksummed, exactly as `.env.example` spells them. The SDK normalises every
// address it reads to lowercase, so `describe()` reports these lowercased.
const KEY_REGISTRY = '0x45F432aB5709e9920b5ec349D29663D7200A8C39';
const KEY_REGISTRY_NORMALISED = KEY_REGISTRY.toLowerCase();
const NODE_REGISTRY = '0x6366BE2f22F9Db9d7405c7E48B75bc415455784E';
const SLOT_ID = `0x${'ab'.repeat(32)}`;

const configWith = (tasra?: GatewayConfig['tasra']): GatewayConfig =>
  (tasra === undefined ? {} : { tasra }) as GatewayConfig;

/** An address book as `.env.example` spells it, serialised the way config carries it. */
const addresses = (book: Record<string, string>): string => JSON.stringify(book);

/** The thrown `ApiException`, asserting the type instead of casting downstream. */
const throwsApiError = (run: () => unknown): ApiException => {
  try {
    run();
  } catch (error) {
    if (error instanceof ApiException) return error;
    throw error;
  }
  throw new Error('expected the call to throw');
};

/** The rejection's `ApiException`; the services throw from inside async methods. */
const rejectsWithApiError = async (run: () => Promise<unknown>): Promise<ApiException> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiException) return error;
    throw error;
  }
  throw new Error('expected the call to reject');
};

describe('TasraDeploymentService', () => {
  it('reports the chain and registry a manifest has to name', () => {
    const service = new TasraDeploymentService(
      configWith({ chainId: 43113, deploymentAddresses: addresses({ KeyRegistry: KEY_REGISTRY }) }),
    );

    expect(service.describe()).toEqual({ chainId: 43113, keyRegistry: KEY_REGISTRY_NORMALISED });
  });

  it('normalises the address to lowercase, the way the SDK reads it', () => {
    // `addressBookFromObject` lowercases every address. Echoing the configured
    // spelling instead would give two spellings of one address — this endpoint's
    // and the chain client's — for a client to compare and get wrong.
    const service = new TasraDeploymentService(
      configWith({ chainId: 43113, deploymentAddresses: addresses({ KeyRegistry: KEY_REGISTRY }) }),
    );

    expect(service.describe().keyRegistry).toBe(KEY_REGISTRY_NORMALISED);
  });

  it('reports the SDK default chain when TASRA_CHAIN_ID is unset, not an error', () => {
    // An unset chain id means the local default deployment, not a chain that
    // cannot be named. `getClient()` applies the same fallback, so a client
    // writing this pair into a manifest describes what the gateway actually reads.
    const service = new TasraDeploymentService(
      configWith({ deploymentAddresses: addresses({ KeyRegistry: KEY_REGISTRY }) }),
    );

    expect(service.describe().chainId).toBe(DEFAULT_CHAIN_ID);
  });

  it('reports only the registry, ignoring the companion contracts', () => {
    const service = new TasraDeploymentService(
      configWith({
        chainId: 43113,
        deploymentAddresses: addresses({ KeyRegistry: KEY_REGISTRY, NodeRegistry: NODE_REGISTRY }),
      }),
    );

    expect(service.describe()).toEqual({ chainId: 43113, keyRegistry: KEY_REGISTRY_NORMALISED });
  });

  it('refuses when no deployment addresses are configured', async () => {
    const service = new TasraDeploymentService(configWith({ chainId: 43113 }));

    const error = await rejectsWithApiError(async () => service.describe());

    expect(error.code).toBe('internal_error');
    expect(error.messageKey).toBe('tasraNotConfigured');
  });

  it('refuses when the address book carries no KeyRegistry', async () => {
    // A NodeRegistry alone cannot fill a manifest, and the key is matched exactly:
    // `keyregistry` or an arbitrary label is a missing entry, not a sloppy match.
    // So this is a configuration error rather than a response with a hole in it.
    const service = new TasraDeploymentService(
      configWith({ chainId: 43113, deploymentAddresses: addresses({ NodeRegistry: NODE_REGISTRY }) }),
    );

    expect((await rejectsWithApiError(async () => service.describe())).messageKey).toBe('tasraNotConfigured');
  });

  it('refuses an address that is not a 20-byte hex value', () => {
    // `configuration.ts` only requires a JSON object, so a typo reaches here
    // rather than stopping the gateway from booting over a feature it may not use.
    // `addressBookFromObject` drops the entry instead of throwing, which surfaces
    // as the missing-registry case above.
    const service = new TasraDeploymentService(
      configWith({ chainId: 43113, deploymentAddresses: addresses({ KeyRegistry: 'not-an-address' }) }),
    );

    expect(throwsApiError(() => service.describe()).messageKey).toBe('tasraNotConfigured');
  });

  it('describes the deployment without an RPC endpoint, but still refuses to read a slot', () => {
    // Reporting the chain is a config read; only slot lookups need the network.
    const service = new TasraDeploymentService(
      configWith({ chainId: 43113, deploymentAddresses: addresses({ KeyRegistry: KEY_REGISTRY }) }),
    );

    expect(service.describe().keyRegistry).toBe(KEY_REGISTRY_NORMALISED);
    expect(throwsApiError(() => service.getClient()).messageKey).toBe('tasraNotConfigured');
  });

  it('memoises the description, so a cached response cannot drift from the client', () => {
    const service = new TasraDeploymentService(
      configWith({ chainId: 43113, deploymentAddresses: addresses({ KeyRegistry: KEY_REGISTRY }) }),
    );

    expect(service.describe()).toBe(service.describe());
  });
});

describe('PublicKeyService', () => {
  it('answers tasraNotConfigured rather than reading a registry it cannot reach', async () => {
    // The service owns no configuration of its own: an unconfigured deployment has
    // to surface as this one code, because the alternative is a bare 500 that says
    // nothing about what the operator has to fix.
    const service = new PublicKeyService(new TasraDeploymentService(configWith({ chainId: 43113 })));

    const error = await rejectsWithApiError(async () => service.lookup(SLOT_ID));

    expect(error.code).toBe('internal_error');
    expect(error.messageKey).toBe('tasraNotConfigured');
  });
});
