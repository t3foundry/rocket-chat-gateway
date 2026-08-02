import type { RcListEnvelope, RcRoom, RcRoomRole, RcSubscription, RcUpload, RcUser } from '../types.js';
import { AuthenticatedResource, roomNamespace } from './base.js';

/** Per-room notification settings, in the string encoding Rocket.Chat stores. */
export interface RcNotificationPreferences {
  disableNotifications?: '0' | '1';
  muteGroupMentions?: '0' | '1';
  hideUnreadStatus?: '0' | '1';
  hideMentionStatus?: '0' | '1';
  desktopNotifications?: string;
  audioNotificationValue?: string;
  mobilePushNotifications?: string;
  emailNotifications?: string;
}

export interface CleanHistoryOptions {
  roomId: string;
  /** Upper bound, ISO string. */
  latest: string;
  /** Lower bound, ISO string. */
  oldest: string;
  inclusive?: boolean;
  limit?: number;
  excludePinned?: boolean;
  filesOnly?: boolean;
  ignoreDiscussion?: boolean;
  ignoreThreads?: boolean;
  /** Restrict to messages from these usernames. */
  users?: string[];
}

export interface RoomsSyncResult {
  update: RcRoom[];
  remove: RcRoom[];
}

export interface SubscriptionsSyncResult {
  update: RcSubscription[];
  remove: RcSubscription[];
}

export class RoomsResource extends AuthenticatedResource {
  /**
   * Rooms the user can see, optionally as a delta. Rocket.Chat expects
   * `updatedSince` as an ISO string and returns *everything* when it is absent,
   * which is why callers should cache and pass it back.
   */
  async list(updatedSince?: string): Promise<RoomsSyncResult> {
    const response = await this.get<{ update?: RcRoom[]; remove?: RcRoom[] }>('rooms.get', {
      updatedSince,
    });
    return { update: response.update ?? [], remove: response.remove ?? [] };
  }

  /** The caller's subscriptions, which carry read state, favourites and mute flags. */
  async listSubscriptions(updatedSince?: string): Promise<SubscriptionsSyncResult> {
    const response = await this.get<{ update?: RcSubscription[]; remove?: RcSubscription[] }>('subscriptions.get', {
      updatedSince,
    });
    return { update: response.update ?? [], remove: response.remove ?? [] };
  }

  async info(roomId: string): Promise<RcRoom> {
    const response = await this.get<{ room: RcRoom }>('rooms.info', { roomId });
    return response.room;
  }

  async subscription(roomId: string): Promise<RcSubscription | null> {
    const response = await this.get<{ subscription?: RcSubscription }>('subscriptions.getOne', { roomId });
    return response.subscription ?? null;
  }

  /**
   * Members of a room. `filter` matches name or username, and `status` narrows
   * to the presences given — both are evaluated by the server, so a filtered
   * page is a real page rather than one page of results sifted client-side.
   */
  async members(
    roomType: string,
    roomId: string,
    options: { offset?: number; count?: number; filter?: string; status?: string[] } = {},
  ): Promise<{ members: RcUser[]; total: number }> {
    const response = await this.get<RcListEnvelope<'members', RcUser>>(`${roomNamespace(roomType)}.members`, {
      roomId,
      offset: options.offset ?? 0,
      count: options.count ?? 50,
      ...(options.filter ? { filter: options.filter } : {}),
      ...(options.status?.length ? { status: options.status } : {}),
    });
    return { members: response.members ?? [], total: response.total ?? response.members?.length ?? 0 };
  }

  /**
   * Files uploaded to the room, newest first.
   *
   * `typeGroup` narrows to one media family (`image`, `video`, …) and `name`
   * filters on the file name — both are what Rocket.Chat's own Files panel
   * sends.
   *
   * `onlyConfirmed` is deliberately *not* sent. Rocket.Chat's own client passes
   * it, but it does so through a typed endpoint layer that serialises a real
   * boolean; as a query string it fails `channels.files`' schema validation
   * outright ("must NOT have additional properties"), which turns the whole
   * panel into an error. The cost of leaving it off is that an upload that was
   * started and abandoned can appear in the list — far cheaper than no list.
   */
  async files(
    roomType: string,
    roomId: string,
    options: { offset?: number; count?: number; name?: string; typeGroup?: string } = {},
  ): Promise<{ files: RcUpload[]; total: number }> {
    const response = await this.get<RcListEnvelope<'files', RcUpload>>(`${roomNamespace(roomType)}.files`, {
      roomId,
      offset: options.offset ?? 0,
      count: options.count ?? 50,
      sort: JSON.stringify({ uploadedAt: -1 }),
      ...(options.name ? { name: options.name } : {}),
      ...(options.typeGroup ? { typeGroup: options.typeGroup } : {}),
    });
    return { files: response.files ?? [], total: response.total ?? 0 };
  }

  /**
   * Who holds `owner`, `moderator` or `leader` in the room.
   *
   * Returned for the whole room in one call rather than per member: the member
   * list needs a badge on every row, and asking per row is N requests.
   */
  async roles(roomType: string, roomId: string): Promise<RcRoomRole[]> {
    const response = await this.get<RcListEnvelope<'roles', RcRoomRole>>(`${roomNamespace(roomType)}.roles`, {
      roomId,
    });
    return response.roles ?? [];
  }

  /** Adds users to a channel or private group. Direct messages cannot be invited to. */
  async invite(roomType: string, roomId: string, userIds: string[]): Promise<void> {
    await this.post(`${roomNamespace(roomType)}.invite`, { roomId, userIds });
  }

  /** Removes one user from the room. Rocket.Chat calls this "kick". */
  async kick(roomType: string, roomId: string, userId: string): Promise<void> {
    await this.post(`${roomNamespace(roomType)}.kick`, { roomId, userId });
  }

  /**
   * Grants or revokes a room role. `owner`, `moderator` and `leader` each have
   * their own pair of endpoints; there is no generic one.
   */
  async setRoomRole(
    roomType: string,
    roomId: string,
    userId: string,
    role: 'owner' | 'moderator' | 'leader',
    granted: boolean,
  ): Promise<void> {
    const suffix = { owner: 'Owner', moderator: 'Moderator', leader: 'Leader' }[role];
    await this.post(`${roomNamespace(roomType)}.${granted ? 'add' : 'remove'}${suffix}`, { roomId, userId });
  }

  /** Silences a user in the room. Keyed by username, unlike every neighbouring route. */
  async setMuted(roomId: string, username: string, muted: boolean): Promise<void> {
    await this.post(muted ? 'rooms.muteUser' : 'rooms.unmuteUser', { roomId, username });
  }

  /** Per-user notification settings for one room. */
  async saveNotification(roomId: string, notifications: RcNotificationPreferences): Promise<void> {
    await this.post('rooms.saveNotification', { roomId, notifications });
  }

  /** Bulk-deletes messages in a time range. Irreversible. */
  async cleanHistory(options: CleanHistoryOptions): Promise<number> {
    const response = await this.post<{ count?: number }>('rooms.cleanHistory', {
      roomId: options.roomId,
      latest: options.latest,
      oldest: options.oldest,
      inclusive: options.inclusive ?? false,
      limit: options.limit ?? 2000,
      excludePinned: options.excludePinned ?? false,
      filesOnly: options.filesOnly ?? false,
      ignoreDiscussion: options.ignoreDiscussion ?? false,
      ignoreThreads: options.ignoreThreads ?? false,
      ...(options.users?.length ? { users: options.users } : {}),
    });
    return response.count ?? 0;
  }

  /** Marks everything up to now as read. `rid` is used because older servers reject `roomId` here. */
  async markRead(roomId: string, readThreads = true): Promise<void> {
    await this.post('subscriptions.read', { rid: roomId, readThreads });
  }

  async setFavorite(roomId: string, favorite: boolean): Promise<void> {
    await this.post('rooms.favorite', { roomId, favorite });
  }

  /** Removes the room from the sidebar without leaving it. */
  async hide(roomId: string): Promise<void> {
    await this.post('rooms.hide', { roomId });
  }

  async open(roomId: string): Promise<void> {
    await this.post('rooms.open', { roomId });
  }

  /** Marks the room unread again from the first unread message. */
  async markUnread(roomId: string): Promise<void> {
    await this.post('subscriptions.unread', { roomId });
  }

  /**
   * Leaves the room. Namespaced by room type, so the caller has to know it —
   * there is no generic endpoint.
   */
  async leave(roomType: string, roomId: string): Promise<void> {
    await this.post(`${roomNamespace(roomType)}.leave`, { roomId });
  }

  /** Creates a public channel or a private group. */
  async create(input: {
    type: 'channel' | 'private';
    name: string;
    members?: string[];
    readOnly?: boolean;
    encrypted?: boolean;
    broadcast?: boolean;
  }): Promise<RcRoom> {
    const namespace = input.type === 'channel' ? 'channels' : 'groups';
    const response = await this.post<{ channel?: RcRoom; group?: RcRoom }>(`${namespace}.create`, {
      name: input.name,
      ...(input.members?.length ? { members: input.members } : {}),
      ...(input.readOnly === undefined ? {} : { readOnly: input.readOnly }),
      // Rocket.Chat nests the less common flags under `extraData`.
      ...(input.encrypted || input.broadcast
        ? {
            extraData: {
              ...(input.encrypted ? { encrypted: true } : {}),
              ...(input.broadcast ? { broadcast: true } : {}),
            },
          }
        : {}),
    });

    const room = response.channel ?? response.group;
    if (!room) {
      throw new Error('Rocket.Chat did not return the created room');
    }
    return room;
  }

  /**
   * Room-wide settings. Every field is optional and Rocket.Chat applies only
   * the ones present, so callers must not send `undefined` placeholders.
   */
  async saveSettings(
    roomId: string,
    settings: {
      roomName?: string;
      roomTopic?: string;
      roomDescription?: string;
      roomAnnouncement?: string;
      readOnly?: boolean;
      archived?: boolean;
      /** `c` for a public channel, `p` for a private group. */
      roomType?: 'c' | 'p';
    },
  ): Promise<void> {
    const body: Record<string, unknown> = { rid: roomId };
    for (const [key, value] of Object.entries(settings)) {
      if (value !== undefined) body[key] = value;
    }
    await this.post('rooms.saveRoomSettings', body);
  }

  /**
   * Sets or clears the room's picture.
   *
   * There is no multipart route for this: Rocket.Chat carries a room avatar as
   * a base64 data URI through `rooms.saveRoomSettings`, and `null` is what
   * clears it. Needs `edit-room` for the call and `edit-room-avatar` for the
   * field.
   */
  async setAvatar(roomId: string, dataUri: string | null): Promise<void> {
    await this.post('rooms.saveRoomSettings', { rid: roomId, roomAvatar: dataUri });
  }

  /** Opens an existing direct message or creates one. Idempotent. */
  async createDirectMessage(username: string): Promise<RcRoom> {
    const response = await this.post<{ room: RcRoom & { rid?: string } }>('im.create', { username });
    // `im.create` returns the room under `rid` rather than `_id` on some versions.
    const room = response.room;
    return room._id ? room : { ...room, _id: room.rid as string };
  }
}
