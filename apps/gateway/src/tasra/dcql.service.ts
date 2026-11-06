import type { DcqlQuery } from '@t3foundry/tasra-sdk';
import {
  createLocalWallet,
  resolveApplicationManifest,
  type ApplicationManifest,
  type TasraDeployment,
} from '@t3foundry/tasra-sdk/app';
import { fetchRequestObject, openVerifierAgentSession } from '@t3foundry/tasra-sdk/oid4vp';
import { Inject, Injectable } from '@nestjs/common';

import { ApiException } from '../common/api-exception';
import { GATEWAY_CONFIG, type GatewayConfig } from '../config/configuration';
// eslint-disable-next-line no-restricted-imports
import networkManifest from './network.json';

/**
 * A fresh 32 zero-bytes payload digest used as a placeholder operation payload,
 * because the session exists only to obtain the DCQL rule — no real operation is
 * authorized. The digest is never stored and the session is abandoned immediately.
 */
const DUMMY_DIGEST = new Uint8Array(32);

/**
 * Reads a slot's DCQL rule from the verifier agent and extracts the expected
 * `key` claim value the credential must carry.
 *
 * The chain stores only a salted commitment, never the rule itself. The rule is
 * obtainable only by opening an OID4VP session with the verifier agent listed in
 * `network.json`, signing the operation with the gateway's creator key as an
 * EVM account. The session delivers the request object whose `dcql_query` carries
 * the committed rule — once extracted, the session is abandoned without waiting
 * for a wallet.
 */
@Injectable()
export class TasraDcqlService {
  private readonly deployment: Readonly<TasraDeployment>;
  private readonly verifierAgentUrl: string;

  constructor(@Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig) {
    const { deployment, verifierAgentUrl } = resolveApplicationManifest(networkManifest as ApplicationManifest, {
      coordinator: 'lowest-operator-id',
    });

    if (!verifierAgentUrl) {
      throw new Error('network.json has no verifier-agent service entry');
    }

    this.deployment = deployment;
    this.verifierAgentUrl = verifierAgentUrl;
  }

  /**
   * Open a short-lived OID4VP session with the verifier, fetch the signed
   * request object, and extract the value the slot's DCQL rule pins on the
   * `key` claim.
   *
   * @param slotId - The 32-byte slot identifier the credential is for.
   * @returns The expected `key` claim value the VC must carry.
   * @throws ApiException (internal_error / tasraRuleUnavailable) when the rule
   *   cannot be read or does not pin `key` unambiguously.
   */
  async resolveKeyValue(slotId: `0x${string}`): Promise<string> {
    const wallet = this.getWallet();

    let requestUri: string;
    try {
      const session = await openVerifierAgentSession({
        verifierAgentUrl: this.verifierAgentUrl,
        signer: wallet.signer,
        chainId: this.deployment.chainId,
        keyRegistry: this.deployment.addresses.KeyRegistry!,
        slotId,
        action: 'decrypt',
        payloadDigest: DUMMY_DIGEST,
        description: 'Gateway reading slot DCQL rule for credential issuance',
      });
      requestUri = session.requestUri;
    } catch (cause) {
      throw ApiException.localized('internal_error', 'tasraRuleUnavailable', {
        details: { reason: cause instanceof Error ? cause.message : String(cause) },
      });
    }

    let dcqlQuery: DcqlQuery;
    try {
      const requestObject = await fetchRequestObject(requestUri);
      dcqlQuery = requestObject.claims.dcql_query;
    } catch (cause) {
      throw ApiException.localized('internal_error', 'tasraRuleUnavailable', {
        details: { reason: cause instanceof Error ? cause.message : String(cause) },
      });
    }

    const keyValue = extractKeyValue(dcqlQuery);
    if (keyValue === undefined) {
      throw ApiException.localized('internal_error', 'tasraRuleUnavailable', {
        details: { reason: 'the slot DCQL rule does not pin the key claim to a value' },
      });
    }

    return keyValue;
  }

  /**
   * Create a local wallet from `TASRA_CREATOR_SEED`, producing an EIP-712
   * signer accepted by the slot's policy (as creator or delegate). Follows
   * the same path as the reference script: `createLocalWallet` wraps a viem
   * `LocalAccount` in a `WalletClient` whose `signTypedData` handles the
   * `PresentationOperation` typed data exactly as the verifier expects.
   */
  private getWallet() {
    const seed = this.config.tasra?.creatorSeed;
    if (!seed) {
      throw ApiException.localized('internal_error', 'tasraIssuerNotConfigured');
    }
    return createLocalWallet(this.deployment, { privateKey: seed as `0x${string}` });
  }
}

/**
 * Walk the DCQL query to find the credential query (matching `DocumentReader`
 * SD-JWT format) and extract the pinned `key` value.
 *
 * @returns The first pinned `key` value, or `undefined` when no unambiguous
 *   pin exists.
 */
function extractKeyValue(query: DcqlQuery): string | undefined {
  const credentials = query.credentials;
  if (!credentials?.length) return undefined;

  for (const cred of credentials) {
    // Match the DocumentReader SD-JWT credential query.
    if (cred.format !== 'dc+sd-jwt') continue;
    const vctValues = cred.meta?.vct_values;
    if (!vctValues?.includes('DocumentReader')) continue;

    // Find the claim entry that pins `key`.
    for (const claim of cred.claims ?? []) {
      if (claim.path?.length === 1 && claim.path[0] === 'key') {
        const values = claim.values;
        // Require a single-pinned value; "any key" rules are insufficient.
        if (Array.isArray(values) && values.length === 1) {
          return String(values[0]);
        }
      }
    }
  }

  return undefined;
}
