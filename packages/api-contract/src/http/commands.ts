import { z } from 'zod';

import { IdSchema } from '../common.js';

/**
 * A slash command the connected server knows about.
 *
 * `description` and `params` are Rocket.Chat i18n *keys* (`Archive_Description`,
 * `Channel_Name`), not finished sentences — the server has no idea which
 * language the caller reads. They are passed through untranslated because the
 * key is still the most useful thing a client can show, and translating half of
 * them here would only hide which ones are missing.
 */
export const SlashCommandSchema = z.object({
  /** The word after the slash, e.g. `archive`. Never carries the slash itself. */
  command: z.string(),
  /** Hint for what follows the command, e.g. `#channel`. */
  params: z.string().nullable(),
  description: z.string().nullable(),
  /**
   * True when Rocket.Chat's own web client handles the command in the browser
   * rather than on the server. Such a command cannot be run through the REST
   * API, so clients that do not implement it themselves should not offer it.
   */
  clientOnly: z.boolean(),
  /** Whether the command can render a preview before it is run. */
  providesPreview: z.boolean(),
  /**
   * Permission the caller needs, when the command declares one. Multiple ids
   * are alternatives: Rocket.Chat allows the command when any one is held.
   */
  permission: z.union([z.string(), z.array(z.string())]).nullable(),
});
export type SlashCommand = z.infer<typeof SlashCommandSchema>;

/** `GET /api/v1/commands` */
export const ListCommandsResponseSchema = z.object({
  items: z.array(SlashCommandSchema),
});
export type ListCommandsResponse = z.infer<typeof ListCommandsResponseSchema>;

/**
 * `POST /api/v1/commands/run`
 *
 * The command is named without its slash, and everything after it travels as
 * one opaque `params` string — Rocket.Chat parses arguments per command, so
 * splitting them here would be guessing.
 */
export const RunCommandRequestSchema = z.object({
  command: z.string().min(1),
  params: z.string().default(''),
  roomId: IdSchema,
  /** Runs the command inside a thread, as sending a message there would. */
  threadId: IdSchema.optional(),
});
export type RunCommandRequest = z.infer<typeof RunCommandRequestSchema>;

/**
 * Commands produce their output as messages, system messages, or nothing at
 * all, and Rocket.Chat reports none of it in the response. There is therefore
 * nothing to return but the acknowledgement.
 */
export const RunCommandResponseSchema = z.object({ ok: z.literal(true) });
export type RunCommandResponse = z.infer<typeof RunCommandResponseSchema>;
