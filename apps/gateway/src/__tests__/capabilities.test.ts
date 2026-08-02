import { afterEach, describe, expect, it, vi } from 'vitest';

import { CapabilitiesService } from '../capabilities/capabilities.service';
import type { ServerSession } from '../session/session.types';

const session: ServerSession = {
  id: 'session-1',
  serverId: 'https://chat.test',
  rocketChatUserId: 'u1',
  rocketChatAuthToken: 'token',
  username: 'quy',
};

const logger = {
  setContext: vi.fn(),
  warn: vi.fn(),
};

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('CapabilitiesService', () => {
  it('returns every Rocket.Chat permission and the public settings used by the client', async () => {
    const userClient = {
      settings: {
        publicSettings: vi.fn().mockResolvedValue(
          new Map<string, unknown>([
            ['Favorite_Rooms', false],
            ['FileUpload_Enabled_Direct', false],
            ['Presence_broadcast_disabled', true],
          ]),
        ),
        permissions: vi.fn().mockResolvedValue([
          { _id: 'mention-all', roles: ['owner'] },
          { _id: 'permission-from-an-app', roles: ['custom-role'] },
        ]),
      },
      users: { me: vi.fn().mockResolvedValue({ roles: ['user'] }) },
    };
    const rocketChat = { userClient: vi.fn(() => userClient) };
    const service = new CapabilitiesService(rocketChat as never, logger as never);

    const result = await service.get(session);

    expect(result.permissions).toEqual({
      rolesByPermission: {
        'mention-all': ['owner'],
        'permission-from-an-app': ['custom-role'],
      },
      userRoles: ['user'],
    });
    expect(result.settings.ui.favoriteRooms).toBe(false);
    expect(result.settings.fileUpload.enabledDirect).toBe(false);
    expect(result.settings.presence.broadcastDisabled).toBe(true);
  });

  it('fails closed when no real capability response has ever been read', async () => {
    const userClient = {
      settings: {
        publicSettings: vi.fn().mockRejectedValue(new Error('upstream unavailable')),
        permissions: vi.fn().mockResolvedValue([]),
      },
      users: { me: vi.fn() },
    };
    const service = new CapabilitiesService({ userClient: () => userClient } as never, logger as never);

    await expect(service.get(session)).rejects.toBeTruthy();
    expect(userClient.users.me).not.toHaveBeenCalled();
  });

  it('uses an expired last-known-good response during a temporary outage', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T00:00:00.000Z'));

    const publicSettings = vi.fn().mockResolvedValue(new Map<string, unknown>([['FileUpload_Enabled', false]]));
    const permissions = vi.fn().mockResolvedValue([{ _id: 'create-c', roles: ['user'] }]);
    const userClient = {
      settings: { publicSettings, permissions },
      users: { me: vi.fn().mockResolvedValue({ roles: ['user'] }) },
    };
    const service = new CapabilitiesService({ userClient: () => userClient } as never, logger as never);

    const initial = await service.get(session);
    expect(initial.settings.fileUpload.enabled).toBe(false);

    vi.advanceTimersByTime(60_001);
    publicSettings.mockRejectedValueOnce(new Error('temporary outage'));
    permissions.mockRejectedValueOnce(new Error('temporary outage'));

    const stale = await service.get(session);
    expect(stale.settings.fileUpload.enabled).toBe(false);
    expect(stale.permissions.rolesByPermission['create-c']).toEqual(['user']);
  });
});
