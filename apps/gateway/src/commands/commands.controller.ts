import {
  RunCommandRequestSchema,
  type ListCommandsResponse,
  type RunCommandRequest,
  type RunCommandResponse,
} from '@t3foundry/open-rocket-chat-api-contract';
import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';

import { toApiException } from '../common/upstream-error';
import { zodPipe } from '../common/zod-validation.pipe';
import { RocketChatService } from '../rocketchat/rocketchat.service';
import { CurrentSession, SessionGuard } from '../session/session.guard';
import type { ServerSession } from '../session/session.types';

@Controller('commands')
@UseGuards(SessionGuard)
export class CommandsController {
  constructor(private readonly rocketChat: RocketChatService) {}

  /** Slash commands the connected server offers, for composer autocomplete. */
  @Get()
  async list(@CurrentSession() session: ServerSession): Promise<ListCommandsResponse> {
    const client = this.rocketChat.userClient(session);

    try {
      const commands = await client.commands.list();

      return {
        items: commands.map((command) => ({
          command: command.command,
          params: command.params ?? null,
          description: command.description ?? null,
          clientOnly: command.clientOnly ?? false,
          providesPreview: command.providesPreview ?? false,
          permission: command.permission ?? null,
        })),
      };
    } catch (error) {
      throw toApiException(error);
    }
  }

  /**
   * Runs a command in a room.
   *
   * Nothing is returned beyond the acknowledgement: a command's output arrives
   * on the room's realtime stream as an ordinary message, so the timeline
   * already has it by the time this call resolves.
   */
  @Post('run')
  async run(
    @CurrentSession() session: ServerSession,
    @Body(zodPipe(RunCommandRequestSchema)) body: RunCommandRequest,
  ): Promise<RunCommandResponse> {
    const client = this.rocketChat.userClient(session);

    try {
      await client.commands.run({
        // The slash is the composer's syntax, not part of the command's name;
        // stripped here so a client that leaves it on still works.
        command: body.command.replace(/^\//, ''),
        params: body.params,
        roomId: body.roomId,
        ...(body.threadId ? { threadId: body.threadId } : {}),
      });

      return { ok: true };
    } catch (error) {
      throw toApiException(error);
    }
  }
}
