import type {
  CreateDirectRoomResponse,
  CreateRoomRequest,
  CreateRoomResponse,
  ListRoomFilesQuery,
  ListRoomFilesResponse,
  ListRoomMembersQuery,
  ListRoomRolesResponse,
  NotificationAlert,
  PruneMessagesRequest,
  PruneMessagesResponse,
  RoomMemberRole,
  RoomNotificationPreferences,
  UpdateRoomMemberRequest,
  UpdateRoomNotificationsRequest,
  UpdateRoomRequest,
  ListRoomMembersResponse,
  ListRoomsQuery,
  ListRoomsResponse,
  RoomSummary,
  UpdateRoomStateRequest,
} from '@open-rocket-chat/api-contract';
import { toRoom, toRoomFile, toRoomSummary, toUserSummary } from '@open-rocket-chat/rc-adapter';
import type { RcNotificationPreferences, RcRoom, RcSubscription } from '@open-rocket-chat/rc-rest-client';
import { Injectable } from '@nestjs/common';

import { ApiException } from '../common/api-exception';
import { toDataUri, withSettledAvatarTag, type AvatarUpload } from '../common/avatar';
import { toApiException } from '../common/upstream-error';
import { RocketChatService } from '../rocketchat/rocketchat.service';
import type { ServerSession } from '../session/session.types';

/**
 * How many room types to remember before the oldest are dropped.
 *
 * A busy account is in a few hundred rooms; this leaves room for several
 * servers' worth without letting a long-lived process grow without bound.
 */
const ROOM_TYPE_CACHE_LIMIT = 5_000;

@Injectable()
export class RoomsService {
  /**
   * `serverId:roomId` → Rocket.Chat's type letter.
   *
   * Rocket.Chat namespaces its history routes by type (`channels.history`,
   * `groups.history`, `im.history`), so every message page needs this letter
   * before it can ask for anything. Reading it from `rooms.info` each time
   * doubles the round-trips of the busiest route in the product — invisible
   * against a server on localhost, and the difference between fast and
   * visibly slow against one across the internet.
   *
   * Keyed by server rather than by session because a room's type belongs to
   * the room, not to whoever is looking at it.
   */
  private readonly roomTypes = new Map<string, string>();

  constructor(private readonly rocketChat: RocketChatService) {}

  /**
   * The sidebar in one request.
   *
   * Rocket.Chat splits this across `subscriptions.get` (read state, favourites)
   * and `rooms.get` (names, topics, member counts), and neither is usable
   * alone. Joining them here is the single biggest reason a client talking to
   * the gateway is simpler than one talking to Rocket.Chat.
   */
  async list(session: ServerSession, query: ListRoomsQuery): Promise<ListRoomsResponse> {
    const client = this.rocketChat.userClient(session);
    const context = this.rocketChat.adapterContext(session);
    // Captured before the calls so a room changed mid-flight is re-fetched on
    // the next delta rather than being silently skipped.
    const syncedAt = new Date().toISOString();

    try {
      const [subscriptions, rooms] = await Promise.all([
        client.rooms.listSubscriptions(query.updatedSince),
        client.rooms.list(query.updatedSince),
      ]);

      const roomsById = new Map<string, RcRoom>(rooms.update.map((room) => [room._id, room]));

      // Warms the type cache for everything in the sidebar, so opening a room
      // and paging its history cost no extra round-trips at all.
      for (const [roomId, room] of roomsById) {
        this.rememberRoomType(session.serverId, roomId, room.t);
      }

      let items = subscriptions.update.map((subscription) =>
        toRoomSummary(roomsById.get(subscription.rid) ?? null, subscription, context),
      );

      if (query.openOnly) {
        items = items.filter((room) => room.open);
      }

      if (query.types?.length) {
        const allowed = new Set(query.types);
        items = items.filter((room) => allowed.has(room.type));
      }

      items.sort(byRecentActivity);

      return {
        items,
        removedRoomIds: [
          ...new Set([
            ...subscriptions.remove.map((subscription) => subscription.rid),
            ...rooms.remove.map((room) => room._id),
          ]),
        ],
        syncedAt,
      };
    } catch (error) {
      throw toApiException(error);
    }
  }

  async get(session: ServerSession, roomId: string): Promise<RoomSummary> {
    const client = this.rocketChat.userClient(session);
    const context = this.rocketChat.adapterContext(session);

    try {
      const [room, subscription] = await Promise.all([client.rooms.info(roomId), client.rooms.subscription(roomId)]);

      this.rememberRoomType(session.serverId, roomId, room.t);

      if (!subscription) {
        // Visible but not joined: Rocket.Chat allows reading some public
        // channels without a subscription, so synthesise a neutral one rather
        // than 404-ing a room the user can legitimately open.
        return toRoomSummary(room, unsubscribedPlaceholder(room, session), context, false);
      }

      return toRoomSummary(room, subscription, context);
    } catch (error) {
      throw toApiException(error);
    }
  }

  async members(session: ServerSession, roomId: string, query: ListRoomMembersQuery): Promise<ListRoomMembersResponse> {
    const client = this.rocketChat.userClient(session);
    const context = this.rocketChat.adapterContext(session);

    try {
      // The member route is namespaced by room type, so the type has to be
      // known first; there is no generic endpoint. Read through the cache
      // rather than with `rooms.info`: mention autocomplete calls this on a
      // keystroke, and paying for a full room record each time — to use one
      // letter of it — doubled the round trips for nothing.
      const roomType = await this.roomType(session, roomId);
      const { members, total } = await client.rooms.members(roomType, roomId, {
        offset: query.offset,
        count: query.limit,
        ...(query.q ? { filter: query.q } : {}),
        // Rocket.Chat's own member list treats "online" as everyone who is not
        // offline, so away and busy belong in it too.
        ...(query.onlineOnly ? { status: ['online', 'away', 'busy'] } : {}),
      });

      return {
        items: members.map((member) => toUserSummary(member, context)),
        total,
        offset: query.offset,
        limit: query.limit,
      };
    } catch (error) {
      throw toApiException(error);
    }
  }

  /**
   * Role assignments for the whole room, plus who is silenced in it.
   *
   * Muting is stored on the room as a list of usernames while roles come from
   * a separate route, but both answer the same question a member list asks of
   * every row, so they are served together.
   */
  async roles(session: ServerSession, roomId: string): Promise<ListRoomRolesResponse> {
    const client = this.rocketChat.userClient(session);

    try {
      const room = await client.rooms.info(roomId);
      const roles = await client.rooms.roles(room.t, roomId);
      const muted = new Set(room.muted ?? []);

      const byUserId = new Map<string, { userId: string; username: string; roles: RoomMemberRole[]; muted: boolean }>();

      for (const record of roles) {
        const username = record.u?.username ?? '';
        byUserId.set(record.u._id, {
          userId: record.u._id,
          username,
          // Rocket.Chat stores every role on the same record, including ones
          // that are not room roles on older servers.
          roles: record.roles.filter((role): role is RoomMemberRole =>
            (['owner', 'moderator', 'leader'] as string[]).includes(role),
          ),
          muted: muted.has(username),
        });
      }

      // Someone silenced without holding a role has no role record at all, and
      // would otherwise be missing from a list the member rows read from.
      for (const username of muted) {
        if ([...byUserId.values()].some((entry) => entry.username === username)) continue;
        byUserId.set(`muted:${username}`, { userId: '', username, roles: [], muted: true });
      }

      return { items: [...byUserId.values()] };
    } catch (error) {
      throw toApiException(error);
    }
  }

  async addMembers(session: ServerSession, roomId: string, userIds: string[]): Promise<void> {
    const roomType = await this.roomType(session, roomId);

    if (roomType === 'd') {
      throw ApiException.localized('bad_request', 'directMessageCannotInvite');
    }

    try {
      await this.rocketChat.userClient(session).rooms.invite(roomType, roomId, userIds);
    } catch (error) {
      throw toApiException(error);
    }
  }

  async removeMember(session: ServerSession, roomId: string, userId: string): Promise<void> {
    const roomType = await this.roomType(session, roomId);

    if (roomType === 'd') {
      throw ApiException.localized('bad_request', 'directMessageCannotRemove');
    }

    try {
      await this.rocketChat.userClient(session).rooms.kick(roomType, roomId, userId);
    } catch (error) {
      throw toApiException(error);
    }
  }

  /**
   * Room roles and the mute flag for one member.
   *
   * Applied one call at a time because Rocket.Chat has a separate endpoint for
   * each, and sequentially rather than concurrently so a partial failure leaves
   * a state the next read explains — two racing writes to the same subscription
   * can otherwise land in either order.
   */
  async updateMember(
    session: ServerSession,
    roomId: string,
    userId: string,
    changes: UpdateRoomMemberRequest,
  ): Promise<void> {
    const client = this.rocketChat.userClient(session);

    try {
      const room = await client.rooms.info(roomId);

      for (const role of ['owner', 'moderator', 'leader'] as const) {
        const granted = changes[role];
        if (granted !== undefined) {
          await client.rooms.setRoomRole(room.t, roomId, userId, role, granted);
        }
      }

      if (changes.muted !== undefined) {
        // `rooms.muteUser` is keyed by username, unlike every route around it.
        const user = await client.users.info({ userId });
        if (!user.username) throw ApiException.localized('not_found', 'userNotFound');
        await client.rooms.setMuted(roomId, user.username, changes.muted);
      }
    } catch (error) {
      throw toApiException(error);
    }
  }

  async files(session: ServerSession, roomId: string, query: ListRoomFilesQuery): Promise<ListRoomFilesResponse> {
    const client = this.rocketChat.userClient(session);
    const context = this.rocketChat.adapterContext(session);

    try {
      const room = await client.rooms.info(roomId);
      const { files, total } = await client.rooms.files(room.t, roomId, {
        offset: query.offset,
        count: query.limit,
        ...(query.q ? { name: query.q } : {}),
        ...(query.type ? { typeGroup: query.type } : {}),
      });

      return {
        items: files.map((file) => toRoomFile(file, context)),
        total,
        offset: query.offset,
        limit: query.limit,
      };
    } catch (error) {
      throw toApiException(error);
    }
  }

  async notifications(session: ServerSession, roomId: string): Promise<RoomNotificationPreferences> {
    try {
      const subscription = await this.rocketChat.userClient(session).rooms.subscription(roomId);
      return toNotificationPreferences(subscription);
    } catch (error) {
      throw toApiException(error);
    }
  }

  /**
   * Rocket.Chat's `rooms.saveNotification` replaces the whole set rather than
   * merging, so a partial change has to be applied on top of what is stored
   * before it is sent — otherwise changing the sound would reset every alert.
   */
  async updateNotifications(
    session: ServerSession,
    roomId: string,
    changes: UpdateRoomNotificationsRequest,
  ): Promise<RoomNotificationPreferences> {
    const client = this.rocketChat.userClient(session);

    try {
      const current = toNotificationPreferences(await client.rooms.subscription(roomId));

      const next: RoomNotificationPreferences = {
        enabled: changes.enabled ?? current.enabled,
        muteGroupMentions: changes.muteGroupMentions ?? current.muteGroupMentions,
        showCounter: changes.showCounter ?? current.showCounter,
        showMentions: changes.showMentions ?? current.showMentions,
        desktop: {
          alert: changes.desktop?.alert ?? current.desktop.alert,
          sound: changes.desktop?.sound ?? current.desktop.sound,
        },
        mobile: { alert: changes.mobile?.alert ?? current.mobile.alert },
        email: { alert: changes.email?.alert ?? current.email.alert },
      };

      await client.rooms.saveNotification(roomId, toRcNotifications(next));
      return next;
    } catch (error) {
      throw toApiException(error);
    }
  }

  async prune(session: ServerSession, roomId: string, request: PruneMessagesRequest): Promise<PruneMessagesResponse> {
    try {
      const count = await this.rocketChat.userClient(session).rooms.cleanHistory({
        roomId,
        // Rocket.Chat requires both bounds. An omitted one becomes the far end
        // of the range rather than "no bound", which it has no encoding for.
        oldest: request.oldest ?? new Date(0).toISOString(),
        latest: request.latest ?? new Date().toISOString(),
        inclusive: request.inclusive,
        limit: request.limit,
        excludePinned: request.excludePinned,
        filesOnly: request.filesOnly,
        ignoreDiscussion: request.ignoreDiscussion,
        ignoreThreads: request.ignoreThreads,
        ...(request.usernames?.length ? { users: request.usernames } : {}),
      });

      return { count };
    } catch (error) {
      throw toApiException(error);
    }
  }

  async createDirect(session: ServerSession, username: string): Promise<CreateDirectRoomResponse> {
    const client = this.rocketChat.userClient(session);

    try {
      const room = await client.rooms.createDirectMessage(username);
      return toRoom(room, this.rocketChat.adapterContext(session));
    } catch (error) {
      throw toApiException(error);
    }
  }

  async create(session: ServerSession, request: CreateRoomRequest): Promise<CreateRoomResponse> {
    const client = this.rocketChat.userClient(session);

    try {
      const room = await client.rooms.create({
        type: request.type,
        name: request.name,
        ...(request.memberUsernames?.length ? { members: request.memberUsernames } : {}),
        ...(request.readOnly === undefined ? {} : { readOnly: request.readOnly }),
        ...(request.encrypted === undefined ? {} : { encrypted: request.encrypted }),
        ...(request.broadcast === undefined ? {} : { broadcast: request.broadcast }),
      });

      // `channels.create` takes only a name; topic and description need a
      // second call, which Rocket.Chat offers no way to combine.
      if (request.topic || request.description) {
        await client.rooms.saveSettings(room._id, {
          ...(request.topic ? { roomTopic: request.topic } : {}),
          ...(request.description ? { roomDescription: request.description } : {}),
        });
        return toRoom(await client.rooms.info(room._id), this.rocketChat.adapterContext(session));
      }

      return toRoom(room, this.rocketChat.adapterContext(session));
    } catch (error) {
      throw toApiException(error);
    }
  }

  async update(session: ServerSession, roomId: string, changes: UpdateRoomRequest): Promise<RoomSummary> {
    const client = this.rocketChat.userClient(session);

    try {
      await client.rooms.saveSettings(roomId, {
        ...(changes.name === undefined ? {} : { roomName: changes.name }),
        ...(changes.topic === undefined ? {} : { roomTopic: changes.topic }),
        ...(changes.description === undefined ? {} : { roomDescription: changes.description }),
        ...(changes.announcement === undefined ? {} : { roomAnnouncement: changes.announcement }),
        ...(changes.readOnly === undefined ? {} : { readOnly: changes.readOnly }),
        ...(changes.archived === undefined ? {} : { archived: changes.archived }),
        ...(changes.type === undefined
          ? {}
          : { roomType: changes.type === 'channel' ? ('c' as const) : ('p' as const) }),
      });
    } catch (error) {
      throw toApiException(error);
    }

    return this.get(session, roomId);
  }

  /**
   * Sets the room's picture, or clears it when `image` is omitted.
   *
   * The room is read back afterwards rather than patched locally, because the
   * caller needs the avatar tag Rocket.Chat minted for the new picture — that
   * tag is what makes the URL address this picture rather than the one it
   * replaced.
   */
  async setAvatar(session: ServerSession, roomId: string, image: AvatarUpload | null): Promise<RoomSummary> {
    const client = this.rocketChat.userClient(session);

    try {
      const before = await client.rooms.info(roomId);
      await client.rooms.setAvatar(roomId, image ? toDataUri(image) : null);

      await withSettledAvatarTag(
        () => client.rooms.info(roomId),
        (candidate) => candidate.avatarETag,
        before.avatarETag,
      );
    } catch (error) {
      throw toApiException(error);
    }

    return this.get(session, roomId);
  }

  async leave(session: ServerSession, roomId: string): Promise<void> {
    const roomType = await this.roomType(session, roomId);

    try {
      await this.rocketChat.userClient(session).rooms.leave(roomType, roomId);
    } catch (error) {
      throw toApiException(error);
    }
  }

  async markUnread(session: ServerSession, roomId: string): Promise<void> {
    try {
      await this.rocketChat.userClient(session).rooms.markUnread(roomId);
    } catch (error) {
      throw toApiException(error);
    }
  }

  async markRead(session: ServerSession, roomId: string): Promise<void> {
    try {
      await this.rocketChat.userClient(session).rooms.markRead(roomId);
    } catch (error) {
      throw toApiException(error);
    }
  }

  async updateState(session: ServerSession, roomId: string, changes: UpdateRoomStateRequest): Promise<RoomSummary> {
    const client = this.rocketChat.userClient(session);

    try {
      if (changes.favorite !== undefined) {
        await client.rooms.setFavorite(roomId, changes.favorite);
      }

      if (changes.hidden !== undefined) {
        await (changes.hidden ? client.rooms.hide(roomId) : client.rooms.open(roomId));
      }
    } catch (error) {
      throw toApiException(error);
    }

    return this.get(session, roomId);
  }

  /**
   * Resolves a room's Rocket.Chat type letter, needed by type-namespaced routes.
   *
   * Served from {@link roomTypes} when the sidebar has already been through
   * here, which is the usual case: nothing opens a room without first listing
   * the rooms.
   */
  async roomType(session: ServerSession, roomId: string): Promise<string> {
    const cached = this.roomTypes.get(roomTypeKey(session.serverId, roomId));
    if (cached) return cached;

    try {
      const room = await this.rocketChat.userClient(session).rooms.info(roomId);
      this.rememberRoomType(session.serverId, roomId, room.t);
      return room.t;
    } catch (error) {
      const apiError = toApiException(error);
      throw apiError.code === 'not_found' ? ApiException.localized('not_found', 'roomNotFound') : apiError;
    }
  }

  /**
   * Records a type seen on a fresh Rocket.Chat record.
   *
   * Writing on every sighting is also how a converted room corrects itself:
   * turning a channel into a private group changes the letter, and the next
   * sidebar sync overwrites the stale entry.
   */
  private rememberRoomType(serverId: string, roomId: string, type: string | undefined): void {
    if (!type) return;

    const key = roomTypeKey(serverId, roomId);
    // Re-inserting moves the key to the end, so eviction below drops what has
    // gone longest without being seen rather than what was added first.
    this.roomTypes.delete(key);
    this.roomTypes.set(key, type);

    if (this.roomTypes.size > ROOM_TYPE_CACHE_LIMIT) {
      const oldest = this.roomTypes.keys().next().value;
      if (oldest !== undefined) this.roomTypes.delete(oldest);
    }
  }
}

const roomTypeKey = (serverId: string, roomId: string): string => `${serverId}:${roomId}`;

/** Newest activity first, with never-used rooms sinking to the bottom. */
const byRecentActivity = (left: RoomSummary, right: RoomSummary): number => {
  const leftAt = left.lastMessageAt ?? left.createdAt ?? '';
  const rightAt = right.lastMessageAt ?? right.createdAt ?? '';
  if (leftAt === rightAt) return left.displayName.localeCompare(right.displayName);
  return leftAt < rightAt ? 1 : -1;
};

const ALERTS: NotificationAlert[] = ['default', 'all', 'mentions', 'nothing'];

/**
 * A stored per-room alert setting, or `default`.
 *
 * The `*PrefOrigin` field is what distinguishes "this room is set to All" from
 * "this room follows the account default, which happens to be All" — reading
 * the value without checking it would show a room as overridden when it is not,
 * and then write that back the first time anything else on the form changed.
 */
const alertOf = (value: string | undefined, origin: string | undefined): NotificationAlert => {
  if (origin !== 'subscription' || !value) return 'default';
  return ALERTS.includes(value as NotificationAlert) ? (value as NotificationAlert) : 'default';
};

const toNotificationPreferences = (subscription: RcSubscription | null): RoomNotificationPreferences => ({
  enabled: !subscription?.disableNotifications,
  muteGroupMentions: Boolean(subscription?.muteGroupMentions),
  showCounter: !subscription?.hideUnreadStatus,
  showMentions: !subscription?.hideMentionStatus,
  desktop: {
    alert: alertOf(subscription?.desktopNotifications, subscription?.desktopPrefOrigin),
    sound: subscription?.audioNotificationValue || 'default',
  },
  mobile: { alert: alertOf(subscription?.mobilePushNotifications, subscription?.mobilePrefOrigin) },
  email: { alert: alertOf(subscription?.emailNotifications, subscription?.emailPrefOrigin) },
});

/** Rocket.Chat takes these as `'0'`/`'1'` strings, not booleans. */
const flag = (value: boolean): '0' | '1' => (value ? '1' : '0');

const toRcNotifications = (preferences: RoomNotificationPreferences): RcNotificationPreferences => ({
  disableNotifications: flag(!preferences.enabled),
  muteGroupMentions: flag(preferences.muteGroupMentions),
  hideUnreadStatus: flag(!preferences.showCounter),
  hideMentionStatus: flag(!preferences.showMentions),
  desktopNotifications: preferences.desktop.alert,
  audioNotificationValue: preferences.desktop.sound,
  mobilePushNotifications: preferences.mobile.alert,
  emailNotifications: preferences.email.alert,
});

const unsubscribedPlaceholder = (room: RcRoom, session: ServerSession): RcSubscription => ({
  _id: `virtual:${room._id}`,
  rid: room._id,
  u: { _id: session.rocketChatUserId, username: session.username },
  t: room.t,
  open: true,
  alert: false,
  unread: 0,
  userMentions: 0,
  groupMentions: 0,
  f: false,
});
