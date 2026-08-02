import { z } from 'zod';

import { IdSchema, IsoDateTimeSchema } from '../common.js';
import { MessageSchema } from '../models/message.js';
import { RoomSummarySchema, RoomTypeSchema } from '../models/room.js';
import { PresenceStatusSchema, UserSummarySchema } from '../models/user.js';

/**
 * The realtime channel is a plain JSON WebSocket at `/ws`, authenticated by the
 * same session cookie as the HTTP API. It deliberately does not expose DDP:
 * clients should never have to know that Rocket.Chat speaks Meteor underneath.
 */
export const REALTIME_PATH = '/ws';

/** Bumped whenever an event's payload changes incompatibly. Sent in `connection.ready`. */
export const REALTIME_PROTOCOL_VERSION = 3;

/**
 * Every event and command carries the server it belongs to.
 *
 * One socket multiplexes all of a session's Rocket.Chat connections, so a
 * client watching room `abc` on two servers has to be able to tell the two
 * streams apart — room ids are only unique within one server.
 */
const ServerScopedSchema = z.object({ serverId: IdSchema });

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export const ConnectionReadyEventSchema = ServerScopedSchema.extend({
  type: z.literal('connection.ready'),
  protocolVersion: z.number().int(),
  userId: IdSchema,
});

/**
 * Emitted when the gateway loses its own upstream link. Clients should show a
 * reconnecting banner and refetch on the following `connection.ready`, because
 * events produced during the gap are not replayed.
 */
export const ConnectionDegradedEventSchema = ServerScopedSchema.extend({
  type: z.literal('connection.degraded'),
  reason: z.enum(['upstream_disconnected', 'upstream_error']),
});

export const MessageCreatedEventSchema = ServerScopedSchema.extend({
  type: z.literal('message.created'),
  roomId: IdSchema,
  message: MessageSchema,
});

export const MessageUpdatedEventSchema = ServerScopedSchema.extend({
  type: z.literal('message.updated'),
  roomId: IdSchema,
  message: MessageSchema,
});

export const MessageDeletedEventSchema = ServerScopedSchema.extend({
  type: z.literal('message.deleted'),
  roomId: IdSchema,
  messageId: IdSchema,
});

/** Covers both room metadata changes and the caller's own read/unread state. */
export const RoomUpdatedEventSchema = ServerScopedSchema.extend({
  type: z.literal('room.updated'),
  room: RoomSummarySchema,
});

export const RoomRemovedEventSchema = ServerScopedSchema.extend({
  type: z.literal('room.removed'),
  roomId: IdSchema,
});

export const TypingChangedEventSchema = ServerScopedSchema.extend({
  type: z.literal('typing.changed'),
  roomId: IdSchema,
  username: z.string(),
  typing: z.boolean(),
});

export const PresenceChangedEventSchema = ServerScopedSchema.extend({
  type: z.literal('presence.changed'),
  username: z.string(),
  status: PresenceStatusSchema,
  statusText: z.string().nullable(),
});

/** Somebody (possibly the caller on another device) read the room up to `until`. */
export const RoomReadEventSchema = ServerScopedSchema.extend({
  type: z.literal('room.read'),
  roomId: IdSchema,
  until: IsoDateTimeSchema,
});

/**
 * A message Rocket.Chat decided this user should be told about.
 *
 * Whether a message is worth a notification is a *server* decision — it depends
 * on the subscription's alert setting, mentions, the user's status and the
 * workspace defaults, none of which the client can see. The gateway therefore
 * forwards this verbatim rather than trying to infer it from `message.created`,
 * which only fires for the rooms a client happens to be watching.
 */
export const NotificationEventSchema = ServerScopedSchema.extend({
  type: z.literal('notification'),
  /** Ready to display: the room name, or the sender's name in a direct message. */
  title: z.string(),
  /** Body as the server composed it, already prefixed with the sender where that applies. */
  text: z.string(),
  /** How long to keep it on screen, in seconds. `null` leaves the choice to the client. */
  duration: z.number().int().positive().nullable(),
  payload: z.object({
    messageId: IdSchema,
    roomId: IdSchema,
    /** Set when the message is a thread reply, so a client can open the thread. */
    threadId: IdSchema.nullable(),
    /**
     * Best-effort: the notification carries Rocket.Chat's raw room letter, which
     * cannot distinguish a discussion or a team from the channel it looks like.
     * Use it to pick an icon, not to decide what a room *is*.
     */
    roomType: RoomTypeSchema,
    /** `null` for direct messages, which have no name. */
    roomName: z.string().nullable(),
    /** `null` when the message has no identifiable author, as omnichannel visitors do not. */
    sender: UserSummarySchema.nullable(),
    /** The subscription's audio choice: a sound name, `none`, or `null` for the default. */
    sound: z.string().nullable(),
  }),
});

export const ServerEventSchema = z.discriminatedUnion('type', [
  ConnectionReadyEventSchema,
  ConnectionDegradedEventSchema,
  MessageCreatedEventSchema,
  MessageUpdatedEventSchema,
  MessageDeletedEventSchema,
  RoomUpdatedEventSchema,
  RoomRemovedEventSchema,
  TypingChangedEventSchema,
  PresenceChangedEventSchema,
  RoomReadEventSchema,
  NotificationEventSchema,
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type ServerEventType = ServerEvent['type'];

/** Narrow a `ServerEvent` to one variant, e.g. `Extract<ServerEvent, { type: 'message.created' }>`. */
export type ServerEventOf<T extends ServerEventType> = Extract<ServerEvent, { type: T }>;

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

/**
 * Room-scoped events only flow after an explicit subscribe. Without this the
 * gateway would have to fan out every message of every room the user belongs
 * to, which is exactly the cost this layer exists to avoid.
 */
export const SubscribeRoomCommandSchema = ServerScopedSchema.extend({
  type: z.literal('room.subscribe'),
  roomId: IdSchema,
});

export const UnsubscribeRoomCommandSchema = ServerScopedSchema.extend({
  type: z.literal('room.unsubscribe'),
  roomId: IdSchema,
});

export const SetTypingCommandSchema = ServerScopedSchema.extend({
  type: z.literal('typing.set'),
  roomId: IdSchema,
  typing: z.boolean(),
});

/** Application-level keepalive; the gateway answers with `pong` over the raw socket. */
export const PingCommandSchema = z.object({
  type: z.literal('ping'),
});

export const ClientCommandSchema = z.discriminatedUnion('type', [
  SubscribeRoomCommandSchema,
  UnsubscribeRoomCommandSchema,
  SetTypingCommandSchema,
  PingCommandSchema,
]);
export type ClientCommand = z.infer<typeof ClientCommandSchema>;
export type ClientCommandType = ClientCommand['type'];
