import { AuthenticatedResource } from './base.js';

export interface RcSlashCommand {
  command: string;
  params?: string;
  description?: string;
  clientOnly?: boolean;
  providesPreview?: boolean;
  permission?: string | string[];
}

export class CommandsResource extends AuthenticatedResource {
  /**
   * Every slash command registered on this server, apps included.
   *
   * Paged upstream, and a server with a few apps installed goes past the
   * default page size, so the count is raised rather than paged through: the
   * list is small, static, and fetched once per session by an autocomplete.
   */
  async list(): Promise<RcSlashCommand[]> {
    const response = await this.get<{ commands?: RcSlashCommand[] }>('commands.list', { count: 200 });
    return response.commands ?? [];
  }

  /**
   * Runs a command in a room.
   *
   * Rocket.Chat answers with a bare acknowledgement: whatever the command
   * produces arrives as a message on the room's realtime stream, like any other
   * message would.
   */
  async run(input: { command: string; params: string; roomId: string; threadId?: string }): Promise<void> {
    await this.post('commands.run', {
      command: input.command,
      params: input.params,
      roomId: input.roomId,
      ...(input.threadId ? { tmid: input.threadId } : {}),
    });
  }
}
