import { z } from 'zod';

import { IdSchema } from '../common.js';

/**
 * An emoji uploaded to the Rocket.Chat server.
 *
 * Standard Unicode emoji are not listed here: they are the same everywhere, so
 * shipping ~1900 of them through the gateway on every page load would be pure
 * waste. Clients bundle that set themselves — from `emojibase-data`, which is
 * what Rocket.Chat itself uses, so the shortcodes match.
 */
export const CustomEmojiSchema = z.object({
  id: IdSchema,
  /** Shortcode without colons, e.g. `party-parrot`. */
  name: z.string(),
  /** Alternative shortcodes that resolve to the same image. */
  aliases: z.array(z.string()),
  /** Gateway-proxied image URL. */
  url: z.string(),
});
export type CustomEmoji = z.infer<typeof CustomEmojiSchema>;

/** `GET /api/v1/emoji/custom` */
export const ListCustomEmojiResponseSchema = z.object({
  items: z.array(CustomEmojiSchema),
});
export type ListCustomEmojiResponse = z.infer<typeof ListCustomEmojiResponseSchema>;
