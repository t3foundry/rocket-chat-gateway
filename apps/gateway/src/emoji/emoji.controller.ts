import type { ListCustomEmojiResponse } from '@open-rocket-chat/api-contract';
import { Controller, Get, UseGuards } from '@nestjs/common';

import { toApiException } from '../common/upstream-error';
import { RocketChatService } from '../rocketchat/rocketchat.service';
import { CurrentSession, SessionGuard } from '../session/session.guard';
import type { ServerSession } from '../session/session.types';

@Controller('emoji')
@UseGuards(SessionGuard)
export class EmojiController {
  constructor(private readonly rocketChat: RocketChatService) {}

  /**
   * Custom emoji uploaded to the connected server.
   *
   * Standard Unicode emoji are not served here — clients bundle that set, and
   * shipping ~1900 unchanging entries on every page load would be waste.
   */
  @Get('custom')
  async listCustom(@CurrentSession() session: ServerSession): Promise<ListCustomEmojiResponse> {
    const client = this.rocketChat.userClient(session);

    try {
      const emojis = await client.emoji.listCustom();

      return {
        items: emojis.map((emoji) => ({
          id: emoji._id,
          name: emoji.name,
          aliases: emoji.aliases ?? [],
          // Proxied like every other media path, so the browser never needs to
          // know where Rocket.Chat lives.
          url: `/api/v1/files${client.emoji.imagePath(emoji)}`,
        })),
      };
    } catch (error) {
      throw toApiException(error);
    }
  }
}
