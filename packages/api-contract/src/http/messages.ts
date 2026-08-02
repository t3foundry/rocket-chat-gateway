import { z } from 'zod';

import { IdSchema, IsoDateTimeSchema, OffsetPaginationSchema, paginatedSchema } from '../common.js';
import { MessageSchema } from '../models/message.js';

/**
 * `GET /api/v1/rooms/:roomId/messages`
 *
 * Anchored on timestamps rather than offsets: a chat timeline shifts under
 * offset pagination every time somebody posts, which is how clients end up
 * showing duplicated or skipped messages while scrolling back.
 */
export const ListMessagesQuerySchema = z.object({
  /** Return messages strictly older than this instant (scroll back). */
  before: IsoDateTimeSchema.optional(),
  /** Return messages strictly newer than this instant (catch up after reconnect). */
  after: IsoDateTimeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /**
   * Thread queries only: how many replies back from the newest to start.
   *
   * A thread is a closed list rather than a moving window — replies only ever
   * land at its end — so offsets are stable here in a way they are not on the
   * main timeline, and Rocket.Chat only offers offsets for it anyway. Ignored
   * unless `threadId` is set.
   */
  offset: z.coerce.number().int().min(0).default(0),
  /**
   * Restrict to one thread. Omit for the main timeline.
   *
   * The thread's parent message is included as the first item of the oldest
   * page, so a client that has paged to the top of a thread has the message it
   * hangs off without a second request.
   */
  threadId: IdSchema.optional(),
  /** Include threaded replies in the main timeline. Rocket.Chat hides them by default. */
  includeThreadReplies: z.stringbool().default(false),
});
export type ListMessagesQuery = z.infer<typeof ListMessagesQuerySchema>;

export const ListMessagesResponseSchema = z.object({
  /** Oldest first, so clients can append without reversing. */
  items: z.array(MessageSchema),
  /** True when more messages exist beyond the window, in the direction requested. */
  hasMore: z.boolean(),
  /**
   * Only ever true for `after` queries. Rocket.Chat can only return the *newest*
   * messages in a time range, so catching up across a very long disconnect can
   * leave a hole between the `after` anchor and `items[0]`. When this is set the
   * window is not contiguous with what the client already has, and the room
   * should be reloaded from scratch instead of appended to.
   */
  gapBefore: z.boolean(),
});
export type ListMessagesResponse = z.infer<typeof ListMessagesResponseSchema>;

/** `POST /api/v1/rooms/:roomId/messages` */
export const SendMessageRequestSchema = z.object({
  text: z.string(),
  /** Reply into a thread rooted at this message. */
  threadId: IdSchema.optional(),
  /** When replying in a thread, also surface the reply in the main timeline. */
  showInMainChannel: z.boolean().optional(),
  /**
   * Client-generated id. Rocket.Chat accepts it as the message `_id`, which
   * makes optimistic sends idempotent across retries and reconnects.
   */
  clientMessageId: IdSchema.optional(),
  /** Ids of previously uploaded files to attach. */
  attachmentIds: z.array(IdSchema).optional(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

export const SendMessageResponseSchema = MessageSchema;
export type SendMessageResponse = z.infer<typeof SendMessageResponseSchema>;

/** `PATCH /api/v1/rooms/:roomId/messages/:messageId` */
export const UpdateMessageRequestSchema = z.object({
  text: z.string(),
});
export type UpdateMessageRequest = z.infer<typeof UpdateMessageRequestSchema>;

export const UpdateMessageResponseSchema = MessageSchema;
export type UpdateMessageResponse = z.infer<typeof UpdateMessageResponseSchema>;

/** `DELETE /api/v1/rooms/:roomId/messages/:messageId` */
export const DeleteMessageResponseSchema = z.object({ ok: z.literal(true) });
export type DeleteMessageResponse = z.infer<typeof DeleteMessageResponseSchema>;

/** `PUT|DELETE /api/v1/rooms/:roomId/messages/:messageId/reactions/:emoji` */
export const ReactionParamsSchema = z.object({
  /** Shortcode with or without colons; the gateway normalises it. */
  emoji: z.string().min(1),
});
export type ReactionParams = z.infer<typeof ReactionParamsSchema>;

export const ReactResponseSchema = z.object({ ok: z.literal(true) });
export type ReactResponse = z.infer<typeof ReactResponseSchema>;

/** `POST|DELETE /api/v1/rooms/:roomId/messages/:messageId/pin` and `/star` */
export const MessageFlagResponseSchema = z.object({ ok: z.literal(true) });
export type MessageFlagResponse = z.infer<typeof MessageFlagResponseSchema>;

/** `GET /api/v1/rooms/:roomId/threads` — thread parents, newest activity first. */
export const ListThreadsQuerySchema = OffsetPaginationSchema;
export type ListThreadsQuery = z.infer<typeof ListThreadsQuerySchema>;

export const ListThreadsResponseSchema = paginatedSchema(MessageSchema);
export type ListThreadsResponse = z.infer<typeof ListThreadsResponseSchema>;

/**
 * `GET /api/v1/rooms/:roomId/pinned`, `/starred` and `/mentions`.
 *
 * Three routes, one shape: each is a filtered view of the room's messages,
 * newest first, and a client renders all three with the same list.
 */
export const ListMessageCollectionQuerySchema = OffsetPaginationSchema;
export type ListMessageCollectionQuery = z.infer<typeof ListMessageCollectionQuerySchema>;

export const ListMessageCollectionResponseSchema = paginatedSchema(MessageSchema);
export type ListMessageCollectionResponse = z.infer<typeof ListMessageCollectionResponseSchema>;

export const ListPinnedMessagesResponseSchema = ListMessageCollectionResponseSchema;
export type ListPinnedMessagesResponse = z.infer<typeof ListPinnedMessagesResponseSchema>;

export const ListStarredMessagesResponseSchema = ListMessageCollectionResponseSchema;
export type ListStarredMessagesResponse = z.infer<typeof ListStarredMessagesResponseSchema>;

export const ListMentionedMessagesResponseSchema = ListMessageCollectionResponseSchema;
export type ListMentionedMessagesResponse = z.infer<typeof ListMentionedMessagesResponseSchema>;

/** `GET /api/v1/rooms/:roomId/messages/search` */
export const SearchMessagesQuerySchema = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type SearchMessagesQuery = z.infer<typeof SearchMessagesQuerySchema>;

export const SearchMessagesResponseSchema = z.object({
  items: z.array(MessageSchema),
});
export type SearchMessagesResponse = z.infer<typeof SearchMessagesResponseSchema>;
