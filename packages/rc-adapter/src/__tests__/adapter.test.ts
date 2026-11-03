import { MessageSchema, RoomSummarySchema, UserProfileSchema } from '@t3foundry/open-rocket-chat-api-contract';
import type { RcMessage, RcRoom, RcSubscription, RcUser } from '@t3foundry/open-rocket-chat-rc-rest-client';
import { describe, expect, it } from 'vitest';

import type { AdapterContext } from '../context.js';
import { toMessage } from '../message.js';
import { toRoomSummary, toRoomType } from '../room.js';
import { toMyProfile, toUserProfile } from '../user.js';

const context: AdapterContext = {
  currentUserId: 'me',
  currentUsername: 'quy',
  avatarUrl: (username) => `https://gw.test/avatars/${username}`,
  roomAvatarUrl: (roomId, etag) => `https://gw.test/avatars/room/${roomId}?etag=${etag}`,
  fileUrl: (path) => `https://gw.test/files${path}`,
};

describe('toRoomType', () => {
  it.each([
    [{ t: 'c' }, 'channel'],
    [{ t: 'p' }, 'private'],
    [{ t: 'd' }, 'direct'],
    [{ t: 'l' }, 'omnichannel'],
    [{ t: 'p', teamMain: true }, 'team'],
    [{ t: 'p', prid: 'parent' }, 'discussion'],
  ])('maps %j to %s', (source, expected) => {
    expect(toRoomType(source)).toBe(expected);
  });

  it('prefers discussion over team when a discussion lives inside a team', () => {
    expect(toRoomType({ t: 'p', prid: 'parent', teamId: 'team-1', teamMain: true })).toBe('discussion');
  });
});

describe('toRoomSummary', () => {
  const subscription: RcSubscription = {
    _id: 'sub1',
    rid: 'room1',
    u: { _id: 'me', username: 'quy' },
    t: 'c',
    name: 'general',
    fname: 'General',
    open: true,
    alert: true,
    unread: 3,
    userMentions: 1,
    groupMentions: 0,
    f: true,
    ls: '2026-01-01T00:00:00.000Z',
  };

  const room: RcRoom = {
    _id: 'room1',
    t: 'c',
    name: 'general',
    fname: 'General',
    usersCount: 12,
    msgs: 340,
    u: { _id: 'owner', username: 'owner', name: 'Owner' },
    lm: '2026-01-02T03:04:05.000Z',
    _updatedAt: '2026-01-02T03:04:05.000Z',
  };

  it('produces a contract-valid summary', () => {
    const summary = toRoomSummary(room, subscription, context);
    expect(RoomSummarySchema.parse(summary)).toBeTruthy();
    expect(summary).toMatchObject({
      id: 'room1',
      type: 'channel',
      displayName: 'General',
      unreadCount: 3,
      favorite: true,
    });
  });

  it('renders a sidebar entry from the subscription alone when the room is unknown', () => {
    const summary = toRoomSummary(null, subscription, context);
    expect(RoomSummarySchema.parse(summary)).toBeTruthy();
    expect(summary.displayName).toBe('General');
    expect(summary.membersCount).toBe(0);
  });

  it('treats a closed subscription as hidden', () => {
    const summary = toRoomSummary(room, { ...subscription, open: false }, context);
    expect(summary.open).toBe(false);
    expect(summary.hidden).toBe(true);
  });

  it('preserves posting restrictions and direct-message block state', () => {
    const summary = toRoomSummary(
      { ...room, muted: ['quy'], unmuted: ['quy'], reactWhenReadOnly: true, cl: false },
      { ...subscription, blocked: true, blocker: true, archived: true },
      context,
      false,
    );

    expect(summary).toMatchObject({
      joined: false,
      mutedForPosting: true,
      unmutedForPosting: true,
      reactWhenReadOnly: true,
      blocked: true,
      blocker: true,
      canLeave: false,
    });
  });

  it('addresses a room picture by the tag Rocket.Chat minted for it', () => {
    const summary = toRoomSummary({ ...room, avatarETag: 'tag-1' }, subscription, context);
    expect(summary.avatarUrl).toBe('https://gw.test/avatars/room/room1?etag=tag-1');
  });

  it('reports no picture for a room that has never had one', () => {
    // Rocket.Chat would answer `/avatar/room/room1` with generated initials, so
    // a URL here would stop the client drawing its own.
    expect(toRoomSummary(room, subscription, context).avatarUrl).toBeNull();
  });

  it('reports no picture once one has been cleared', () => {
    // `Rooms.unsetAvatarData` leaves the tag behind as `Date.now().toString()`
    // rather than removing it, so an all-digit tag is a tombstone. Reading it
    // as a picture puts Rocket.Chat's generated SVG where the room icon belongs.
    const cleared = toRoomSummary({ ...room, avatarETag: '1785646069368' }, subscription, context);
    expect(cleared.avatarUrl).toBeNull();
  });

  it('drops the room name for direct messages', () => {
    const dmSummary = toRoomSummary(
      { ...room, t: 'd', name: 'quy-peer' },
      { ...subscription, t: 'd', name: 'peer', fname: 'Peer' },
      context,
    );
    expect(dmSummary.type).toBe('direct');
    expect(dmSummary.name).toBeNull();
    expect(dmSummary.displayName).toBe('Peer');
  });
});

describe('toMessage', () => {
  const base: RcMessage = {
    _id: 'msg1',
    rid: 'room1',
    msg: 'hello',
    ts: '2026-01-01T10:00:00.000Z',
    u: { _id: 'u1', username: 'alice', name: 'Alice' },
  };

  it('produces a contract-valid message', () => {
    const message = toMessage(base, context);
    expect(MessageSchema.parse(message)).toBeTruthy();
    expect(message).toMatchObject({ id: 'msg1', kind: 'user', text: 'hello', systemType: null });
  });

  it('marks messages carrying a type as system messages', () => {
    const message = toMessage({ ...base, t: 'uj', msg: 'alice' }, context);
    expect(message.kind).toBe('system');
    expect(message.systemType).toBe('uj');
  });

  it('withholds ciphertext from encrypted messages', () => {
    const message = toMessage({ ...base, e2e: 'pending', msg: 'AAAA-ciphertext' }, context);
    expect(message.encrypted).toBe(true);
    expect(message.text).toBe('');
  });

  it('resolves reactions relative to the requesting user', () => {
    const message = toMessage(
      { ...base, reactions: { ':tada:': { usernames: ['alice', 'quy'] }, ':eyes:': { usernames: ['bob'] } } },
      context,
    );

    expect(message.reactions).toEqual(
      expect.arrayContaining([
        { emoji: ':tada:', usernames: ['alice', 'quy'], count: 2, reactedByMe: true },
        { emoji: ':eyes:', usernames: ['bob'], count: 1, reactedByMe: false },
      ]),
    );
  });

  it('resolves starred relative to the requesting user id', () => {
    expect(toMessage({ ...base, starred: [{ _id: 'me' }] }, context).starred).toBe(true);
    expect(toMessage({ ...base, starred: [{ _id: 'someone-else' }] }, context).starred).toBe(false);
  });

  it('classifies broadcast mentions', () => {
    const message = toMessage(
      {
        ...base,
        mentions: [
          { _id: 'all', username: 'all' },
          { _id: 'u2', username: 'bob', name: 'Bob' },
        ],
      },
      context,
    );
    expect(message.mentions.map((mention) => mention.kind)).toEqual(['all', 'user']);
  });

  it('proxies uploaded files through the gateway', () => {
    const message = toMessage(
      { ...base, files: [{ _id: 'f1', name: 'report.pdf', type: 'application/pdf', size: 1024 }] },
      context,
    );
    expect(message.files[0]?.url).toBe('https://gw.test/files/file-upload/f1/report.pdf');
    expect(message.files[0]?.thumbnailUrl).toBeNull();
  });

  it('folds the generated thumbnail into the image it belongs to', () => {
    const message = toMessage(
      {
        ...base,
        files: [
          { _id: 'f1', name: 'photo.png', type: 'image/png', size: 90_000 },
          { _id: 'thumb1', name: 'thumb-photo.png', type: 'image/jpeg', size: 4_000, typeGroup: 'thumb' },
        ],
        attachments: [
          {
            title: 'photo.png',
            fileId: 'f1',
            title_link: '/file-upload/f1/photo.png',
            image_url: '/file-upload/thumb1/photo.png',
            image_type: 'image/jpeg',
          },
        ],
      },
      context,
    );

    expect(MessageSchema.parse(message)).toBeTruthy();
    expect(message.files).toHaveLength(1);
    expect(message.files[0]).toMatchObject({
      id: 'f1',
      url: 'https://gw.test/files/file-upload/f1/photo.png',
      thumbnailUrl: 'https://gw.test/files/file-upload/thumb1/photo.png',
    });
  });

  it('keeps the image when the server generated no thumbnail for it', () => {
    // Rocket.Chat points `image_url` at the original for images already smaller
    // than the thumbnail size — dropping that file would lose the image itself.
    const message = toMessage(
      {
        ...base,
        files: [{ _id: 'f1', name: 'icon.png', type: 'image/png', size: 900 }],
        attachments: [
          {
            title: 'icon.png',
            fileId: 'f1',
            title_link: '/file-upload/f1/icon.png',
            image_url: '/file-upload/f1/icon.png',
          },
        ],
      },
      context,
    );

    expect(message.files).toHaveLength(1);
    expect(message.files[0]?.thumbnailUrl).toBeNull();
  });

  it('drops a thumbnail whose attachment no longer references it', () => {
    const message = toMessage(
      {
        ...base,
        files: [
          { _id: 'f1', name: 'photo.png', type: 'image/png', size: 90_000 },
          { _id: 'thumb1', name: 'thumb-photo.png', type: 'image/jpeg', size: 4_000, typeGroup: 'thumb' },
        ],
      },
      context,
    );

    expect(message.files.map((file) => file.id)).toEqual(['f1']);
  });

  it('accepts DDP-style dates as well as ISO strings', () => {
    const message = toMessage({ ...base, ts: { $date: Date.UTC(2026, 0, 1, 10) } }, context);
    expect(message.createdAt).toBe('2026-01-01T10:00:00.000Z');
  });
});

describe('toUserProfile', () => {
  it('produces a contract-valid profile and a fixed-offset timezone', () => {
    const user: RcUser = {
      _id: 'u1',
      username: 'quy',
      name: 'Quy Le',
      emails: [{ address: 'quy@example.com', verified: true }],
      roles: ['user'],
      utcOffset: 7,
      status: 'online',
    };

    const profile = toUserProfile(user, context);
    expect(UserProfileSchema.parse(profile)).toBeTruthy();
    expect(profile.timezone).toBe('UTC+07:00');
    expect(profile.email).toBe('quy@example.com');
  });

  it('falls back to the username when the account has no display name', () => {
    expect(toUserProfile({ _id: 'u2', username: 'bot' }, context).displayName).toBe('bot');
  });

  it('reports another account as Rocket.Chat computed them, intent included or not', () => {
    const user: RcUser = { _id: 'u3', username: 'ana', status: 'offline', statusDefault: 'busy' };
    expect(toUserProfile(user, context).status).toBe('offline');
  });
});

describe('toMyProfile', () => {
  it('reports the presence the caller chose, not the one their sessions imply', () => {
    // What `/api/v1/me` returns for somebody who set "busy" over REST and holds
    // no DDP session: offline to onlookers, busy to themselves.
    const user: RcUser = {
      _id: 'me',
      username: 'quy',
      status: 'offline',
      statusDefault: 'busy',
      statusText: 'Writing tests',
    };

    const profile = toMyProfile(user, context);
    expect(UserProfileSchema.parse(profile)).toBeTruthy();
    expect(profile.status).toBe('busy');
    expect(profile.statusText).toBe('Writing tests');
  });

  it('falls back to the computed status when the server sends no intent', () => {
    expect(toMyProfile({ _id: 'me', username: 'quy', status: 'away' }, context).status).toBe('away');
    expect(toMyProfile({ _id: 'me', username: 'quy' }, context).status).toBeNull();
  });
});
