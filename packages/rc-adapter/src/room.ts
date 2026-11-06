import type {
  Room,
  RoomSummary,
  RoomType,
  RoomVisibility,
  UserSummary,
} from '@t3foundry/open-rocket-chat-api-contract';
import type { RcRoom, RcSubscription } from '@t3foundry/open-rocket-chat-rc-rest-client';

import { toIsoString, type AdapterContext } from './context.js';
import { toUserSummary } from './user.js';

/**
 * Rocket.Chat spreads the room kind across a type letter and two orthogonal
 * flags. Order matters: a discussion inside a team carries both `prid` and
 * `teamId`, and it should read as a discussion.
 */
export const toRoomType = (source: {
  t?: string;
  prid?: string;
  teamMain?: boolean;
  // Accepted but unused: callers pass whole room or subscription records, and
  // a narrower parameter would reject them under excess-property checking.
  teamId?: string;
}): RoomType => {
  if (source.t === 'l') return 'omnichannel';
  if (source.t === 'd') return 'direct';
  if (source.prid) return 'discussion';
  if (source.teamMain) return 'team';
  return source.t === 'c' ? 'channel' : 'private';
};

const toRoomVisibility = (type: string | undefined): RoomVisibility => {
  if (type === 'c') return 'public';
  if (type === 'd') return 'direct';
  if (type === 'l') return 'omnichannel';
  return 'private';
};

/**
 * Direct-message peers. Rocket.Chat stores ids and usernames in two parallel
 * arrays with no guaranteed correspondence, so they are only zipped when the
 * lengths line up; otherwise the caller falls back to the room's display name.
 */
const toDirectMembers = (room: RcRoom, context: AdapterContext): UserSummary[] => {
  if (room.t !== 'd') return [];

  const usernames = room.usernames ?? [];
  const uids = room.uids ?? [];
  if (usernames.length === 0 || usernames.length !== uids.length) return [];

  return usernames
    .map((username, index) => ({ username, id: uids[index] as string }))
    .filter((entry) => entry.username !== context.currentUsername)
    .map((entry) => toUserSummary({ _id: entry.id, username: entry.username, name: entry.username }, context));
};

/**
 * The room's picture, or `null` when it has none.
 *
 * The avatar tag is the only usable signal here. Rocket.Chat answers
 * `/avatar/room/<id>` for every room, generating initials when nothing is
 * stored, so a URL that always resolves would stop a client drawing the room's
 * own icon — and `avatarOrigin`, which would say this outright, is returned by
 * `rooms.info` but projected out of `rooms.get`, the route the sidebar syncs
 * from.
 *
 * Clearing a picture does not remove the tag: `Rooms.unsetAvatarData` replaces
 * it with `Date.now().toString()` so caches refetch the generated initials. A
 * tag that is nothing but digits is therefore a tombstone rather than a
 * picture — a real one is a `Random.id()`, seventeen characters drawn from an
 * alphabet that is mostly letters.
 */
const roomAvatarUrl = (room: RcRoom, context: AdapterContext): string | null => {
  const etag = room.avatarETag;
  if (!etag || /^\d+$/.test(etag)) return null;

  return context.roomAvatarUrl(room._id, etag);
};

export const toRoom = (room: RcRoom, context: AdapterContext): Room => {
  const type = toRoomType(room);

  return {
    id: room._id,
    type,
    visibility: toRoomVisibility(room.t),
    // Direct messages have no addressable name; `name` on a DM record is the
    // peer's username, which would be misleading as a room identifier.
    name: type === 'direct' ? null : (room.name ?? null),
    displayName: roomDisplayName(room),
    topic: room.topic ?? null,
    description: room.description ?? null,
    announcement: room.announcement ?? null,
    avatarUrl: roomAvatarUrl(room, context),
    owner: room.u ? toUserSummary(room.u, context) : null,
    membersCount: room.usersCount ?? 0,
    messagesCount: room.msgs ?? 0,
    readOnly: room.ro ?? false,
    reactWhenReadOnly: room.reactWhenReadOnly ?? false,
    broadcast: room.broadcast ?? false,
    encrypted: room.encrypted ?? false,
    archived: room.archived ?? false,
    isDefault: room.default ?? false,
    canLeave: room.cl !== false,
    parentRoomId: room.prid ?? null,
    teamId: room.teamId ?? null,
    isTeamMain: room.teamMain ?? false,
    directMembers: toDirectMembers(room, context),
    lastMessageAt: toIsoString(room.lm),
    createdAt: toIsoString(room.ts),
    updatedAt: toIsoString(room._updatedAt),
  };
};

/**
 * Joins a room with the caller's subscription. The subscription wins for
 * display purposes because Rocket.Chat lets a user rename a room locally, and
 * it is the only source for read state.
 */
export const toRoomSummary = (
  room: RcRoom | null,
  subscription: RcSubscription,
  context: AdapterContext,
  joined = true,
): RoomSummary => {
  const base: Room = room
    ? toRoom(room, context)
    : // Subscriptions can outlive our view of a room — for example when
      // `subscriptions.get` returns before `rooms.get` catches up. The
      // subscription alone carries enough to render a sidebar entry.
      {
        id: subscription.rid,
        type: toRoomType(subscription),
        visibility: toRoomVisibility(subscription.t),
        name: subscription.t === 'd' ? null : (subscription.name ?? null),
        displayName: subscription.fname?.trim() || subscription.name || subscription.rid,
        topic: null,
        description: null,
        announcement: null,
        // A subscription carries no avatar tag, so a room known only through
        // one shows initials until `rooms.get` catches up with it.
        avatarUrl: null,
        owner: null,
        membersCount: 0,
        messagesCount: 0,
        readOnly: false,
        reactWhenReadOnly: false,
        broadcast: false,
        encrypted: false,
        archived: subscription.archived ?? false,
        isDefault: false,
        canLeave: true,
        parentRoomId: subscription.prid ?? null,
        teamId: subscription.teamId ?? null,
        isTeamMain: subscription.teamMain ?? false,
        directMembers: [],
        lastMessageAt: null,
        createdAt: toIsoString(subscription.ts),
        updatedAt: toIsoString(subscription._updatedAt),
      };

  const lastMessage = room?.lastMessage;

  return {
    ...base,
    joined,
    // Some Rocket.Chat versions keep a direct-message archive marker only on
    // its subscription; ordinary rooms carry it on the room record.
    archived: base.archived || (subscription.t === 'd' && (subscription.archived ?? false)),
    displayName: subscription.fname?.trim() || base.displayName,
    unreadCount: subscription.unread ?? 0,
    userMentionsCount: subscription.userMentions ?? 0,
    groupMentionsCount: subscription.groupMentions ?? 0,
    hasUnreadActivity: subscription.alert ?? false,
    favorite: subscription.f ?? false,
    open: subscription.open ?? true,
    hidden: !(subscription.open ?? true),
    muted: subscription.disableNotifications ?? false,
    mutedForPosting: room?.muted?.includes(context.currentUsername) ?? false,
    unmutedForPosting: room?.unmuted?.includes(context.currentUsername) ?? false,
    blocked: subscription.blocked ?? false,
    blocker: subscription.blocker ?? false,
    lastSeenAt: toIsoString(subscription.ls),
    roles: subscription.roles ?? [],
    lastMessagePreview:
      lastMessage && lastMessage.u
        ? {
            id: lastMessage._id,
            text: lastMessage.msg ?? '',
            sender: toUserSummary(lastMessage.u, context),
            createdAt: toIsoString(lastMessage.ts) ?? new Date(0).toISOString(),
          }
        : null,
  };
};

const roomDisplayName = (room: RcRoom): string =>
  room.fname?.trim() || room.name?.trim() || room.usernames?.join(', ') || room._id;
