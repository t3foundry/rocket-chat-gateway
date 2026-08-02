import { z } from 'zod';

import { PresenceStatusSchema, UserProfileSchema, UserSummarySchema } from '../models/user.js';

/** `GET /api/v1/users/:userIdOrUsername` */
export const GetUserResponseSchema = UserProfileSchema;
export type GetUserResponse = z.infer<typeof GetUserResponseSchema>;

/** `GET /api/v1/users/search?q=` — used by the mention autocomplete. */
export const SearchUsersQuerySchema = z.object({
  /**
   * Empty is meaningful, not missing: an empty term matches every user, which
   * gives a member picker something to show before anybody types.
   */
  q: z.string().default(''),
  /**
   * A ceiling, not a request. Rocket.Chat decides how many suggestions a search
   * returns — `Number_of_users_autocomplete_suggestions`, five by default — and
   * has no parameter to ask for more.
   */
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchUsersQuery = z.infer<typeof SearchUsersQuerySchema>;

export const SearchUsersResponseSchema = z.object({
  items: z.array(UserSummarySchema),
});
export type SearchUsersResponse = z.infer<typeof SearchUsersResponseSchema>;

/** What Rocket.Chat's own account screen allows in a status message. */
export const STATUS_TEXT_MAX_LENGTH = 120;

/**
 * `PATCH /api/v1/users/me/status`
 *
 * Both fields are optional and independent, so a client can flip the presence
 * dot without touching the message, or clear the message without changing the
 * dot. `offline` is Rocket.Chat's "invisible": the user stays connected and
 * everybody else sees them as away from the app.
 *
 * An empty `statusText` clears the message — it is a value, not an omission,
 * which is why the two cases have to stay distinguishable.
 */
export const UpdateMyStatusRequestSchema = z
  .object({
    status: PresenceStatusSchema.optional(),
    statusText: z.string().max(STATUS_TEXT_MAX_LENGTH).optional(),
  })
  .refine((body) => body.status !== undefined || body.statusText !== undefined, {
    message: 'provide status, statusText, or both',
  });
export type UpdateMyStatusRequest = z.infer<typeof UpdateMyStatusRequestSchema>;

/** The caller's profile as it stands after the change. */
export const UpdateMyStatusResponseSchema = UserProfileSchema;
export type UpdateMyStatusResponse = z.infer<typeof UpdateMyStatusResponseSchema>;
