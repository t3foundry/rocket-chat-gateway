import type { Mention, Message, Reaction } from '@t3foundry/open-rocket-chat-api-contract';
import type { RcMention, RcMessage } from '@t3foundry/open-rocket-chat-rc-rest-client';

import { toAttachment, toFileRefs } from './attachment.js';
import { toIsoString, toIsoStringOrEpoch, type AdapterContext } from './context.js';
import { toUserSummary } from './user.js';

const toReactions = (message: RcMessage, context: AdapterContext): Reaction[] =>
  Object.entries(message.reactions ?? {}).map(([emoji, value]) => {
    const usernames = value.usernames ?? [];
    return {
      emoji,
      usernames,
      count: usernames.length,
      reactedByMe: usernames.includes(context.currentUsername),
    };
  });

const toMention = (mention: RcMention): Mention => {
  const username = mention.username ?? '';

  return {
    id: mention._id,
    username,
    displayName: mention.name ?? mention.fname ?? null,
    // `all` and `here` are stored as mentions with those literal usernames and
    // no backing user record, so they cannot be distinguished by `type`.
    kind: username === 'all' ? 'all' : username === 'here' ? 'here' : (mention.type ?? 'user'),
  };
};

export const toMessage = (message: RcMessage, context: AdapterContext): Message => {
  const isSystem = Boolean(message.t);
  const encrypted = message.e2e === 'pending' || message.e2e === 'done';

  // Rocket.Chat keeps the legacy single `file` alongside the newer `files`
  // array, and populates both for uploads made through the current API.
  const files = message.files ?? (message.file ? [message.file] : []);
  const attachments = message.attachments ?? [];

  return {
    id: message._id,
    roomId: message.rid,
    threadId: message.tmid ?? null,
    showInMainChannel: message.tshow ?? false,
    kind: isSystem ? 'system' : 'user',
    systemType: message.t ?? null,
    // The ciphertext is useless to a client that cannot decrypt it, and
    // leaking it into the UI is how encrypted rooms end up showing garbage.
    text: encrypted ? '' : (message.msg ?? ''),
    sender: toUserSummary(message.u, context),
    senderAlias: message.alias ?? null,
    createdAt: toIsoStringOrEpoch(message.ts),
    updatedAt: toIsoString(message._updatedAt),
    editedAt: toIsoString(message.editedAt),
    editedBy: message.editedBy ? toUserSummary(message.editedBy, context) : null,
    reactions: toReactions(message, context),
    attachments: attachments.map((attachment) => toAttachment(attachment, context)),
    files: toFileRefs(files, attachments, context),
    mentions: (message.mentions ?? []).map(toMention),
    // A channel record with no name cannot be matched back to the `#…` in the
    // text, so it is of no use to a client and is dropped here.
    channels: (message.channels ?? []).flatMap((channel) =>
      channel.name ? [{ id: channel._id, name: channel.name }] : [],
    ),
    pinned: message.pinned ?? false,
    // Starring is per-user: the array holds every user who starred it, so the
    // boolean is only meaningful relative to the requesting user.
    starred: (message.starred ?? []).some((entry) => entry._id === context.currentUserId),
    threadCount: message.tcount ?? 0,
    threadLastReplyAt: toIsoString(message.tlm),
    threadParticipantIds: message.replies ?? [],
    urls: (message.urls ?? []).map((url) => url.url),
    encrypted,
    isTemporary: false,
  };
};
