import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiException } from '../common/api-exception';
import type { GatewayConfig } from '../config/configuration';
import { TasraDcqlService } from '../tasra/dcql.service';

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
  createLocalWallet: vi.fn().mockReturnValue({ signer: {} }),
}));

vi.mock('../tasra/network.json', () => ({ default: {} }));

// Import after mocks so the factory wrappers reference the same vi.fn instances.
import { openVerifierAgentSession, fetchRequestObject } from '@t3foundry/tasra-sdk/oid4vp';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SLOT_A = `0x${'aa'.repeat(32)}` as `0x${string}`;
const SLOT_B = `0x${'bb'.repeat(32)}` as `0x${string}`;

const KEY_A = `0x${'a1'.repeat(32)}`;
const KEY_B = `0x${'b1'.repeat(32)}`;

const CREATOR_SEED = `0x${'fe'.repeat(32)}`;

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

const config: GatewayConfig = {
  tasra: { creatorSeed: CREATOR_SEED },
} as GatewayConfig;

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

    service = new TasraDcqlService(config, noopLogger);
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