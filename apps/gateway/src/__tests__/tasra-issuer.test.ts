import { verifyCredential } from '@t3foundry/tasra-sdk/app';
import { describe, expect, it } from 'vitest';

import { ApiException } from '../common/api-exception';
import { loadConfig, type GatewayConfig } from '../config/configuration';
import type { TasraDcqlService } from '../tasra/dcql.service';
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

/**
 * The expected `key` claim value the slot's DCQL rule pins — deliberately
 * different from the slot id so a test that accidentally passes because both
 * happen to be strings of the same length cannot slip through.
 */
const RULE_KEY_VALUE = `0x${'cd'.repeat(32)}`;

const configWith = (issuerSeed?: string): GatewayConfig =>
  // `''` has to reach the service as a configured-but-empty seed, so only
  // `undefined` means "variable absent".
  (issuerSeed === undefined ? {} : { tasra: { issuerSeed } }) as GatewayConfig;

/** A DCQL service that always returns the pin from the slot's rule. */
const okDcql = {
  resolveKeyValue: async () => RULE_KEY_VALUE,
} as unknown as TasraDcqlService;

/** A DCQL service that always throws — standing in for an unreachable verifier
 *  or a slot whose rule does not pin `key`. */
const failingDcql = {
  resolveKeyValue: async () => {
    throw ApiException.localized('internal_error', 'tasraRuleUnavailable');
  },
} as unknown as TasraDcqlService;

const captureError = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
};

describe('TasraIssuerService', () => {
  it('derives the configured issuer DID from the seed', async () => {
    const service = new TasraIssuerService(configWith(FIXTURE_SEED), okDcql);

    const result = await service.issue({ slotId: SLOT_ID, did: HOLDER_DID });

    expect(result.issuer).toBe(FIXTURE_ISSUER_DID);
    expect(result.vct).toBe('DocumentReader');
  });

  it('mints a holder-bound DocumentReader credential whose key claim comes from the DCQL rule', async () => {
    const service = new TasraIssuerService(configWith(FIXTURE_SEED), okDcql);

    const result = await service.issue({ slotId: SLOT_ID, did: HOLDER_DID });
    const claims = verifyCredential(result.credential, { issuer: FIXTURE_ISSUER_DID, type: 'DocumentReader' });

    expect(claims).toMatchObject({
      iss: FIXTURE_ISSUER_DID,
      vct: 'DocumentReader',
      // The holder is bound through `cnf` only — the reference OID4VCI flow
      // writes no `sub` for a DocumentReader, so presenting this credential
      // depends on the key binding.
      cnf: { kid: `${HOLDER_DID}#0` },
      // The `key` claim is the value the DCQL rule pins, not the slot id
      // the client passed in the request.
      key: RULE_KEY_VALUE,
    });
    expect(claims.sub).toBeUndefined();
  });

  it('reports an expiry that matches the credential lifetime instead of drifting from it', async () => {
    const service = new TasraIssuerService(configWith(FIXTURE_SEED), okDcql);

    const result = await service.issue({ slotId: SLOT_ID, did: HOLDER_DID });
    const claims = verifyCredential(result.credential, { issuer: FIXTURE_ISSUER_DID });
    const ttlSecs = Number(claims.exp) - Number(claims.iat);

    expect(ttlSecs).toBe(365 * 24 * 60 * 60);
    expect(new Date(result.expiresAt).toISOString()).toBe(result.expiresAt);
    expect(Math.floor(new Date(result.expiresAt).getTime() / 1_000)).toBe(claims.exp);
  });

  it('refuses to mint when no seed is configured', async () => {
    const service = new TasraIssuerService(configWith(), okDcql);

    const error = await captureError(() => service.issue({ slotId: SLOT_ID, did: HOLDER_DID }));

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe('internal_error');
    expect((error as ApiException).messageKey).toBe('tasraIssuerNotConfigured');
  });

  it('treats an empty-string seed as unset rather than as an identity', async () => {
    // `configuration.ts` accepts `''` because an unset variable interpolates to
    // an empty string in `docker/stack.compose.yml`; the service, not the schema,
    // is what has to refuse it. The config is built inline so a truthiness check
    // in `configWith` cannot quietly turn this into the "absent" case.
    const service = new TasraIssuerService({ tasra: { issuerSeed: '' } } as GatewayConfig, okDcql);

    const error = await captureError(() => service.issue({ slotId: SLOT_ID, did: HOLDER_DID }));

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe('internal_error');
    expect((error as ApiException).messageKey).toBe('tasraIssuerNotConfigured');
  });

  it('refuses to mint when the DCQL rule cannot be read', async () => {
    const service = new TasraIssuerService(configWith(FIXTURE_SEED), failingDcql);

    const error = await captureError(() => service.issue({ slotId: SLOT_ID, did: HOLDER_DID }));

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe('internal_error');
    expect((error as ApiException).messageKey).toBe('tasraRuleUnavailable');
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
