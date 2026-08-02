import { DdpClient, type DdpClientOptions, type DdpLogger } from './ddp.js';
import type { Unsubscribe } from './emitter.js';

/**
 * Rocket.Chat's stream publications take `(key, options)`. `useCollection:
 * false` tells the server to push raw events instead of maintaining a Meteor
 * collection, which is the only mode a non-Meteor client can consume.
 */
const STREAM_OPTIONS = { useCollection: false, args: [] } as const;

const STREAM_ROOM_MESSAGES = 'stream-room-messages';
const STREAM_NOTIFY_USER = 'stream-notify-user';
const STREAM_NOTIFY_ROOM = 'stream-notify-room';
const STREAM_USER_PRESENCE = 'stream-user-presence';

/** Index into this array is the numeric status Rocket.Chat sends over presence streams. */
const PRESENCE_BY_CODE = ['offline', 'online', 'away', 'busy', 'offline'] as const;

export type PresenceStatus = 'online' | 'away' | 'busy' | 'offline';

export interface RealtimeClientOptions extends Omit<DdpClientOptions, 'url'> {
  /** HTTP(S) base URL of the Rocket.Chat server; converted to the WebSocket URL internally. */
  serverUrl: string;
  logger?: DdpLogger;
}

export interface RealtimeLoginResult {
  userId: string;
  /** Refreshed token; Rocket.Chat may rotate it on resume. */
  authToken: string;
  expiresAt: Date | null;
}

export type SubscriptionChangeAction = 'inserted' | 'updated' | 'removed' | 'changed';

export interface TypingEvent {
  username: string;
  typing: boolean;
}

export interface PresenceEvent {
  username: string;
  status: PresenceStatus;
  statusText: string | null;
}

/**
 * Rocket.Chat's desktop notification payload, as `notifyDesktopUser` builds it.
 *
 * Everything below `payload` is optional in practice: omnichannel notifications
 * are sent without a message id, and older servers predate `audioNotificationValue`.
 */
export interface DesktopNotificationEvent {
  title?: string;
  text?: string;
  duration?: number;
  payload?: {
    _id?: string;
    rid?: string;
    tmid?: string;
    sender?: { _id?: string; username?: string; name?: string };
    /** The raw room letter: `c`, `p`, `d` or `l`. */
    type?: string;
    name?: string;
    message?: { msg?: string; t?: string };
    audioNotificationValue?: string;
  };
}

/**
 * Rocket.Chat-flavoured wrapper over {@link DdpClient}: it knows the stream
 * names, key formats and argument shapes, so callers work with named methods
 * instead of raw DDP publications.
 */
export class RocketChatRealtimeClient {
  private readonly ddp: DdpClient;

  private authToken?: string;

  private userId?: string;

  constructor(options: RealtimeClientOptions) {
    const { serverUrl, ...ddpOptions } = options;

    this.ddp = new DdpClient({
      ...ddpOptions,
      url: toWebSocketUrl(serverUrl),
      // Rocket.Chat discards the socket's identity when the connection drops.
      // Replaying the resume login here — rather than from a `connected`
      // listener — guarantees it completes before subscriptions are restored.
      onHandshake: async (_client, reconnected) => {
        if (!reconnected || !this.authToken) return;
        await this.login(this.authToken);
      },
    });
  }

  get connection(): DdpClient {
    return this.ddp;
  }

  get isConnected(): boolean {
    return this.ddp.isConnected;
  }

  get currentUserId(): string | undefined {
    return this.userId;
  }

  onConnected(handler: (info: { reconnected: boolean }) => void): Unsubscribe {
    return this.ddp.on('connected', ({ reconnected }) => handler({ reconnected }));
  }

  onDisconnected(handler: (info: { willReconnect: boolean }) => void): Unsubscribe {
    return this.ddp.on('disconnected', ({ willReconnect }) => handler({ willReconnect }));
  }

  onError(handler: (error: Error) => void): Unsubscribe {
    return this.ddp.on('error', ({ error }) => handler(error));
  }

  /** Opens the socket and authenticates with a REST-issued auth token. */
  async connect(authToken: string): Promise<RealtimeLoginResult> {
    await this.ddp.connect();
    return this.login(authToken);
  }

  private async login(authToken: string): Promise<RealtimeLoginResult> {
    const result = await this.ddp.call<{
      id: string;
      token: string;
      tokenExpires?: { $date: number };
    }>('login', { resume: authToken });

    this.userId = result.id;
    this.authToken = result.token;

    return {
      userId: result.id,
      authToken: result.token,
      expiresAt: result.tokenExpires ? new Date(result.tokenExpires.$date) : null,
    };
  }

  // -------------------------------------------------------------------------
  // Room streams
  // -------------------------------------------------------------------------

  /**
   * New and edited messages in a room. Rocket.Chat emits the same event for
   * both, distinguishable only by the message's `editedAt` field.
   */
  onRoomMessage(roomId: string, handler: (message: unknown) => void): Unsubscribe {
    return this.stream(STREAM_ROOM_MESSAGES, roomId, (args) => {
      const [message] = args;
      if (message) handler(message);
    });
  }

  /**
   * Typing indicators. Modern servers publish `user-activity` with a list of
   * activity types; older ones publish a plain `typing` boolean. Both are
   * subscribed so behaviour does not depend on the server version.
   */
  onRoomTyping(roomId: string, handler: (event: TypingEvent) => void): Unsubscribe {
    const offActivity = this.stream(STREAM_NOTIFY_ROOM, `${roomId}/user-activity`, (args) => {
      const [username, activities] = args as [string, string[] | undefined];
      if (typeof username !== 'string') return;
      handler({ username, typing: Array.isArray(activities) && activities.includes('user-typing') });
    });

    const offLegacy = this.stream(STREAM_NOTIFY_ROOM, `${roomId}/typing`, (args) => {
      const [username, typing] = args as [string, boolean];
      if (typeof username !== 'string') return;
      handler({ username, typing: Boolean(typing) });
    });

    return () => {
      offActivity();
      offLegacy();
    };
  }

  onRoomMessageDeleted(roomId: string, handler: (messageId: string) => void): Unsubscribe {
    return this.stream(STREAM_NOTIFY_ROOM, `${roomId}/deleteMessage`, (args) => {
      const [payload] = args as [{ _id?: string } | undefined];
      if (payload?._id) handler(payload._id);
    });
  }

  /** Fired when any of the user's sessions marks the room as read up to `until`. */
  onRoomRead(roomId: string, handler: (until: Date) => void): Unsubscribe {
    return this.stream(STREAM_NOTIFY_ROOM, `${roomId}/messagesRead`, (args) => {
      const [payload] = args as [{ until?: string | { $date: number } } | undefined];
      const until = toDate(payload?.until);
      if (until) handler(until);
    });
  }

  /** Announces that this user is typing. Fire-and-forget by design. */
  setTyping(roomId: string, username: string, typing: boolean): void {
    void this.ddp
      .call(STREAM_NOTIFY_ROOM, `${roomId}/user-activity`, username, typing ? ['user-typing'] : [], {})
      .catch(() => {
        // A dropped typing notification is not worth surfacing or retrying.
      });
  }

  // -------------------------------------------------------------------------
  // User streams
  // -------------------------------------------------------------------------

  /** Subscription changes: unread counts, favourites, a room being hidden. */
  onSubscriptionChanged(
    userId: string,
    handler: (action: SubscriptionChangeAction, subscription: unknown) => void,
  ): Unsubscribe {
    return this.stream(STREAM_NOTIFY_USER, `${userId}/subscriptions-changed`, (args) => {
      const [action, subscription] = args as [SubscriptionChangeAction, unknown];
      if (action && subscription) handler(action, subscription);
    });
  }

  /**
   * Messages the server decided this user should be alerted about.
   *
   * This is not "every message": Rocket.Chat has already applied the
   * subscription's alert setting, mentions, the user's status and the workspace
   * defaults before publishing here. A client must not second-guess it.
   */
  onDesktopNotification(userId: string, handler: (notification: DesktopNotificationEvent) => void): Unsubscribe {
    return this.stream(STREAM_NOTIFY_USER, `${userId}/notification`, (args) => {
      const [notification] = args as [DesktopNotificationEvent | undefined];
      if (notification) handler(notification);
    });
  }

  /** Room metadata changes: renames, topic edits, archival. */
  onRoomChanged(userId: string, handler: (action: SubscriptionChangeAction, room: unknown) => void): Unsubscribe {
    return this.stream(STREAM_NOTIFY_USER, `${userId}/rooms-changed`, (args) => {
      const [action, room] = args as [SubscriptionChangeAction, unknown];
      if (action && room) handler(action, room);
    });
  }

  /**
   * Presence for every user visible to the caller. Rocket.Chat keys this
   * stream on the empty string to mean "all", rather than taking a user list.
   */
  onPresence(handler: (event: PresenceEvent) => void): Unsubscribe {
    return this.stream(STREAM_USER_PRESENCE, '', (args) => {
      const [payload] = args as [[string, number?, string?] | undefined];
      if (!Array.isArray(payload)) return;

      const [username, statusCode, statusText] = payload;
      if (typeof username !== 'string') return;

      handler({
        username,
        status: PRESENCE_BY_CODE[statusCode ?? 0] ?? 'offline',
        statusText: statusText ?? null,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private stream(collection: string, key: string, handler: (args: unknown[]) => void): Unsubscribe {
    const token = this.ddp.subscribe(collection, [key, STREAM_OPTIONS]);
    const offEvent = this.ddp.onStream(collection, key, handler);

    return () => {
      offEvent();
      this.ddp.unsubscribe(token);
    };
  }

  close(): void {
    this.authToken = undefined;
    this.userId = undefined;
    this.ddp.close();
  }
}

/** `https://chat.example.com` -> `wss://chat.example.com/websocket`. */
export const toWebSocketUrl = (serverUrl: string): string => {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/websocket`;
  url.search = '';
  url.hash = '';
  return url.toString();
};

const toDate = (value: string | number | { $date: number } | undefined): Date | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') return new Date(value.$date);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
