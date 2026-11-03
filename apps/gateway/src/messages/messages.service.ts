import type {
  ListMessageCollectionResponse,
  ListMessagesQuery,
  ListMessagesResponse,
  ListThreadsResponse,
  Message,
  SearchMessagesResponse,
  SendMessageRequest,
} from '@t3foundry/open-rocket-chat-api-contract';
import { toMessage } from '@t3foundry/open-rocket-chat-rc-adapter';
import type { RcMessage } from '@t3foundry/open-rocket-chat-rc-rest-client';
import { Injectable } from '@nestjs/common';

import { toApiException } from '../common/upstream-error';
import { RocketChatService } from '../rocketchat/rocketchat.service';
import { RoomsService } from '../rooms/rooms.service';
import type { ServerSession } from '../session/session.types';

/**
 * How far back a catch-up query will page before giving up and telling the
 * client to reload. Ten pages of 50 covers any realistic reconnect; beyond
 * that, refetching the room is cheaper than stitching the timeline.
 */
const MAX_CATCHUP_PAGES = 10;

@Injectable()
export class MessagesService {
  constructor(
    private readonly rocketChat: RocketChatService,
    private readonly rooms: RoomsService,
  ) {}

  async list(session: ServerSession, roomId: string, query: ListMessagesQuery): Promise<ListMessagesResponse> {
    if (query.threadId) {
      return this.listThreadMessages(session, query.threadId, query.offset, query.limit);
    }

    const client = this.rocketChat.userClient(session);
    const context = this.rocketChat.adapterContext(session);

    try {
      const roomType = await this.rooms.roomType(session, roomId);
      const fetchPage = (latest: string | undefined, count: number): Promise<RcMessage[]> =>
        client.chat.history({
          roomType,
          roomId,
          ...(latest ? { latest } : {}),
          count,
          showThreadMessages: query.includeThreadReplies,
        });

      if (query.after) {
        return await this.catchUp(fetchPage, query.after, query.limit, context);
      }

      // Rocket.Chat returns newest-first; ask for one extra to learn whether
      // older history exists without a second round-trip.
      const page = await fetchPage(query.before, query.limit + 1);
      const hasMore = page.length > query.limit;
      const window = hasMore ? page.slice(0, query.limit) : page;

      return {
        items: window.reverse().map((message) => toMessage(message, context)),
        hasMore,
        gapBefore: false,
      };
    } catch (error) {
      throw toApiException(error);
    }
  }

  /**
   * Reconstructs the oldest messages newer than `after`.
   *
   * `channels.history` sorts descending and truncates to `count`, so a naive
   * range query returns the *tail* of the window and silently drops everything
   * between the anchor and the first result. Paging backwards until the anchor
   * is crossed is the only way to get a contiguous slice out of that API.
   */
  private async catchUp(
    fetchPage: (latest: string | undefined, count: number) => Promise<RcMessage[]>,
    after: string,
    limit: number,
    context: Parameters<typeof toMessage>[1],
  ): Promise<ListMessagesResponse> {
    const collected: RcMessage[] = [];
    let cursor: string | undefined;
    let reachedAnchor = false;

    for (let page = 0; page < MAX_CATCHUP_PAGES; page += 1) {
      const batch = await fetchPage(cursor, limit);
      if (batch.length === 0) {
        reachedAnchor = true;
        break;
      }

      collected.push(...batch);

      const oldest = batch[batch.length - 1] as RcMessage;
      const oldestAt = timestampOf(oldest);
      cursor = oldestAt;

      if (oldestAt <= after) {
        reachedAnchor = true;
        break;
      }

      // A short page means we hit the beginning of the room.
      if (batch.length < limit) {
        reachedAnchor = true;
        break;
      }
    }

    const fresh = collected
      .filter((message) => timestampOf(message) > after)
      .sort((left, right) => (timestampOf(left) < timestampOf(right) ? -1 : 1));

    // De-duplicate: overlapping pages can return the same message twice when
    // several share a timestamp at a page boundary.
    const unique = [...new Map(fresh.map((message) => [message._id, message])).values()];

    return {
      items: unique.slice(0, limit).map((message) => toMessage(message, context)),
      hasMore: unique.length > limit,
      gapBefore: !reachedAnchor,
    };
  }

  /**
   * One page of a thread, paged backwards from its newest reply.
   *
   * Offsets rather than the timestamp cursor the main timeline uses: a thread
   * only ever grows at its end, so an offset means the same thing between two
   * requests, and `chat.getThreadMessages` offers nothing else. The upstream
   * page arrives newest-first (see the resource) and is flipped here, because
   * the response contract is oldest-first throughout.
   *
   * The parent rides along on the oldest page. It is not a reply and so is
   * absent from every page, but it is the message the thread hangs off and
   * belongs above the first one — and a client that reached the top of the
   * thread should not need a second request to draw it.
   */
  private async listThreadMessages(
    session: ServerSession,
    threadId: string,
    offset: number,
    limit: number,
  ): Promise<ListMessagesResponse> {
    const client = this.rocketChat.userClient(session);
    const context = this.rocketChat.adapterContext(session);

    try {
      const { messages, total } = await client.chat.listThreadMessages(threadId, offset, limit);
      const replies = [...messages].reverse();
      const hasMore = offset + messages.length < total;

      // Fetched only once the start of the thread is in view, so scrolling back
      // through a long thread does not re-request the parent on every page.
      const parent = hasMore ? undefined : await client.chat.getMessage(threadId);

      return {
        items: [...(parent ? [toMessage(parent, context)] : []), ...replies.map((m) => toMessage(m, context))],
        hasMore,
        gapBefore: false,
      };
    } catch (error) {
      throw toApiException(error);
    }
  }

  async send(session: ServerSession, roomId: string, request: SendMessageRequest): Promise<Message> {
    const client = this.rocketChat.userClient(session);

    try {
      const message = await client.chat.send({
        roomId,
        text: request.text,
        ...(request.clientMessageId ? { messageId: request.clientMessageId } : {}),
        ...(request.threadId ? { threadId: request.threadId } : {}),
        ...(request.showInMainChannel ? { showInMainChannel: true } : {}),
      });

      return toMessage(message, this.rocketChat.adapterContext(session));
    } catch (error) {
      throw toApiException(error);
    }
  }

  async update(session: ServerSession, roomId: string, messageId: string, text: string): Promise<Message> {
    const client = this.rocketChat.userClient(session);

    try {
      const message = await client.chat.update(roomId, messageId, text);
      return toMessage(message, this.rocketChat.adapterContext(session));
    } catch (error) {
      throw toApiException(error);
    }
  }

  async delete(session: ServerSession, roomId: string, messageId: string): Promise<void> {
    try {
      await this.rocketChat.userClient(session).chat.delete(roomId, messageId);
    } catch (error) {
      throw toApiException(error);
    }
  }

  async react(session: ServerSession, messageId: string, emoji: string, shouldReact: boolean): Promise<void> {
    try {
      await this.rocketChat.userClient(session).chat.react(messageId, emoji, shouldReact);
    } catch (error) {
      throw toApiException(error);
    }
  }

  async setPinned(session: ServerSession, messageId: string, pinned: boolean): Promise<void> {
    try {
      await this.rocketChat.userClient(session).chat.setPinned(messageId, pinned);
    } catch (error) {
      throw toApiException(error);
    }
  }

  async setStarred(session: ServerSession, messageId: string, starred: boolean): Promise<void> {
    try {
      await this.rocketChat.userClient(session).chat.setStarred(messageId, starred);
    } catch (error) {
      throw toApiException(error);
    }
  }

  async listThreads(
    session: ServerSession,
    roomId: string,
    offset: number,
    limit: number,
  ): Promise<ListThreadsResponse> {
    const client = this.rocketChat.userClient(session);
    const context = this.rocketChat.adapterContext(session);

    try {
      const { threads, total } = await client.chat.listThreads(roomId, offset, limit);
      return {
        items: threads.map((message) => toMessage(message, context)),
        total,
        offset,
        limit,
      };
    } catch (error) {
      throw toApiException(error);
    }
  }

  /**
   * The pinned, starred and mentioned collections.
   *
   * One method rather than three: they differ only in which upstream route
   * fetches them, and every caller pages them identically.
   */
  async listCollection(
    session: ServerSession,
    roomId: string,
    collection: 'pinned' | 'starred' | 'mentions',
    offset: number,
    limit: number,
  ): Promise<ListMessageCollectionResponse> {
    const client = this.rocketChat.userClient(session);
    const context = this.rocketChat.adapterContext(session);

    const fetch = {
      pinned: () => client.chat.listPinned(roomId, offset, limit),
      starred: () => client.chat.listStarred(roomId, offset, limit),
      mentions: () => client.chat.listMentioned(roomId, offset, limit),
    }[collection];

    try {
      const { messages, total } = await fetch();
      return {
        items: messages.map((message) => toMessage(message, context)),
        total,
        offset,
        limit,
      };
    } catch (error) {
      throw toApiException(error);
    }
  }

  async search(session: ServerSession, roomId: string, term: string, limit: number): Promise<SearchMessagesResponse> {
    const client = this.rocketChat.userClient(session);
    const context = this.rocketChat.adapterContext(session);

    try {
      const messages = await client.chat.search(roomId, term, limit);
      return { items: messages.map((message) => toMessage(message, context)) };
    } catch (error) {
      throw toApiException(error);
    }
  }
}

/** Comparable ISO timestamp regardless of which date encoding Rocket.Chat used. */
const timestampOf = (message: RcMessage): string => {
  const value = message.ts;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return new Date(value).toISOString();
  return new Date(value.$date).toISOString();
};
