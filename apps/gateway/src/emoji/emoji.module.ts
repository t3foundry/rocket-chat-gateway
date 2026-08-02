import { Module } from '@nestjs/common';

import { EmojiController } from './emoji.controller';

@Module({
  controllers: [EmojiController],
})
export class EmojiModule {}
