import type { DcqlQuery } from '@t3foundry/tasra-sdk';
import {
  createLocalWallet,
  resolveApplicationManifest,
  type ApplicationManifest,
  type TasraDeployment,
} from '@t3foundry/tasra-sdk/app';
import { createDecryptionRecipient, decryptionBinding } from '@t3foundry/tasra-sdk/committee';
import { fetchRequestObject, openVerifierAgentSession } from '@t3foundry/tasra-sdk/oid4vp';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { ApiException } from '../common/api-exception';
import { GATEWAY_CONFIG, type GatewayConfig } from '../config/configuration';
import { TasraDeploymentService } from './deployment.service';
import { TasraSlotRuleService } from './slot-rule.service';
// eslint-disable-next-line no-restricted-imports
import networkManifest from './network.json';

/**
 * A placeholder content digest (32 zero bytes) for the operation the session
 * names, because the session exists only to obtain the DCQL rule: nothing is
 * presented, so no operation is ever authorized. The session is abandoned as
 * soon as its request object has been read.
 */
const PLACEHOLDER_CONTENT_DIGEST = new Uint8Array(32);

/**
 * Resolves the `key` claim value a slot's DCQL rule pins, which a reader
 * credential for that slot must carry.
 *
 * Two sources, in order:
 *
 *  1. the gateway's own rules file (`TASRA_SLOT_RULES_FILE`): the rule is read
 *     directly, with no network round-trip;
 *  2. the network: the chain stores only a salted commitment, never the rule, but
 *     the verifier agent's signed request object for a slot carries the rule's
 *     query. Any key may open a session (the slot's rule decides who is admitted
 *     when a credential is presented), so the gateway signs with a fresh random
 *     key, reads the request object and abandons the session without presenting.
 *     It holds no key of the slot's creator.
 */
@Injectable()
export class TasraDcqlService {
  private readonly deployment: Readonly<TasraDeployment>;
  private readonly verifierAgentUrl: string;

  /**
   * Resolved DCQL key values are cached permanently. A slot's DCQL rule is a
   * pinned on-chain commitment whose `key` claim never changes — re-opening an
   * OID4VP session on every credential-issuance request wastes two network
   * round-trips for a value that is always the same. The cache serves the
   * resolved value for the lifetime of the gateway process.
   *
   * A cached value is also served on fetch failure so a transient verifier
   * outage does not block credential issuance for slots already resolved.
   */
  private readonly cache = new Map<string, string>();

  constructor(
    @Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig,
    private readonly logger: PinoLogger,
    private readonly slotRules: TasraSlotRuleService,
    private readonly chain: TasraDeploymentService,
  ) {
    this.logger.setContext(TasraDcqlService.name);

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
   * Return the value the slot's DCQL rule pins on the `key` claim.
   *
   * On first call for a given slot the gateway reads the rule (from its own
   * rules file, else from the verifier agent's signed request object) and
   * extracts the pinned `key` value. The result is cached permanently —
   * subsequent calls for the same slot return it immediately without any
   * network round-trips.
   *
   * @param slotId - The 32-byte slot identifier the credential is for.
   * @returns The expected `key` claim value the VC must carry.
   * @throws ApiException (internal_error / tasraRuleUnavailable) when the rule
   *   cannot be read or does not pin `key` unambiguously, and no cached value
   *   exists.
   */
  async resolveKeyValue(slotId: `0x${string}`): Promise<string> {
    const cached = this.cache.get(slotId);
    if (cached !== undefined) return cached;

    try {
      const keyValue = await this.fetchKeyValue(slotId);
      this.cache.set(slotId, keyValue);
      return keyValue;
    } catch (error) {
      // A fetch failure with no cached entry is fatal — there is nothing to
      // fall back to. The caller receives the original error.
      throw error;
    }
  }

  /**
   * The uncached work: read the rule (held, else from a session's request
   * object) and extract the pinned `key` value. Never called when the slot is
   * already cached.
   */
  private async fetchKeyValue(slotId: `0x${string}`): Promise<string> {
    // A slot whose rule this gateway holds needs no session: the rule is right here.
    const held = this.slotRules.find(slotId);
    if (held !== undefined) {
      let query: DcqlQuery;
      try {
        query = JSON.parse(held) as DcqlQuery;
      } catch {
        throw ApiException.localized('internal_error', 'tasraRuleUnavailable', {
          details: { reason: 'the configured slot rule is not a DCQL query' },
        });
      }
      const pinned = extractKeyValue(query);
      if (pinned === undefined) {
        throw ApiException.localized('internal_error', 'tasraRuleUnavailable', {
          details: { reason: 'the slot DCQL rule does not pin the key claim to a value' },
        });
      }
      return pinned;
    }

    let requestUri: string;
    try {
      // A decrypt operation names a recipient and the slot's key epoch. The
      // recipient is a throwaway: nothing is presented, so nothing is ever sealed to it.
      // The epoch is read through the configured chain, the session is opened at the agent of
      // the checked-in network manifest: they must describe the same network.
      if (this.chain.describe().chainId !== this.deployment.chainId) {
        throw new Error(
          'the configured chain is not the network of the gateway manifest; list the slot in TASRA_SLOT_RULES_FILE',
        );
      }
      const slot = await this.chain.getClient().readers.keyRegistry.getKeySlot(slotId);
      const binding = decryptionBinding(
        PLACEHOLDER_CONTENT_DIGEST,
        Number(slot.epoch),
        await createDecryptionRecipient(),
      );
      const session = await openVerifierAgentSession({
        verifierAgentUrl: this.verifierAgentUrl,
        // A fresh random key per read: any key may open a session.
        signer: createLocalWallet(this.deployment).signer,
        chainId: this.deployment.chainId,
        keyRegistry: this.deployment.addresses.KeyRegistry!,
        slotId,
        action: 'decrypt',
        ...binding,
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
