/**
 * Everything the normalisers need that cannot be derived from a Rocket.Chat
 * record alone: who is asking, and how to turn upstream paths into URLs the
 * caller is actually allowed to fetch.
 */
export interface AdapterContext {
  currentUserId: string;
  currentUsername: string;
  /**
   * Builds a URL for a user's avatar. Returning `null` means "no avatar",
   * which clients render as initials rather than a broken image.
   */
  avatarUrl: (username: string, etag?: string | null) => string | null;
  /**
   * Builds a URL for a room's picture. Addressed by id rather than by name,
   * because a direct message has no name and a room can be renamed while its
   * picture stays put.
   */
  roomAvatarUrl: (roomId: string, etag: string) => string;
  /**
   * Rewrites a Rocket.Chat file path (`/file-upload/<id>/<name>`) into a URL the
   * client can request. Under the gateway this points back at the gateway,
   * which streams the bytes using the server-side credentials — the browser
   * never gets a Rocket.Chat token to fetch files with.
   */
  fileUrl: (path: string) => string;
}

/** Rocket.Chat dates arrive as ISO strings, epoch millis or `{ $date }`. */
export type RcDateLike = string | number | { $date: number } | Date | null | undefined;

export const toIsoString = (value: RcDateLike): string | null => {
  if (value === null || value === undefined) return null;

  const date =
    value instanceof Date
      ? value
      : typeof value === 'object'
        ? new Date(value.$date)
        : typeof value === 'number'
          ? new Date(value)
          : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/** Same as {@link toIsoString} but for fields the contract marks non-nullable. */
export const toIsoStringOrEpoch = (value: RcDateLike): string => toIsoString(value) ?? new Date(0).toISOString();
