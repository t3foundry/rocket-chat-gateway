import { z } from 'zod';

import { RoomSummarySchema } from '../models/room.js';
import { UserProfileSchema } from '../models/user.js';

/**
 * Image types Rocket.Chat stores but cannot render back.
 *
 * Mirrors `unrenderableImageTypes` in Rocket.Chat: the avatar store accepts
 * anything under `image/`, and these are the ones that would be saved happily
 * and then show as a broken picture everywhere.
 */
export const UNRENDERABLE_IMAGE_TYPES = ['image/tiff', 'image/x-motion-jpeg', 'image/avs-video', 'image/pic'];

/** What an `<input type="file">` should offer for an avatar. */
export const AVATAR_ACCEPT = 'image/*';

/**
 * Whether a media type may be used as an avatar. Parameters are ignored, so
 * `image/png; charset=binary` — which some browsers send — still passes.
 */
export const isAvatarMediaType = (contentType: string | null | undefined): boolean => {
  const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return type.startsWith('image/') && !UNRENDERABLE_IMAGE_TYPES.includes(type);
};

/**
 * `POST /api/v1/users/me/avatar` — `multipart/form-data` with an `image` part.
 * `DELETE` on the same path restores the generated initials.
 *
 * Both answer with the profile as it stands afterwards, for the same reason
 * `PATCH /users/me/status` does: Rocket.Chat mints a new avatar tag on write,
 * and the caller needs it to address the new picture rather than the cached
 * old one.
 */
export const SetMyAvatarResponseSchema = UserProfileSchema;
export type SetMyAvatarResponse = z.infer<typeof SetMyAvatarResponseSchema>;

/**
 * `POST /api/v1/rooms/:roomId/avatar` — `multipart/form-data` with an `image`
 * part. `DELETE` on the same path clears it.
 */
export const SetRoomAvatarResponseSchema = RoomSummarySchema;
export type SetRoomAvatarResponse = z.infer<typeof SetRoomAvatarResponseSchema>;
