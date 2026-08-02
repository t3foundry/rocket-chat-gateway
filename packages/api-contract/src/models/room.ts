import { z } from 'zod';

import { IdSchema, IsoDateTimeSchema } from '../common.js';
import { UserSummarySchema } from './user.js';

/**
 * Rocket.Chat encodes the room kind in a single letter (`c`, `p`, `d`, `l`)
 * plus orthogonal flags (`prid` for discussions, `teamMain` for teams). We
 * flatten that into one discriminator because every client ends up doing the
 * same derivation otherwise.
 */
export const RoomTypeSchema = z.enum(['channel', 'private', 'direct', 'discussion', 'team', 'omnichannel']);
export type RoomType = z.infer<typeof RoomTypeSchema>;

export const RoomVisibilitySchema = z.enum(['public', 'private', 'direct', 'omnichannel']);
export type RoomVisibility = z.infer<typeof RoomVisibilitySchema>;

export const RoomSchema = z.object({
  id: IdSchema,
  type: RoomTypeSchema,
  /** Preserves Rocket.Chat's underlying `t`; discussions and team rooms can be public or private. */
  visibility: RoomVisibilitySchema,
  /** URL-safe unique name. `null` for direct messages, which have no name. */
  name: z.string().nullable(),
  /** What to render in the sidebar and header. Always present. */
  displayName: z.string(),
  topic: z.string().nullable(),
  description: z.string().nullable(),
  announcement: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  owner: UserSummarySchema.nullable(),
  membersCount: z.number().int().min(0),
  messagesCount: z.number().int().min(0),
  readOnly: z.boolean(),
  /** Anyone may react even when the room is read-only. */
  reactWhenReadOnly: z.boolean(),
  broadcast: z.boolean(),
  encrypted: z.boolean(),
  archived: z.boolean(),
  isDefault: z.boolean(),
  /** False when Rocket.Chat marks the room as non-leavable. */
  canLeave: z.boolean(),
  /** Set when this room is a discussion; points at the room it was spawned from. */
  parentRoomId: IdSchema.nullable(),
  teamId: IdSchema.nullable(),
  /** True when the room *is* the team's main channel rather than merely belonging to one. */
  isTeamMain: z.boolean(),
  /** Direct-message peers, excluding the current user. Empty for other room types. */
  directMembers: z.array(UserSummarySchema),
  lastMessageAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema.nullable(),
  updatedAt: IsoDateTimeSchema.nullable(),
});
export type Room = z.infer<typeof RoomSchema>;

/**
 * A room joined with the caller's subscription to it. This is what the sidebar
 * renders: Rocket.Chat keeps read state on the subscription, not the room, and
 * fetching them separately for every room is what makes naive clients slow.
 */
export const RoomSummarySchema = RoomSchema.extend({
  /** Whether the caller has a real subscription rather than merely preview access. */
  joined: z.boolean(),
  /** Per-user override of the room name (Rocket.Chat allows renaming a DM locally). */
  unreadCount: z.number().int().min(0),
  userMentionsCount: z.number().int().min(0),
  groupMentionsCount: z.number().int().min(0),
  /** Rocket.Chat's "has activity" flag; not always equal to `unreadCount > 0`. */
  hasUnreadActivity: z.boolean(),
  favorite: z.boolean(),
  /** False when the user closed the room; it stays subscribed but hidden. */
  open: z.boolean(),
  hidden: z.boolean(),
  muted: z.boolean(),
  /** The caller was muted by a room moderator and cannot post. */
  mutedForPosting: z.boolean(),
  /** The caller is explicitly exempt from this room's read-only restriction. */
  unmutedForPosting: z.boolean(),
  /** Direct-message block state in either direction. */
  blocked: z.boolean(),
  blocker: z.boolean(),
  lastSeenAt: IsoDateTimeSchema.nullable(),
  roles: z.array(z.string()),
  lastMessagePreview: z
    .object({
      id: IdSchema,
      text: z.string(),
      sender: UserSummarySchema,
      createdAt: IsoDateTimeSchema,
    })
    .nullable(),
});
export type RoomSummary = z.infer<typeof RoomSummarySchema>;
