import { describe, expect, it, vi } from 'vitest';

import { DdpClient } from '../ddp.js';
import { RocketChatRealtimeClient, toWebSocketUrl } from '../realtime.js';

type Listener = (event: unknown) => void;

/**
 * A scriptable stand-in for `WebSocket`. Only the four events and the two
 * methods the client actually uses are implemented.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];

  readyState = 0;

  readonly sent: string[] = [];

  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    let bucket = this.listeners.get(type);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(type, bucket);
    }
    bucket.add(listener);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', { code: 1000, reason: 'closed' });
  }

  // --- test controls -------------------------------------------------------

  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  receive(frame: unknown): void {
    this.emit('message', { data: JSON.stringify(frame) });
  }

  drop(code = 1006): void {
    this.readyState = 3;
    this.emit('close', { code, reason: 'dropped' });
  }

  frames(): any[] {
    return this.sent.map((payload) => JSON.parse(payload));
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const fakeWebSocket = FakeSocket as unknown as typeof WebSocket;

const newClient = (options: Partial<ConstructorParameters<typeof DdpClient>[0]> = {}) => {
  FakeSocket.instances = [];
  const client = new DdpClient({
    url: 'ws://chat.test/websocket',
    webSocketImpl: fakeWebSocket,
    heartbeatIntervalMs: 0,
    ...options,
  });
  return client;
};

/** Completes the DDP handshake on the most recently created socket. */
const handshake = async (client: DdpClient, connecting: Promise<void>): Promise<FakeSocket> => {
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1]!;
  socket.open();
  socket.receive({ msg: 'connected', session: 'session-1' });
  await connecting;
  return socket;
};

describe('toWebSocketUrl', () => {
  it.each([
    ['https://chat.test', 'wss://chat.test/websocket'],
    ['http://localhost:3000', 'ws://localhost:3000/websocket'],
    ['https://chat.test/rocket/', 'wss://chat.test/rocket/websocket'],
  ])('maps %s to %s', (input, expected) => {
    expect(toWebSocketUrl(input)).toBe(expected);
  });
});

describe('DdpClient', () => {
  it('sends the DDP connect frame and resolves on `connected`', async () => {
    const client = newClient();
    const socket = await handshake(client, client.connect());

    expect(socket.frames()[0]).toMatchObject({ msg: 'connect', version: '1' });
    expect(client.isConnected).toBe(true);
    client.close();
  });

  it('answers server pings so the connection is not reaped', async () => {
    const client = newClient();
    const socket = await handshake(client, client.connect());

    socket.receive({ msg: 'ping', id: 'p1' });

    expect(socket.frames()).toContainEqual({ msg: 'pong', id: 'p1' });
    client.close();
  });

  it('resolves and rejects method calls by id', async () => {
    const client = newClient();
    const socket = await handshake(client, client.connect());

    const ok = client.call('login', { resume: 'token' });
    const failed = client.call('broken');

    const calls = socket.frames().filter((frame) => frame.msg === 'method');
    socket.receive({ msg: 'result', id: calls[0].id, result: { id: 'u1' } });
    socket.receive({ msg: 'result', id: calls[1].id, error: { error: 403, reason: 'nope' } });

    await expect(ok).resolves.toEqual({ id: 'u1' });
    await expect(failed).rejects.toThrow('nope');
    client.close();
  });

  it('dispatches stream events by collection and key', async () => {
    const client = newClient();
    const socket = await handshake(client, client.connect());

    const seen: unknown[] = [];
    client.onStream('stream-room-messages', 'room-1', (args) => seen.push(args));

    socket.receive({
      msg: 'changed',
      collection: 'stream-room-messages',
      id: 'id',
      fields: { eventName: 'room-1', args: [{ _id: 'm1' }] },
    });
    // Same collection, different room: must not leak across subscriptions.
    socket.receive({
      msg: 'changed',
      collection: 'stream-room-messages',
      id: 'id',
      fields: { eventName: 'room-2', args: [{ _id: 'm2' }] },
    });

    expect(seen).toEqual([[{ _id: 'm1' }]]);
    client.close();
  });

  it('rejects in-flight calls when the socket dies', async () => {
    const client = newClient({ reconnect: { enabled: false } });
    const socket = await handshake(client, client.connect());

    const pending = client.call('slow');
    socket.drop();

    await expect(pending).rejects.toThrow(/Connection closed/);
    client.close();
  });

  it('re-authenticates before restoring subscriptions after a reconnect', async () => {
    // Ordering matters: Rocket.Chat drops the socket's identity on reconnect
    // and rejects user-scoped subscriptions issued before the resume login.
    const order: string[] = [];

    const client = newClient({
      reconnect: { enabled: true, minDelayMs: 1, maxDelayMs: 2 },
      onHandshake: async (_client, reconnected) => {
        if (reconnected) order.push('login');
      },
    });

    const first = await handshake(client, client.connect());
    client.subscribe('stream-room-messages', ['room-1', {}]);

    first.drop();
    await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(2));

    const second = FakeSocket.instances[1]!;
    second.open();
    second.receive({ msg: 'connected', session: 'session-2' });

    await vi.waitFor(() => {
      const resubscribed = second.frames().some((frame) => frame.msg === 'sub');
      expect(resubscribed).toBe(true);
    });

    order.push('subscribe');
    expect(order).toEqual(['login', 'subscribe']);
    client.close();
  });

  it('stops reconnecting once the server rejects the resume login', async () => {
    // A token the server will not accept is not worth retrying: before this,
    // every attempt reached `connected`, failed the resume login and scheduled
    // another one, until Rocket.Chat blocked the gateway's IP for it.
    const client = newClient({
      reconnect: { enabled: true, minDelayMs: 1, maxDelayMs: 2 },
      onHandshake: async (inner, reconnected) => {
        if (!reconnected) return;
        await inner.call('login', { resume: 'stale' });
      },
    });

    const first = await handshake(client, client.connect());
    first.drop();

    await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(2));
    const second = FakeSocket.instances[1]!;
    second.open();
    second.receive({ msg: 'connected', session: 'session-2' });

    await vi.waitFor(() => {
      const login = second.frames().find((frame) => frame.msg === 'method' && frame.method === 'login');
      expect(login).toBeDefined();
      second.receive({ msg: 'result', id: login.id, error: { error: 'error-invalid-user', reason: 'User not found' } });
    });

    await vi.waitFor(() => expect(second.readyState).toBe(3));
    // Long enough for a retry to have been scheduled and fired.
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(FakeSocket.instances.length).toBe(2);
    client.close();
  });

  it('backs off after a handshake failure instead of restarting the delay', async () => {
    // The `connected` frame arriving is not success; treating it as such reset
    // the backoff on every pass and pinned the retry delay at its minimum.
    const delays: number[] = [];
    const client = newClient({
      reconnect: { enabled: true, minDelayMs: 100, maxDelayMs: 10_000 },
      logger: {
        debug: (message, context) => {
          if (message === 'scheduling ddp reconnect') delays.push(context?.delay as number);
        },
        warn: () => undefined,
        error: () => undefined,
      },
      onHandshake: async (_client, reconnected) => {
        if (reconnected) throw new Error('upstream unavailable');
      },
    });

    const first = await handshake(client, client.connect());
    first.drop();

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(attempt + 1));
      const socket = FakeSocket.instances[attempt]!;
      socket.open();
      socket.receive({ msg: 'connected', session: `session-${attempt + 1}` });
      await vi.waitFor(() => expect(socket.readyState).toBe(3));
    }

    await vi.waitFor(() => expect(delays.length).toBeGreaterThanOrEqual(3));
    // Jitter puts a first-attempt delay in [50, 100) and a third in [200, 400),
    // so the threshold separates real backoff from a counter stuck at one
    // without depending on which side of the jitter each attempt landed.
    expect(delays[2]).toBeGreaterThan(100);
    client.close();
  });

  it('queues frames produced before the handshake completes', async () => {
    const client = newClient();
    const connecting = client.connect();

    // Subscribing while still connecting is normal; dropping these would
    // silently lose every event for the room.
    client.subscribe('stream-room-messages', ['room-1', {}]);

    const socket = await handshake(client, connecting);

    expect(socket.frames().some((frame) => frame.msg === 'sub')).toBe(true);
    client.close();
  });
});

describe('RocketChatRealtimeClient', () => {
  it('subscribes with the options shape Rocket.Chat expects', async () => {
    FakeSocket.instances = [];

    const client = new RocketChatRealtimeClient({
      serverUrl: 'http://chat.test',
      webSocketImpl: fakeWebSocket,
      heartbeatIntervalMs: 0,
    });

    const connecting = client.connect('token-1');
    const socket = FakeSocket.instances[0]!;
    socket.open();
    socket.receive({ msg: 'connected', session: 's1' });

    await vi.waitFor(() => {
      expect(socket.frames().some((frame) => frame.msg === 'method' && frame.method === 'login')).toBe(true);
    });

    const login = socket.frames().find((frame) => frame.method === 'login')!;
    expect(login.params[0]).toEqual({ resume: 'token-1' });

    socket.receive({
      msg: 'result',
      id: login.id,
      result: { id: 'u1', token: 'token-2', tokenExpires: { $date: 1 } },
    });
    await connecting;

    client.onRoomMessage('room-1', () => undefined);

    const sub = socket.frames().find((frame) => frame.msg === 'sub' && frame.name === 'stream-room-messages')!;
    expect(sub.params).toEqual(['room-1', { useCollection: false, args: [] }]);

    client.close();
  });

  it('reports typing only for the `user-typing` activity', async () => {
    FakeSocket.instances = [];

    const client = new RocketChatRealtimeClient({
      serverUrl: 'http://chat.test',
      webSocketImpl: fakeWebSocket,
      heartbeatIntervalMs: 0,
    });

    const connecting = client.connect('token-1');
    const socket = FakeSocket.instances[0]!;
    socket.open();
    socket.receive({ msg: 'connected', session: 's1' });

    await vi.waitFor(() => expect(socket.frames().some((frame) => frame.method === 'login')).toBe(true));
    const login = socket.frames().find((frame) => frame.method === 'login')!;
    socket.receive({ msg: 'result', id: login.id, result: { id: 'u1', token: 't', tokenExpires: { $date: 1 } } });
    await connecting;

    const events: unknown[] = [];
    client.onRoomTyping('room-1', (event) => events.push(event));

    socket.receive({
      msg: 'changed',
      collection: 'stream-notify-room',
      id: 'id',
      fields: { eventName: 'room-1/user-activity', args: ['alice', ['user-typing']] },
    });
    socket.receive({
      msg: 'changed',
      collection: 'stream-notify-room',
      id: 'id',
      fields: { eventName: 'room-1/user-activity', args: ['alice', ['user-recording']] },
    });

    expect(events).toEqual([
      { username: 'alice', typing: true },
      { username: 'alice', typing: false },
    ]);

    client.close();
  });

  it('receives the desktop notifications the server decided to send', async () => {
    FakeSocket.instances = [];

    const client = new RocketChatRealtimeClient({
      serverUrl: 'http://chat.test',
      webSocketImpl: fakeWebSocket,
      heartbeatIntervalMs: 0,
    });

    const connecting = client.connect('token-1');
    const socket = FakeSocket.instances[0]!;
    socket.open();
    socket.receive({ msg: 'connected', session: 's1' });

    await vi.waitFor(() => expect(socket.frames().some((frame) => frame.method === 'login')).toBe(true));
    const login = socket.frames().find((frame) => frame.method === 'login')!;
    socket.receive({ msg: 'result', id: login.id, result: { id: 'u1', token: 't', tokenExpires: { $date: 1 } } });
    await connecting;

    const received: unknown[] = [];
    client.onDesktopNotification('u1', (notification) => received.push(notification));

    const sub = socket.frames().find((frame) => frame.msg === 'sub' && frame.name === 'stream-notify-user')!;
    expect(sub.params).toEqual(['u1/notification', { useCollection: false, args: [] }]);

    socket.receive({
      msg: 'changed',
      collection: 'stream-notify-user',
      id: 'id',
      fields: {
        eventName: 'u1/notification',
        args: [{ title: 'general', text: 'alice: hello', payload: { _id: 'm1', rid: 'r1' } }],
      },
    });

    expect(received).toEqual([{ title: 'general', text: 'alice: hello', payload: { _id: 'm1', rid: 'r1' } }]);

    client.close();
  });
});
