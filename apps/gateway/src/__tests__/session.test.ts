import { RocketChatApiError, RocketChatTransportError } from '@t3foundry/open-rocket-chat-rc-rest-client';
import { describe, expect, it } from 'vitest';

import { toApiException } from '../common/upstream-error';
import { loadConfig } from '../config/configuration';
import { MemorySessionStore } from '../session/memory-session.store';
import { SessionService } from '../session/session.service';
import { connectionFor } from '../session/session.types';
import type { GatewayConfig } from '../config/configuration';

const baseEnv = {
  ROCKETCHAT_SERVERS: 'http://localhost:3000',
  SESSION_SECRET: 'a-secret-that-is-at-least-32-characters-long',
};

const newSessions = (config: GatewayConfig = loadConfig(baseEnv as NodeJS.ProcessEnv)) =>
  new SessionService(config, new MemorySessionStore());

const connection = (serverId: string, username = 'quy') => ({
  serverId,
  rocketChatUserId: `u-${serverId}`,
  rocketChatAuthToken: `token-${serverId}`,
  username,
});

describe('multi-server sessions', () => {
  it('holds several servers at once', async () => {
    const sessions = newSessions();

    const first = await sessions.connect(null, connection('acme'));
    const both = await sessions.connect(first, connection('contoso'));

    expect(both.id).toBe(first.id);
    expect(both.connections.map((entry) => entry.serverId)).toEqual(['acme', 'contoso']);
    // The first server signed in to stays the fallback for unscoped requests.
    expect(both.defaultServerId).toBe('acme');
  });

  it('replaces the credentials when signing in to a server again', async () => {
    const sessions = newSessions();

    const first = await sessions.connect(null, connection('acme'));
    const again = await sessions.connect(first, { ...connection('acme'), rocketChatAuthToken: 'fresher' });

    // A re-login after an expired upstream token must not leave two entries.
    expect(again.connections).toHaveLength(1);
    expect(again.connections[0]?.rocketChatAuthToken).toBe('fresher');
  });

  it('scopes a request to the server it names', async () => {
    const sessions = newSessions();
    const first = await sessions.connect(null, connection('acme'));
    const session = await sessions.connect(first, connection('contoso'));

    expect(connectionFor(session, 'contoso')?.rocketChatAuthToken).toBe('token-contoso');
    // No header falls back to the default rather than picking arbitrarily.
    expect(connectionFor(session, undefined)?.serverId).toBe('acme');
    expect(connectionFor(session, 'never-signed-in')).toBeNull();
  });

  it('moves the default when the default server disconnects', async () => {
    const sessions = newSessions();
    const first = await sessions.connect(null, connection('acme'));
    const session = await sessions.connect(first, connection('contoso'));

    const remaining = await sessions.disconnect(session, 'acme');

    expect(remaining?.connections.map((entry) => entry.serverId)).toEqual(['contoso']);
    // Leaving it pointing at a disconnected server would break every
    // unscoped request that followed.
    expect(remaining?.defaultServerId).toBe('contoso');
  });

  it('ends the session when the last server disconnects', async () => {
    const sessions = newSessions();
    const session = await sessions.connect(null, connection('acme'));

    expect(await sessions.disconnect(session, 'acme')).toBeNull();
    expect(await sessions.get(session.id)).toBeNull();
  });
});

describe('configuration', () => {
  it('accepts a bare URL for the single-server case', () => {
    const config = loadConfig(baseEnv as NodeJS.ProcessEnv);

    expect(config.servers).toEqual([{ id: 'default', name: 'Rocket.Chat', url: 'http://localhost:3000' }]);
    expect(config.defaultServerId).toBe('default');
  });

  it('accepts a JSON array for multi-server deployments', () => {
    const config = loadConfig({
      ...baseEnv,
      ROCKETCHAT_SERVERS: '[{"id":"a","name":"A","url":"http://a:3000"},{"id":"b","name":"B","url":"http://b:3000"}]',
    } as NodeJS.ProcessEnv);

    expect(config.servers.map((server) => server.id)).toEqual(['a', 'b']);
  });

  it('rejects a short session secret instead of starting insecurely', () => {
    expect(() => loadConfig({ ...baseEnv, SESSION_SECRET: 'too-short' } as NodeJS.ProcessEnv)).toThrow(
      /SESSION_SECRET/,
    );
  });

  it('forces Secure when SameSite=None, which browsers require', () => {
    const config = loadConfig({ ...baseEnv, SESSION_COOKIE_SAMESITE: 'none' } as NodeJS.ProcessEnv);

    expect(config.session.secure).toBe(true);
  });
});

describe('session cookies', () => {
  it('round-trips a signed session id', () => {
    const sessions = newSessions();
    expect(sessions.verify(sessions.sign('abc123'))).toBe('abc123');
  });

  it('rejects a tampered id', () => {
    const sessions = newSessions();
    const signed = sessions.sign('abc123');

    expect(sessions.verify(signed.replace('abc123', 'abc124'))).toBeNull();
  });

  it('rejects a cookie signed with a different secret', () => {
    const mine = newSessions();
    const theirs = newSessions(
      loadConfig({ ...baseEnv, SESSION_SECRET: 'a-completely-different-secret-value-here' } as NodeJS.ProcessEnv),
    );

    expect(mine.verify(theirs.sign('abc123'))).toBeNull();
  });

  it.each([undefined, '', 'no-separator', '.onlysignature', 'id.'])('rejects the malformed cookie %j', (value) => {
    expect(newSessions().verify(value as string | undefined)).toBeNull();
  });

  it('issues unguessable ids', async () => {
    const sessions = newSessions();
    const ids = new Set<string>();

    for (let i = 0; i < 50; i += 1) {
      const record = await sessions.connect(null, connection('default'));
      ids.add(record.id);
      expect(record.id.length).toBeGreaterThanOrEqual(43);
    }

    expect(ids.size).toBe(50);
  });

  it('expires a session once its lifetime elapses', async () => {
    const config = loadConfig({ ...baseEnv, SESSION_TTL_SECONDS: '60' } as NodeJS.ProcessEnv);
    const store = new MemorySessionStore();
    const sessions = new SessionService(config, store);

    const record = await sessions.connect(null, connection('default'));

    expect(await sessions.get(record.id)).not.toBeNull();

    await store.set({ ...record, expiresAt: Date.now() - 1 });
    expect(await sessions.get(record.id)).toBeNull();
  });
});

describe('upstream error mapping', () => {
  it('surfaces a two-factor challenge as its own code, not a bare 401', () => {
    const mapped = toApiException(new RocketChatApiError(401, 'TOTP Required', 'totp-required'));

    expect(mapped.code).toBe('totp_required');
  });

  it('maps a missing route to `unsupported_by_server`', () => {
    const mapped = toApiException(new RocketChatApiError(404, 'unknown', 'unknown-endpoint'));

    expect(mapped.code).toBe('unsupported_by_server');
    expect(mapped.getStatus()).toBe(501);
  });

  it('distinguishes an unreachable server from one that returned an error', () => {
    expect(toApiException(new RocketChatTransportError('nope', undefined, false)).code).toBe('upstream_unavailable');
    expect(toApiException(new RocketChatApiError(500, 'boom')).code).toBe('upstream_error');
  });

  it('does not leak the upstream message into the client-facing text', () => {
    const mapped = toApiException(new RocketChatApiError(500, 'MongoError: connection refused at /app/x.js:12'));

    expect(JSON.stringify(mapped.getResponse())).not.toContain('MongoError');
  });

  it('preserves the upstream identifier for debugging', () => {
    const mapped = toApiException(new RocketChatApiError(403, 'nope', 'error-not-allowed'));

    expect(mapped.upstream).toBe('error-not-allowed');
    expect(mapped.code).toBe('forbidden');
  });
});
