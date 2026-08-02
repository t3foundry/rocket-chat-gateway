import {
  MessageSchema,
  REALTIME_PROTOCOL_VERSION,
  RoomSummarySchema,
  ServerEventSchema,
  type ServerEvent,
} from '@open-rocket-chat/api-contract';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  GatewayClient,
  seedTestRoom,
  startGateway,
  waitForRocketChat,
} from './harness';

let app: NestFastifyApplication;
let baseUrl: string;
let client: GatewayClient;
let roomId: string;
let roomName: string;

beforeAll(async () => {
  await waitForRocketChat();
  ({ roomId, name: roomName } = await seedTestRoom());
  ({ app, baseUrl } = await startGateway());
  client = new GatewayClient(baseUrl);
}, 240_000);

afterAll(async () => {
  await app?.close();
});

describe('auth', () => {
  it('rejects protected routes without a session', async () => {
    const anonymous = new GatewayClient(baseUrl);
    const response = await anonymous.get('/rooms');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('unauthorized');
  });

  it('rejects bad credentials with a stable error code', async () => {
    const anonymous = new GatewayClient(baseUrl);
    const response = await anonymous.post('/auth/login', { user: ADMIN_USERNAME, password: 'definitely-wrong' });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('unauthorized');
  });

  it('logs in and sets an HttpOnly session cookie', async () => {
    const response = await client.post('/auth/login', { user: ADMIN_USERNAME, password: ADMIN_PASSWORD });

    expect(response.status).toBe(200);
    // A session is a list of server connections, even with just the one.
    expect(response.body.connections).toHaveLength(1);
    expect(response.body.connections[0].user.username).toBe(ADMIN_USERNAME);
    expect(response.body.defaultServerId).toBe('default');

    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie.toLowerCase()).toContain('httponly');

    // The whole point of the gateway: no Rocket.Chat credential reaches the client.
    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain('authToken');
    expect(serialised).not.toContain('X-Auth-Token');
  });

  it('scopes a request to the server named in the header', async () => {
    const response = await client.request('/rooms', { headers: { 'x-server-id': 'default' } });

    expect(response.status).toBe(200);
  });

  it('refuses a server this session is not signed in to', async () => {
    // 401 rather than 404: the room may well exist, just not for this caller.
    const response = await client.request('/rooms', { headers: { 'x-server-id': 'not-connected' } });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('unauthorized');
  });

  it('returns the current session', async () => {
    const response = await client.get('/auth/session');

    expect(response.status).toBe(200);
    expect(response.body.connections[0].user.username).toBe(ADMIN_USERNAME);
    expect(response.body.connections[0].server.id).toBe('default');
  });
});

describe('rooms', () => {
  it('lists rooms joined with subscription state', async () => {
    const response = await client.get('/rooms');

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.items)).toBe(true);
    expect(response.body.items.length).toBeGreaterThan(0);

    for (const room of response.body.items) {
      expect(() => RoomSummarySchema.parse(room)).not.toThrow();
    }

    const fixture = response.body.items.find((room: any) => room.name === roomName);
    expect(fixture).toBeDefined();
    expect(fixture.id).toBe(roomId);
  });

  it('fetches a single room', async () => {
    const response = await client.get(`/rooms/${roomId}`);

    expect(response.status).toBe(200);
    expect(RoomSummarySchema.parse(response.body).id).toBe(roomId);
  });

  it('lists room members', async () => {
    const response = await client.get(`/rooms/${roomId}/members`);

    expect(response.status).toBe(200);
    expect(response.body.items.some((user: any) => user.username === ADMIN_USERNAME)).toBe(true);
  });

  it('toggles favourite state', async () => {
    const favourited = await client.patch(`/rooms/${roomId}/state`, { favorite: true });
    expect(favourited.status).toBe(200);
    expect(favourited.body.favorite).toBe(true);

    const cleared = await client.patch(`/rooms/${roomId}/state`, { favorite: false });
    expect(cleared.body.favorite).toBe(false);
  });

  it('rejects an empty state patch', async () => {
    const response = await client.patch(`/rooms/${roomId}/state`, {});

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('bad_request');
  });

  it('marks a room as read', async () => {
    const response = await client.post(`/rooms/${roomId}/read`);
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });
});

describe('messages', () => {
  let messageId: string;

  it('sends a message', async () => {
    const response = await client.post(`/rooms/${roomId}/messages`, { text: 'hello from the gateway e2e' });

    expect(response.status).toBe(201);
    const message = MessageSchema.parse(response.body);
    expect(message.text).toBe('hello from the gateway e2e');
    expect(message.sender.username).toBe(ADMIN_USERNAME);
    expect(message.kind).toBe('user');

    messageId = message.id;
  });

  it('honours a client-supplied id so retries are idempotent', async () => {
    const clientMessageId = `e2e${Date.now()}`;
    const first = await client.post(`/rooms/${roomId}/messages`, {
      text: 'idempotent send',
      clientMessageId,
    });

    expect(first.status).toBe(201);
    expect(first.body.id).toBe(clientMessageId);
  });

  it('lists messages oldest first', async () => {
    const response = await client.get(`/rooms/${roomId}/messages?limit=20`);

    expect(response.status).toBe(200);
    expect(response.body.gapBefore).toBe(false);

    const items = response.body.items as any[];
    expect(items.length).toBeGreaterThan(0);
    for (const message of items) {
      expect(() => MessageSchema.parse(message)).not.toThrow();
    }

    const timestamps = items.map((message) => message.createdAt);
    expect([...timestamps].sort()).toEqual(timestamps);
    expect(items.some((message) => message.id === messageId)).toBe(true);
  });

  it('edits a message', async () => {
    const response = await client.patch(`/rooms/${roomId}/messages/${messageId}`, { text: 'edited by e2e' });

    expect(response.status).toBe(200);
    expect(response.body.text).toBe('edited by e2e');
    expect(response.body.editedAt).not.toBeNull();
  });

  it('adds and removes a reaction', async () => {
    const added = await client.put(`/rooms/${roomId}/messages/${messageId}/reactions/${encodeURIComponent(':tada:')}`);
    expect(added.status).toBe(200);

    const listed = await client.get(`/rooms/${roomId}/messages?limit=20`);
    const reacted = (listed.body.items as any[]).find((message) => message.id === messageId);
    expect(reacted.reactions.some((reaction: any) => reaction.emoji === ':tada:' && reaction.reactedByMe)).toBe(true);

    const removed = await client.delete(
      `/rooms/${roomId}/messages/${messageId}/reactions/${encodeURIComponent(':tada:')}`,
    );
    expect(removed.status).toBe(200);
  });

  it('pins and stars a message', async () => {
    expect((await client.post(`/rooms/${roomId}/messages/${messageId}/pin`)).status).toBe(200);
    expect((await client.post(`/rooms/${roomId}/messages/${messageId}/star`)).status).toBe(200);

    const listed = await client.get(`/rooms/${roomId}/messages?limit=20`);
    const flagged = (listed.body.items as any[]).find((message) => message.id === messageId);
    expect(flagged.pinned).toBe(true);
    expect(flagged.starred).toBe(true);

    expect((await client.delete(`/rooms/${roomId}/messages/${messageId}/pin`)).status).toBe(200);
    expect((await client.delete(`/rooms/${roomId}/messages/${messageId}/star`)).status).toBe(200);
  });

  it('replies in a thread', async () => {
    const reply = await client.post(`/rooms/${roomId}/messages`, {
      text: 'threaded reply',
      threadId: messageId,
    });

    expect(reply.status).toBe(201);
    expect(reply.body.threadId).toBe(messageId);

    const thread = await client.get(`/rooms/${roomId}/messages?threadId=${messageId}`);
    expect(thread.body.items.some((message: any) => message.text === 'threaded reply')).toBe(true);
  });

  it('deletes a message', async () => {
    const standalone = await client.post(`/rooms/${roomId}/messages`, { text: 'delete me' });
    expect((await client.delete(`/rooms/${roomId}/messages/${standalone.body.id}`)).status).toBe(200);

    const listed = await client.get(`/rooms/${roomId}/messages?limit=50`);
    expect((listed.body.items as any[]).some((message) => message.id === standalone.body.id)).toBe(false);
  });

  it('leaves a tombstone when deleting a message that has thread replies', async () => {
    // Rocket.Chat cannot remove a thread parent outright without orphaning its
    // replies, so it rewrites the record as a system message of type `rm`.
    // Clients must render that as "message removed" rather than as a blank.
    expect((await client.delete(`/rooms/${roomId}/messages/${messageId}`)).status).toBe(200);

    const listed = await client.get(`/rooms/${roomId}/messages?limit=50`);
    const tombstone = (listed.body.items as any[]).find((message) => message.id === messageId);

    expect(tombstone).toBeDefined();
    expect(tombstone.kind).toBe('system');
    expect(tombstone.systemType).toBe('rm');
    expect(tombstone.text).toBe('');
  });
});

describe('files', () => {
  it('uploads a file and returns the resulting message', async () => {
    const form = new FormData();
    form.set('file', new Blob([Buffer.from('gateway upload test')], { type: 'text/plain' }), 'note.txt');
    form.set('description', 'uploaded by e2e');

    const response = await fetch(`${baseUrl}/api/v1/rooms/${roomId}/files`, {
      method: 'POST',
      headers: { cookie: client.sessionCookie ?? '' },
      body: form,
    });

    expect(response.status).toBe(201);
    const message = MessageSchema.parse(await response.json());
    expect(message.files.length).toBeGreaterThan(0);
    expect(message.files[0]?.name).toBe('note.txt');
    // The URL must point at the gateway, never at Rocket.Chat directly.
    expect(message.files[0]?.url.startsWith('/api/v1/files/')).toBe(true);
  });

  it('streams an uploaded file back through the gateway', async () => {
    const listed = await client.get(`/rooms/${roomId}/messages?limit=20`);
    const withFile = (listed.body.items as any[]).find((message) => message.files.length > 0);
    expect(withFile).toBeDefined();

    const response = await fetch(`${baseUrl}${withFile.files[0].url}`, {
      headers: { cookie: client.sessionCookie ?? '' },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('gateway upload test');
  });

  it('refuses to serve files without a session', async () => {
    const response = await fetch(`${baseUrl}/api/v1/files/file-upload/whatever/x.txt`);
    expect(response.status).toBe(401);
  });
});

describe('users', () => {
  it('reads a profile', async () => {
    const response = await client.get(`/users/${ADMIN_USERNAME}`);

    expect(response.status).toBe(200);
    expect(response.body.username).toBe(ADMIN_USERNAME);
    expect(response.body.avatarUrl).toContain('/api/v1/avatars/');
  });

  it('searches users', async () => {
    const response = await client.get(`/users/search?q=${ADMIN_USERNAME.slice(0, 3)}`);
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.items)).toBe(true);
  });

  it('sets presence and status message, and clears the message again', async () => {
    const set = await client.patch('/users/me/status', { status: 'busy', statusText: 'Writing tests' });

    expect(set.status).toBe(200);
    expect(set.body.status).toBe('busy');
    expect(set.body.statusText).toBe('Writing tests');

    // An empty string is a value here, not an omission: it is how the message
    // is removed without touching the presence set above.
    const cleared = await client.patch('/users/me/status', { statusText: '' });

    expect(cleared.status).toBe(200);
    // Rocket.Chat drops the field rather than storing an empty one, so both
    // shapes mean "no message".
    expect(cleared.body.statusText ?? '').toBe('');
    expect(cleared.body.status).toBe('busy');

    await client.patch('/users/me/status', { status: 'online' });
  });

  it('rejects a status patch that changes nothing', async () => {
    expect((await client.patch('/users/me/status', {})).status).toBe(400);
  });
});

describe('realtime', () => {
  /**
   * A socket that records every event from the moment it is constructed.
   *
   * `connection.ready` can arrive in the same tick as the upgrade when the
   * session already has a warm upstream connection, so a listener attached
   * after awaiting `open` is not guaranteed to see it. Buffering from
   * construction removes that race from the assertions.
   */
  class RecordingSocket {
    readonly received: ServerEvent[] = [];

    private readonly waiters = new Set<(event: ServerEvent) => void>();

    constructor(readonly socket: WebSocket) {
      socket.on('message', (data) => {
        const parsed = ServerEventSchema.safeParse(JSON.parse(String(data)));
        if (!parsed.success) {
          throw new Error(`Gateway emitted an event that violates the contract: ${String(data).slice(0, 200)}`);
        }

        this.received.push(parsed.data);
        for (const waiter of [...this.waiters]) waiter(parsed.data);
      });
    }

    send(command: unknown): void {
      this.socket.send(JSON.stringify(command));
    }

    /** Resolves from the buffer when the event already arrived, otherwise waits. */
    waitFor<T extends ServerEvent['type']>(type: T, timeoutMs = 20_000): Promise<Extract<ServerEvent, { type: T }>> {
      const buffered = this.received.find((event) => event.type === type);
      if (buffered) return Promise.resolve(buffered as Extract<ServerEvent, { type: T }>);

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`Timed out waiting for \`${type}\`; saw: ${this.received.map((e) => e.type).join(', ')}`));
        }, timeoutMs);

        const waiter = (event: ServerEvent): void => {
          if (event.type !== type) return;
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve(event as Extract<ServerEvent, { type: T }>);
        };

        this.waiters.add(waiter);
      });
    }

    /** Forgets buffered events so a later `waitFor` cannot match an earlier one. */
    reset(): void {
      this.received.length = 0;
    }

    close(): void {
      this.socket.close();
    }
  }

  const openSocket = async (cookie: string): Promise<RecordingSocket> => {
    const socket = new WebSocket(`${baseUrl.replace('http://', 'ws://')}/ws`, {
      headers: { cookie, origin: 'http://localhost:5173' },
    });

    // Recording starts before `open` is awaited, so nothing can slip past.
    const recording = new RecordingSocket(socket);

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

    return recording;
  };

  it('rejects an unauthenticated upgrade', async () => {
    const socket = new WebSocket(`${baseUrl.replace('http://', 'ws://')}/ws`);

    await expect(
      new Promise((resolve, reject) => {
        socket.once('open', () => resolve('opened'));
        socket.once('error', reject);
      }),
    ).rejects.toThrow();
  });

  it('rejects an upgrade from a disallowed origin', async () => {
    const socket = new WebSocket(`${baseUrl.replace('http://', 'ws://')}/ws`, {
      headers: { cookie: client.sessionCookie ?? '', origin: 'https://evil.example.com' },
    });

    await expect(
      new Promise((resolve, reject) => {
        socket.once('open', () => resolve('opened'));
        socket.once('error', reject);
      }),
    ).rejects.toThrow();
  });

  it('delivers a message.created event for a subscribed room', async () => {
    const socket = await openSocket(client.sessionCookie ?? '');

    try {
      const ready = await socket.waitFor('connection.ready');
      // One ready event per attached server, each naming the server it is for.
      expect(ready).toMatchObject({
        type: 'connection.ready',
        protocolVersion: REALTIME_PROTOCOL_VERSION,
        serverId: 'default',
      });

      socket.send({ type: 'room.subscribe', serverId: 'default', roomId });

      // Rocket.Chat needs a moment to register the DDP subscription; posting
      // immediately would race it and the event would never be produced.
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      const expected = `realtime probe ${Date.now()}`;
      const eventPromise = socket.waitFor('message.created');
      await client.post(`/rooms/${roomId}/messages`, { text: expected });

      const event = await eventPromise;
      expect(event.serverId).toBe('default');
      expect(event.roomId).toBe(roomId);
      expect(event.message.text).toBe(expected);
      expect(() => MessageSchema.parse(event.message)).not.toThrow();
    } finally {
      socket.close();
    }
  }, 60_000);

  it('delivers message.deleted for a subscribed room', async () => {
    const socket = await openSocket(client.sessionCookie ?? '');

    try {
      await socket.waitFor('connection.ready');
      socket.send({ type: 'room.subscribe', serverId: 'default', roomId });
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      const sent = await client.post(`/rooms/${roomId}/messages`, { text: 'to be deleted' });
      socket.reset();

      const eventPromise = socket.waitFor('message.deleted');
      await client.delete(`/rooms/${roomId}/messages/${sent.body.id}`);

      const event = await eventPromise;
      expect(event.messageId).toBe(sent.body.id);
    } finally {
      socket.close();
    }
  }, 60_000);
});

describe('logout', () => {
  it('destroys the session', async () => {
    expect((await client.post('/auth/logout')).status).toBe(204);
    expect((await client.get('/auth/session')).status).toBe(401);
  });
});
