import { z } from 'zod';

import { IdSchema } from '../common.js';
import { MessageSchema } from '../models/message.js';

/**
 * `POST /api/v1/rooms/:roomId/files` — `multipart/form-data` with a `file` part.
 *
 * Rocket.Chat couples upload and message creation in a single endpoint, so this
 * returns the message the upload produced rather than a bare file handle.
 */
export const UploadFileFieldsSchema = z.object({
  /** Caption posted alongside the file. */
  description: z.string().optional(),
  /** Upload into a thread instead of the main timeline. */
  threadId: IdSchema.optional(),
});
export type UploadFileFields = z.infer<typeof UploadFileFieldsSchema>;

export const UploadFileResponseSchema = MessageSchema;
export type UploadFileResponse = z.infer<typeof UploadFileResponseSchema>;
