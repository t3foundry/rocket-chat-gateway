import { randomInt } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { Inject, Injectable } from '@nestjs/common';
import { hexToBytes } from '@t3foundry/tasra-sdk';
import { createIdentity } from '@t3foundry/tasra-sdk/app';
import { signCompactJws } from '@t3foundry/tasra-sdk/oid4vp';

import { ApiException } from '../common/api-exception';
import { GATEWAY_CONFIG, type GatewayConfig } from '../config/configuration';

/** Entries in the list: the W3C Status List 2021 minimum, which keeps one holder's index in a crowd. */
const LIST_BITS = 131_072;
/** How long a signed list is valid. Verifiers never reuse a list beyond its signed expiry. */
const LIST_TTL_SECONDS = 24 * 60 * 60;
/** How long one signature is served before the list is signed again with a newer issue time. */
const RESIGN_AFTER_SECONDS = 10 * 60;

/** The `credentialStatus` a credential carries: where its list is published and which bit is its own. */
export type StatusListEntry = {
  id: string;
  type: 'StatusList2021Entry';
  statusPurpose: 'revocation';
  statusListIndex: string;
  statusListCredential: string;
};

/**
 * The revocation status list for the credentials this gateway issues.
 *
 * A Tasra verifier refuses a credential that names no revocation status, and
 * checks the named list on every presentation: it must be published at the URL
 * the credential carries, signed by the credential's own issuer, unexpired, and
 * never older than a version the verifier has already seen.
 *
 * This gateway keeps no revocation record, so every bit is clear: a reader
 * credential ends by expiring, or by rotating the slot. The list is still real —
 * signed with the issuer key and re-signed on a schedule — so adding revocation
 * later means setting bits here, not changing what credentials carry.
 */
@Injectable()
export class TasraStatusListService {
  private signed: { token: string; at: number } | null = null;

  constructor(@Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig) {}

  /** The URL verifiers fetch the list from, or `undefined` when status publishing is not configured. */
  get url(): string | undefined {
    return this.config.tasra?.statusListUrl;
  }

  /** A status entry for one new credential, at a random position in the list. */
  entry(): StatusListEntry {
    const url = this.requireUrl();
    const index = randomInt(LIST_BITS);
    return {
      id: `${url}#${index}`,
      type: 'StatusList2021Entry',
      statusPurpose: 'revocation',
      statusListIndex: String(index),
      statusListCredential: url,
    };
  }

  /** The signed list as a compact JWT, in the W3C Status List 2021 JWT-VC profile. */
  token(nowSecs = Math.floor(Date.now() / 1_000)): string {
    if (this.signed && nowSecs - this.signed.at < RESIGN_AFTER_SECONDS) return this.signed.token;

    const url = this.requireUrl();
    const seed = this.config.tasra?.issuerSeed;
    if (!seed) throw ApiException.localized('internal_error', 'tasraIssuerNotConfigured');

    // `encodedList` is base64url(gzip(bitstring)), every bit clear.
    const encodedList = gzipSync(new Uint8Array(LIST_BITS / 8)).toString('base64url');
    const issuer = createIdentity({ seed: hexToBytes(seed) });
    try {
      const token = signCompactJws(
        { typ: 'JWT', kid: issuer.issuer.kid ?? `${issuer.did}#0` },
        {
          iss: issuer.did,
          sub: url,
          jti: url,
          iat: nowSecs,
          nbf: nowSecs,
          exp: nowSecs + LIST_TTL_SECONDS,
          vc: {
            '@context': ['https://www.w3.org/2018/credentials/v1', 'https://w3id.org/vc/status-list/2021/v1'],
            id: url,
            type: ['VerifiableCredential', 'StatusList2021Credential'],
            issuer: issuer.did,
            credentialSubject: {
              id: `${url}#list`,
              type: 'StatusList2021',
              statusPurpose: 'revocation',
              encodedList,
            },
          },
        },
        issuer.issuer.signer,
      );
      this.signed = { token, at: nowSecs };
      return token;
    } finally {
      issuer.destroy();
    }
  }

  private requireUrl(): string {
    const url = this.url;
    if (!url) throw ApiException.localized('internal_error', 'tasraIssuerNotConfigured');
    return url;
  }
}
