import type { RcListEnvelope, RcMessage } from '../types.js';
import { AuthenticatedResource, roomNamespace } from './base.js';

export interface HistoryOptions {
  roomType: string;
  roomId: string;
  /** Upper bound (exclusive unless `inclusive`), ISO string. Scrolling back. */
  latest?: string;
  /** Lower bound, ISO string. Catching up after a reconnect. */
  oldest?: string;
  count: number;
  inclusive?: boolean;
  /** Rocket.Chat hides threaded replies from the main timeline by default. */
  showThreadMessages?: boolean;
}

export interface SendMessageOptions {
  roomId: string;
  text: string;
  /** Client-generated id; makes retries idempotent because Rocket.Chat honours it as `_id`. */
  messageId?: string;
  threadId?: string;
  showInMainChannel?: boolean;
}

export class ChatResource extends AuthenticatedResource {
  /**
   * Newest-first history page. Rocket.Chat returns messages in descending
   * order regardless of which bound was supplied.
   */
  async history(options: HistoryOptions): Promise<RcMessage[]> {
    const response = await this.get<RcListEnvelope<'messages', RcMessage>>(
      `${roomNamespace(options.roomType)}.history`,
      {
        roomId: options.roomId,
        latest: options.latest,
        oldest: options.oldest,
        count: options.count,
        inclusive: options.inclusive ?? false,
        showThreadMessages: options.showThreadMessages ?? false,
      },
    );
    return response.messages ?? [];
  }

  async getMessage(messageId: string): Promise<RcMessage> {
    const response = await this.get<{ message: RcMessage }>('chat.getMessage', { msgId: messageId });
    return response.message;
  }

  async send(options: SendMessageOptions): Promise<RcMessage> {
    const response = await this.post<{ message: RcMessage }>('chat.sendMessage', {
      message: {
        ...(options.messageId ? { _id: options.messageId } : {}),
        rid: options.roomId,
        msg: options.text,
        ...(options.threadId ? { tmid: options.threadId } : {}),
        ...(options.showInMainChannel ? { tshow: true } : {}),
      },
    });
    return response.message;
  }

  async update(roomId: string, messageId: string, text: string): Promise<RcMessage> {
    const response = await this.post<{ message: RcMessage }>('chat.update', {
      roomId,
      msgId: messageId,
      text,
    });
    return response.message;
  }

  async delete(roomId: string, messageId: string): Promise<void> {
    // `asUser: true` makes Rocket.Chat attribute the deletion to the caller
    // rather than to an admin override, which changes what other clients render.
    await this.post('chat.delete', { roomId, msgId: messageId, asUser: true });
  }

  /**
   * Toggles a reaction. Rocket.Chat flips the current state when `shouldReact`
   * is omitted; we always pass it so concurrent clicks converge.
   */
  async react(messageId: string, emoji: string, shouldReact: boolean): Promise<void> {
    await this.post('chat.react', { messageId, emoji: normaliseEmoji(emoji), shouldReact });
  }

  async setPinned(messageId: string, pinned: boolean): Promise<void> {
    await this.post(pinned ? 'chat.pinMessage' : 'chat.unPinMessage', { messageId });
  }

  async setStarred(messageId: string, starred: boolean): Promise<void> {
    await this.post(starred ? 'chat.starMessage' : 'chat.unStarMessage', { messageId });
  }

  /** Thread parents in a room, ordered by most recent reply. */
  async listThreads(roomId: string, offset: number, count: number): Promise<{ threads: RcMessage[]; total: number }> {
    const response = await this.get<RcListEnvelope<'threads', RcMessage>>('chat.getThreadsList', {
      rid: roomId,
      offset,
      count,
    });
    return { threads: response.threads ?? [], total: response.total ?? 0 };
  }

  /**
   * Replies in a thread, newest first.
   *
   * Rocket.Chat defaults this endpoint to oldest-first, which pins offset 0 to
   * the *start* of the thread — the opposite of what a reply pane needs, since
   * it opens on the latest replies and pages backwards from there. Sorting
   * descending makes offset 0 the newest window and each further page an older
   * one; the caller flips each page back into reading order.
   */
  async listThreadMessages(
    threadId: string,
    offset: number,
    count: number,
  ): Promise<{ messages: RcMessage[]; total: number }> {
    const response = await this.get<RcListEnvelope<'messages', RcMessage>>('chat.getThreadMessages', {
      tmid: threadId,
      offset,
      count,
      sort: JSON.stringify({ ts: -1 }),
    });
    return { messages: response.messages ?? [], total: response.total ?? 0 };
  }

  async search(roomId: string, searchText: string, count: number): Promise<RcMessage[]> {
    const response = await this.get<RcListEnvelope<'messages', RcMessage>>('chat.search', {
      roomId,
      searchText,
      count,
    });
    return response.messages ?? [];
  }

  async listPinned(roomId: string, offset: number, count: number): Promise<{ messages: RcMessage[]; total: number }> {
    const response = await this.get<RcListEnvelope<'messages', RcMessage>>('chat.getPinnedMessages', {
      roomId,
      offset,
      count,
    });
    return { messages: response.messages ?? [], total: response.total ?? 0 };
  }

  async listStarred(roomId: string, offset: number, count: number): Promise<{ messages: RcMessage[]; total: number }> {
    const response = await this.get<RcListEnvelope<'messages', RcMessage>>('chat.getStarredMessages', {
      roomId,
      offset,
      count,
    });
    return { messages: response.messages ?? [], total: response.total ?? 0 };
  }

  /** Messages in the room that mention the calling user. */
  async listMentioned(
    roomId: string,
    offset: number,
    count: number,
  ): Promise<{ messages: RcMessage[]; total: number }> {
    const response = await this.get<RcListEnvelope<'messages', RcMessage>>('chat.getMentionedMessages', {
      roomId,
      offset,
      count,
    });
    return { messages: response.messages ?? [], total: response.total ?? 0 };
  }
}

/** Rocket.Chat stores reaction keys with surrounding colons and rejects them without. */
export const normaliseEmoji = (emoji: string): string => {
  const bare = emoji.replace(/^:+|:+$/g, '');
  return `:${bare}:`;
};
