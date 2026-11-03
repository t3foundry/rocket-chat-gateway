import { verifyCredential } from '@t3foundry/tasra-sdk/app';
import { describe, expect, it } from 'vitest';

import { ApiException } from '../common/api-exception';
import { loadConfig, type GatewayConfig } from '../config/configuration';
import { TasraIssuerService } from '../tasra/issuer.service';

/**
 * A throwaway fixture seed, written as readable ASCII so nobody can mistake it
 * for a signing key: `tasra-test-seed-not-for-deploy!!` as hex. It exists only
 * to pin the DID derivation below and must never be used to sign anything a
 * deployment relies on — anyone with this comment can reconstruct it.
 */
const FIXTURE_SEED = '0x74617372612d746573742d736565642d6e6f742d666f722d6465706c6f792121';

/** The DID the fixture seed deterministically derives. */
const FIXTURE_ISSUER_DID =
  'did:jwk:eyJrdHkiOiJPS1AiLCJjcnYiOiJFZDI1NTE5IiwieCI6ImNTTWdKR0Qxa2gwQkNGelNUNkpGU215VVFBd2UtX1ctdDRHYTZCSXV1ZGcifQ';

/**
 * A different identity's DID, standing in for a wallet. Kept distinct from the
 * issuer so a `cnf` that echoed the issuer by accident cannot pass.
 */
const HOLDER_DID =
  'did:jwk:eyJrdHkiOiJPS1AiLCJjcnYiOiJFZDI1NTE5IiwieCI6IjBFcXlNblFydEtzNkUyaTlSaFhrNXRBaVNyY2FBV3V2aFNDak1zbDNoemMifQ';
const SLOT_ID = `0x${'ab'.repeat(32)}`;

const configWith = (issuerSeed?: string): GatewayConfig =>
  // `''` has to reach the service as a configured-but-empty seed, so only
  // `undefined` means "variable absent".
  (issuerSeed === undefined ? {} : { tasra: { issuerSeed } }) as GatewayConfig;

const captureError = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
};

describe('TasraIssuerService', () => {
  it('derives the configured issuer DID from the seed', () => {
    const service = new TasraIssuerService(configWith(FIXTURE_SEED));

    const result = service.issue({ slotId: SLOT_ID, did: HOLDER_DID });

    expect(result.issuer).toBe(FIXTURE_ISSUER_DID);
    expect(result.vct).toBe('DocumentReader');
  });

  it('mints a holder-bound DocumentReader credential with the documented claims', () => {
    const service = new TasraIssuerService(configWith(FIXTURE_SEED));

    const result = service.issue({ slotId: SLOT_ID, did: HOLDER_DID });
    const claims = verifyCredential(result.credential, { issuer: FIXTURE_ISSUER_DID, type: 'DocumentReader' });

    expect(claims).toMatchObject({
      iss: FIXTURE_ISSUER_DID,
      vct: 'DocumentReader',
      // The holder is bound through `cnf` only — the reference OID4VCI flow
      // writes no `sub` for a DocumentReader, so presenting this credential
      // depends on the key binding.
      cnf: { kid: `${HOLDER_DID}#0` },
      key: SLOT_ID,
    });
    expect(claims.sub).toBeUndefined();
  });

  it('reports an expiry that matches the credential lifetime instead of drifting from it', () => {
    const service = new TasraIssuerService(configWith(FIXTURE_SEED));

    const result = service.issue({ slotId: SLOT_ID, did: HOLDER_DID });
    const claims = verifyCredential(result.credential, { issuer: FIXTURE_ISSUER_DID });
    const ttlSecs = Number(claims.exp) - Number(claims.iat);

    expect(ttlSecs).toBe(365 * 24 * 60 * 60);
    expect(new Date(result.expiresAt).toISOString()).toBe(result.expiresAt);
    expect(Math.floor(new Date(result.expiresAt).getTime() / 1_000)).toBe(claims.exp);
  });

  it('refuses to mint when no seed is configured', () => {
    const service = new TasraIssuerService(configWith());

    const error = captureError(() => service.issue({ slotId: SLOT_ID, did: HOLDER_DID }));

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe('internal_error');
    expect((error as ApiException).messageKey).toBe('tasraIssuerNotConfigured');
  });

  it('treats an empty-string seed as unset rather than as an identity', () => {
    // `configuration.ts` accepts `''` because an unset variable interpolates to
    // an empty string in `docker/stack.compose.yml`; the service, not the schema,
    // is what has to refuse it. The config is built inline so a truthiness check
    // in `configWith` cannot quietly turn this into the "absent" case.
    const service = new TasraIssuerService({ tasra: { issuerSeed: '' } } as GatewayConfig);

    const error = captureError(() => service.issue({ slotId: SLOT_ID, did: HOLDER_DID }));

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe('internal_error');
    expect((error as ApiException).messageKey).toBe('tasraIssuerNotConfigured');
  });
});

describe('TASRA_ISSUER_SEED', () => {
  // The minimum environment a gateway boots with; only the seed varies below.
  const base: NodeJS.ProcessEnv = {
    ROCKETCHAT_SERVERS: 'http://localhost:3000',
    SESSION_SECRET: 'x'.repeat(32),
  };

  it('reads an absent or empty seed as "issuance disabled" rather than as an error', () => {
    // An unset variable interpolates to an empty string in `docker/stack.compose.yml`,
    // so treating `''` as malformed would take down a stack that never issues.
    expect(loadConfig(base).tasra).toBeUndefined();
    expect(loadConfig({ ...base, TASRA_ISSUER_SEED: '' }).tasra).toBeUndefined();
  });

  it('rejects a malformed seed at startup instead of at the first request', () => {
    expect(() => loadConfig({ ...base, TASRA_ISSUER_SEED: '0xdeadbeef' })).toThrow(/TASRA_ISSUER_SEED/);
    expect(() => loadConfig({ ...base, TASRA_ISSUER_SEED: FIXTURE_SEED.slice(2) })).toThrow(/TASRA_ISSUER_SEED/);
  });

  it('keeps a well-formed seed for the issuer to use', () => {
    expect(loadConfig({ ...base, TASRA_ISSUER_SEED: FIXTURE_SEED }).tasra).toEqual({ issuerSeed: FIXTURE_SEED });
  });
});
