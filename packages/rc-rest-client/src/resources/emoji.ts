import { AuthenticatedResource } from './base.js';

export interface RcCustomEmoji {
  _id: string;
  name: string;
  aliases?: string[];
  /** File extension without the dot, e.g. `png`. */
  extension?: string;
  _updatedAt?: string;
}

export class EmojiResource extends AuthenticatedResource {
  /**
   * Custom emoji uploaded to this server.
   *
   * Rocket.Chat returns the delta shape (`{ emojis: { update, remove } }`) even
   * for a full listing, so the `update` array is the complete set when no
   * `updatedSince` is given.
   */
  async listCustom(updatedSince?: string): Promise<RcCustomEmoji[]> {
    const response = await this.get<{
      emojis?: { update?: RcCustomEmoji[]; remove?: RcCustomEmoji[] } | RcCustomEmoji[];
    }>('emoji-custom.list', { updatedSince });

    const emojis = response.emojis;
    if (!emojis) return [];
    // Older servers returned a bare array from this route.
    return Array.isArray(emojis) ? emojis : (emojis.update ?? []);
  }

  /** Public path Rocket.Chat serves a custom emoji image from. */
  imagePath(emoji: RcCustomEmoji): string {
    return `/emoji-custom/${encodeURIComponent(emoji.name)}.${emoji.extension ?? 'png'}`;
  }
}
