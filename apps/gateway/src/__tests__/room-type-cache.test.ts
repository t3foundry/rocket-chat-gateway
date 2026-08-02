import { describe, expect, it, vi } from 'vitest';

import { RoomsService } from '../rooms/rooms.service';
import type { RocketChatService } from '../rocketchat/rocketchat.service';
import type { ServerSession } from '../session/session.types';

const session = (serverId: string): ServerSession => ({
  id: 'session-1',
  serverId,
  rocketChatUserId: 'u1',
  rocketChatAuthToken: 'token',
  username: 'quy',
});

/**
 * Just enough of `RocketChatService` for the type lookup, with a counter so a
 * test can assert what actually reached Rocket.Chat.
 */
const stubRocketChat = (types: Record<string, string>) => {
  const info = vi.fn(async (roomId: string) => {
    const t = types[roomId];
    if (!t) throw new Error(`no such room: ${roomId}`);
    return { _id: roomId, t };
  });

  const service = {
    userClient: () => ({ rooms: { info } }),
    adapterContext: () => ({
      currentUserId: 'u1',
      currentUsername: 'quy',
      avatarUrl: () => null,
      fileUrl: (path: string) => path,
    }),
  } as unknown as RocketChatService;

  return { service, info };
};

describe('room type cache', () => {
  it('asks Rocket.Chat once and answers the rest from memory', async () => {
    const { service, info } = stubRocketChat({ 'room-1': 'c' });
    const rooms = new RoomsService(service);

    await expect(rooms.roomType(session('acme'), 'room-1')).resolves.toBe('c');
    await expect(rooms.roomType(session('acme'), 'room-1')).resolves.toBe('c');
    await expect(rooms.roomType(session('acme'), 'room-1')).resolves.toBe('c');

    // Rocket.Chat namespaces history by type, so this lookup precedes every
    // page of every room. Repeating it doubles the round-trips of the busiest
    // route in the product.
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('keeps the same room id on two servers apart', async () => {
    const { service, info } = stubRocketChat({ 'shared-id': 'c' });
    const rooms = new RoomsService(service);

    await rooms.roomType(session('acme'), 'shared-id');
    await rooms.roomType(session('contoso'), 'shared-id');

    // Ids are unique only within one server, so a cache hit across servers
    // would hand the second server a type from the first.
    expect(info).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed lookup', async () => {
    const { service, info } = stubRocketChat({});
    const rooms = new RoomsService(service);

    await expect(rooms.roomType(session('acme'), 'missing')).rejects.toThrow();
    await expect(rooms.roomType(session('acme'), 'missing')).rejects.toThrow();

    // A room that appears later — an invite accepted in another tab — has to
    // be reachable without restarting the gateway.
    expect(info).toHaveBeenCalledTimes(2);
  });
});
