import { describe, expect, it } from 'vitest';

import {
  ClientCommandSchema,
  ListMessagesQuerySchema,
  ListRoomsQuerySchema,
  ServerEventSchema,
  SlashCommandSchema,
  UpdateMyStatusRequestSchema,
  UpdateRoomStateRequestSchema,
} from '../index.js';

describe('query schemas', () => {
  it('coerces query strings, which always arrive as text', () => {
    const parsed = ListMessagesQuerySchema.parse({ limit: '25', includeThreadReplies: 'true' });

    expect(parsed.limit).toBe(25);
    expect(parsed.includeThreadReplies).toBe(true);
  });

  it('applies defaults for an empty query', () => {
    expect(ListMessagesQuerySchema.parse({})).toMatchObject({ limit: 50, includeThreadReplies: false });
  });

  it('rejects an out-of-range limit rather than silently clamping', () => {
    expect(ListMessagesQuerySchema.safeParse({ limit: '5000' }).success).toBe(false);
  });

  it('accepts a room type filter as one value or many', () => {
    expect(ListRoomsQuerySchema.parse({ types: 'channel' }).types).toEqual(['channel']);
    expect(ListRoomsQuerySchema.parse({ types: ['channel', 'direct'] }).types).toEqual(['channel', 'direct']);
  });

  it('requires a room state patch to change something', () => {
    expect(UpdateRoomStateRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateRoomStateRequestSchema.safeParse({ favorite: true }).success).toBe(true);
  });
});

describe('slash command schema', () => {
  it('accepts Rocket.Chat commands guarded by any of several permissions', () => {
    const command = SlashCommandSchema.parse({
      command: 'create',
      params: null,
      description: null,
      clientOnly: false,
      providesPreview: false,
      permission: ['create-c', 'create-p'],
    });

    expect(command.permission).toEqual(['create-c', 'create-p']);
  });
});

describe('status schema', () => {
  it('takes presence and message together or on their own', () => {
    expect(UpdateMyStatusRequestSchema.safeParse({ status: 'busy' }).success).toBe(true);
    expect(UpdateMyStatusRequestSchema.safeParse({ statusText: 'In a meeting' }).success).toBe(true);
    expect(UpdateMyStatusRequestSchema.safeParse({ status: 'away', statusText: 'Back at 3' }).success).toBe(true);
  });

  it('treats an empty message as "clear it", not as a missing field', () => {
    expect(UpdateMyStatusRequestSchema.safeParse({ statusText: '' }).success).toBe(true);
  });

  it('rejects a patch that changes nothing', () => {
    expect(UpdateMyStatusRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an unknown presence and an over-long message', () => {
    expect(UpdateMyStatusRequestSchema.safeParse({ status: 'lunch' }).success).toBe(false);
    expect(UpdateMyStatusRequestSchema.safeParse({ statusText: 'x'.repeat(121) }).success).toBe(false);
  });
});

describe('realtime schemas', () => {
  it('discriminates server events by type', () => {
    const parsed = ServerEventSchema.parse({
      type: 'message.deleted',
      serverId: 'acme',
      roomId: 'r1',
      messageId: 'm1',
    });

    expect(parsed.type).toBe('message.deleted');
  });

  it('rejects an unknown event type', () => {
    expect(ServerEventSchema.safeParse({ type: 'message.exploded', serverId: 'acme', roomId: 'r1' }).success).toBe(
      false,
    );
  });

  it('requires every event to name the server it came from', () => {
    // One socket carries several Rocket.Chat servers, and room ids are only
    // unique within one of them — an unscoped event cannot be routed.
    expect(ServerEventSchema.safeParse({ type: 'message.deleted', roomId: 'r1', messageId: 'm1' }).success).toBe(false);
  });

  it('validates client commands, so a malformed frame cannot reach the upstream', () => {
    expect(ClientCommandSchema.safeParse({ type: 'room.subscribe', serverId: 'acme', roomId: 'r1' }).success).toBe(
      true,
    );
    // A missing roomId used to reach `subscribeRoom` as `undefined`.
    expect(ClientCommandSchema.safeParse({ type: 'room.subscribe', serverId: 'acme' }).success).toBe(false);
    // Without a server the gateway would have to guess which upstream to
    // subscribe on, so the command is rejected instead.
    expect(ClientCommandSchema.safeParse({ type: 'room.subscribe', roomId: 'r1' }).success).toBe(false);
    expect(
      ClientCommandSchema.safeParse({ type: 'typing.set', serverId: 'acme', roomId: 'r1', typing: 'yes' }).success,
    ).toBe(false);
  });

  it('leaves the keepalive unscoped, since it belongs to the socket', () => {
    expect(ClientCommandSchema.safeParse({ type: 'ping' }).success).toBe(true);
  });

  it('carries everything a desktop notification needs to be shown and clicked', () => {
    const parsed = ServerEventSchema.parse({
      type: 'notification',
      serverId: 'acme',
      title: 'general',
      text: 'Quy: deploy is green',
      duration: null,
      payload: {
        messageId: 'm1',
        roomId: 'r1',
        threadId: null,
        roomType: 'channel',
        roomName: 'general',
        sender: { id: 'u1', username: 'quy', displayName: 'Quy', avatarUrl: null, status: null },
        sound: null,
      },
    });

    expect(parsed).toMatchObject({ type: 'notification', payload: { roomId: 'r1' } });
  });

  it('rejects a notification with no message to open', () => {
    // Clicking one navigates to the message; without an id there is nowhere to
    // go, and a notification that does nothing is worse than none at all.
    const withoutMessage = {
      type: 'notification',
      serverId: 'acme',
      title: 'general',
      text: 'deploy is green',
      duration: null,
      payload: {
        roomId: 'r1',
        threadId: null,
        roomType: 'channel',
        roomName: 'general',
        sender: { id: 'u1', username: 'quy', displayName: 'Quy', avatarUrl: null, status: null },
        sound: null,
      },
    };

    expect(ServerEventSchema.safeParse(withoutMessage).success).toBe(false);
  });
});
