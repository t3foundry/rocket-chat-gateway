import { z } from 'zod';

import { IdSchema, IsoDateTimeSchema } from '../common.js';

export const PresenceStatusSchema = z.enum(['online', 'away', 'busy', 'offline']);
export type PresenceStatus = z.infer<typeof PresenceStatusSchema>;

/**
 * The shape embedded in messages, room owners and member lists. Deliberately
 * small: a room with 5k members should not ship 5k full profiles.
 */
export const UserSummarySchema = z.object({
  id: IdSchema,
  username: z.string(),
  /** `name` when the server has one, otherwise the username. Never empty. */
  displayName: z.string(),
  /** Absolute or gateway-relative URL; resolved by the gateway, never guessed by the client. */
  avatarUrl: z.string().nullable(),
  status: PresenceStatusSchema.nullable(),
});
export type UserSummary = z.infer<typeof UserSummarySchema>;

export const UserProfileSchema = UserSummarySchema.extend({
  email: z.string().nullable(),
  statusText: z.string().nullable(),
  bio: z.string().nullable(),
  roles: z.array(z.string()),
  /** IANA timezone reported by the server, e.g. `Asia/Ho_Chi_Minh`. */
  timezone: z.string().nullable(),
  language: z.string().nullable(),
  createdAt: IsoDateTimeSchema.nullable(),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;
