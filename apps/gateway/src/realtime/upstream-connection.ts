import { REALTIME_PROTOCOL_VERSION, type RoomType, type ServerEvent } from '@open-rocket-chat/api-contract';
import { toMessage, toUserSummary, type AdapterContext } from '@open-rocket-chat/rc-adapter';
import type { RcMessage } from '@open-rocket-chat/rc-rest-client';
import {
  RocketChatRealtimeClient,
  type DesktopNotificationEvent,
  type Unsubscribe,
} from '@open-rocket-chat/rc-realtime-client';
import type { PinoLogger } from 'nestjs-pino';

import type { RoomsService } from '../rooms/rooms.service';
import type { ServerSession } from '../session/session.types';

export type EventSink = (event: ServerEvent) => void;

/**
 * An event as this class produces it, before the server it came from is
 * stamped on. Distributive so each variant keeps its own shape rather than
 * collapsing into a union of shared keys.
 */
type UnscopedEvent<T = ServerEvent> = T extends unknown ? Omit<T, 'serverId'> : never;

interface RoomBinding {
  /** How many attached client sockets currently want this room. */
  refCount: number;
  teardown: Unsubscribe[];
}

/**
 * Coalesces bursts of subscription changes. Rocket.Chat emits several
 * `subscriptions-changed` events for a single user action (reading a room fires
 * one per counter it touches), and each one would otherwise cost a REST
 * round-trip to rebuild the room summary.
 */
const ROOM_REFRESH_DEBOUNCE_MS = 150;

/**
 * One upstream Rocket.Chat realtime connection per *session*, shared by every
 * browser socket that session has open. A user with five tabs costs the
 * Rocket.Chat server one DDP connection, not five.
 */
export class UpstreamConnection {
  private readonly client: RocketChatRealtimeClient;

  private readonly sinks = new Set<EventSink>();

  private readonly rooms = new Map<string, RoomBinding>();

  private readonly userStreamTeardown: Unsubscribe[] = [];

  private readonly pendingRoomRefreshes = new Map<string, NodeJS.Timeout>();

  private ready = false;

  private disposed = false;

  private readonly deadHandlers = new Set<() => void>();

  constructor(
    private readonly session: ServerSession,
    private readonly context: AdapterContext,
    serverUrl: string,
    private readonly roomsService: RoomsService,
    private readonly logger: PinoLogger,
  ) {
    this.client = new RocketChatRealtimeClient({
      serverUrl,
      logger: {
        debug: (message, ctx) => this.logger.debug({ ...ctx, sessionId: session.id }, message),
        warn: (message, ctx) => this.logger.warn({ ...ctx, sessionId: session.id }, message),
        error: (message, ctx) => this.logger.error({ ...ctx, sessionId: session.id }, message),
      },
    });
  }

  get isReady(): boolean {
    return this.ready;
  }

  get attachedCount(): number {
    return this.sinks.size;
  }

  async start(): Promise<void> {
    await this.client.connect(this.session.rocketChatAuthToken);
    this.bindUserStreams();
    this.ready = true;

    this.client.onDisconnected(({ willReconnect }) => {
      this.broadcast({
        type: 'connection.degraded',
        reason: willReconnect ? 'upstream_disconnected' : 'upstream_error',
      });

      if (willReconnect || this.disposed) return;

      // The realtime client has given up — a rejected resume token, typically.
      // Nothing here can revive it, so it is announced as dead and dropped;
      // the next attach builds a fresh connection from current credentials.
      this.ready = false;
      for (const handler of [...this.deadHandlers]) handler();
    });

    this.client.onConnected(({ reconnected }) => {
      if (!reconnected) return;
      // Events produced while we were disconnected are gone for good, so tell
      // clients to resync rather than pretending the stream was continuous.
      this.broadcast(this.readyEvent());
    });
  }

  readyEvent(): ServerEvent {
    return {
      type: 'connection.ready',
      protocolVersion: REALTIME_PROTOCOL_VERSION,
      userId: this.session.rocketChatUserId,
      serverId: this.session.serverId,
    };
  }

  /** Fires once the upstream link is beyond recovery, so its owner can drop it. */
  onDead(handler: () => void): void {
    this.deadHandlers.add(handler);
  }

  attach(sink: EventSink): void {
    this.sinks.add(sink);
  }

  detach(sink: EventSink): void {
    this.sinks.delete(sink);
  }

  /**
   * Stamps the server on the way out.
   *
   * Doing it here rather than at each call site means a new event type cannot
   * be added without one — and an event that reached a client unlabelled would
   * be applied to whichever server happened to be active.
   */
  private broadcast(event: UnscopedEvent): void {
    const scoped = { ...event, serverId: this.session.serverId } as ServerEvent;

    for (const sink of [...this.sinks]) {
      try {
        sink(scoped);
      } catch (error) {
        this.logger.warn({ err: error, sessionId: this.session.id }, 'realtime sink threw');
      }
    }
  }

  // -------------------------------------------------------------------------
  // User-scoped streams (always on while the connection lives)
  // -------------------------------------------------------------------------

  private bindUserStreams(): void {
    const userId = this.session.rocketChatUserId;

    this.userStreamTeardown.push(
      this.client.onSubscriptionChanged(userId, (action, subscription) => {
        const roomId = (subscription as { rid?: string }).rid;
        if (!roomId) return;

        if (action === 'removed') {
          this.broadcast({ type: 'room.removed', roomId });
          return;
        }

        this.scheduleRoomRefresh(roomId);
      }),

      this.client.onRoomChanged(userId, (action, room) => {
        const roomId = (room as { _id?: string })._id;
        if (!roomId) return;

        if (action === 'removed') {
          this.broadcast({ type: 'room.removed', roomId });
          return;
        }

        this.scheduleRoomRefresh(roomId);
      }),

      this.client.onPresence((event) => {
        this.broadcast({
          type: 'presence.changed',
          username: event.username,
          status: event.status,
          statusText: event.statusText,
        });
      }),

      // Not derived from `message.created`: that only fires for rooms a client
      // is watching, which is precisely when a notification is *not* wanted.
      // Rocket.Chat publishes here only after deciding this user should be
      // alerted, so the gateway forwards rather than re-deciding.
      this.client.onDesktopNotification(userId, (notification) => {
        const event = this.toNotificationEvent(notification);
        if (event) this.broadcast(event);
      }),
    );
  }

  /**
   * Normalises Rocket.Chat's desktop notification into the contract shape.
   *
   * Returns `undefined` for payloads with no message to open — omnichannel
   * sends those, and a notification that goes nowhere when clicked is worse
   * than one that never appeared.
   */
  private toNotificationEvent(
    notification: DesktopNotificationEvent,
  ): UnscopedEvent<Extract<ServerEvent, { type: 'notification' }>> | undefined {
    const payload = notification.payload;
    if (!payload?.rid || !payload._id) return undefined;

    const sender = payload.sender;

    return {
      type: 'notification',
      title: notification.title ?? '',
      // Falls back to the message itself: older servers leave `text` empty for
      // some message types, and an empty body reads as a broken notification.
      text: notification.text || payload.message?.msg || '',
      duration: notification.duration && notification.duration > 0 ? Math.round(notification.duration) : null,
      payload: {
        messageId: payload._id,
        roomId: payload.rid,
        // Rocket.Chat sends an empty string rather than omitting it.
        threadId: payload.tmid || null,
        roomType: toNotificationRoomType(payload.type),
        roomName: payload.name || null,
        sender: sender?._id
          ? toUserSummary({ _id: sender._id, username: sender.username, name: sender.name }, this.context)
          : null,
        // `none` is a real choice — silence — and is passed through as such.
        sound: payload.audioNotificationValue || null,
      },
    };
  }

  /**
   * Rebuilds a room summary out of band. The realtime payload is a partial
   * subscription, not enough to satisfy `RoomSummarySchema`, so the authoritative
   * shape is re-read over REST.
   */
  private scheduleRoomRefresh(roomId: string): void {
    const existing = this.pendingRoomRefreshes.get(roomId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.pendingRoomRefreshes.delete(roomId);
      if (this.disposed) return;

      void this.roomsService
        .get(this.session, roomId)
        .then((room) => this.broadcast({ type: 'room.updated', room }))
        .catch((error: unknown) => {
          // Losing access to a room manifests as a 403/404 here; treat it as a
          // removal so the sidebar does not keep an entry the user cannot open.
          this.logger.debug({ err: error, roomId }, 'room refresh failed; treating as removed');
          this.broadcast({ type: 'room.removed', roomId });
        });
    }, ROOM_REFRESH_DEBOUNCE_MS);

    timer.unref?.();
    this.pendingRoomRefreshes.set(roomId, timer);
  }

  // -------------------------------------------------------------------------
  // Room-scoped streams (subscribed on demand)
  // -------------------------------------------------------------------------

  subscribeRoom(roomId: string): void {
    const existing = this.rooms.get(roomId);
    if (existing) {
      existing.refCount += 1;
      return;
    }

    const teardown: Unsubscribe[] = [
      this.client.onRoomMessage(roomId, (raw) => {
        const message = raw as RcMessage;
        if (!message?._id) return;

        this.broadcast({
          type: isEdit(message) ? 'message.updated' : 'message.created',
          roomId,
          message: toMessage(message, this.context),
        });
      }),

      this.client.onRoomMessageDeleted(roomId, (messageId) => {
        this.broadcast({ type: 'message.deleted', roomId, messageId });
      }),

      this.client.onRoomTyping(roomId, (event) => {
        // Our own typing echoes back from the server; forwarding it would make
        // the sender see themselves in the "is typing" line.
        if (event.username === this.session.username) return;
        this.broadcast({ type: 'typing.changed', roomId, username: event.username, typing: event.typing });
      }),

      this.client.onRoomRead(roomId, (until) => {
        this.broadcast({ type: 'room.read', roomId, until: until.toISOString() });
      }),
    ];

    this.rooms.set(roomId, { refCount: 1, teardown });
  }

  unsubscribeRoom(roomId: string): void {
    const binding = this.rooms.get(roomId);
    if (!binding) return;

    binding.refCount -= 1;
    if (binding.refCount > 0) return;

    for (const teardown of binding.teardown) teardown();
    this.rooms.delete(roomId);
  }

  setTyping(roomId: string, typing: boolean): void {
    this.client.setTyping(roomId, this.session.username, typing);
  }

  dispose(): void {
    this.disposed = true;
    this.ready = false;

    for (const timer of this.pendingRoomRefreshes.values()) clearTimeout(timer);
    this.pendingRoomRefreshes.clear();

    for (const binding of this.rooms.values()) {
      for (const teardown of binding.teardown) teardown();
    }
    this.rooms.clear();

    for (const teardown of this.userStreamTeardown) teardown();
    this.userStreamTeardown.length = 0;

    this.deadHandlers.clear();
    this.sinks.clear();
    this.client.close();
  }
}

/**
 * The notification payload carries only Rocket.Chat's room letter, so a
 * discussion and a team both arrive looking like the channel they are built on.
 * That is enough for an icon, which is all a client does with it here — the
 * room's real type comes from the room summary.
 */
const toNotificationRoomType = (letter: string | undefined): RoomType => {
  switch (letter) {
    case 'p':
      return 'private';
    case 'd':
      return 'direct';
    case 'l':
      return 'omnichannel';
    default:
      return 'channel';
  }
};

/**
 * `stream-room-messages` carries new messages, edits *and* reaction changes on
 * the same channel. An explicit `editedAt` marks a human edit; anything else
 * whose update timestamp has drifted from its creation timestamp is a
 * server-side mutation such as a reaction. Only a message whose two timestamps
 * still agree is genuinely new.
 */
const isEdit = (message: RcMessage): boolean => {
  if (message.editedAt) return true;

  const createdAt = epochOf(message.ts);
  const updatedAt = message._updatedAt ? epochOf(message._updatedAt) : createdAt;
  return updatedAt - createdAt > 1_000;
};

const epochOf = (value: RcMessage['ts']): number => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Date.parse(value);
  return value.$date;
};
