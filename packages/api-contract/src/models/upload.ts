import { z } from 'zod';

import { IdSchema, IsoDateTimeSchema } from '../common.js';
import { UserSummarySchema } from './user.js';

/**
 * Rocket.Chat's own Files panel groups uploads by the first half of the MIME
 * type, and `application` is what it labels "Files" — everything that is not
 * one of the recognised media families.
 */
export const FileTypeGroupSchema = z.enum(['image', 'video', 'audio', 'text', 'application']);
export type FileTypeGroup = z.infer<typeof FileTypeGroupSchema>;

/**
 * An upload as the room's file list sees it.
 *
 * Distinct from `FileRef`, which is a file *attached to a message*: this is the
 * stored record, and it carries who uploaded it and when — neither of which the
 * message-level shape has, because the message already says both.
 */
export const RoomFileSchema = z.object({
  id: IdSchema,
  name: z.string(),
  mimeType: z.string().nullable(),
  size: z.number().int().min(0).nullable(),
  description: z.string().nullable(),
  typeGroup: FileTypeGroupSchema,
  /** Gateway-proxied download URL; the raw Rocket.Chat path is never exposed. */
  url: z.string(),
  /** Downscaled preview for images, when the server generated one. */
  thumbnailUrl: z.string().nullable(),
  dimensions: z.object({ width: z.number(), height: z.number() }).nullable(),
  uploadedBy: UserSummarySchema.nullable(),
  uploadedAt: IsoDateTimeSchema.nullable(),
});
export type RoomFile = z.infer<typeof RoomFileSchema>;
