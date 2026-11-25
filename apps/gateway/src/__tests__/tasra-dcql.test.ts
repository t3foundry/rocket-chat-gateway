import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiException } from '../common/api-exception';
import type { GatewayConfig } from '../config/configuration';
import { TasraDcqlService } from '../tasra/dcql.service';
import type { TasraDeploymentService } from '../tasra/deployment.service';
import { TasraSlotRuleService } from '../tasra/slot-rule.service';

// ---------------------------------------------------------------------------
// SDK mocks — controlled per-test via mockImplementation in beforeEach.
// ---------------------------------------------------------------------------

vi.mock('@t3foundry/tasra-sdk/oid4vp', () => ({
  openVerifierAgentSession: vi.fn(),
  fetchRequestObject: vi.fn(),
}));

vi.mock('@t3foundry/tasra-sdk/app', () => ({
  resolveApplicationManifest: vi.fn().mockReturnValue({
    deployment: {
      chainId: 43113,
      addresses: { KeyRegistry: '0x0000000000000000000000000000000000000001' },
    },
    verifierAgentUrl: 'https://verifier.example',
  }),
  createLocalWallet: vi.fn(),
}));

vi.mock('@t3foundry/tasra-sdk/committee', () => ({
  createDecryptionRecipient: vi.fn(),
  decryptionBinding: vi.fn(),
}));

vi.mock('../tasra/network.json', () => ({ default: {} }));

// Import after mocks so the factory wrappers reference the same vi.fn instances.
import { createLocalWallet } from '@t3foundry/tasra-sdk/app';
import { createDecryptionRecipient, decryptionBinding } from '@t3foundry/tasra-sdk/committee';
import { openVerifierAgentSession, fetchRequestObject } from '@t3foundry/tasra-sdk/oid4vp';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SLOT_A = `0x${'aa'.repeat(32)}` as `0x${string}`;
const SLOT_B = `0x${'bb'.repeat(32)}` as `0x${string}`;

const KEY_A = `0x${'a1'.repeat(32)}`;
const KEY_B = `0x${'b1'.repeat(32)}`;

/** The slot's key epoch on chain, which the session's decrypt binding must name. */
const SLOT_EPOCH = 7;
const RECIPIENT = { recipient: { suite: 'test', public_key: '0x01' } };
const BINDING = { payloadDigest: new Uint8Array(32).fill(9), decryption: { ciphertext_epoch: SLOT_EPOCH } };

const DUMMY_URI = 'https://verifier.example/request/session-abc';

/** Build a DCQL query whose DocumentReader claim pins a single key value. */
const dcqlPinning = (key: string) => ({
  claims: {
    dcql_query: {
      credentials: [
        {
          format: 'dc+sd-jwt',
          meta: { vct_values: ['DocumentReader'] },
          claims: [{ path: ['key'], values: [key] }],
        },
      ],
    },
  },
});

// No creator key anywhere: the gateway opens rule-reading sessions with a random key.
const config: GatewayConfig = { tasra: {} } as GatewayConfig;

const getKeySlot = vi.fn();
/** The configured chain: the network of the gateway manifest unless a test says otherwise. */
const chainOn = (chainId: number): TasraDeploymentService =>
  ({
    describe: () => ({ chainId, keyRegistry: '0x0000000000000000000000000000000000000001' }),
    getClient: () => ({ readers: { keyRegistry: { getKeySlot } } }),
  }) as unknown as TasraDeploymentService;

const rulesFile = (rules: Record<string, { rule: string; salt?: string }>): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'dcql-rules-')), 'rules.json');
  writeFileSync(path, JSON.stringify(rules));
  return path;
};

const noopLogger = {
  setContext: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
} as any;

// ---------------------------------------------------------------------------

describe('TasraDcqlService', () => {
  let service: TasraDcqlService;

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: both SDK calls succeed with a rule pinning KEY_A.
    vi.mocked(openVerifierAgentSession).mockResolvedValue({ requestUri: DUMMY_URI } as any);
    vi.mocked(fetchRequestObject).mockResolvedValue(dcqlPinning(KEY_A) as any);

    getKeySlot.mockResolvedValue({ exists: true, epoch: BigInt(SLOT_EPOCH) });
    vi.mocked(createDecryptionRecipient).mockResolvedValue(RECIPIENT as any);
    vi.mocked(decryptionBinding).mockReturnValue(BINDING as any);
    // A new signer object per call, so a test can tell one key from the next.
    vi.mocked(createLocalWallet).mockImplementation(() => ({ signer: {} }) as any);

    service = new TasraDcqlService(config, noopLogger, new TasraSlotRuleService(config), chainOn(43113));
  });

  // -----------------------------------------------------------------------
  // Reading the rule from the network
  // -----------------------------------------------------------------------

  it('opens the session with a fresh random key, never a configured one', async () => {
    await service.resolveKeyValue(SLOT_A);
    await service.resolveKeyValue(SLOT_B);

    // `createLocalWallet(deployment)` with no private key generates one.
    expect(createLocalWallet).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(createLocalWallet).mock.calls) expect(call).toHaveLength(1);

    const [first, second] = vi.mocked(openVerifierAgentSession).mock.calls.map(([options]) => options.signer);
    expect(first).toBeDefined();
    expect(first).not.toBe(second);
  });

  it('names a decrypt of the slot at its on-chain key epoch, and presents nothing', async () => {
    await service.resolveKeyValue(SLOT_A);

    expect(getKeySlot).toHaveBeenCalledWith(SLOT_A);
    expect(decryptionBinding).toHaveBeenCalledWith(new Uint8Array(32), SLOT_EPOCH, RECIPIENT);
    expect(openVerifierAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        verifierAgentUrl: 'https://verifier.example',
        chainId: 43113,
        slotId: SLOT_A,
        action: 'decrypt',
        payloadDigest: BINDING.payloadDigest,
        decryption: BINDING.decryption,
      }),
    );
    // The request object is all the gateway reads: the session is abandoned there.
    expect(fetchRequestObject).toHaveBeenCalledWith(DUMMY_URI);
  });

  it('refuses to read a rule from the manifest network when the configured chain is another one', async () => {
    const elsewhere = new TasraDcqlService(config, noopLogger, new TasraSlotRuleService(config), chainOn(43112));

    await expect(elsewhere.resolveKeyValue(SLOT_A)).rejects.toThrow(ApiException);
    expect(openVerifierAgentSession).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Reading the rule the gateway holds
  // -----------------------------------------------------------------------

  it('reads a held rule directly, without the chain or a session', async () => {
    const rule = JSON.stringify(dcqlPinning(KEY_B).claims.dcql_query);
    const held: GatewayConfig = { tasra: { slotRulesFile: rulesFile({ [SLOT_A]: { rule } }) } } as GatewayConfig;
    const withRules = new TasraDcqlService(held, noopLogger, new TasraSlotRuleService(held), chainOn(43112));

    expect(await withRules.resolveKeyValue(SLOT_A)).toBe(KEY_B);
    expect(getKeySlot).not.toHaveBeenCalled();
    expect(openVerifierAgentSession).not.toHaveBeenCalled();
    expect(createLocalWallet).not.toHaveBeenCalled();
  });

  it('refuses a held rule that pins no key', async () => {
    const held: GatewayConfig = {
      tasra: { slotRulesFile: rulesFile({ [SLOT_A]: { rule: JSON.stringify({ credentials: [] }) } }) },
    } as GatewayConfig;
    const withRules = new TasraDcqlService(held, noopLogger, new TasraSlotRuleService(held), chainOn(43113));

    await expect(withRules.resolveKeyValue(SLOT_A)).rejects.toThrow(ApiException);
    expect(openVerifierAgentSession).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Core caching
  // -----------------------------------------------------------------------

  it('resolves via the verifier on first call and returns the cached value on subsequent calls', async () => {
    const first = await service.resolveKeyValue(SLOT_A);
    expect(first).toBe(KEY_A);
    expect(openVerifierAgentSession).toHaveBeenCalledTimes(1);
    expect(fetchRequestObject).toHaveBeenCalledTimes(1);

    const second = await service.resolveKeyValue(SLOT_A);
    expect(second).toBe(KEY_A);
    // Cache hit — no additional verifier round-trips.
    expect(openVerifierAgentSession).toHaveBeenCalledTimes(1);
    expect(fetchRequestObject).toHaveBeenCalledTimes(1);
  });

  it('caches each slot independently', async () => {
    // Prime slot A.
    const a1 = await service.resolveKeyValue(SLOT_A);
    expect(a1).toBe(KEY_A);

    // Prime slot B with a different value.
    vi.mocked(fetchRequestObject).mockResolvedValue(dcqlPinning(KEY_B) as any);
    const b = await service.resolveKeyValue(SLOT_B);
    expect(b).toBe(KEY_B);
    expect(openVerifierAgentSession).toHaveBeenCalledTimes(2);
    expect(fetchRequestObject).toHaveBeenCalledTimes(2);

    // Slot A still returns its cached value — no extra calls.
    const a2 = await service.resolveKeyValue(SLOT_A);
    expect(a2).toBe(KEY_A);
    expect(openVerifierAgentSession).toHaveBeenCalledTimes(2);
    expect(fetchRequestObject).toHaveBeenCalledTimes(2);
  });

  it('returns the cached value across many invocations without re-contacting the verifier', async () => {
    await service.resolveKeyValue(SLOT_A);

    for (let i = 0; i < 50; i++) {
      const value = await service.resolveKeyValue(SLOT_A);
      expect(value).toBe(KEY_A);
    }

    expect(openVerifierAgentSession).toHaveBeenCalledTimes(1);
    expect(fetchRequestObject).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed resolution', async () => {
    // First call fails.
    vi.mocked(openVerifierAgentSession).mockRejectedValue(new Error('transient failure'));

    await expect(service.resolveKeyValue(SLOT_A)).rejects.toThrow();
    expect(openVerifierAgentSession).toHaveBeenCalledTimes(1);
    expect(fetchRequestObject).toHaveBeenCalledTimes(0);

    // Now the verifier recovers — the service must try again.
    vi.mocked(openVerifierAgentSession).mockResolvedValue({ requestUri: DUMMY_URI } as any);

    const result = await service.resolveKeyValue(SLOT_A);
    expect(result).toBe(KEY_A);
    // Hit the verifier again — the failure was not cached.
    expect(openVerifierAgentSession).toHaveBeenCalledTimes(2);
    expect(fetchRequestObject).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // Error propagation
  // -----------------------------------------------------------------------

  it('throws when the verifier is unreachable and no cached value exists', async () => {
    vi.mocked(openVerifierAgentSession).mockRejectedValue(new Error('verifier down'));

    await expect(service.resolveKeyValue(SLOT_A)).rejects.toThrow(ApiException);
    expect(openVerifierAgentSession).toHaveBeenCalledTimes(1);
    expect(fetchRequestObject).toHaveBeenCalledTimes(0);
  });

  it('throws when the DCQL rule does not pin a key and no cached value exists', async () => {
    vi.mocked(fetchRequestObject).mockResolvedValue({
      claims: {
        dcql_query: {
          credentials: [
            {
              format: 'dc+sd-jwt',
              meta: { vct_values: ['DocumentReader'] },
              // Empty values = "any key", not a pinned value.
              claims: [{ path: ['key'], values: [] }],
            },
          ],
        },
      },
    } as any);

    await expect(service.resolveKeyValue(SLOT_A)).rejects.toThrow(ApiException);
    expect(openVerifierAgentSession).toHaveBeenCalledTimes(1);
    expect(fetchRequestObject).toHaveBeenCalledTimes(1);
  });
});