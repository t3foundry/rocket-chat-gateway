import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { jwkFromDid, parseSdJwt, verifyCompactJws } from '@t3foundry/tasra-sdk/oid4vp';
import { describe, expect, it } from 'vitest';

import { ApiException } from '../common/api-exception';
import type { GatewayConfig } from '../config/configuration';
import type { TasraDcqlService } from '../tasra/dcql.service';
import { TasraIssuerService } from '../tasra/issuer.service';
import { TasraSlotRuleService } from '../tasra/slot-rule.service';
import { TasraStatusListService } from '../tasra/status-list.service';

/** `tasra-test-seed-not-for-deploy!!` as hex — a readable fixture, never a deployment key. */
const FIXTURE_SEED = '0x74617372612d746573742d736565642d6e6f742d666f722d6465706c6f792121';
const HOLDER_DID =
  'did:jwk:eyJrdHkiOiJPS1AiLCJjcnYiOiJFZDI1NTE5IiwieCI6IjBFcXlNblFydEtzNkUyaTlSaFhrNXRBaVNyY2FBV3V2aFNDak1zbDNoemMifQ';
const LIST_URL = 'https://status.example/api/v1/tasra/status/document-reader';
const SLOT_ID = `0x${'ab'.repeat(32)}`;
const SALT = `0x${'5a'.repeat(32)}`;
const RULE = JSON.stringify({
  credentials: [
    {
      id: 'reader',
      format: 'dc+sd-jwt',
      meta: { vct_values: ['DocumentReader'] },
      claims: [{ path: ['key'], values: ['room-key'] }],
    },
  ],
});

const config = (tasra: GatewayConfig['tasra']): GatewayConfig => ({ tasra }) as GatewayConfig;
const dcql = { resolveKeyValue: async () => 'room-key' } as unknown as TasraDcqlService;

const rulesFile = (content: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'slot-rules-')), 'rules.json');
  writeFileSync(path, content);
  return path;
};

describe('TasraStatusListService', () => {
  it('signs an all-clear revocation list a verifier can check against the credential issuer', () => {
    const service = new TasraStatusListService(config({ issuerSeed: FIXTURE_SEED, statusListUrl: LIST_URL }));
    const now = 1_800_000_000;
    const token = service.token(now);

    const issuer = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).iss as string;
    const { payload } = verifyCompactJws<Record<string, any>>(token, jwkFromDid(issuer));

    // The list identifies itself by the URL it is published at, and belongs to its subject.
    expect(payload.jti).toBe(LIST_URL);
    expect(payload.vc.id).toBe(LIST_URL);
    expect(payload.vc.issuer).toBe(issuer);
    expect(payload.vc.type).toContain('StatusList2021Credential');
    expect(payload.vc.credentialSubject).toMatchObject({
      id: `${LIST_URL}#list`,
      type: 'StatusList2021',
      statusPurpose: 'revocation',
    });
    expect(payload.iat).toBe(now);
    expect(payload.exp).toBeGreaterThan(now);

    const bits = gunzipSync(Buffer.from(payload.vc.credentialSubject.encodedList, 'base64url'));
    expect(bits.length).toBe(131_072 / 8);
    expect(bits.every((byte) => byte === 0)).toBe(true);
  });

  it('re-signs with a newer issue time once the served signature has aged', () => {
    const service = new TasraStatusListService(config({ issuerSeed: FIXTURE_SEED, statusListUrl: LIST_URL }));
    const first = service.token(1_800_000_000);
    expect(service.token(1_800_000_100)).toBe(first);
    expect(service.token(1_800_000_700)).not.toBe(first);
  });

  it('refuses to publish a list when no URL is configured', () => {
    const service = new TasraStatusListService(config({ issuerSeed: FIXTURE_SEED }));
    expect(() => service.token()).toThrow(ApiException);
  });
});

describe('TasraIssuerService with a status list', () => {
  it('names the credential status in the clear, pointing into the published list', async () => {
    const cfg = config({ issuerSeed: FIXTURE_SEED, statusListUrl: LIST_URL });
    const issued = await new TasraIssuerService(cfg, dcql, new TasraStatusListService(cfg)).issue({
      slotId: SLOT_ID,
      did: HOLDER_DID,
    });

    const { payload, disclosures } = parseSdJwt(issued.credential);
    const status = payload.credentialStatus as Record<string, string>;
    expect(status.type).toBe('StatusList2021Entry');
    expect(status.statusPurpose).toBe('revocation');
    expect(status.statusListCredential).toBe(LIST_URL);
    expect(Number(status.statusListIndex)).toBeGreaterThanOrEqual(0);
    expect(Number(status.statusListIndex)).toBeLessThan(131_072);
    expect(status.id).toBe(`${LIST_URL}#${status.statusListIndex}`);
    // `key` stays a selective disclosure; the status must not be one.
    expect(disclosures.map((disclosure) => disclosure.name)).toEqual(['key']);
    // The list and the credential share one issuer, which the verifier requires.
    expect(payload.iss).toBe(issued.issuer);
  });

  it('issues without a status when none is configured', async () => {
    const cfg = config({ issuerSeed: FIXTURE_SEED });
    const issued = await new TasraIssuerService(cfg, dcql, new TasraStatusListService(cfg)).issue({
      slotId: SLOT_ID,
      did: HOLDER_DID,
    });
    expect(parseSdJwt(issued.credential).payload.credentialStatus).toBeUndefined();
  });
});

describe('TasraSlotRuleService', () => {
  it('holds the exact rule text, whatever the case of the slot id, and needs no salt', () => {
    const service = new TasraSlotRuleService(
      config({
        slotRulesFile: rulesFile(JSON.stringify({ [SLOT_ID.toUpperCase().replace('0X', '0x')]: { rule: RULE } })),
      }),
    );
    expect(service.find(SLOT_ID)).toBe(RULE);
  });

  it('still loads a file that carries a salt, and ignores it', () => {
    const service = new TasraSlotRuleService(
      config({ slotRulesFile: rulesFile(JSON.stringify({ [SLOT_ID]: { rule: RULE, salt: SALT } })) }),
    );
    expect(service.find(SLOT_ID)).toBe(RULE);
  });

  it('holds nothing for a slot it has no rule for, and when no file is configured', () => {
    expect(new TasraSlotRuleService(config({ slotRulesFile: rulesFile('{}') })).find(SLOT_ID)).toBeUndefined();
    expect(new TasraSlotRuleService(config({})).find(SLOT_ID)).toBeUndefined();
  });

  it('refuses a malformed file without echoing its contents', () => {
    const service = new TasraSlotRuleService(
      config({ slotRulesFile: rulesFile(JSON.stringify({ [SLOT_ID]: { rule: 'secret-rule-text', salt: 'nope' } })) }),
    );
    expect(() => service.find(SLOT_ID)).toThrow(/not a valid slot rules file/);
    try {
      service.find(SLOT_ID);
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-rule-text');
    }
  });
});
