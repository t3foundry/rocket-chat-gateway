import { z } from 'zod';

import { IdSchema, IsoDateTimeSchema, OffsetPaginationSchema, paginatedSchema } from '../common.js';
import { RoomSchema, RoomSummarySchema, RoomTypeSchema } from '../models/room.js';
import { FileTypeGroupSchema, RoomFileSchema } from '../models/upload.js';
import { UserSummarySchema } from '../models/user.js';

/**
 * `GET /api/v1/rooms`
 *
 * Returns the caller's subscriptions joined with room metadata — one request
 * instead of the `subscriptions.get` + `rooms.get` pair Rocket.Chat requires.
 */
export const ListRoomsQuerySchema = z.object({
  /** Only rooms updated after this instant; enables cheap delta refreshes. */
  updatedSince: IsoDateTimeSchema.optional(),
  types: z
    .union([z.array(RoomTypeSchema), RoomTypeSchema.transform((value) => [value])])
    .optional()
    .describe('Repeat the query parameter to filter on several types'),
  /** Exclude rooms the user has closed. Defaults to true, matching the sidebar. */
  openOnly: z.stringbool().default(true),
});
export type ListRoomsQuery = z.infer<typeof ListRoomsQuerySchema>;

export const ListRoomsResponseSchema = z.object({
  items: z.array(RoomSummarySchema),
  /**
   * Rooms the caller can no longer see. Only meaningful on a delta request —
   * without it a client doing incremental sync would keep stale sidebar
   * entries forever, since a removal never appears in `items`.
   */
  removedRoomIds: z.array(IdSchema),
  /** Server clock at the moment the snapshot was taken; feed back as `updatedSince`. */
  syncedAt: IsoDateTimeSchema,
});
export type ListRoomsResponse = z.infer<typeof ListRoomsResponseSchema>;

/** `GET /api/v1/rooms/:roomId` */
export const GetRoomResponseSchema = RoomSummarySchema;
export type GetRoomResponse = z.infer<typeof GetRoomResponseSchema>;

/** `GET /api/v1/rooms/:roomId/members` */
export const ListRoomMembersQuerySchema = OffsetPaginationSchema.extend({
  /** Name or username substring. Rocket.Chat matches both. */
  q: z.string().optional(),
  /**
   * Restrict to people who are reachable now. Rocket.Chat's member list opens
   * on this by default, because in a large channel the full roll is mostly
   * people who are not around.
   */
  onlineOnly: z.stringbool().default(false),
});
export type ListRoomMembersQuery = z.infer<typeof ListRoomMembersQuerySchema>;

export const ListRoomMembersResponseSchema = paginatedSchema(UserSummarySchema);
export type ListRoomMembersResponse = z.infer<typeof ListRoomMembersResponseSchema>;

/**
 * `POST /api/v1/rooms/:roomId/members` — invites users by id.
 *
 * Ids rather than usernames: the caller has just picked people out of a search
 * that returned both, and a username can change between the pick and the post.
 */
export const AddRoomMembersRequestSchema = z.object({
  userIds: z.array(IdSchema).min(1).max(100),
});
export type AddRoomMembersRequest = z.infer<typeof AddRoomMembersRequestSchema>;

export const AddRoomMembersResponseSchema = z.object({ ok: z.literal(true) });
export type AddRoomMembersResponse = z.infer<typeof AddRoomMembersResponseSchema>;

/** `DELETE /api/v1/rooms/:roomId/members/:userId` */
export const RemoveRoomMemberResponseSchema = z.object({ ok: z.literal(true) });
export type RemoveRoomMemberResponse = z.infer<typeof RemoveRoomMemberResponseSchema>;

/** Roles a user can hold *within a room*, as opposed to their server-wide roles. */
export const RoomMemberRoleSchema = z.enum(['owner', 'moderator', 'leader']);
export type RoomMemberRole = z.infer<typeof RoomMemberRoleSchema>;

/**
 * `PATCH /api/v1/rooms/:roomId/members/:userId`
 *
 * Each field maps to a separate Rocket.Chat endpoint pair (`addOwner` /
 * `removeOwner`, `muteUser` / `unmuteUser`, …); collapsing them into one
 * resource keeps the client from having to know that.
 */
export const UpdateRoomMemberRequestSchema = z
  .object({
    owner: z.boolean().optional(),
    moderator: z.boolean().optional(),
    leader: z.boolean().optional(),
    muted: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Provide at least one field to change' });
export type UpdateRoomMemberRequest = z.infer<typeof UpdateRoomMemberRequestSchema>;

export const UpdateRoomMemberResponseSchema = z.object({ ok: z.literal(true) });
export type UpdateRoomMemberResponse = z.infer<typeof UpdateRoomMemberResponseSchema>;

/**
 * `GET /api/v1/rooms/:roomId/roles`
 *
 * The whole room's role assignments in one response. The member list needs a
 * badge on every row, and asking per row would be one request per member.
 */
export const RoomMemberRolesSchema = z.object({
  userId: IdSchema,
  username: z.string(),
  roles: z.array(RoomMemberRoleSchema),
  /** Silenced in this room. Stored on the room, not the role record. */
  muted: z.boolean(),
});
export type RoomMemberRoles = z.infer<typeof RoomMemberRolesSchema>;

export const ListRoomRolesResponseSchema = z.object({ items: z.array(RoomMemberRolesSchema) });
export type ListRoomRolesResponse = z.infer<typeof ListRoomRolesResponseSchema>;

/** `GET /api/v1/rooms/:roomId/files` */
export const ListRoomFilesQuerySchema = OffsetPaginationSchema.extend({
  /** File name substring. */
  q: z.string().optional(),
  type: FileTypeGroupSchema.optional(),
});
export type ListRoomFilesQuery = z.infer<typeof ListRoomFilesQuerySchema>;

export const ListRoomFilesResponseSchema = paginatedSchema(RoomFileSchema);
export type ListRoomFilesResponse = z.infer<typeof ListRoomFilesResponseSchema>;

/**
 * How loudly one room may speak, per device.
 *
 * `default` defers to the user's account-wide preference, which is why it is a
 * distinct value rather than an absent one: a room explicitly set to `all` and
 * a room that has never been touched behave differently when the account
 * default changes.
 */
export const NotificationAlertSchema = z.enum(['default', 'all', 'mentions', 'nothing']);
export type NotificationAlert = z.infer<typeof NotificationAlertSchema>;

/** `GET /api/v1/rooms/:roomId/notifications` */
export const RoomNotificationPreferencesSchema = z.object({
  /** Rocket.Chat stores the inverse (`disableNotifications`); the positive reads better. */
  enabled: z.boolean(),
  /** Ignore `@all` and `@here`, but still alert on a direct mention. */
  muteGroupMentions: z.boolean(),
  /** Show the unread badge in the sidebar. */
  showCounter: z.boolean(),
  /** Show the mention badge when the counter is hidden. */
  showMentions: z.boolean(),
  desktop: z.object({
    alert: NotificationAlertSchema,
    /** Custom-sound id, `default`, or `none`. */
    sound: z.string(),
  }),
  mobile: z.object({ alert: NotificationAlertSchema }),
  email: z.object({ alert: NotificationAlertSchema }),
});
export type RoomNotificationPreferences = z.infer<typeof RoomNotificationPreferencesSchema>;

/** `PATCH /api/v1/rooms/:roomId/notifications` */
export const UpdateRoomNotificationsRequestSchema = RoomNotificationPreferencesSchema.partial()
  .extend({
    desktop: RoomNotificationPreferencesSchema.shape.desktop.partial().optional(),
    mobile: RoomNotificationPreferencesSchema.shape.mobile.partial().optional(),
    email: RoomNotificationPreferencesSchema.shape.email.partial().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Provide at least one field to change' });
export type UpdateRoomNotificationsRequest = z.infer<typeof UpdateRoomNotificationsRequestSchema>;

/**
 * `POST /api/v1/rooms/:roomId/prune`
 *
 * Bulk deletion, and irreversible. The bounds are both optional so "everything
 * before Friday" and "everything after Monday" are expressible, but at least
 * one filter must be present — an unbounded call would empty the room.
 */
export const PruneMessagesRequestSchema = z.object({
  /** Delete messages newer than this. */
  oldest: IsoDateTimeSchema.optional(),
  /** Delete messages older than this. */
  latest: IsoDateTimeSchema.optional(),
  /** Include messages sitting exactly on a bound. */
  inclusive: z.boolean().default(false),
  /** Keep pinned messages, which is Rocket.Chat's "Exclude pinned messages". */
  excludePinned: z.boolean().default(false),
  /** Strip attachments and leave the messages themselves in place. */
  filesOnly: z.boolean().default(false),
  ignoreDiscussion: z.boolean().default(true),
  ignoreThreads: z.boolean().default(true),
  /** Restrict to messages from these people. */
  usernames: z.array(z.string()).max(50).optional(),
  /** Upper bound on how many are removed in one call; Rocket.Chat's own UI sends 2000. */
  limit: z.number().int().min(1).max(2000).default(2000),
});
export type PruneMessagesRequest = z.infer<typeof PruneMessagesRequestSchema>;

export const PruneMessagesResponseSchema = z.object({
  /** How many were actually deleted. Zero is a legitimate result, not an error. */
  count: z.number().int().min(0),
});
export type PruneMessagesResponse = z.infer<typeof PruneMessagesResponseSchema>;

/** `POST /api/v1/rooms/direct` — opens (creating if needed) a DM with a user. */
export const CreateDirectRoomRequestSchema = z.object({
  username: z.string().min(1),
});
export type CreateDirectRoomRequest = z.infer<typeof CreateDirectRoomRequestSchema>;

export const CreateDirectRoomResponseSchema = RoomSchema;
export type CreateDirectRoomResponse = z.infer<typeof CreateDirectRoomResponseSchema>;

/** `POST /api/v1/rooms/:roomId/read` — clears the unread badge. */
export const MarkRoomReadResponseSchema = z.object({ ok: z.literal(true) });
export type MarkRoomReadResponse = z.infer<typeof MarkRoomReadResponseSchema>;

/** `PATCH /api/v1/rooms/:roomId/state` — per-user room flags. */
export const UpdateRoomStateRequestSchema = z
  .object({
    favorite: z.boolean().optional(),
    hidden: z.boolean().optional(),
  })
  .refine((value) => value.favorite !== undefined || value.hidden !== undefined, {
    message: 'At least one of `favorite` or `hidden` must be provided',
  });
export type UpdateRoomStateRequest = z.infer<typeof UpdateRoomStateRequestSchema>;

export const UpdateRoomStateResponseSchema = RoomSummarySchema;
export type UpdateRoomStateResponse = z.infer<typeof UpdateRoomStateResponseSchema>;

/**
 * `POST /api/v1/rooms`
 *
 * Only channels and private groups can be created this way. Direct messages
 * come from `POST /rooms/direct`, discussions from a parent message, and teams
 * from Rocket.Chat's own admin flows — each has different required inputs.
 */
export const CreateRoomRequestSchema = z.object({
  type: z.enum(['channel', 'private']),
  /**
   * The allowed characters are entirely a server decision: `UTF8_Channel_Names_Validation`
   * holds the pattern, and with `UI_Allow_room_names_with_special_chars` on
   * Rocket.Chat slugifies the name before testing it — so `Team Rocket` becomes
   * `Team-Rocket` and is valid. Enforcing a pattern here would reject names the
   * server accepts, so only the length is checked and the server has the say.
   * Clients read both settings from `GET /server/capabilities`.
   */
  name: z.string().trim().min(1).max(80),
  topic: z.string().max(200).optional(),
  description: z.string().max(500).optional(),
  /** Usernames to invite. The creator is added automatically. */
  memberUsernames: z.array(z.string()).max(200).optional(),
  readOnly: z.boolean().optional(),
  encrypted: z.boolean().optional(),
  broadcast: z.boolean().optional(),
});
export type CreateRoomRequest = z.infer<typeof CreateRoomRequestSchema>;

export const CreateRoomResponseSchema = RoomSchema;
export type CreateRoomResponse = z.infer<typeof CreateRoomResponseSchema>;

/**
 * `PATCH /api/v1/rooms/:roomId`
 *
 * Room-wide settings, as opposed to `PATCH /rooms/:roomId/state`, which
 * changes only the caller's own view of the room.
 */
export const UpdateRoomRequestSchema = z
  .object({
    /** Same server-owned rule as `CreateRoomRequestSchema.name`. */
    name: z.string().trim().min(1).max(80).optional(),
    topic: z.string().max(200).optional(),
    description: z.string().max(500).optional(),
    announcement: z.string().max(500).optional(),
    readOnly: z.boolean().optional(),
    archived: z.boolean().optional(),
    /** Converts between a public channel and a private group. */
    type: RoomTypeSchema.extract(['channel', 'private']).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Provide at least one field to change' });
export type UpdateRoomRequest = z.infer<typeof UpdateRoomRequestSchema>;

export const UpdateRoomResponseSchema = RoomSummarySchema;
export type UpdateRoomResponse = z.infer<typeof UpdateRoomResponseSchema>;

/** `POST /api/v1/rooms/:roomId/leave` */
export const LeaveRoomResponseSchema = z.object({ ok: z.literal(true) });
export type LeaveRoomResponse = z.infer<typeof LeaveRoomResponseSchema>;

/** `POST /api/v1/rooms/:roomId/unread` — restores the unread badge. */
export const MarkRoomUnreadResponseSchema = z.object({ ok: z.literal(true) });
export type MarkRoomUnreadResponse = z.infer<typeof MarkRoomUnreadResponseSchema>;
