import type { PresenceStatus, UserProfile, UserSummary } from '@t3foundry/open-rocket-chat-api-contract';
import type { RcUser, RcUserSummary } from '@t3foundry/open-rocket-chat-rc-rest-client';

import { toIsoString, type AdapterContext } from './context.js';

const PRESENCE_VALUES: PresenceStatus[] = ['online', 'away', 'busy', 'offline'];

const toPresence = (status: string | undefined): PresenceStatus | null => {
  if (!status) return null;
  // Rocket.Chat also reports `disabled` for deactivated accounts; from a
  // client's point of view that is indistinguishable from offline.
  if (status === 'disabled') return 'offline';
  return PRESENCE_VALUES.includes(status as PresenceStatus) ? (status as PresenceStatus) : null;
};

export const toUserSummary = (user: RcUserSummary | RcUser, context: AdapterContext): UserSummary => {
  const username = user.username ?? '';
  const full = user as RcUser;

  return {
    id: user._id,
    username,
    // Rocket.Chat leaves `name` empty for accounts created via the API, and a
    // blank display name would render as an empty row in every member list.
    displayName: user.name?.trim() || username || user._id,
    avatarUrl: username ? context.avatarUrl(username, full.avatarETag ?? null) : null,
    status: toPresence(full.status),
  };
};

export const toUserProfile = (user: RcUser, context: AdapterContext): UserProfile => ({
  ...toUserSummary(user, context),
  email: user.emails?.find((entry) => entry.address)?.address ?? null,
  statusText: user.statusText ?? null,
  bio: user.bio ?? null,
  roles: user.roles ?? [],
  // Rocket.Chat stores the offset in hours, not an IANA zone name; there is no
  // lossless conversion, so the offset is surfaced as a fixed-offset zone.
  timezone: typeof user.utcOffset === 'number' ? utcOffsetToZone(user.utcOffset) : null,
  language: user.language ?? null,
  createdAt: toIsoString(user.createdAt),
});

/**
 * The caller's own profile, from `/api/v1/me`.
 *
 * `status` there is presence as Rocket.Chat computes it: the presence the user
 * chose, narrowed by their live sessions. A user with no DDP session is offline
 * to everybody no matter what they picked, so a REST client that sets `busy`
 * and reads back gets `offline` — accurate for onlookers, wrong for the status
 * picker, which asks what *this* user chose. That intent is `statusDefault`,
 * and it is what this reports; `status` remains the fallback for a server too
 * old or too restricted to send one.
 */
export const toMyProfile = (user: RcUser, context: AdapterContext): UserProfile => ({
  ...toUserProfile(user, context),
  status: toPresence(user.statusDefault) ?? toPresence(user.status),
});

/**
 * `7` -> `UTC+07:00`. Deliberately not guessed as `Asia/Ho_Chi_Minh`: an offset
 * maps to many zones and picking one silently breaks daylight-saving handling.
 */
const utcOffsetToZone = (offsetHours: number): string => {
  const sign = offsetHours < 0 ? '-' : '+';
  const absolute = Math.abs(offsetHours);
  const hours = Math.floor(absolute);
  const minutes = Math.round((absolute - hours) * 60);
  return `UTC${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};
