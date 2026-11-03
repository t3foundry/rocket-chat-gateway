import type { IssueDocumentReaderRequest, IssueDocumentReaderResponse } from '@t3foundry/open-rocket-chat-api-contract';
import { Inject, Injectable } from '@nestjs/common';
import { hexToBytes } from '@t3foundry/tasra-sdk';
import { createIdentity } from '@t3foundry/tasra-sdk/app';
import { holderCnf, issueSdJwtVc } from '@t3foundry/tasra-sdk/oid4vp';

import { ApiException } from '../common/api-exception';
import { GATEWAY_CONFIG, type GatewayConfig } from '../config/configuration';

/**
 * A reader credential is meant to outlive the session that requested it — it is
 * handed to a wallet, which presents it until it expires. One year, matching the
 * lifetime the OID4VCI reference flow issues for a holder.
 */
const CREDENTIAL_TTL_SECONDS = 365 * 24 * 60 * 60;

/**
 * Mints a Holder-bound `DocumentReader` SD-JWT VC on demand.
 *
 * This is deliberately not OID4VCI: there is no offer, token endpoint, nonce or
 * proof JWT, because the caller already holds a gateway session. It reproduces
 * what the OID4VCI reference flow does for a `DocumentReader`, so a credential
 * issued here is indistinguishable from one obtained through that flow.
 *
 * Nothing about the seed, the identity or the credential is ever logged.
 */
@Injectable()
export class TasraIssuerService {
  constructor(@Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig) {}

  issue(input: IssueDocumentReaderRequest): IssueDocumentReaderResponse {
    const seed = this.config.tasra?.issuerSeed;
    if (!seed) {
      throw ApiException.localized('internal_error', 'tasraIssuerNotConfigured');
    }

    // The identity holds the private key, so it lives for exactly one mint and
    // is destroyed immediately after — the reference flow's discipline, and the
    // reason this is not a key held on a long-lived service.
    const issuer = createIdentity({ seed: hexToBytes(seed) });

    try {
      // One timestamp drives both `iat`/`exp` and the reported `expiresAt`, so
      // the body cannot disagree with the credential about when it expires.
      const nowSecs = Math.floor(Date.now() / 1_000);
      const credential = issueSdJwtVc({
        issuer: issuer.issuer,
        vct: 'DocumentReader',
        // The holder is bound through `cnf` alone: the reference flow writes no
        // `sub` claim for this credential type, and a slot policy pinned to the
        // holder would then never match a credential minted here.
        cnf: holderCnf({ did: input.did }),
        // The `key` claim is what a slot's DCQL rule pins on.
        claims: { key: input.slotId },
        nowSecs,
        ttlSecs: CREDENTIAL_TTL_SECONDS,
      });

      return {
        credential,
        issuer: issuer.did,
        vct: 'DocumentReader',
        expiresAt: new Date((nowSecs + CREDENTIAL_TTL_SECONDS) * 1_000).toISOString(),
      };
    } finally {
      issuer.destroy();
    }
  }
}
