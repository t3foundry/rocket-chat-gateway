import { z } from 'zod';

import { IdSchema, IsoDateTimeSchema } from '../common.js';
import { UserSummarySchema } from './user.js';

export const ReactionSchema = z.object({
  /** Shortcode including colons, e.g. `:thumbsup:`. */
  emoji: z.string(),
  usernames: z.array(z.string()),
  count: z.number().int().min(0),
  /** Whether the requesting user is among `usernames`. Saved every client the lookup. */
  reactedByMe: z.boolean(),
});
export type Reaction = z.infer<typeof ReactionSchema>;

export const MentionSchema = z.object({
  id: IdSchema,
  username: z.string(),
  displayName: z.string().nullable(),
  /** `all` and `here` are broadcast mentions with no backing user record. */
  kind: z.enum(['user', 'team', 'all', 'here']),
});
export type Mention = z.infer<typeof MentionSchema>;

/**
 * A `#room` named in the message body.
 *
 * Kept apart from {@link MentionSchema} because it resolves to a room rather
 * than a person, and because Rocket.Chat stores the two in separate fields. The
 * id is what lets a client show the room without first having to find it by
 * name — including rooms the reader has not joined.
 */
export const ChannelMentionSchema = z.object({
  id: IdSchema,
  /** URL-safe room name, exactly as it was written after the `#`. */
  name: z.string(),
});
export type ChannelMention = z.infer<typeof ChannelMentionSchema>;

export const AttachmentKindSchema = z.enum(['image', 'video', 'audio', 'file', 'quote', 'link', 'unknown']);
export type AttachmentKind = z.infer<typeof AttachmentKindSchema>;

/**
 * Rocket.Chat attachments are a loose union discriminated by which optional
 * fields happen to be present. We collapse them to one shape with an explicit
 * `kind` so clients can `switch` instead of sniffing properties.
 */
export const AttachmentSchema = z.object({
  kind: AttachmentKindSchema,
  title: z.string().nullable(),
  /** Gateway-proxied download URL when the attachment is a hosted file. */
  url: z.string().nullable(),
  description: z.string().nullable(),
  text: z.string().nullable(),
  mimeType: z.string().nullable(),
  size: z.number().int().min(0).nullable(),
  /** Present for `image`/`video`; lets the client reserve layout before loading. */
  dimensions: z.object({ width: z.number(), height: z.number() }).nullable(),
  thumbnailUrl: z.string().nullable(),
  /** Accent colour requested by the sender (integrations use this heavily). */
  color: z.string().nullable(),
  author: z
    .object({
      name: z.string(),
      iconUrl: z.string().nullable(),
      link: z.string().nullable(),
    })
    .nullable(),
  /** Set on `quote` attachments: the message being quoted. */
  quotedMessageUrl: z.string().nullable(),
  createdAt: IsoDateTimeSchema.nullable(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const FileRefSchema = z.object({
  id: IdSchema,
  name: z.string(),
  mimeType: z.string().nullable(),
  size: z.number().int().min(0).nullable(),
  /** Gateway-proxied URL; the raw Rocket.Chat path is never exposed. */
  url: z.string(),
  /**
   * Downscaled preview for images, when the server generated one. Clients
   * should render this in the timeline and only fetch `url` on demand — a room
   * scrolling past twenty photos otherwise pulls twenty full-size originals.
   */
  thumbnailUrl: z.string().nullable(),
});
export type FileRef = z.infer<typeof FileRefSchema>;

/**
 * `user` is an ordinary chat message. Everything else is a system event that
 * Rocket.Chat stores in the same collection (joins, topic changes, …). Clients
 * render the two very differently, so the distinction is first-class.
 */
export const MessageKindSchema = z.enum(['user', 'system']);
export type MessageKind = z.infer<typeof MessageKindSchema>;

export const MessageSchema = z.object({
  id: IdSchema,
  roomId: IdSchema,
  /** Set when the message belongs to a thread; equals the thread parent's id. */
  threadId: IdSchema.nullable(),
  /** True when a threaded reply should also appear in the main channel timeline. */
  showInMainChannel: z.boolean(),
  kind: MessageKindSchema,
  /** Raw Rocket.Chat system type (`uj`, `room_changed_topic`, …); null for user messages. */
  systemType: z.string().nullable(),
  text: z.string(),
  sender: UserSummarySchema,
  /** Display name override supplied by bots/integrations. */
  senderAlias: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema.nullable(),
  /** Non-null only when a human edited the message, unlike `updatedAt`. */
  editedAt: IsoDateTimeSchema.nullable(),
  editedBy: UserSummarySchema.nullable(),
  reactions: z.array(ReactionSchema),
  attachments: z.array(AttachmentSchema),
  files: z.array(FileRefSchema),
  mentions: z.array(MentionSchema),
  /** Rooms named with `#` in the text, for the client to link them up. */
  channels: z.array(ChannelMentionSchema),
  pinned: z.boolean(),
  /** Starring is per-user, so this is always relative to the requesting user. */
  starred: z.boolean(),
  /** Reply count when this message is a thread parent. */
  threadCount: z.number().int().min(0),
  threadLastReplyAt: IsoDateTimeSchema.nullable(),
  /** Users following the thread rooted at this message. */
  threadParticipantIds: z.array(IdSchema),
  urls: z.array(z.string()),
  /**
   * End-to-end encrypted. `text` holds ciphertext the gateway cannot read, so
   * clients must render a placeholder rather than the raw string.
   */
  encrypted: z.boolean(),
  /** True for `chat.sendMessage` echoes the client itself created; helps dedupe. */
  isTemporary: z.boolean().default(false),
});
export type Message = z.infer<typeof MessageSchema>;
